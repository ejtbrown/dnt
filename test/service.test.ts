import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Service, type Request } from "../src/api/service.js";
import { MemoryStore, MemoryBlobs } from "../src/api/store.js";

const admin = "cognito:operator";
const user = "cognito:member";
const maintainer = "cognito:maintainer";
async function setup() {
  const db = new MemoryStore();
  const blobs = new MemoryBlobs();
  const service = new Service(db, blobs, [admin]);
  const request = (
    method: string,
    path: string,
    body?: unknown,
    principal = admin,
    version?: number,
    key = randomUUID(),
    query?: Request["query"],
  ) =>
    service.handle({
      method,
      path: `/api/v1${path}`,
      principal,
      body,
      query,
      headers: {
        "idempotency-key": key,
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
  await request("POST", "/projects", { slug: "ROOT", name: "Root" });
  await request("POST", "/projects/ROOT/members", {
    principal: user,
    role: "User",
  });
  await request("POST", "/projects/ROOT/members", {
    principal: maintainer,
    role: "Maintainer",
  });
  const initiative = (
    await request("POST", "/projects/ROOT/items", {
      kind: "Initiative",
      title: "First initiative",
    })
  ).body;
  const epic = (
    await request("POST", "/projects/ROOT/items", {
      kind: "Epic",
      title: "First epic",
      parentId: initiative.id,
    })
  ).body;
  return { db, blobs, service, request, initiative, epic };
}
test("project creators do not gain automatic access to other projects", async () => {
  const { request } = await setup();
  assert.equal(
    (await request("POST", "/projects", { slug: "AB", name: "B" }, user))
      .status,
    403,
  );
  assert.equal(
    (await request("GET", "/projects/ROOT", undefined, "cognito:outsider"))
      .status,
    404,
  );
  assert.deepEqual(
    (await request("GET", "/projects", undefined, "cognito:outsider")).body
      .items,
    [],
  );
});
test("all work item types share a project sequence, with typed parents", async () => {
  const { request, initiative, epic } = await setup();
  assert.equal(initiative.id, "ROOT-1");
  assert.equal(epic.id, "ROOT-2");
  const task = await request(
    "POST",
    "/projects/ROOT/items",
    { kind: "Task", title: "Task", parentId: epic.id },
    user,
  );
  assert.equal(task.status, 201);
  assert.equal(task.body.id, "ROOT-3");
  assert.equal(task.body.state, "Concept");
  assert.equal(
    (
      await request("POST", "/projects/ROOT/items", {
        kind: "Task",
        title: "Bad",
        parentId: initiative.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("POST", "/projects/ROOT/items", {
        kind: "Epic",
        title: "Bad",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("POST", "/projects/ROOT/items", {
        kind: "Initiative",
        title: "Bad",
        state: "Done",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/projects/ROOT/items",
        { kind: "Epic", title: "Forbidden", parentId: initiative.id },
        user,
      )
    ).status,
    403,
  );
});
test("parallel creates allocate distinct ordered identifiers and retries are idempotent", async () => {
  const { request, epic } = await setup();
  const body = { kind: "Task", title: "Concurrent", parentId: epic.id };
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      request("POST", "/projects/ROOT/items", body),
    ),
  );
  assert.ok(
    responses.every((r) => r.status === 201),
    JSON.stringify(responses),
  );
  assert.equal(new Set(responses.map((r) => r.body.id)).size, 6);
  const key = randomUUID();
  const repeat = await Promise.all(
    Array.from({ length: 3 }, () =>
      request("POST", "/projects/ROOT/items", body, admin, undefined, key),
    ),
  );
  assert.ok(repeat.every((r) => r.status === 201));
  assert.equal(new Set(repeat.map((r) => r.body.id)).size, 1);
  assert.equal(
    (
      await request(
        "POST",
        "/projects/ROOT/items",
        { ...body, title: "Different" },
        admin,
        undefined,
        key,
      )
    ).status,
    409,
  );
});
test("all five task states are accepted and stale updates do not overwrite changes", async () => {
  const { request, epic } = await setup();
  let task = (
    await request("POST", "/projects/ROOT/items", {
      kind: "Task",
      title: "Workflow",
      parentId: epic.id,
    })
  ).body;
  assert.equal(
    (
      await request("PATCH", `/projects/ROOT/items/${task.id}`, {
        state: "Done",
      })
    ).status,
    428,
  );
  for (const state of [
    "Implement",
    "Needs Attention",
    "Review",
    "Done",
    "Concept",
  ]) {
    const result = await request(
      "PATCH",
      `/projects/ROOT/items/${task.id}`,
      { state },
      user,
      task.version,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.state, state);
    task = result.body;
  }
  assert.equal(
    (
      await request(
        "PATCH",
        `/projects/ROOT/items/${task.id}`,
        { title: "Stale overwrite" },
        user,
        1,
      )
    ).status,
    412,
  );
  assert.equal(
    (
      await request(
        "PATCH",
        `/projects/ROOT/items/${task.id}`,
        { state: "In Progress" },
        user,
        task.version,
      )
    ).status,
    400,
  );
});
test("cross-project parents, item IDs, and non-member assignments are rejected", async () => {
  const { request, epic } = await setup();
  await request("POST", "/projects", { slug: "OTHER", name: "Other" });
  assert.equal(
    (
      await request("POST", "/projects/OTHER/items", {
        kind: "Task",
        title: "Wrong project",
        parentId: epic.id,
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("GET", `/projects/OTHER/items/${epic.id}`)).status,
    404,
  );
  assert.equal(
    (
      await request("POST", "/projects/ROOT/items", {
        kind: "Task",
        title: "Wrong assignee",
        parentId: epic.id,
        assignee: "cognito:outsider",
      })
    ).status,
    400,
  );
});
test("tree visibility and writes follow project roles; no privilege fields are accepted", async () => {
  const { request } = await setup();
  assert.equal(
    (await request("GET", "/projects/ROOT/docs/Administrator", undefined, user))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/projects/ROOT/docs/Administrator",
        undefined,
        maintainer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/projects/ROOT/docs/Maintainer",
        { title: "Guide", content: "# Hello" },
        maintainer,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/projects/ROOT/docs/User",
        { title: "Guide", content: "# Hello" },
        user,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/projects/ROOT/members",
        { principal: user, role: "Administrator" },
        user,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("POST", "/projects/ROOT/docs/User", {
        title: "Guide",
        content: "",
        objectKey: "someone-elses-file",
      })
    ).status,
    400,
  );
});
test("document revisions preserve content and cannot move across trees", async () => {
  const { request, blobs } = await setup();
  const page = (
    await request("POST", "/projects/ROOT/docs/User", {
      title: "Guide",
      content: "# First",
    })
  ).body;
  const update = await request(
    "PATCH",
    `/projects/ROOT/docs/User/${page.id}`,
    { content: "# Second" },
    user,
    1,
  );
  assert.equal(update.status, 200);
  assert.notEqual(update.body.objectKey, page.objectKey);
  assert.equal(
    (await request("GET", `/projects/ROOT/docs/User/${page.id}/revisions/1`))
      .body.content,
    "# First",
  );
  assert.equal(
    (await request("GET", `/projects/ROOT/docs/User/${page.id}`)).body.content,
    "# Second",
  );
  assert.equal(
    (await request("GET", `/projects/ROOT/docs/User/${page.id}/revisions`)).body
      .items.length,
    2,
  );
  assert.equal(
    (
      await request("POST", "/projects/ROOT/docs/Maintainer", {
        title: "Wrong tree",
        content: "",
        parentId: page.id,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "PATCH",
        `/projects/ROOT/docs/User/${page.id}`,
        { parentId: page.id },
        admin,
        2,
      )
    ).status,
    400,
  );
  assert.equal(blobs.objects.size, 2);
});
test("a failed blob upload leaves no document pointer or revision", async () => {
  const { request, blobs } = await setup();
  blobs.put = async () => {
    throw new Error("Storage unavailable");
  };
  const result = await request("POST", "/projects/ROOT/docs/User", {
    title: "Fails safely",
    content: "Text",
  });
  assert.equal(result.status, 500);
  assert.equal(
    (await request("GET", "/projects/ROOT/docs/User")).body.items.length,
    0,
  );
});
test("administrators cannot remove or demote the final administrator, even concurrently", async () => {
  const { request } = await setup();
  assert.equal(
    (
      await request(
        "DELETE",
        `/projects/ROOT/members/${encodeURIComponent(admin)}`,
        undefined,
        admin,
        1,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/projects/ROOT/members",
        { principal: admin, role: "User" },
        admin,
        1,
      )
    ).status,
    409,
  );
  await request(
    "POST",
    "/projects/ROOT/members",
    { principal: maintainer, role: "Administrator" },
    admin,
    1,
  );
  const responses = await Promise.all([
    request(
      "DELETE",
      `/projects/ROOT/members/${encodeURIComponent(admin)}`,
      undefined,
      admin,
      1,
    ),
    request(
      "DELETE",
      `/projects/ROOT/members/${encodeURIComponent(maintainer)}`,
      undefined,
      maintainer,
      2,
    ),
  ]);
  assert.equal(responses.filter((r) => r.status === 204).length, 1);
  const survivor = responses[0].status === 204 ? maintainer : admin;
  const project = (await request("GET", "/projects/ROOT", undefined, survivor))
    .body;
  assert.equal(project.administrators, 1);
});
test("revoked permissions are checked even when replaying idempotent requests", async () => {
  const { request, epic } = await setup();
  const key = randomUUID();
  const body = { kind: "Task", title: "T", parentId: epic.id };
  await request("POST", "/projects/ROOT/items", body, user, undefined, key);
  await request(
    "DELETE",
    `/projects/ROOT/members/${encodeURIComponent(user)}`,
    undefined,
    admin,
    1,
  );
  assert.equal(
    (await request("POST", "/projects/ROOT/items", body, user, undefined, key))
      .status,
    404,
  );
});
test("pagination is bounded, scoped, and exposes all records without scans", async () => {
  const { request } = await setup();
  const first = await request(
    "GET",
    "/projects/ROOT/items",
    undefined,
    user,
    undefined,
    undefined,
    { limit: "1" },
  );
  assert.equal(first.body.items.length, 1);
  assert.ok(first.body.nextCursor);
  const next = await request(
    "GET",
    "/projects/ROOT/items",
    undefined,
    user,
    undefined,
    undefined,
    { limit: "1", cursor: first.body.nextCursor },
  );
  assert.equal(next.body.items.length, 1);
  assert.notEqual(next.body.items[0].id, first.body.items[0].id);
  assert.equal(
    (
      await request(
        "GET",
        "/projects/ROOT/items",
        undefined,
        user,
        undefined,
        undefined,
        { cursor: "MEMBER#" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/projects/ROOT/items",
        undefined,
        user,
        undefined,
        undefined,
        { limit: "1000" },
      )
    ).status,
    400,
  );
});

test("removing an assignee does not block unrelated task updates", async () => {
  const { request, epic } = await setup();
  const task = (
    await request("POST", "/projects/ROOT/items", {
      kind: "Task",
      title: "Keep working",
      parentId: epic.id,
      assignee: user,
    })
  ).body;
  await request(
    "DELETE",
    `/projects/ROOT/members/${encodeURIComponent(user)}`,
    undefined,
    admin,
    1,
  );
  const update = await request(
    "PATCH",
    `/projects/ROOT/items/${task.id}`,
    { state: "Review" },
    admin,
    1,
  );
  assert.equal(update.status, 200);
  assert.equal(update.body.assignee, user);
  assert.equal(
    (
      await request(
        "PATCH",
        `/projects/ROOT/items/${task.id}`,
        { assignee: "cognito:outsider" },
        admin,
        2,
      )
    ).status,
    400,
  );
});
