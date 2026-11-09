import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { loadConfig } from "../infra/config.js";
import { aws, verifyAccount } from "./aws.js";
import { DynamoStore, S3Blobs } from "../src/api/aws-store.js";
import { Service } from "../src/api/service.js";
import type { Store, Row } from "../src/api/store.js";

// Exercise real AWS storage using an isolated, unpredictable namespace. This
// invokes the service directly; API Gateway authentication is checked separately.
const config = loadConfig();
verifyAccount(config.account);
process.env.AWS_REGION = config.region;
const outputs = aws(["cloudformation", "describe-stacks", "--region", config.region,
  "--stack-name", "dnt-data"]).Stacks[0].Outputs as { OutputKey: string; OutputValue: string }[];
const output = (name: string) => {
  const value = outputs.find(o => o.OutputKey === name)?.OutputValue;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const db = new DynamoStore(output("TableName"));
const blobs = new S3Blobs(output("ContentBucket"));
const namespace = `SMOKE#${randomUUID()}#`;
const records = new Map<string, { pk: string; sk: string }>();
const objectKeys = new Set<string>();
const restore = <T>(row: Row<T>): Row<T> => ({ ...row, pk: row.pk.slice(namespace.length) });
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
    const mapped = writes.map(w => {
      const row = { ...w.row, pk: namespace + w.row.pk };
      records.set(JSON.stringify([row.pk, row.sk]), { pk: row.pk, sk: row.sk });
      return { ...w, row };
    });
    await db.commit(mapped, checks.map(c => ({ ...c, pk: namespace + c.pk })));
  },
};
const admin = "cognito:storage-smoke";
const member = "cognito:storage-smoke-member";
const service = new Service(store, {
  async put(key, content) {
    objectKeys.add(namespace + key);
    await blobs.put(namespace + key, content);
  },
  get: key => blobs.get(namespace + key),
}, [admin]);
async function request(method: string, path: string, body?: unknown,
  principal = admin, version?: number, key = randomUUID()) {
  return service.handle({ method, path: `/api/v1${path}`, body, principal,
    headers: { "idempotency-key": key, ...(version ? { "if-match": `"${version}"` } : {}) } });
}
try {
  assert.equal((await request("POST", "/projects", { slug: "ROOT", name: "Isolated smoke" })).status, 201);
  assert.equal((await request("POST", "/projects/ROOT/members", { principal: member, role: "User" })).status, 201);
  const initiative = await request("POST", "/projects/ROOT/items", { kind: "Initiative", title: "Initiative" });
  assert.equal(initiative.status, 201);
  const epic = await request("POST", "/projects/ROOT/items", { kind: "Epic", title: "Epic", parentId: initiative.body.id });
  assert.equal(epic.status, 201);
  const key = randomUUID();
  const body = { kind: "Task", title: "Task", parentId: epic.body.id };
  const task = await request("POST", "/projects/ROOT/items", body, member, undefined, key);
  assert.equal(task.status, 201);
  assert.equal(task.body.id, "ROOT-3");
  assert.deepEqual((await request("POST", "/projects/ROOT/items", body, member, undefined, key)).body, task.body);
  const taskPath = `/projects/ROOT/items/${task.body.id}`;
  assert.equal((await request("PATCH", taskPath, { state: "Review" }, member, 1)).status, 200);
  assert.equal((await request("PATCH", taskPath, { state: "Done" }, member, 1)).status, 412);
  assert.equal((await request("GET", "/projects/ROOT/docs/Administrator", undefined, member)).status, 403);
  const page = await request("POST", "/projects/ROOT/docs/User", { title: "Guide", content: "# First" });
  assert.equal(page.status, 201);
  const path = `/projects/ROOT/docs/User/${page.body.id}`;
  assert.equal((await request("PATCH", path, { content: "# Second" }, member, 1)).status, 200);
  assert.equal((await request("GET", `${path}/revisions/1`)).body.content, "# First");
  assert.equal((await request("GET", path)).body.content, "# Second");
  const firstKey = objectKeys.values().next().value!;
  await assert.rejects(blobs.put(firstKey, "Cannot replace immutable content"),
    (error: any) => error.$metadata?.httpStatusCode === 412);
  console.log("AWS storage smoke passed: hierarchy, idempotency, stale writes, roles, revisions, immutable objects.");
} finally {
  // Only this run's exact random-prefix keys are eligible for cleanup.
  for (const key of records.values())
    await db.client.send(new DeleteCommand({ TableName: db.table, Key: key }));
  for (const key of objectKeys) {
    const versions = await blobs.client.send(new ListObjectVersionsCommand({ Bucket: blobs.bucket, Prefix: key }));
    for (const version of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])])
      if (version.Key === key)
        await blobs.client.send(new DeleteObjectCommand({ Bucket: blobs.bucket, Key: key, VersionId: version.VersionId }));
  }
  console.log(`Cleaned isolated storage namespace ${namespace}`);
}
