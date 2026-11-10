import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, admin, member } from "./mcp-fixtures.js";
import {
  documentReference,
  isPublicDocumentRequest,
} from "../src/shared/links.js";
import { roles } from "../src/shared/model.js";

function setup() {
  const f = fixture();
  const request = (
    method: string,
    path: string,
    body?: unknown,
    version?: number,
    principal = admin,
  ) =>
    f.service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal,
      userName: "Owner",
      agentName: "Link Agent",
      headers: {
        "idempotency-key": randomUUID(),
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
  return { ...f, request };
}
test("direct links resolve across projects; publication exposes only current content and revokes immediately", async () => {
  const { request } = setup();
  await request("POST", "/projects", { slug: "AA", name: "First" });
  await request("POST", "/projects", { slug: "BB", name: "Second" });
  await request("POST", "/projects/BB/members", {
    principal: member,
    role: "User",
  });
  let parentId: string | undefined;
  for (const kind of ["Initiative", "Epic", "Task"]) {
    const result = await request("POST", "/projects/BB/items", {
      kind,
      title: kind,
      parentId,
    });
    assert.equal(result.status, 201);
    parentId = result.body.id;
    assert.equal(new URL(result.body.url).pathname, `/t/${parentId}`);
  }
  for (const tree of roles) {
    const doc = (
      await request("POST", `/projects/BB/docs/${tree}`, {
        title: "Guide",
        content: "# Private revision",
      })
    ).body;
    const path = `/projects/BB/docs/${tree}/${doc.id}`;
    const reference = documentReference(tree, doc.id);
    const publicPath = `/public/documents/${reference}`;
    assert.equal(new URL(doc.url).pathname, `/d/${reference}`);
    assert.equal(doc.public, false);
    assert.equal(
      (await request("GET", `/documents/${reference}`)).body.project,
      "BB",
    );
    assert.equal(
      (await request("GET", publicPath, undefined, undefined, "")).status,
      404,
    );
    assert.equal(
      (
        await request(
          "GET",
          `/documents/${reference}`,
          undefined,
          undefined,
          "",
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          "GET",
          `/documents/${reference}`,
          undefined,
          undefined,
          member,
        )
      ).status,
      tree === "User" ? 200 : 403,
    );
    const published = await request(
      "PATCH",
      path,
      { public: true, content: "# Public revision" },
      1,
    );
    assert.equal(published.status, 200);
    assert.equal(
      (await request("PATCH", path, { title: "Renamed" }, 2)).body.public,
      true,
    );
    const visible = await request("GET", publicPath, undefined, undefined, "");
    assert.equal(visible.status, 200);
    assert.equal(visible.headers?.["cache-control"], "no-store");
    assert.deepEqual(
      Object.keys(visible.body).sort(),
      ["id", "tree", "title", "content", "updatedAt", "public", "url"].sort(),
    );
    assert.equal(visible.body.content, "# Public revision");
    assert.equal(visible.body.title, "Renamed");
    for (const suffix of ["/revisions", "/revisions/1", "/compare"])
      assert.equal(
        (await request("GET", publicPath + suffix, undefined, undefined, ""))
          .status,
        401,
      );
    assert.equal(
      (
        await request(
          "GET",
          `${path}/revisions/1`,
          undefined,
          undefined,
          member,
        )
      ).status,
      tree === "User" ? 200 : 403,
    );
    assert.equal(
      (await request("PATCH", path, { public: false }, 1)).status,
      412,
    );
    await request("PATCH", path, { public: false }, 3);
    assert.equal(
      (await request("GET", publicPath, undefined, undefined, "")).status,
      404,
    );
    assert.equal(
      (
        await request(
          "GET",
          `/documents/${reference.replace(/^[^-]+/, "bogus")}`,
        )
      ).status,
      404,
    );
  }
  for (const path of ["/projects", "/public/documents", "/me"])
    assert.equal(
      (await request("GET", path, undefined, undefined, "")).status,
      401,
    );
  for (const method of ["POST", "PATCH", "DELETE"])
    assert.equal(
      (
        await request(
          method,
          "/public/documents/user-example",
          {},
          undefined,
          "",
        )
      ).status,
      401,
    );
});

test("page deletion enforces tree permissions, versions and child safety, revoking all links and history", async () => {
  const { request, serviceDb } = setup();
  await request("POST", "/projects", { slug: "AA", name: "First" });
  await request("POST", "/projects/AA/members", {
    principal: member,
    role: "User",
  });
  const parent = (
    await request("POST", "/projects/AA/docs/Maintainer", {
      title: "Parent",
      content: "Parent",
      public: true,
    })
  ).body;
  const child = (
    await request("POST", "/projects/AA/docs/Maintainer", {
      title: "Child",
      content: "Child",
      parentId: parent.id,
    })
  ).body;
  const path = `/projects/AA/docs/Maintainer/${parent.id}`;
  assert.equal(
    (await request("DELETE", path, undefined, 1, member)).status,
    403,
  );
  assert.equal((await request("DELETE", path)).status, 428);
  assert.equal((await request("DELETE", path, undefined, 2)).status, 412);
  assert.equal((await request("DELETE", path, undefined, 1)).status, 409);
  assert.equal(
    (
      await request(
        "DELETE",
        `/projects/AA/docs/Maintainer/${child.id}`,
        undefined,
        1,
      )
    ).status,
    204,
  );
  assert.equal((await request("DELETE", path, undefined, 1)).status, 204);
  const reference = documentReference("Maintainer", parent.id);
  for (const endpoint of [
    path,
    `${path}/revisions`,
    `${path}/revisions/1`,
    `/documents/${reference}`,
    `/public/documents/${reference}`,
  ])
    assert.equal((await request("GET", endpoint)).status, 404);
  assert.deepEqual(
    (await request("GET", "/projects/AA/docs/Maintainer")).body.items,
    [],
  );
  assert.ok(
    await serviceDb.get(
      "PROJECT#AA",
      `REV#Maintainer#${parent.id}#000000000001`,
    ),
  );
  const audit = (await request("GET", "/projects/AA/audit")).body.items;
  assert.ok(
    audit.some(
      (a: any) =>
        a.action === "document.deleted" &&
        a.attribution.agentName === "Link Agent",
    ),
  );
  const publicDoc = (
    await request("POST", "/projects/AA/docs/User", {
      title: "Shared",
      content: "Content",
      public: true,
    })
  ).body;
  const project = (await request("GET", "/projects/AA")).body;
  await request("DELETE", "/projects/AA", undefined, project.version);
  assert.equal(
    (
      await request(
        "GET",
        `/public/documents/${documentReference("User", publicDoc.id)}`,
        undefined,
        undefined,
        "",
      )
    ).status,
    404,
  );
});

test("anonymous adapter bypass is limited to one GET route", () => {
  assert.equal(
    isPublicDocumentRequest("GET", "/api/v1/public/documents/user-id"),
    true,
  );
  for (const path of [
    "/api/v1/public/documents",
    "/api/v1/public/documents/id/revisions",
    "/api/v1/projects",
    "/agent/v1/public/documents/id",
  ])
    assert.equal(isPublicDocumentRequest("GET", path), false);
  for (const method of ["POST", "PATCH", "DELETE", "HEAD"])
    assert.equal(
      isPublicDocumentRequest(method, "/api/v1/public/documents/id"),
      false,
    );
});

test("concurrent child creation and parent deletion cannot leave an orphan", async () => {
  const { request } = setup();
  await request("POST", "/projects", { slug: "AA", name: "Concurrent pages" });
  const parent = (
    await request("POST", "/projects/AA/docs/User", {
      title: "Parent",
      content: "",
    })
  ).body;
  const [created, deleted] = await Promise.all([
    request("POST", "/projects/AA/docs/User", {
      title: "Child",
      content: "",
      parentId: parent.id,
    }),
    request("DELETE", `/projects/AA/docs/User/${parent.id}`, undefined, 1),
  ]);
  assert.ok(
    (created.status === 201 && deleted.status === 409) ||
      (created.status === 404 && deleted.status === 204),
  );
  const pages = (await request("GET", "/projects/AA/docs/User")).body.items;
  for (const page of pages)
    if (page.parentId)
      assert.ok(pages.some((p: any) => p.id === page.parentId));
});
