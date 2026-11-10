import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "../infra/config.js";
import { aws, verifyAccount } from "./aws.js";
import { DynamoStore } from "../src/api/aws-store.js";
import { MemoryBlobs, type Store } from "../src/api/store.js";
import { Service } from "../src/api/service.js";
import { CognitoDirectory } from "../src/groups/cognito.js";
import { projectGroups, type GroupSync } from "../src/groups/model.js";
const config = loadConfig();
verifyAccount(config.account);
process.env.AWS_REGION = config.region;
const table = aws([
  "cloudformation",
  "describe-stacks",
  "--region",
  config.region,
  "--stack-name",
  "dnt-data",
  "--query",
  "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue | [0]",
]);
const db = new DynamoStore(table);
const directory = new CognitoDirectory(config.cognitoPoolId);
const slug = `GS${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
const actor = `iam:arn:aws:iam::${config.account}:role/dnt-group-smoke-${slug}`;
const user = await directory.resolve(
  config.projectCreators.find((p) => p.startsWith("cognito:"))!,
);
assert.ok(user, "Configured operator must exist in Cognito");
assert.equal(await db.get(`PROJECT#${slug}`, "META"), undefined);
for (const group of projectGroups(slug))
  assert.equal(await directory.group(group.name), undefined);
const records = new Map<string, { pk: string; sk: string }>();
const store: Store = {
  get: <T>(pk: string, sk: string) => db.get<T>(pk, sk),
  query: <T>(pk: string, prefix: string, limit: number, after?: string) =>
    db.query<T>(pk, prefix, limit, after),
  async commit(writes, checks) {
    for (const { row } of writes)
      records.set(JSON.stringify([row.pk, row.sk]), { pk: row.pk, sk: row.sk });
    await db.commit(writes, checks);
  },
};
// The in-process test service uses real storage and directory adapters; the
// deployed stream worker processes its outbox. This is not an HTTP identity.
const service = new Service(
  store,
  new MemoryBlobs(),
  [actor],
  directory,
  `https://${config.domain}`,
);
const call = (method: string, path: string, body?: unknown, version?: number) =>
  service.handle({
    method,
    path: `/api/v1${path}`,
    body,
    principal: actor,
    userName: "Group Smoke Test",
    agentName: "Deployment Verification",
    headers: {
      "idempotency-key": randomUUID(),
      ...(version ? { "if-match": `"${version}"` } : {}),
    },
  });
async function waitFor(status: string) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const row = await db.get<GroupSync>(`PROJECT#${slug}`, "GROUP_SYNC");
    if (row?.value.status === status) return;
    if (row?.value.status === "error") throw new Error(row.value.error);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error(
    `Timed out waiting for ${slug} synchronization to become ${status}`,
  );
}
let created = false;
try {
  assert.equal(
    (
      await call("POST", "/projects", {
        slug,
        name: "Temporary group deployment verification",
      })
    ).status,
    201,
  );
  created = true;
  await waitFor("ready");
  console.log(`${slug}: deployed worker created all three groups`);
  assert.ok(
    (await call("GET", `/projects/${slug}/groups`)).body.groups.every(
      (g: any) => g.exists && g.owned,
    ),
  );
  assert.equal(
    (
      await call("POST", `/projects/${slug}/members`, {
        principal: user.principal,
        role: "User",
      })
    ).status,
    201,
  );
  await waitFor("ready");
  assert.equal(
    (await directory.groupUsers(`dnt-proj-${slug}-viewer`, 60)).items[0]
      ?.principal,
    user.principal,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/projects/${slug}/members`,
        { principal: user.principal, role: "Maintainer" },
        1,
      )
    ).status,
    200,
  );
  await waitFor("ready");
  assert.equal(
    (await directory.groupUsers(`dnt-proj-${slug}-viewer`, 60)).items.length,
    0,
  );
  assert.equal(
    (await directory.groupUsers(`dnt-proj-${slug}-maintainer`, 60)).items[0]
      ?.principal,
    user.principal,
  );
  assert.equal(
    (
      await call(
        "DELETE",
        `/projects/${slug}/members/${user.principal}`,
        undefined,
        2,
      )
    ).status,
    204,
  );
  await waitFor("ready");
  assert.equal(
    (await directory.groupUsers(`dnt-proj-${slug}-maintainer`, 60)).items
      .length,
    0,
  );
  console.log(`${slug}: grants, role changes, and removals synchronized`);
} finally {
  if (created) {
    try {
      const current = await db.get<any>(`PROJECT#${slug}`, "META");
      if (!current?.value.deletedAt)
        assert.equal(
          (
            await call(
              "DELETE",
              `/projects/${slug}`,
              undefined,
              current!.version,
            )
          ).status,
          202,
        );
      else await call("POST", `/projects/${slug}/groups/reconcile`);
      await waitFor("deleted");
      for (const group of projectGroups(slug))
        assert.equal(await directory.group(group.name), undefined);
      assert.equal((await call("GET", `/projects/${slug}`)).status, 404);
      assert.equal((await call("GET", "/projects")).body.items.length, 0);
      for (const key of records.values())
        await db.client.send(
          new DeleteCommand({ TableName: db.table, Key: key }),
        );
      console.log(
        `${slug}: deletion verified; temporary records and groups cleaned up`,
      );
    } catch (error) {
      console.error(
        `Temporary project ${slug} retained for cleanup; inspect GROUP_SYNC and retry reconciliation.`,
      );
      throw error;
    }
  }
}
