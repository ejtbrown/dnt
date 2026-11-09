import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  fixture,
  mint,
  origin,
  admin,
  member,
  type Fixture,
} from "./mcp-fixtures.js";
import { AccountNames } from "../src/api/names.js";
import { attributionLabel } from "../src/shared/model.js";
async function connect(f: Fixture) {
  const token = await mint(f);
  const client = new Client({ name: "attribution-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: (input, init) => f.http(new Request(input, init)),
      requestInit: {
        headers: { authorization: `Bearer ${token.access_token}` },
      },
    }),
  );
  return client;
}
test("MCP attribution is per call, cannot forge the user, and survives history, restoration, concurrency and retries", async () => {
  const f = fixture(),
    client = await connect(f);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return (result.structuredContent as any).result;
  };
  try {
    for (const tool of (await client.listTools()).tools)
      assert.equal(
        !!tool.inputSchema.properties?.agentName,
        !tool.annotations?.readOnlyHint,
      );
    await call("create_project", {
      input: { slug: "ROOT", name: "Root" },
      idempotencyKey: randomUUID(),
      agentName: "Planner",
    });
    const i = await call("create_work_item", {
      project: "ROOT",
      input: { kind: "Initiative", title: "Release" },
      idempotencyKey: randomUUID(),
      agentName: "Planner",
    });
    const e = await call("create_work_item", {
      project: "ROOT",
      input: { kind: "Epic", title: "Build", parentId: i.id },
      idempotencyKey: randomUUID(),
    });
    const task = await call("create_work_item", {
      project: "ROOT",
      input: { kind: "Task", title: "Implement", parentId: e.id },
      idempotencyKey: randomUUID(),
      agentName: "  Builder  ",
    });
    assert.deepEqual(task.attribution, {
      principal: admin,
      userName: "Owner",
      agentName: "Builder",
    });
    assert.equal(task.updatedBy, admin);
    const doc = await call("create_document", {
      project: "ROOT",
      tree: "User",
      input: { title: "Guide", content: "First" },
      idempotencyKey: randomUUID(),
      agentName: "Writer",
    });
    const page = { project: "ROOT", tree: "User", documentId: doc.id };
    await call("update_document", {
      ...page,
      patch: { content: "Second" },
      expectedVersion: 1,
      agentName: "Editor",
    });
    const restored = await call("restore_document_revision", {
      ...page,
      revision: 1,
      expectedVersion: 2,
      agentName: "Restorer",
    });
    assert.equal(restored.attribution.agentName, "Restorer");
    assert.equal(
      (await call("get_document_revision", { ...page, revision: 1 }))
        .attribution.agentName,
      "Writer",
    );
    const untagged = await call("update_document", {
      ...page,
      patch: { content: "Direct edit" },
      expectedVersion: 3,
    });
    assert.deepEqual(untagged.attribution, {
      principal: admin,
      userName: "Owner",
    });
    assert.deepEqual(
      (await call("list_document_revisions", page)).items.map(
        (r: any) => r.attribution.agentName,
      ),
      ["Writer", "Editor", "Restorer", undefined],
    );
    const comment = {
      project: "ROOT",
      id: task.id,
      input: { content: "Progress" },
      idempotencyKey: randomUUID(),
      agentName: "Builder",
    };
    const first = await call("create_task_comment", comment);
    assert.deepEqual(await call("create_task_comment", comment), first);
    const changedAgent = await client.callTool({
      name: "create_task_comment",
      arguments: { ...comment, agentName: "Reviewer" },
    });
    assert.equal(changedAgent.isError, true);
    assert.match(JSON.stringify(changedAgent.content), /409/);
    await Promise.all(
      ["Agent A", "Agent B"].map((agentName) =>
        call("create_task_comment", {
          ...comment,
          input: { content: agentName },
          idempotencyKey: randomUUID(),
          agentName,
        }),
      ),
    );
    const comments = (
      await call("list_task_comments", { project: "ROOT", id: task.id })
    ).items;
    assert.equal(comments.length, 3);
    for (const c of comments.slice(1))
      assert.equal(c.content, c.attribution.agentName);
    const updated = await call("update_work_item", {
      project: "ROOT",
      id: task.id,
      patch: { state: "Review" },
      expectedVersion: task.version,
      agentName: "Reviewer",
    });
    assert.equal(updated.attribution.agentName, "Reviewer");
    await call("set_member", {
      project: "ROOT",
      input: { principal: member, role: "User" },
      idempotencyKey: randomUUID(),
      agentName: "Access Manager",
    });
    await call("remove_member", {
      project: "ROOT",
      principal: member,
      expectedVersion: 1,
      agentName: "Access Manager",
    });
    const audit = (await call("list_audit_events", { project: "ROOT" })).items;
    assert.ok(
      audit.every(
        (a: any) =>
          a.principal === admin &&
          a.attribution.principal === admin &&
          a.attribution.userName === "Owner",
      ),
    );
    assert.equal(
      audit.filter((a: any) => a.action === "comment.created").length,
      3,
    );
    assert.equal(
      audit.find((a: any) => a.action === "membership.removed").attribution
        .agentName,
      "Access Manager",
    );
    for (const agentName of [
      "",
      " ",
      "x".repeat(81),
      "Agent\nAdmin",
      "Agent\u202eAdmin",
    ]) {
      const bad = await client.callTool({
        name: "create_task_comment",
        arguments: { ...comment, idempotencyKey: randomUUID(), agentName },
      });
      assert.equal(bad.isError, true);
    }
    for (const spoof of [
      { userName: "Someone else" },
      { attribution: { principal: member } },
      { principal: member },
    ])
      assert.equal(
        (
          await client.callTool({
            name: "create_task_comment",
            arguments: { ...comment, ...spoof },
          })
        ).isError,
        true,
      );
    assert.equal(
      attributionLabel(undefined, "cognito:legacy"),
      "cognito:legacy",
    );
    assert.equal(
      attributionLabel(first.attribution, admin),
      "Owner via Builder",
    );
  } finally {
    await client.close();
  }
});

