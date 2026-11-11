import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Service } from "../src/api/service.js";
import { MemoryStore, MemoryBlobs } from "../src/api/store.js";
import { MemoryDirectory } from "../src/groups/memory.js";

async function fixture() {
  const admin = "cognito:admin",
    maintainer = "cognito:maintainer",
    user = "cognito:user";
  const db = new MemoryStore();
  const service = new Service(
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
  ) =>
    service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal,
      origin: "web",
      headers: {
        "idempotency-key": key,
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
  await call("POST", "/projects", { slug: "ROOT", name: "Root" });
  await call("POST", "/projects/ROOT/members", {
    principal: maintainer,
    role: "Maintainer",
  });
  await call("POST", "/projects/ROOT/members", {
    principal: user,
    role: "User",
  });
  const i = (
    await call("POST", "/projects/ROOT/items", {
      kind: "Initiative",
      title: "I",
    })
  ).body;
  const e = (
    await call("POST", "/projects/ROOT/items", {
      kind: "Epic",
      title: "E",
      parentId: i.id,
    })
  ).body;
  const create = (title: string, extra = {}) =>
    call(
      "POST",
      "/projects/ROOT/items",
      { kind: "Task", title, parentId: e.id, ...extra },
      maintainer,
    );
  return { call, db, admin, maintainer, user, e, create };
}
test("immutable task snapshots, state changes and deletion retain exact scope and audit", async () => {
  const { call, create, maintainer, db } = await fixture();
  const t = (await create("Original")).body,
    path = `/projects/ROOT/items/${t.id}`;
  const changed = await call(
    "PATCH",
    path,
    { title: "New scope", state: "Cancelled", dueDate: "2026-12-31" },
    maintainer,
    1,
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (await call("GET", `${path}/revisions/1`)).body.title,
    "Original",
  );
  const history = (await call("GET", `${path}/revisions`)).body.items;
  assert.deepEqual(
    history.map((x: any) => x.version),
    [1, 2],
  );
  const audit = (await call("GET", "/projects/ROOT/audit")).body.items.find(
    (a: any) => a.action === "item.updated",
  );
  assert.equal(audit.before.state, "Concept");
  assert.equal(audit.after.state, "Cancelled");
  assert.ok(audit.changedFields.includes("title"));
  assert.equal(audit.attribution.source, "web");
  assert.equal(
    (await call("DELETE", path, undefined, maintainer, 2)).status,
    204,
  );
  assert.equal((await call("GET", path)).status, 404);
  assert.equal((await call("GET", `${path}/revisions`)).body.items.length, 3);
  assert.ok(
    !(await call("GET", "/projects/ROOT/items")).body.items.some(
      (x: any) => x.id === t.id,
    ),
  );
  assert.equal(
    [...db.rows.values()].filter((r) => r.sk.startsWith(`ITEM_REV#${t.id}#`))
      .length,
    3,
  );
});
test("nested replies, version-bound approval vs acknowledgement, withdrawal and stale protection", async () => {
  const { call, create, maintainer, user } = await fixture();
  const t = (await create("Discussion")).body,
    path = `/projects/ROOT/items/${t.id}/comments`;
  const c = (
    await call("POST", path, { content: "Decision: ship?" }, maintainer)
  ).body;
  const reply = (
    await call(
      "POST",
      path,
      { content: "Only after tests", parentCommentId: c.id },
      maintainer,
    )
  ).body;
  const nested = await call(
    "POST",
    path,
    { content: "Acknowledged", parentCommentId: reply.id },
    maintainer,
  );
  assert.equal(nested.status, 201);
  assert.equal(nested.body.parentCommentId, reply.id);
  assert.match(c.url, new RegExp(`#comment-${c.id}$`));
  const key = randomUUID();
  const reactions = `${path}/${c.id}/reactions`;
  const approval = await call(
    "POST",
    reactions,
    { kind: "approval", commentVersion: 1 },
    maintainer,
    undefined,
    key,
  );
  assert.equal(approval.status, 201);
  assert.deepEqual(
    (
      await call(
        "POST",
        reactions,
        { kind: "approval", commentVersion: 1 },
        maintainer,
        undefined,
        key,
      )
    ).body,
    approval.body,
  );
  assert.equal(
    (
      await call(
        "POST",
        reactions,
        { kind: "acknowledgement", commentVersion: 1 },
        user,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "PATCH",
        `${path}/${c.id}`,
        { content: "Decision: ship changed scope?" },
        maintainer,
        1,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        reactions,
        { kind: "approval", commentVersion: 1 },
        maintainer,
      )
    ).status,
    412,
  );
  const ack = await call(
    "POST",
    reactions,
    { kind: "acknowledgement", commentVersion: 2 },
    maintainer,
  );
  assert.equal(ack.status, 201);
  assert.equal((await call("GET", reactions)).body.items.length, 2);
  assert.equal(
    (
      await call(
        "DELETE",
        `${reactions}/${approval.body.id}`,
        undefined,
        maintainer,
        1,
      )
    ).status,
    200,
  );
  assert.ok(
    (await call("GET", reactions)).body.items.find(
      (r: any) => r.id === approval.body.id,
    ).withdrawnAt,
  );
  assert.equal(
    (await call("GET", `${path}/${c.id}/revisions`)).body.items[0].content,
    "Decision: ship?",
  );
});
test("User is read-only across tasks, comments, reactions and document publication", async () => {
  const { call, create, user, maintainer, e } = await fixture();
  const t = (await create("Read")).body,
    path = `/projects/ROOT/items/${t.id}`;
  const doc = (
    await call(
      "POST",
      "/projects/ROOT/docs/User",
      { title: "Read", content: "body" },
      maintainer,
    )
  ).body;
  for (const [method, url, body, version] of [
    [
      "POST",
      "/projects/ROOT/items",
      { kind: "Task", title: "No", parentId: e.id },
      undefined,
    ],
    ["PATCH", path, { state: "Implement" }, 1],
    ["DELETE", path, undefined, 1],
    ["POST", `${path}/comments`, { content: "No" }, undefined],
    [
      "POST",
      "/projects/ROOT/docs/User",
      { title: "No", content: "No" },
      undefined,
    ],
    ["PATCH", `/projects/ROOT/docs/User/${doc.id}`, { public: true }, 1],
    ["DELETE", `/projects/ROOT/docs/User/${doc.id}`, undefined, 1],
  ] as const)
    assert.equal(
      (await call(method, url, body, user, version)).status,
      403,
      `${method} ${url}`,
    );
  assert.equal((await call("GET", path, undefined, user)).status, 200);
  assert.equal(
    (await call("GET", `/projects/ROOT/docs/User/${doc.id}`, undefined, user))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/projects/ROOT/members",
        { principal: "cognito:new", role: "User" },
        maintainer,
      )
    ).status,
    403,
  );
});
test("valid dates, task links, cycle and concurrent cycle prevention", async () => {
  const { call, create, maintainer } = await fixture();
  assert.equal((await create("bad", { dueDate: "2026-02-30" })).status, 400);
  const a = (await create("A")).body,
    b = (await create("B")).body;
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${a.id}`,
        { dependencies: [a.id] },
        maintainer,
        1,
      )
    ).status,
    400,
  );
  const [ab, ba] = await Promise.all([
    call(
      "PATCH",
      `/projects/ROOT/items/${a.id}`,
      { dependencies: [b.id] },
      maintainer,
      1,
    ),
    call(
      "PATCH",
      `/projects/ROOT/items/${b.id}`,
      { dependencies: [a.id] },
      maintainer,
      1,
    ),
  ]);
  assert.deepEqual([ab.status, ba.status].sort(), [200, 400]);
  assert.equal((await create("Related", { relatedTasks: [a.id] })).status, 201);
  assert.equal(
    (await create("Missing", { dependencies: ["ROOT-999"] })).status,
    404,
  );
});
test("historical imports retain source evidence without impersonating live approval", async () => {
  const { call, create, maintainer, user } = await fixture();
  const t = (
    await create("Imported description", { description: "Original Jira scope" })
  ).body;
  const base = `/projects/ROOT/items/${t.id}/comments`;
  const input = {
    content: "Decision: deploy?",
    source: {
      system: "jira",
      id: "12345",
      url: "https://example.atlassian.net/browse/ROOT-1?focusedCommentId=12345",
      author: "Erick",
      createdAt: "2026-11-01T12:00:00Z",
    },
    historicalApprovals: [
      { kind: "approval", author: "Erick", sourceRevision: "1" },
    ],
  };
  assert.equal((await call("POST", `${base}/import`, input, user)).status, 403);
  const key = randomUUID();
  const imported = await call(
    "POST",
    `${base}/import`,
    input,
    maintainer,
    undefined,
    key,
  );
  assert.equal(imported.status, 201);
  assert.equal(imported.body.createdBy, maintainer);
  assert.equal(imported.body.importedEvidence.historical, true);
  assert.equal(imported.body.importedEvidence.source.author, "Erick");
  assert.equal(imported.body.importedEvidence.importedBy, maintainer);
  assert.equal(
    (await call("GET", `${base}/${imported.body.id}/reactions`)).body.items
      .length,
    0,
  );
  assert.deepEqual(
    (await call("POST", `${base}/import`, input, maintainer, undefined, key))
      .body,
    imported.body,
  );
  assert.equal(
    (
      await call(
        "POST",
        `${base}/import`,
        { ...input, source: { ...input.source, url: "javascript:alert(1)" } },
        maintainer,
      )
    ).status,
    400,
  );
  const reply = await call(
    "POST",
    `${base}/import`,
    {
      ...input,
      content: "Historical reply",
      parentCommentId: imported.body.id,
      source: { ...input.source, id: "12346" },
    },
    maintainer,
  );
  assert.equal(reply.status, 201);
  assert.equal(reply.body.parentCommentId, imported.body.id);
});
test("deleted items reject new comments and parent items with live children cannot be deleted", async () => {
  const { call, create, maintainer, e } = await fixture();
  const task = (await create("Delete")).body;
  assert.equal(
    (
      await call(
        "DELETE",
        `/projects/ROOT/items/${e.id}`,
        undefined,
        maintainer,
        e.version,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "DELETE",
        `/projects/ROOT/items/${task.id}`,
        undefined,
        maintainer,
        1,
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/projects/ROOT/items/${task.id}/comments`,
        { content: "No" },
        maintainer,
      )
    ).status,
    409,
  );
});
test("cross-project dependencies serialize concurrent cycle creation and check visibility", async () => {
  const { call, create, maintainer } = await fixture();
  await call("POST", "/projects", { slug: "OTHER", name: "Other" });
  const i = (
    await call("POST", "/projects/OTHER/items", {
      kind: "Initiative",
      title: "I",
    })
  ).body;
  const e = (
    await call("POST", "/projects/OTHER/items", {
      kind: "Epic",
      title: "E",
      parentId: i.id,
    })
  ).body;
  const a = (await create("A")).body;
  const b = (
    await call("POST", "/projects/OTHER/items", {
      kind: "Task",
      title: "B",
      parentId: e.id,
    })
  ).body;
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${a.id}`,
        { dependencies: [b.id] },
        maintainer,
        1,
      )
    ).status,
    404,
  );
  await call("POST", "/projects/OTHER/members", {
    principal: maintainer,
    role: "User",
  });
  const outcomes = await Promise.all([
    call(
      "PATCH",
      `/projects/ROOT/items/${a.id}`,
      { dependencies: [b.id] },
      maintainer,
      1,
    ),
    call(
      "PATCH",
      `/projects/OTHER/items/${b.id}`,
      { dependencies: [a.id] },
      undefined,
      1,
    ),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), [200, 400]);
});
test("legacy task first edit retains last known historical snapshot", async () => {
  const { call, create, db } = await fixture();
  const t = (await create("Legacy")).body;
  for (const [key, row] of db.rows)
    if (row.sk.startsWith(`ITEM_REV#${t.id}#`)) db.rows.delete(key);
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${t.id}`,
        { title: "Edited" },
        undefined,
        1,
      )
    ).status,
    200,
  );
  const history = (await call("GET", `/projects/ROOT/items/${t.id}/revisions`))
    .body.items;
  assert.deepEqual(
    history.map((r: any) => r.title),
    ["Legacy", "Edited"],
  );
});
test("documentation trees are organizational: all members read, Maintainers write every tree", async () => {
  const { call, user, maintainer } = await fixture();
  for (const tree of ["User", "Maintainer", "Administrator"]) {
    const base = `/projects/ROOT/docs/${tree}`;
    assert.equal((await call("GET", base, undefined, user)).status, 200);
    assert.equal(
      (await call("POST", base, { title: "Denied", content: "x" }, user))
        .status,
      403,
    );
    const created = await call(
      "POST",
      base,
      { title: "Guide", content: "Original" },
      maintainer,
    );
    assert.equal(created.status, 201);
    const path = `${base}/${created.body.id}`;
    for (const suffix of ["", "/revisions", "/revisions/1"])
      assert.equal(
        (await call("GET", path + suffix, undefined, user)).status,
        200,
      );
    assert.equal(
      (await call("PATCH", path, { content: "Changed" }, maintainer, 1)).status,
      200,
    );
    assert.equal((await call("DELETE", path, undefined, user, 2)).status, 403);
    assert.equal(
      (await call("DELETE", path, undefined, maintainer, 2)).status,
      204,
    );
  }
});
test("demoted Users may withdraw only their own consent but cannot create reactions", async () => {
  const { call, create, maintainer, user } = await fixture();
  const t = (await create("Consent")).body;
  const base = `/projects/ROOT/items/${t.id}`;
  const comment = (
    await call("POST", `${base}/comments`, { content: "Decision" }, maintainer)
  ).body;
  const path = `${base}/comments/${comment.id}/reactions`;
  const reaction = (
    await call(
      "POST",
      path,
      { kind: "approval", commentVersion: 1 },
      maintainer,
    )
  ).body;
  await call(
    "POST",
    "/projects/ROOT/members",
    { principal: maintainer, role: "User" },
    undefined,
    1,
  );
  assert.equal(
    (
      await call(
        "POST",
        path,
        { kind: "acknowledgement", commentVersion: 1 },
        maintainer,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("DELETE", `${path}/${reaction.id}`, undefined, user, 1)).status,
    403,
  );
  await call("DELETE", base, undefined, undefined, 1);
  assert.equal(
    (await call("DELETE", `${path}/${reaction.id}`, undefined, maintainer, 1))
      .status,
    200,
  );
  assert.ok(
    (await call("GET", path, undefined, maintainer)).body.items[0].withdrawnAt,
  );
});
test("separate tabs cannot duplicate an active approval; withdrawn consent may be explicitly renewed", async () => {
  const { call, create, maintainer } = await fixture();
  const t = (await create("Consent")).body;
  const comment = (
    await call(
      "POST",
      `/projects/ROOT/items/${t.id}/comments`,
      { content: "Decision" },
      maintainer,
    )
  ).body;
  const path = `/projects/ROOT/items/${t.id}/comments/${comment.id}/reactions`;
  const results = await Promise.all([
    call("POST", path, { kind: "approval", commentVersion: 1 }, maintainer),
    call("POST", path, { kind: "approval", commentVersion: 1 }, maintainer),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const reaction = results.find((r) => r.status === 201)!.body;
  await call("DELETE", `${path}/${reaction.id}`, undefined, maintainer, 1);
  const renewed = await call(
    "POST",
    path,
    { kind: "approval", commentVersion: 1 },
    maintainer,
  );
  assert.equal(renewed.status, 201);
  assert.notEqual(renewed.body.id, reaction.id);
  assert.equal((await call("GET", path)).body.items.length, 2);
});
test("unrelated task edits survive lost dependency access while new links still require access", async () => {
  const { call, create, maintainer } = await fixture();
  await call("POST", "/projects", { slug: "OTHER", name: "Other" });
  await call("POST", "/projects/OTHER/members", {
    principal: maintainer,
    role: "User",
  });
  const i = (
    await call("POST", "/projects/OTHER/items", {
      kind: "Initiative",
      title: "I",
    })
  ).body;
  const e = (
    await call("POST", "/projects/OTHER/items", {
      kind: "Epic",
      title: "E",
      parentId: i.id,
    })
  ).body;
  const remote = (
    await call("POST", "/projects/OTHER/items", {
      kind: "Task",
      title: "Remote",
      parentId: e.id,
    })
  ).body;
  const task = (await create("Local", { dependencies: [remote.id] })).body;
  await call(
    "DELETE",
    `/projects/OTHER/members/${maintainer}`,
    undefined,
    undefined,
    1,
  );
  const path = `/projects/ROOT/items/${task.id}`;
  assert.equal(
    (await call("PATCH", path, { title: "Unrelated edit" }, maintainer, 1))
      .status,
    200,
  );
  assert.equal(
    (await call("PATCH", path, { dependencies: [remote.id] }, maintainer, 2))
      .status,
    404,
  );
  assert.equal(
    (await call("PATCH", path, { dependencies: [] }, maintainer, 2)).status,
    200,
  );
});

test("pre-upgrade idempotent retries retain original response and attribution without new writes", async () => {
  const { call, db, maintainer, e } = await fixture();
  const key = randomUUID(),
    body = { kind: "Task", title: "Legacy", parentId: e.id };
  const created = await call(
    "POST",
    "/projects/ROOT/items",
    body,
    maintainer,
    undefined,
    key,
  );
  const entry = [...db.rows.values()].find(
    (r) =>
      r.sk === "RESULT" &&
      (r.value as any).response?.body?.id === created.body.id,
  )!;
  const legacy = structuredClone(entry);
  delete (legacy.value as any).source;
  delete (legacy.value as any).response.body.attribution.source;
  (legacy.value as any).hash = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  db.rows.set(db.key(entry.pk, entry.sk), legacy);
  const count = db.rows.size;
  const repeated = await call(
    "POST",
    "/projects/ROOT/items",
    body,
    maintainer,
    undefined,
    key,
  );
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.id, created.body.id);
  assert.equal(repeated.body.attribution.source, undefined);
  assert.equal(db.rows.size, count);
  assert.equal(
    (
      await call(
        "POST",
        "/projects/ROOT/items",
        { ...body, title: "Changed" },
        maintainer,
        undefined,
        key,
      )
    ).status,
    409,
  );
});
