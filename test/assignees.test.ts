import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, admin } from "./mcp-fixtures.js";
test("assignees reveals only current project member names/IDs to writers", async () => {
  const f = fixture();
  const call = (
    method: string,
    path: string,
    body?: unknown,
    who = admin,
    query?: Record<string, string>,
  ) =>
    f.service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal: who,
      query,
      headers: { "idempotency-key": randomUUID() },
    });
  await call("POST", "/projects", { slug: "PICK", name: "Picker" });
  for (const [principal, role] of [
    ["cognito:writer", "Maintainer"],
    ["cognito:reader", "User"],
  ])
    await call("POST", "/projects/PICK/members", { principal, role });
  const r = await call(
    "GET",
    "/projects/PICK/assignees",
    undefined,
    "cognito:writer",
    { limit: "1" },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.ok(r.body.nextCursor);
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ["name", "principal"]);
  assert.equal(
    (await call("GET", "/projects/PICK/members", undefined, "cognito:writer"))
      .status,
    403,
  );
  assert.equal(
    (await call("GET", "/projects/PICK/assignees", undefined, "cognito:reader"))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        "GET",
        "/projects/PICK/assignees",
        undefined,
        "cognito:outsider",
      )
    ).status,
    404,
  );
  assert.notEqual(
    (await call("POST", "/projects/PICK/assignees", {})).status,
    200,
  );
});