test("comments are scoped to tasks and membership, paginated, immutable, and HTTP bodies cannot supply attribution", async () => {
  const f = fixture();
  const request = (
    method: string,
    path: string,
    body?: unknown,
    principal = admin,
    query?: Record<string, string>,
  ) =>
    f.service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal,
      userName: "Owner",
      query,
      headers: {
        "idempotency-key": randomUUID(),
        "x-agent-name": "Forged header",
      },
    });
  await request("POST", "/projects", { slug: "ROOT", name: "Root" });
  const i = (
    await request("POST", "/projects/ROOT/items", {
      kind: "Initiative",
      title: "I",
    })
  ).body;
  const e = (
    await request("POST", "/projects/ROOT/items", {
      kind: "Epic",
      title: "E",
      parentId: i.id,
    })
  ).body;
  const t = (
    await request("POST", "/projects/ROOT/items", {
      kind: "Task",
      title: "T",
      parentId: e.id,
    })
  ).body;
  const path = `/projects/ROOT/items/${t.id}/comments`;
  for (const body of [
    { content: " " },
    { content: "x".repeat(20001) },
    { content: "Hello", agentName: "Fake" },
    { content: "Hello", userName: "Fake" },
  ])
    assert.equal((await request("POST", path, body)).status, 400);
  assert.equal(
    (
      await request("POST", `/projects/ROOT/items/${e.id}/comments`, {
        content: "Hello",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("POST", path, { content: "Hello" }, member)).status,
    404,
  );
  await request("POST", "/projects/ROOT/members", {
    principal: member,
    role: "User",
  });
  const one = await request("POST", path, { content: "First" }, member);
  assert.equal(one.status, 201);
  assert.equal(one.body.attribution.agentName, undefined);
  await request("POST", path, { content: "Second" });
  const firstPage = (
    await request("GET", path, undefined, member, { limit: "1" })
  ).body;
  assert.ok(firstPage.nextCursor);
  assert.equal(
    (
      await request("GET", path, undefined, member, {
        limit: "1",
        cursor: firstPage.nextCursor,
      })
    ).body.items.length,
    1,
  );
  assert.equal(
    (
      await request("GET", path, undefined, member, {
        cursor: "COMMENT#ITEM#000000999999#fake",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("PATCH", `${path}/${one.body.id}`, { content: "Replaced" }))
      .status,
    404,
  );
  assert.equal((await request("DELETE", `${path}/${one.body.id}`)).status, 404);
});

test("display names come from the matching Cognito account, with bounded cached lookup and safe fallbacks", async () => {
  let count = 0;
  const names = new AccountNames("pool", async (input) => {
    count++;
    assert.equal(input.UserPoolId, "pool");
    assert.equal(input.Username, "trusted-username");
    return {
      $metadata: {},
      Username: "trusted-username",
      UserAttributes: [
        { Name: "sub", Value: admin.slice(8) },
        { Name: "name", Value: "Erick Brown" },
      ],
    };
  });
  assert.equal(await names.resolve(admin, "trusted-username"), "Erick Brown");
  assert.equal(await names.resolve(admin, "trusted-username"), "Erick Brown");
  assert.equal(count, 1);
  assert.equal(await names.resolve("iam:role"), "iam:role");
  assert.equal(count, 1);
  const mismatched = new AccountNames("pool", async () => ({
    $metadata: {},
    Username: "other",
    UserAttributes: [
      { Name: "sub", Value: "other" },
      { Name: "name", Value: "Wrong user" },
    ],
  }));
  assert.equal(await mismatched.resolve(admin, "other"), admin);
  const email = new AccountNames("pool", async () => ({
    $metadata: {},
    Username: "test",
    UserAttributes: [
      { Name: "sub", Value: admin.slice(8) },
      { Name: "email", Value: "verified@example.com" },
      { Name: "email_verified", Value: "true" },
    ],
  }));
  assert.equal(await email.resolve(admin, "test"), "verified@example.com");
});
