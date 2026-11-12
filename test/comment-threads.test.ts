import test from "node:test";
import assert from "node:assert/strict";
import { commentThreads } from "../src/web/comment-threads.js";
import type { WorkItemComment } from "../src/shared/model.js";
const comment = (id: string, second: number, parentCommentId?: string) =>
  ({
    id,
    createdAt: `2026-11-12T00:00:${String(second).padStart(2, "0")}Z`,
    parentCommentId,
    parentCommentVersion: parentCommentId ? 2 : undefined,
  }) as WorkItemComment;
test("roots and flattened replies sort newest-first without rewriting stored evidence", () => {
  const source = [
    comment("old", 1),
    comment("reply", 3, "old"),
    comment("nested", 5, "reply"),
    comment("new", 4),
    comment("sibling", 2, "old"),
  ];
  const before = structuredClone(source);
  const groups = commentThreads(source);
  assert.deepEqual(
    groups.map((g) => g.root.id),
    ["new", "old"],
  );
  assert.deepEqual(
    groups[1].replies.map((r) => r.id),
    ["nested", "reply", "sibling"],
  );
  assert.equal(groups[1].replies[0].parentCommentId, "reply");
  assert.equal(groups[1].replies[0].parentCommentVersion, 2);
  assert.deepEqual(source, before);
});
test("missing parents, cycles and tied timestamps do not hide or duplicate comments", () => {
  const source = [
    comment("orphan", 1, "missing"),
    comment("a", 2, "b"),
    comment("b", 2, "a"),
    comment("child", 3, "b"),
    comment("z", 1),
  ];
  const groups = commentThreads(source);
  const ids = groups.flatMap((g) => [g.root.id, ...g.replies.map((r) => r.id)]);
  assert.deepEqual([...ids].sort(), source.map((r) => r.id).sort());
  assert.equal(new Set(ids).size, source.length);
  assert.deepEqual(
    groups.find((g) => g.root.id === "a")!.replies.map((r) => r.id),
    ["child", "b"],
  );
});
