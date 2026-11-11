import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Service } from "../src/api/service.js";
import { MemoryStore, MemoryBlobs, Conflict } from "../src/api/store.js";
import { DynamoStore } from "../src/api/aws-store.js";
import { MemoryDirectory } from "../src/groups/memory.js";
import { changeKey, encodeChangeCursor } from "../src/api/changes.js";
const admin = "cognito:admin",
  user = "cognito:user";
async function setup() {
  const db = new MemoryStore(),
    service = new Service(
      db,
      new MemoryBlobs(),
      new MemoryDirectory(true, [admin]),
    );
  const call = (
    method: string,
    path: string,
    body?: unknown,
    principal = admin,
    version?: number,
    key = randomUUID(),
    query?: Record<string, string>,
  ) =>
    service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal,
      query,
      headers: {
        "idempotency-key": key,
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
  assert.equal(
    (await call("POST", "/projects", { slug: "ROOT", name: "Root" })).status,
    201,
  );
  const feed = (query?: Record<string, string>, principal = admin) =>
    call(
      "GET",
      "/projects/ROOT/changes",
      undefined,
      principal,
      undefined,
      undefined,
      query,
    );
  const create = () =>
    call("POST", "/projects/ROOT/items", {
      kind: "Initiative",
      title: "Secret title",
    });
  return { db, call, feed, create };
}
test("fixed windows, stable replay, empty durable checkpoints and later writes", async () => {
  const { feed, create } = await setup();
  await create();
  await create();
  const first = (await feed({ limit: "1" })).body;
  assert.equal(first.watermark, 3);
  assert.equal(first.items[0].sequence, 1);
  assert.equal(first.baselineRequired, false);
  const again = (await feed({ limit: "1" })).body;
  assert.deepEqual(again, first);
  await create();
  const second = (await feed({ cursor: first.nextCursor, limit: "1" })).body;
  assert.equal(second.watermark, 3);
  assert.equal(second.items[0].sequence, 2);
  const last = (await feed({ cursor: second.nextCursor, limit: "1" })).body;
  assert.equal(last.items[0].sequence, 3);
  assert.ok(last.checkpoint);
  assert.equal(last.nextCursor, undefined);
  const following = (await feed({ cursor: last.checkpoint })).body;
  assert.deepEqual(
    following.items.map((e: any) => e.sequence),
    [4],
  );
  const empty = (await feed({ cursor: following.checkpoint })).body;
  assert.deepEqual(empty.items, []);
  assert.equal(empty.checkpoint, following.checkpoint);
});
test("since drains empty pages and never suppresses later backdated events", async () => {
  const { feed, create, db } = await setup();
  await create();
  const first = (await feed({ since: "2099-01-01T00:00:00Z", limit: "1" }))
    .body;
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  const end = (await feed({ cursor: first.nextCursor })).body;
  assert.deepEqual(end.items, []);
  assert.ok(end.checkpoint);
  await create();
  const key = db.key("PROJECT#ROOT", changeKey(3));
  const row = db.rows.get(key)!;
  row.value.at = "2000-01-01T00:00:00.000Z";
  const next = (await feed({ cursor: end.checkpoint })).body;
  assert.equal(next.items[0].sequence, 3);
  assert.equal(
    (await feed({ cursor: end.checkpoint, since: "2000-01-01T00:00:00Z" }))
      .status,
    400,
  );
});
test("legacy project coverage is honest; empty baseline checkpoint captures first post-upgrade mutation", async () => {
  const { db, feed, create } = await setup();
  for (const [key, r] of db.rows)
    if (r.sk === "CHANGE_FEED" || r.sk.startsWith("CHANGES#"))
      db.rows.delete(key);
  const initial = (await feed()).body;
  assert.equal(initial.baselineRequired, true);
  assert.equal(initial.coverage.firstSequence, null);
  assert.ok(initial.checkpoint);
  await create();
  const next = (await feed({ cursor: initial.checkpoint })).body;
  assert.equal(next.coverage.firstSequence, 2);
  assert.equal(next.coverage.historyComplete, false);
  assert.equal(next.baselineRequired, true);
  assert.equal(next.items[0].sequence, 2);
});
test("cursor rejects corruption, wrong principal/project, future or invalid ranges and invalid queries", async () => {
  const { feed, call } = await setup();
  await call("POST", "/projects/ROOT/members", {
    principal: user,
    role: "User",
  });
  const page = (await feed({ limit: "1" })).body;
  assert.equal((await feed({ cursor: page.nextCursor + "x" })).status, 400);
  assert.equal((await feed({ cursor: page.nextCursor }, user)).status, 400);
  const base = {
    v: 1 as const,
    principal: admin,
    project: "ROOT",
    mode: "page" as const,
    after: 0,
    watermark: 2,
  };
  for (const patch of [
    { project: "NOPE" },
    { after: -1 },
    { watermark: 999 },
    { after: 3 },
    { after: 1.5 },
  ])
    assert.equal(
      (await feed({ cursor: encodeChangeCursor({ ...base, ...patch }) }))
        .status,
      400,
    );
  const invalidQueries: Record<string, string>[] = [
    { limit: "0" },
    { limit: "101" },
    { since: "garbage" },
    { cursor: "" },
  ];
  for (const query of invalidQueries)
    assert.equal((await feed(query)).status, 400);
});
test("metadata covers docs, items, nested comments, reactions and deletions without bodies or principals", async () => {
  const { call, feed } = await setup();
  await call("POST", "/projects/ROOT/members", {
    principal: user,
    role: "User",
  });
  const i = (
    await call("POST", "/projects/ROOT/items", {
      kind: "Initiative",
      title: "Secret",
    })
  ).body;
  const cp = `/projects/ROOT/items/${i.id}/comments`;
  const c = (await call("POST", cp, { content: "Private comment" })).body;
  await call("POST", cp, { content: "Reply", parentCommentId: c.id });
  const reaction = (
    await call("POST", `${cp}/${c.id}/reactions`, {
      kind: "approval",
      commentVersion: 1,
    })
  ).body;
  await call(
    "DELETE",
    `${cp}/${c.id}/reactions/${reaction.id}`,
    undefined,
    admin,
    1,
  );
  const doc = (
    await call("POST", "/projects/ROOT/docs/User", {
      title: "Secret doc",
      content: "Private body",
    })
  ).body;
  await call(
    "PATCH",
    `/projects/ROOT/docs/User/${doc.id}`,
    { title: "Updated" },
    admin,
    1,
  );
  await call(
    "DELETE",
    `/projects/ROOT/docs/User/${doc.id}`,
    undefined,
    admin,
    2,
  );
  await call("DELETE", `/projects/ROOT/items/${i.id}`, undefined, admin, 1);
  const result = await feed({}, user);
  assert.equal(result.status, 200);
  const events = result.body.items;
  const actions = events.map((e: any) => e.action);
  for (const action of [
    "item.created",
    "item.deleted",
    "comment.created",
    "comment.approval",
    "comment.reaction.withdrawn",
    "document.created",
    "document.updated",
    "document.deleted",
  ])
    assert.ok(actions.includes(action), action);
  assert.equal(
    events.find((e: any) => e.action === "membership.set").target,
    "ROOT",
  );
  const documentEvent = events.find(
    (e: any) => e.action === "document.created",
  );
  const { url: _url, ...documentResource } = documentEvent.resource;
  assert.deepEqual(documentResource, {
    entityType: "document",
    id: doc.id,
    version: 1,
    tree: "User",
  });
  assert.equal(
    events.find((e: any) => e.action === "item.created").resource.kind,
    "Initiative",
  );
  const reactionEvent = events.find(
    (e: any) => e.action === "comment.approval",
  );
  assert.equal(reactionEvent.resource.entityType, "reaction");
  assert.equal(reactionEvent.resource.commentId, c.id);
  assert.equal(reactionEvent.resource.itemId, i.id);
  const wire = JSON.stringify(events);
  for (const secret of [
    "Secret",
    "Private",
    admin,
    user,
    "attribution",
    "before",
    "after",
  ])
    assert.ok(!wire.includes(secret), secret);
  assert.equal(new Set(events.map((e: any) => e.eventId)).size, events.length);
});
test("revoked membership cannot use checkpoints and in-flight revocation is rechecked", async () => {
  const { db, call, feed } = await setup();
  await call("POST", "/projects/ROOT/members", {
    principal: user,
    role: "User",
  });
  const checkpoint = (await feed({}, user)).body.checkpoint;
  const range = db.range.bind(db);
  db.range = async (...args) => {
    const result = await range(...args);
    db.rows.delete(db.key(`PRINCIPAL#${user}`, "PROJECT#ROOT"));
    return result as any;
  };
  assert.equal((await feed({}, user)).status, 404);
  assert.equal((await feed({ cursor: checkpoint }, user)).status, 404);
});
test("failed transactions and exact idempotent retries do not append phantom or duplicate events", async () => {
  const { db, call, feed } = await setup();
  const key = randomUUID();
  const path = "/projects/ROOT/items",
    body = { kind: "Initiative", title: "One" };
  const first = await call("POST", path, body, admin, undefined, key);
  assert.equal(first.status, 201);
  assert.deepEqual(
    await call("POST", path, body, admin, undefined, key),
    first,
  );
  const commit = db.commit.bind(db);
  db.commit = async () => {
    throw new Conflict();
  };
  assert.equal((await call("POST", path, body)).status, 409);
  db.commit = commit;
  const result = (await feed()).body;
  assert.equal(result.watermark, 2);
  assert.equal(result.items.length, 2);
});
test("deleted project terminal metadata is admin-only and content remains hidden", async () => {
  const { call, feed } = await setup();
  await call("POST", "/projects/ROOT/members", {
    principal: user,
    role: "User",
  });
  const version = (await feed()).body.watermark;
  assert.equal(
    (await call("DELETE", "/projects/ROOT", undefined, admin, version)).status,
    202,
  );
  const events = (await feed()).body.items;
  assert.equal(events.at(-1).action, "project.deleted");
  assert.equal((await feed({}, user)).status, 404);
  assert.equal((await call("GET", "/projects/ROOT/items")).status, 404);
});
test("Dynamo range is strongly consistent, key-bounded and continues from evaluated key", async () => {
  const sent: any[] = [];
  const client = {
    send: async (c: any) => {
      sent.push(c.input);
      return {
        Items: [],
        LastEvaluatedKey: { pk: "PROJECT#ROOT", sk: changeKey(4) },
      };
    },
  };
  const db = new DynamoStore("table", client as any);
  const result = await db.range(
    "PROJECT#ROOT",
    changeKey(1),
    changeKey(5),
    2,
    changeKey(2),
  );
  assert.equal(sent[0].ConsistentRead, true);
  assert.match(sent[0].KeyConditionExpression, /BETWEEN/);
  assert.equal(sent[0].ExpressionAttributeValues[":upper"], changeKey(5));
  assert.equal(sent[0].ExclusiveStartKey.sk, changeKey(2));
  assert.equal(result.next, changeKey(4));
});

test("concurrent first feed installation serializes without gaps or phantom rows", async () => {
  const { db, create, feed } = await setup();
  for (const [key, r] of db.rows)
    if (r.sk === "CHANGE_FEED" || r.sk.startsWith("CHANGES#"))
      db.rows.delete(key);
  const attempts = await Promise.all([create(), create()]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 201]);
  const retried = await create();
  assert.equal(retried.status, 201);
  const result = (await feed()).body;
  assert.deepEqual(
    result.items.map((e: any) => e.sequence),
    [2, 3, 4],
  );
  assert.equal(result.coverage.firstSequence, 2);
  assert.equal((await feed({ since: "2026-02-30T00:00:00Z" })).status, 400);
});

