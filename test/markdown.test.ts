import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { compareText, type TextDiff } from "../src/shared/diff.js";
import { Service } from "../src/api/service.js";
import { MemoryStore, MemoryBlobs } from "../src/api/store.js";
import { MemoryDirectory } from "../src/groups/memory.js";
const admin = "cognito:operator",
  user = "cognito:author",
  other = "cognito:other";
const reconstruct = (diff: TextDiff, side: "before" | "after") =>
  diff.parts
    .filter((p) => p.type !== (side === "before" ? "added" : "removed"))
    .map((p) => p.text)
    .join("");
async function setup() {
  const db = new MemoryStore(),
    blobs = new MemoryBlobs();
  const service = new Service(db, blobs, new MemoryDirectory(true, [admin]));
  const request = (
    method: string,
    path: string,
    body?: unknown,
    principal = admin,
    version?: number,
    query?: Record<string, string>,
  ) =>
    service.handle({
      method,
      path: `/api/v1${path}`,
      body,
      principal,
      userName: principal,
      query,
      agentName: "Markdown Agent",
      headers: {
        "idempotency-key": randomUUID(),
        ...(version ? { "if-match": `"${version}"` } : {}),
      },
    });
  assert.equal(
    (await request("POST", "/projects", { slug: "ROOT", name: "Root" })).status,
    201,
  );
  for (const principal of [user, other])
    await request("POST", "/projects/ROOT/members", {
      principal,
      role: "User",
    });
  return { db, blobs, request };
}
test("diffs preserve exact Markdown whitespace, line endings, direction, and bounded fallback", () => {
  for (const [before, after] of [
    ["", "# hi\n"],
    ["a\r\n  \r\nb", "a\n\nb\n"],
    ["    code  \nlast", "    code\nlast\n"],
    ["same", "same"],
    ["## old", ""],
  ]) {
    for (const budget of [0, 2000]) {
      const diff = compareText(before, after, budget);
      assert.equal(reconstruct(diff, "before"), before);
      assert.equal(reconstruct(diff, "after"), after);
    }
  }
  assert.equal(compareText("one", "two", 0).simplified, true);
});
test("document comparison supports arbitrary revisions, exact titles/bodies, permissions, and restoration", async () => {
  const { request, blobs } = await setup();
  const content = (v: number) =>
    `# Revision ${v}\n\n    indented code  \n\n| A | B |\n|---|---|\n| ${v} | value |\n`;
  for (const tree of ["User", "Maintainer", "Administrator"]) {
    const doc = (
      await request("POST", `/projects/ROOT/docs/${tree}`, {
        title: "Title 1",
        content: content(1),
      })
    ).body;
    const path = `/projects/ROOT/docs/${tree}/${doc.id}`;
    for (let v = 2; v <= 20; v++)
      assert.equal(
        (
          await request(
            "PATCH",
            path,
            { title: `Title ${v}`, content: content(v) },
            admin,
            v - 1,
          )
        ).status,
        200,
      );
    for (const [from, to] of [
      [3, 20],
      [20, 3],
      [3, 3],
    ]) {
      const result = await request(
        "GET",
        `${path}/compare`,
        undefined,
        admin,
        undefined,
        { from: String(from), to: String(to) },
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.from.version, from);
      assert.equal(result.body.to.version, to);
      assert.equal(reconstruct(result.body.content, "before"), content(from));
      assert.equal(reconstruct(result.body.content, "after"), content(to));
      assert.equal(reconstruct(result.body.title, "before"), `Title ${from}`);
    }
    for (const query of [
      { from: "0", to: "20" },
      { from: "1.5", to: "2" },
      { from: "3" },
      { from: "01", to: "2" },
    ])
      assert.equal(
        (
          await request(
            "GET",
            `${path}/compare`,
            undefined,
            admin,
            undefined,
            query as Record<string, string>,
          )
        ).status,
        400,
      );
    assert.equal(
      (
        await request("GET", `${path}/compare`, undefined, admin, undefined, {
          from: "3",
          to: "21",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request("GET", `${path}/compare`, undefined, user, undefined, {
          from: "3",
          to: "20",
        })
      ).status,
      tree === "User" ? 200 : 403,
    );
    const count = blobs.objects.size;
    await request("PATCH", path, { title: "Title only" }, admin, 20);
    assert.equal(blobs.objects.size, count);
    const titleOnly = (
      await request("GET", `${path}/compare`, undefined, admin, undefined, {
        from: "20",
        to: "21",
      })
    ).body;
    assert.ok(
      titleOnly.content.parts.every((p: any) => p.type === "unchanged"),
    );
    await request(
      "PATCH",
      path,
      { title: "Restored", content: content(3) },
      admin,
      21,
    );
    assert.equal(
      (await request("GET", `${path}/revisions/20`)).body.content,
      content(20),
    );
    assert.equal((await request("GET", path)).body.version, 22);
  }
});
test("all work items support editable Markdown comments with immutable, paginated, attributed history", async () => {
  const { request } = await setup();
  let parentId: string | undefined;
  for (const kind of ["Initiative", "Epic", "Task"]) {
    const item = (
      await request("POST", "/projects/ROOT/items", {
        kind,
        title: kind,
        parentId,
      })
    ).body;
    parentId = item.id;
    const path = `/projects/ROOT/items/${item.id}/comments`;
    const source = "    indented code\n\nA hard break  \nnext\n";
    const created = await request("POST", path, { content: source }, user);
    assert.equal(created.status, 201);
    assert.equal(created.body.itemId, item.id);
    assert.equal("taskId" in created.body, false);
    assert.equal(created.body.content, source);
    const commentPath = `${path}/${created.body.id}`;
    assert.equal(
      (await request("PATCH", commentPath, { content: "forged" }, other, 1))
        .status,
      403,
    );
    assert.equal(
      (await request("PATCH", commentPath, { content: "  " }, user, 1)).status,
      400,
    );
    const edited = await request(
      "PATCH",
      commentPath,
      { content: "# Corrected\n" },
      user,
      1,
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body.version, 2);
    assert.equal(edited.body.createdBy, user);
    assert.equal(edited.body.editAttribution.agentName, "Markdown Agent");
    assert.equal(
      (await request("PATCH", commentPath, { content: "stale" }, user, 1))
        .status,
      412,
    );
    assert.equal(
      (
        await request(
          "PATCH",
          commentPath,
          { content: "**Admin correction**" },
          admin,
          2,
        )
      ).status,
      200,
    );
    const first = (
      await request(
        "GET",
        `${commentPath}/revisions`,
        undefined,
        user,
        undefined,
        { limit: "1" },
      )
    ).body;
    assert.equal(first.items[0].content, source);
    assert.equal(first.items[0].updatedBy, undefined);
    assert.ok(first.nextCursor);
    const rest = (
      await request(
        "GET",
        `${commentPath}/revisions`,
        undefined,
        user,
        undefined,
        { cursor: first.nextCursor },
      )
    ).body;
    assert.deepEqual(
      rest.items.map((r: any) => r.version),
      [2, 3],
    );
    assert.equal(rest.items[1].updatedBy, admin);
    assert.equal(rest.items[1].createdBy, user);
    assert.equal(
      (
        await request(
          "GET",
          `${commentPath}/revisions`,
          undefined,
          "cognito:outsider",
        )
      ).status,
      404,
    );
    const comments = (await request("GET", path)).body.items;
    assert.equal(comments.length, 1);
    assert.equal(comments[0].version, 3);
  }
});
