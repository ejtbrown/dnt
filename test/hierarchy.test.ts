import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Service } from "../src/api/service.js";
import { MemoryStore, MemoryBlobs } from "../src/api/store.js";
import { MemoryDirectory } from "../src/groups/memory.js";

async function fixture() {
  const principal = "cognito:admin";
  const db = new MemoryStore();
  const service = new Service(
    db,
    new MemoryBlobs(),
    new MemoryDirectory(true, [principal]),
  );
  const call = (
    method: string,
    path: string,
    body?: unknown,
    version?: number,
    who = principal,
    key = randomUUID(),
    query?: Record<string, string>,
  ) =>
    service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal: who,
      origin: "web",
      query,
      headers: {
        "idempotency-key": key,
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
  await call("POST", "/projects", { slug: "ROOT", name: "Root" });
  const create = async (kind: string, parentId?: string, extra = {}) => {
    const r = await call("POST", "/projects/ROOT/items", {
      kind,
      title: kind,
      parentId,
      ...extra,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const get = async (id: string) =>
    (await call("GET", `/projects/ROOT/items/${id}`)).body;
  return { db, call, create, get };
}
test("hierarchy state derives descendant tasks, ignores empty branches and deleted tasks", async () => {
  const { create, call, get } = await fixture();
  const i = await create("Initiative"),
    e = await create("Epic", i.id);
  await create("Epic", i.id);
  assert.equal((await get(i.id)).state, "Concept");
  const a = await create("Task", e.id),
    b = await create("Task", e.id);
  assert.equal((await get(e.id)).state, "Concept");
  await call("PATCH", `/projects/ROOT/items/${a.id}`, { state: "Done" }, 1);
  assert.equal((await get(e.id)).state, "Implement");
  await call("PATCH", `/projects/ROOT/items/${b.id}`, { state: "Done" }, 1);
  assert.equal((await get(i.id)).state, "Done");
  await call(
    "PATCH",
    `/projects/ROOT/items/${b.id}`,
    { state: "Cancelled" },
    2,
  );
  assert.equal((await get(i.id)).state, "Implement");
  await call("DELETE", `/projects/ROOT/items/${b.id}`, undefined, 3);
  assert.equal((await get(i.id)).state, "Done");
  assert.equal(
    (await call("PATCH", `/projects/ROOT/items/${e.id}`, { state: "Done" }, 1))
      .status,
    400,
  );
});
test("aggregate list reads all descendant pages and detects concurrent mutation", async () => {
  const { db, create, call } = await fixture();
  const i = await create("Initiative"),
    e = await create("Epic", i.id);
  for (let n = 0; n < 101; n++)
    await create("Task", e.id, { state: n === 100 ? "Done" : "Concept" });
  const result = await call(
    "GET",
    "/projects/ROOT/items",
    undefined,
    undefined,
    undefined,
    undefined,
    { limit: "1" },
  );
  assert.equal(result.body.items[0].state, "Implement");
  assert.ok(result.body.nextCursor);
  const original = db.query.bind(db);
  let fired = false;
  db.query = async <T>(...args: Parameters<typeof db.query>) => {
    const page = await original<T>(...args);
    if (!fired && args[1] === "ITEM#") {
      fired = true;
      const meta = await db.get<any>("PROJECT#ROOT", "META");
      if (meta)
        await db.commit([
          {
            row: {
              ...meta,
              version: meta.version + 1,
              value: { ...meta.value, version: meta.version + 1 },
            },
            expected: meta.version,
          },
        ]);
    }
    return page;
  };
  const race = await call("GET", `/projects/ROOT/items/${i.id}`);
  assert.equal(race.status, 409);
});
test("all kinds accept relationships, cycles remain rejected and access checked", async () => {
  const { create, call } = await fixture();
  const a = await create("Initiative"),
    b = await create("Initiative", undefined, { dependencies: [a.id] }),
    e = await create("Epic", b.id, { relatedTasks: [a.id] });
  assert.deepEqual(e.relatedTasks, [a.id]);
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${a.id}`,
        { dependencies: [b.id] },
        1,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${e.id}`,
        { dependencies: [e.id] },
        1,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${e.id}`,
        { dueDate: "2026-12-31" },
        1,
      )
    ).status,
    400,
  );
});
test("explicit ordinals preserve gaps and high water mark, collision and deleted IDs never reused", async () => {
  const { call, create } = await fixture();
  const i = await create("Initiative", undefined, { ordinal: 100 });
  const e = await create("Epic", i.id, { ordinal: 2 });
  assert.equal(e.id, "ROOT-2");
  assert.equal((await create("Task", e.id)).id, "ROOT-101");
  const input = {
    kind: "Task",
    title: "Imported",
    parentId: e.id,
    ordinal: 10,
  };
  const key = randomUUID();
  const first = await call(
    "POST",
    "/projects/ROOT/items",
    input,
    undefined,
    undefined,
    key,
  );
  assert.equal(first.status, 201);
  assert.deepEqual(
    await call(
      "POST",
      "/projects/ROOT/items",
      input,
      undefined,
      undefined,
      key,
    ),
    first,
  );
  assert.equal((await call("POST", "/projects/ROOT/items", input)).status, 409);
  await call("DELETE", "/projects/ROOT/items/ROOT-10", undefined, 1);
  assert.equal((await call("POST", "/projects/ROOT/items", input)).status, 409);
  await call("POST", "/projects/ROOT/members", {
    principal: "cognito:reader",
    role: "User",
  });
  assert.equal(
    (
      await call(
        "POST",
        "/projects/ROOT/items",
        { ...input, ordinal: 11 },
        undefined,
        "cognito:reader",
      )
    ).status,
    403,
  );
  for (const ordinal of [0, -1, 1.5, 1000000000000])
    assert.equal(
      (await call("POST", "/projects/ROOT/items", { ...input, ordinal }))
        .status,
      400,
    );
});

test("concurrent requested ordinals allocate once and automatic overflow is rejected", async () => {
  const { call, create } = await fixture();
  const i = await create("Initiative"),
    e = await create("Epic", i.id);
  const input = { kind: "Task", title: "Exact", parentId: e.id, ordinal: 50 };
  const results = await Promise.all([
    call("POST", "/projects/ROOT/items", input),
    call("POST", "/projects/ROOT/items", input),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  await create("Task", e.id, { ordinal: 999999999999 });
  assert.equal(
    (
      await call("POST", "/projects/ROOT/items", {
        kind: "Task",
        title: "Overflow",
        parentId: e.id,
      })
    ).status,
    409,
  );
});

test("cross-kind dependency cycles serialize and hierarchy moves immediately recompute", async () => {
  const { create, call, get } = await fixture();
  const i = await create("Initiative"),
    e = await create("Epic", i.id),
    e2 = await create("Epic", i.id);
  const t = await create("Task", e.id, { state: "Done" });
  const outcomes = await Promise.all([
    call("PATCH", `/projects/ROOT/items/${i.id}`, { dependencies: [t.id] }, 1),
    call("PATCH", `/projects/ROOT/items/${t.id}`, { dependencies: [i.id] }, 1),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 200).length, 1);
  assert.ok(outcomes.some((r) => r.status === 400 || r.status === 409));
  const current = await get(t.id);
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${t.id}`,
        { parentId: e2.id },
        current.version,
      )
    ).status,
    200,
  );
  assert.equal((await get(e.id)).state, "Concept");
  assert.equal((await get(e2.id)).state, "Done");
  assert.equal((await get(i.id)).state, "Done");
  assert.equal(
    (
      await call(
        "PATCH",
        `/projects/ROOT/items/${e.id}`,
        { relatedTasks: ["OTHER-1"] },
        1,
      )
    ).status,
    404,
  );
});