test("old-writer gaps return explicit recovery rather than advancing a successful checkpoint", async () => {
  const { db, feed, create } = await setup();
  const old = (await feed()).body.checkpoint;
  const meta = db.rows.get(db.key("PROJECT#ROOT", "META"))!;
  meta.version++;
  meta.value.version++;
  const gap = await feed({ cursor: old });
  assert.equal(gap.status, 409);
  assert.equal(gap.body.baselineRequired, true);
  assert.ok(gap.body.checkpoint);
  await create();
  const replay = (await feed({ cursor: gap.body.checkpoint })).body;
  assert.deepEqual(
    replay.items.map((e: any) => e.sequence),
    [3],
  );
  assert.equal(replay.coverage.historyComplete, false);
  assert.equal(replay.baselineRequired, true);
  const full = await feed();
  assert.equal(full.status, 409);
});

test("leading and middle missing events fail closed including across page boundaries", async () => {
  for (const missing of [1, 2, 3]) {
    const { db, feed, create } = await setup();
    await create();
    await create();
    db.rows.delete(db.key("PROJECT#ROOT", changeKey(missing)));
    let response = await feed({ limit: "1" });
    while (response.status === 200 && response.body.nextCursor)
      response = await feed({ cursor: response.body.nextCursor, limit: "1" });
    assert.equal(response.status, 409, `missing ${missing}`);
    assert.ok(response.body.checkpoint);
    assert.equal(response.body.coverage.historyComplete, false);
  }
});
