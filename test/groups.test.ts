import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Service } from "../src/api/service.js";
import { Conflict, MemoryStore, MemoryBlobs } from "../src/api/store.js";
import { MemoryDirectory } from "../src/groups/memory.js";
import { synchronize, ownership } from "../src/groups/sync.js";
import { groupName, type GroupSync } from "../src/groups/model.js";
import { CognitoDirectory } from "../src/groups/cognito.js";
const admin = "cognito:local-developer",
  member = "cognito:teammate",
  origin = "https://dnt.example.com";
async function fixture() {
  const db = new MemoryStore(),
    directory = new MemoryDirectory();
  const service = new Service(
    db,
    new MemoryBlobs(),
    [admin],
    directory,
    origin,
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
      userName: "Owner",
      agentName: "Group Agent",
      query,
      headers: {
        "idempotency-key": key,
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
  const create = await call("POST", "/projects", {
    slug: "ROOT",
    name: "Root",
  });
  assert.equal(create.status, 201);
  const sync = () => synchronize(db, directory, origin, "ROOT");
  const status = async () =>
    (await db.get<GroupSync>("PROJECT#ROOT", "GROUP_SYNC"))!.value;
  return { db, directory, service, call, sync, status };
}
test("groups follow create, grant, role change, revoke, and delete; access and audit are transactional", async () => {
  const f = await fixture();
  assert.equal((await f.status()).status, "pending");
  await f.sync();
  assert.deepEqual([...f.directory.groups.keys()].sort(), [
    "dnt-proj-ROOT-admin",
    "dnt-proj-ROOT-maintainer",
    "dnt-proj-ROOT-viewer",
  ]);
  assert.deepEqual(
    [...f.directory.groups.get(groupName("ROOT", "Administrator"))!.users],
    ["local-developer"],
  );
  const key = randomUUID();
  const body = { principal: member, role: "User" };
  assert.equal(
    (
      await f.call(
        "POST",
        "/projects/ROOT/members",
        body,
        admin,
        undefined,
        key,
      )
    ).status,
    201,
  );
  const generation = (await f.status()).generation;
  assert.equal(
    (await f.call("GET", "/projects/ROOT", undefined, member)).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "POST",
        "/projects/ROOT/members",
        body,
        admin,
        undefined,
        key,
      )
    ).status,
    201,
  );
  assert.equal(
    (await f.status()).generation,
    generation,
    "deduplication cannot enqueue twice",
  );
  await f.sync();
  assert.ok(
    f.directory.groups.get(groupName("ROOT", "User"))!.users.has("teammate"),
  );
  assert.equal(
    (
      await f.call(
        "POST",
        "/projects/ROOT/members",
        { principal: member, role: "Maintainer" },
        admin,
        1,
      )
    ).status,
    200,
  );
  await f.sync();
  assert.ok(
    !f.directory.groups.get(groupName("ROOT", "User"))!.users.has("teammate"),
  );
  assert.ok(
    f.directory.groups
      .get(groupName("ROOT", "Maintainer"))!
      .users.has("teammate"),
  );
  assert.equal(
    (
      await f.call(
        "DELETE",
        `/projects/ROOT/members/${member}`,
        undefined,
        admin,
        2,
      )
    ).status,
    204,
  );
  assert.equal(
    (await f.call("GET", "/projects/ROOT", undefined, member)).status,
    404,
  );
  await f.sync();
  assert.ok(
    !f.directory.groups
      .get(groupName("ROOT", "Maintainer"))!
      .users.has("teammate"),
  );
  assert.equal(
    (
      await f.call(
        "DELETE",
        `/projects/ROOT/members/${admin}`,
        undefined,
        admin,
        1,
      )
    ).status,
    409,
  );
  const events = (await f.call("GET", "/projects/ROOT/audit")).body.items;
  assert.ok(
    events.every((e: any) => e.attribution.agentName === "Group Agent"),
  );
  const current = (await f.call("GET", "/projects/ROOT")).body;
  assert.equal(
    (await f.call("DELETE", "/projects/ROOT", undefined, admin, 1)).status,
    412,
  );
  assert.equal(
    (
      await f.call(
        "DELETE",
        "/projects/ROOT",
        undefined,
        admin,
        current.version,
      )
    ).status,
    202,
  );
  for (const path of [
    "/projects/ROOT",
    "/projects/ROOT/items",
    "/projects/ROOT/members",
    "/projects/ROOT/docs/User",
  ])
    assert.equal((await f.call("GET", path)).status, 404);
  assert.equal((await f.call("GET", "/projects")).body.items.length, 0);
  const tombstones = await f.call(
    "GET",
    "/projects",
    undefined,
    admin,
    undefined,
    undefined,
    { includeDeleted: "true" },
  );
  assert.equal(tombstones.body.items[0].project, "ROOT");
  assert.ok(tombstones.body.items[0].deletedAt);
  assert.equal(
    (await f.call("POST", "/projects", { slug: "ROOT", name: "Reuse" })).status,
    409,
  );
  await f.sync();
  assert.equal(f.directory.groups.size, 0);
  assert.equal(
    (await f.call("GET", "/projects/ROOT/groups")).body.sync.status,
    "deleted",
  );
  const audit = await f.db.query<any>("PROJECT#ROOT", "AUDIT#", 100);
  assert.equal(audit.rows.at(-1)!.value.action, "project.deleted");
  assert.equal(audit.rows.at(-1)!.value.attribution.agentName, "Group Agent");
});
test("only project administrators can search or manage groups, and nonexistent accounts cannot be granted access", async () => {
  const f = await fixture();
  await f.call("POST", "/projects/ROOT/members", {
    principal: member,
    role: "User",
  });
  for (const principal of [member, "cognito:outsider"]) {
    for (const path of [
      "/projects/ROOT/users",
      "/projects/ROOT/groups",
      "/projects/ROOT/groups/Administrator/users",
    ]) {
      assert.equal(
        (await f.call("GET", path, undefined, principal)).status,
        principal === member ? 403 : 404,
      );
    }
    assert.equal(
      (
        await f.call(
          "POST",
          "/projects/ROOT/groups/reconcile",
          undefined,
          principal,
        )
      ).status,
      principal === member ? 403 : 404,
    );
    assert.equal(
      (await f.call("DELETE", "/projects/ROOT", undefined, principal, 1))
        .status,
      principal === member ? 403 : 404,
    );
  }
  const before = (await f.status()).generation;
  assert.equal(
    (
      await f.call("POST", "/projects/ROOT/members", {
        principal: "cognito:unknown",
        role: "User",
      })
    ).status,
    400,
  );
  assert.equal((await f.status()).generation, before);
  const first = await f.call(
    "GET",
    "/projects/ROOT/users",
    undefined,
    admin,
    undefined,
    undefined,
    { limit: "1" },
  );
  assert.equal(first.body.items.length, 1);
  assert.ok(first.body.nextCursor);
  const next = await f.call(
    "GET",
    "/projects/ROOT/users",
    undefined,
    admin,
    undefined,
    undefined,
    { limit: "1", cursor: first.body.nextCursor },
  );
  assert.notEqual(first.body.items[0].principal, next.body.items[0].principal);
  assert.equal(
    (
      await f.call(
        "GET",
        "/projects/ROOT/users",
        undefined,
        admin,
        undefined,
        undefined,
        { limit: "61" },
      )
    ).status,
    400,
  );
});
test("partial Cognito failures retry idempotently and external membership edits converge to dnt assignments", async () => {
  const f = await fixture();
  const original = f.directory.createGroup.bind(f.directory);
  let fail = true;
  f.directory.createGroup = async (name, description) => {
    if (name.endsWith("-viewer") && fail) {
      fail = false;
      throw new Error("SDK secret error detail");
    }
    return original(name, description);
  };
  await assert.rejects(f.sync(), /GroupSynchronizationFailed/);
  assert.equal(f.directory.groups.size, 2);
  assert.equal((await f.status()).status, "error");
  assert.ok(!(await f.status()).error?.includes("secret"));
  await f.sync();
  assert.equal((await f.status()).status, "ready");
  await f.directory.addUser(groupName("ROOT", "Administrator"), "teammate");
  assert.equal(
    (await f.call("GET", "/projects/ROOT", undefined, member)).status,
    404,
  );
  await f.call("POST", "/projects/ROOT/groups/reconcile");
  await f.sync();
  assert.ok(
    !f.directory.groups
      .get(groupName("ROOT", "Administrator"))!
      .users.has("teammate"),
  );
});
test("name collisions never adopt or delete another application's group, including groups with IAM roles", async () => {
  for (const roleArn of [undefined, "arn:aws:iam::123456789012:role/other"]) {
    const f = await fixture();
    const name = groupName("ROOT", "User");
    f.directory.groups.set(name, {
      name,
      description: roleArn
        ? ownership(origin, "ROOT", "User")
        : "owned by another service",
      roleArn,
      users: new Set(["teammate"]),
    });
    await assert.rejects(f.sync(), /GroupOwnershipConflict/);
    assert.equal(f.directory.groups.size, 1);
    assert.equal(
      (await f.call("GET", "/projects/ROOT/groups/User/users")).status,
      409,
    );
    const current = (await f.call("GET", "/projects/ROOT")).body;
    await f.call("DELETE", "/projects/ROOT", undefined, admin, current.version);
    await assert.rejects(f.sync(), /GroupOwnershipConflict/);
    assert.ok(f.directory.groups.get(name)!.users.has("teammate"));
  }
});
test("an in-flight old sync cannot mark a newer request complete or recreate a deleted project", async () => {
  const f = await fixture();
  const original = f.directory.createGroup.bind(f.directory);
  let changed = false;
  f.directory.createGroup = async (name, description) => {
    if (!changed) {
      changed = true;
      const project = (await f.call("GET", "/projects/ROOT")).body;
      assert.equal(
        (
          await f.call(
            "DELETE",
            "/projects/ROOT",
            undefined,
            admin,
            project.version,
          )
        ).status,
        202,
      );
    }
    await original(name, description);
  };
  await f.sync();
  assert.equal((await f.status()).status, "pending");
  await f.sync();
  assert.equal((await f.status()).status, "deleted");
  assert.equal(f.directory.groups.size, 0);
});
test("Cognito adapter verifies immutable subjects, escapes directory filters, and preserves cursors", async () => {
  const calls: any[] = [];
  const sub = "11111111-1111-4111-8111-111111111111";
  const client = {
    send: async (command: any) => {
      calls.push(command);
      if (command.constructor.name === "AdminGetUserCommand")
        return {
          Username: "owner",
          UserAttributes: [
            { Name: "sub", Value: sub },
            { Name: "name", Value: "Owner" },
          ],
          Enabled: true,
        };
      return { Users: [], PaginationToken: "page2" };
    },
  };
  const directory = new CognitoDirectory("pool", client as any);
  assert.equal((await directory.resolve(`cognito:${sub}`))?.username, "owner");
  assert.equal(
    await directory.resolve("cognito:11111111-1111-4111-8111-111111111112"),
    undefined,
  );
  const page = await directory.users('a"\\b', 2, "page1");
  assert.equal(page.nextCursor, "page2");
  assert.equal(calls.at(-1).input.Filter, 'email ^= "a\\"\\\\b"');
  assert.equal(calls.at(-1).input.PaginationToken, "page1");
});

test("transient storage conflicts preserve stream retries for the same generation", async () => {
  const f = await fixture();
  const commit = f.db.commit.bind(f.db);
  let fail = true;
  f.db.commit = async (writes, checks) => {
    if (fail) {
      fail = false;
      throw new Conflict();
    }
    await commit(writes, checks);
  };
  await assert.rejects(f.sync(), /GroupSynchronizationConflict/);
  assert.equal((await f.status()).status, "pending");
  await f.sync();
  assert.equal((await f.status()).status, "ready");
});

test("a recreated Cognito username does not inherit the deleted account's group assignment", async () => {
  const f = await fixture();
  await f.call("POST", "/projects/ROOT/members", {
    principal: member,
    role: "User",
  });
  await f.sync();
  const previous = f.directory.accounts.get(member)!;
  f.directory.accounts.delete(member);
  f.directory.accounts.set("cognito:replacement", {
    ...previous,
    principal: "cognito:replacement",
  });
  await f.call("POST", "/projects/ROOT/groups/reconcile");
  await f.sync();
  assert.equal((await f.status()).missingUsers, 1);
  assert.equal(
    f.directory.groups.get(groupName("ROOT", "User"))!.users.size,
    0,
  );
});
