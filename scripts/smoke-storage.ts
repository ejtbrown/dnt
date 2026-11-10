import { MemoryDirectory } from "../src/groups/memory.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { loadConfig } from "../infra/config.js";
import { aws, verifyAccount } from "./aws.js";
import { DynamoStore, S3Blobs } from "../src/api/aws-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/tools.js";
import { Service } from "../src/api/service.js";
import type { Store, Row } from "../src/api/store.js";

// Exercise real AWS storage using an isolated, unpredictable namespace. This
// invokes the service directly; API Gateway authentication is checked separately.
const config = loadConfig();
verifyAccount(config.account);
process.env.AWS_REGION = config.region;
const outputs = aws([
  "cloudformation",
  "describe-stacks",
  "--region",
  config.region,
  "--stack-name",
  "dnt-data",
]).Stacks[0].Outputs as { OutputKey: string; OutputValue: string }[];
const output = (name: string) => {
  const value = outputs.find((o) => o.OutputKey === name)?.OutputValue;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const db = new DynamoStore(output("TableName"));
const blobs = new S3Blobs(output("ContentBucket"));
const namespace = `SMOKE#${randomUUID()}#`;
const records = new Map<string, { pk: string; sk: string }>();
const objectKeys = new Set<string>();
const restore = <T>(row: Row<T>): Row<T> => ({
  ...row,
  pk: row.pk.slice(namespace.length),
});
const store: Store = {
  async get<T>(pk: string, sk: string) {
    const found = await db.get<T>(namespace + pk, sk);
    return found && restore(found);
  },
  async query<T>(pk: string, prefix: string, limit: number, after?: string) {
    const page = await db.query<T>(namespace + pk, prefix, limit, after);
    return { ...page, rows: page.rows.map(restore) };
  },
  async commit(writes, checks = []) {
    const mapped = writes.map((w) => {
      const row = { ...w.row, pk: namespace + w.row.pk };
      records.set(JSON.stringify([row.pk, row.sk]), { pk: row.pk, sk: row.sk });
      return { ...w, row };
    });
    await db.commit(
      mapped,
      checks.map((c) => ({ ...c, pk: namespace + c.pk })),
    );
  },
};
const admin = "cognito:storage-smoke";
const member = "cognito:storage-smoke-member";
const service = new Service(
  store,
  {
    async put(key, content) {
      objectKeys.add(namespace + key);
      await blobs.put(namespace + key, content);
    },
    get: (key) => blobs.get(namespace + key),
  },
  new MemoryDirectory(true, [admin]),
);
async function request(
  method: string,
  path: string,
  body?: unknown,
  principal = admin,
  version?: number,
  key = randomUUID(),
) {
  return service.handle({
    method,
    path: `/api/v1${path}`,
    body,
    principal,
    headers: {
      "idempotency-key": key,
      ...(version ? { "if-match": `"${version}"` } : {}),
    },
  });
}
try {
  assert.equal(
    (
      await request("POST", "/projects", {
        slug: "ROOT",
        name: "Isolated smoke",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request("POST", "/projects/ROOT/members", {
        principal: member,
        role: "User",
      })
    ).status,
    201,
  );
  const initiative = await request("POST", "/projects/ROOT/items", {
    kind: "Initiative",
    title: "Initiative",
  });
  assert.equal(initiative.status, 201);
  const epic = await request("POST", "/projects/ROOT/items", {
    kind: "Epic",
    title: "Epic",
    parentId: initiative.body.id,
  });
  assert.equal(epic.status, 201);
  const key = randomUUID();
  const body = { kind: "Task", title: "Task", parentId: epic.body.id };
  const task = await request(
    "POST",
    "/projects/ROOT/items",
    body,
    member,
    undefined,
    key,
  );
  assert.equal(task.status, 201);
  assert.equal(task.body.id, "ROOT-3");
  assert.deepEqual(
    (
      await request(
        "POST",
        "/projects/ROOT/items",
        body,
        member,
        undefined,
        key,
      )
    ).body,
    task.body,
  );
  const taskPath = `/projects/ROOT/items/${task.body.id}`;
  assert.equal(
    (await request("PATCH", taskPath, { state: "Review" }, member, 1)).status,
    200,
  );
  assert.equal(
    (await request("PATCH", taskPath, { state: "Done" }, member, 1)).status,
    412,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/projects/ROOT/docs/Administrator",
        undefined,
        member,
      )
    ).status,
    403,
  );
  const page = await request("POST", "/projects/ROOT/docs/User", {
    title: "Guide",
    content: "# First",
  });
  assert.equal(page.status, 201);
  const path = `/projects/ROOT/docs/User/${page.body.id}`;
  assert.equal(
    (await request("PATCH", path, { content: "# Second" }, member, 1)).status,
    200,
  );
  assert.equal(
    (await request("GET", `${path}/revisions/1`)).body.content,
    "# First",
  );
  assert.equal((await request("GET", path)).body.content, "# Second");
  const firstKey = objectKeys.values().next().value!;
  await assert.rejects(
    blobs.put(firstKey, "Cannot replace immutable content"),
    (error: any) => error.$metadata?.httpStatusCode === 412,
  );
  const mcp = createMcpServer(service, `https://${config.domain}`, {
    principal: admin,
    profile: { id: "storage-smoke", name: "Smoke Operator" },
    scopes: ["dnt:read", "dnt:write"],
  });
  const client = new Client({ name: "dnt-storage-smoke", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, "MCP storage operation failed");
      return (response.structuredContent as any).result;
    };
    const comment = await call("create_task_comment", {
      project: "ROOT",
      id: task.body.id,
      input: { content: "Isolated attributed comment" },
      idempotencyKey: randomUUID(),
      agentName: "Storage Agent",
    });
    assert.deepEqual(comment.attribution, {
      principal: admin,
      userName: "Smoke Operator",
      agentName: "Storage Agent",
    });
    assert.equal(
      (await call("list_task_comments", { project: "ROOT", id: task.body.id }))
        .items[0].attribution.agentName,
      "Storage Agent",
    );
    const commentArgs = {
      project: "ROOT",
      id: task.body.id,
      commentId: comment.id,
    };
    const edited = await call("update_work_item_comment", {
      ...commentArgs,
      input: { content: "    Markdown code  \nnext\n" },
      expectedVersion: 1,
      agentName: "Comment Editor",
    });
    assert.equal(edited.content, "    Markdown code  \nnext\n");
    const commentRevisions = (
      await call("list_work_item_comment_revisions", commentArgs)
    ).items;
    assert.equal(commentRevisions.length, 2);
    assert.equal(commentRevisions[0].content, "Isolated attributed comment");
    assert.equal(
      commentRevisions[1].editAttribution.agentName,
      "Comment Editor",
    );
    const pageArgs = {
      project: "ROOT",
      tree: "User",
      documentId: page.body.id,
    };
    await call("update_document", {
      ...pageArgs,
      patch: { content: "# Attributed revision" },
      expectedVersion: 2,
      agentName: "Writer",
    });
    await call("restore_document_revision", {
      ...pageArgs,
      revision: 1,
      expectedVersion: 3,
      agentName: "Restorer",
    });
    assert.equal(
      (await call("get_document_revision", { ...pageArgs, revision: 3 }))
        .attribution.agentName,
      "Writer",
    );
    assert.equal(
      (await call("get_document", pageArgs)).attribution.agentName,
      "Restorer",
    );
    const comparison = await call("compare_document_revisions", {
      ...pageArgs,
      fromRevision: 1,
      toRevision: 3,
    });
    assert.equal(comparison.from.version, 1);
    assert.equal(comparison.to.version, 3);
    assert.equal(
      comparison.content.parts
        .filter((p: any) => p.type !== "removed")
        .map((p: any) => p.text)
        .join(""),
      "# Attributed revision",
    );
    const audit = (await call("list_audit_events", { project: "ROOT" })).items;
    assert.ok(
      audit.some(
        (a: any) =>
          a.action === "comment.created" &&
          a.attribution.agentName === "Storage Agent",
      ),
    );
    console.log(
      "AWS MCP attribution smoke passed: comment edits/history, document comparison, restoration, immutable history, and audit.",
    );
  } finally {
    await client.close();
    await mcp.close();
  }
  console.log(
    "AWS storage smoke passed: hierarchy, idempotency, stale writes, roles, revisions, immutable objects.",
  );
} finally {
  // Only this run's exact random-prefix keys are eligible for cleanup.
  for (const key of records.values())
    await db.client.send(new DeleteCommand({ TableName: db.table, Key: key }));
  for (const key of objectKeys) {
    const versions = await blobs.client.send(
      new ListObjectVersionsCommand({ Bucket: blobs.bucket, Prefix: key }),
    );
    for (const version of [
      ...(versions.Versions ?? []),
      ...(versions.DeleteMarkers ?? []),
    ])
      if (version.Key === key)
        await blobs.client.send(
          new DeleteObjectCommand({
            Bucket: blobs.bucket,
            Key: key,
            VersionId: version.VersionId,
          }),
        );
  }
  console.log(`Cleaned isolated storage namespace ${namespace}`);
}
