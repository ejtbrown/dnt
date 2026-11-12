import test from "node:test";
import assert from "node:assert/strict";
import type { WorkItem, State } from "../src/shared/model.js";
import { buildDependencyGraph } from "../src/web/dependency-graph.js";
const item = (
  id: string,
  state: State,
  dependencies: string[] = [],
  kind: WorkItem["kind"] = "Task",
) =>
  ({
    id,
    project: id.split("-")[0],
    kind,
    state,
    dependencies,
    title: id,
    relatedTasks: [],
  }) as unknown as WorkItem;

test("dependency arrows point prerequisite to depender and colors carry transitive risk", () => {
  const graph = buildDependencyGraph([
    item("PT-1", "Concept", [], "Initiative"),
    item("PT-2", "Implement", ["PT-1"], "Epic"),
    item("PT-3", "Implement", ["PT-2"]),
    item("PT-4", "Needs Attention"),
    item("PT-5", "Implement", ["PT-3", "PT-4"]),
    item("PT-6", "Implement", ["PT-5"]),
    item("PT-7", "Implement"),
  ]);
  const tones = Object.fromEntries(
    graph.nodes.map((node) => [node.item.id, node.tone]),
  );
  assert.deepEqual(tones, {
    "PT-1": "concept",
    "PT-2": "blocked-concept",
    "PT-3": "blocked-concept",
    "PT-4": "attention",
    "PT-5": "blocked-attention",
    "PT-6": "blocked-attention",
    "PT-7": "implement",
  });
  assert.ok(
    graph.edges.some((edge) => edge.from === "PT-1" && edge.to === "PT-2"),
  );
  assert.ok(
    graph.nodes.find((n) => n.item.id === "PT-2")!.column >
      graph.nodes.find((n) => n.item.id === "PT-1")!.column,
  );
});
test("multiple dependency branches prefer attention regardless of order or path length", () => {
  for (const dependencies of [
    ["PT-1", "PT-2"],
    ["PT-2", "PT-1"],
  ]) {
    const g = buildDependencyGraph([
      item("PT-1", "Concept"),
      item("PT-2", "Needs Attention"),
      item("PT-3", "Implement", dependencies),
    ]);
    assert.equal(
      g.nodes.find((n) => n.item.id === "PT-3")!.tone,
      "blocked-attention",
    );
  }
});
test("terminal/deleted nodes and other projects never become visible or propagate warnings", () => {
  const graph = buildDependencyGraph([
    item("PT-1", "Needs Attention"),
    item("PT-2", "Done", ["PT-1"]),
    item("PT-3", "Cancelled", ["PT-1"]),
    { ...item("PT-4", "Concept"), deletedAt: "2026-11-12T00:00:00Z" },
    item("PT-5", "Implement", ["PT-2", "PT-3", "PT-4", "QM-1", "PT-99"]),
    item("QM-1", "Needs Attention"),
  ]);
  assert.deepEqual(
    graph.nodes.map((n) => n.item.id),
    ["PT-1", "PT-5"],
  );
  assert.equal(graph.nodes[1].tone, "implement");
  assert.equal(graph.nodes[1].externalDependencies, 2);
  assert.deepEqual(graph.edges, []);
});
test("cycles are finite and visible; unrelated links are not dependency arrows", () => {
  const source = [
    item("PT-1", "Implement", ["PT-2"]),
    item("PT-2", "Needs Attention", ["PT-1"]),
    item("PT-3", "Implement", ["PT-2"]),
    { ...item("PT-4", "Review"), relatedTasks: ["PT-2"] },
  ];
  const before = structuredClone(source);
  const graph = buildDependencyGraph(source);
  assert.deepEqual(
    graph.nodes.filter((n) => n.cycle).map((n) => n.item.id),
    ["PT-1", "PT-2"],
  );
  assert.equal(graph.nodes[0].tone, "blocked-attention");
  assert.equal(graph.nodes[2].tone, "blocked-attention");
  assert.equal(graph.nodes[3].tone, "other");
  assert.equal(graph.edges.length, 3);
  assert.deepEqual(source, before);
  assert.ok(
    graph.nodes.every(
      (n) => Number.isFinite(n.column) && Number.isFinite(n.row),
    ),
  );
});
test("empty graphs, self cycles and duplicate edges remain deterministic", () => {
  assert.equal(buildDependencyGraph([]).nodes.length, 0);
  const graph = buildDependencyGraph([
    item("PT-1", "Implement", ["PT-1", "PT-1"]),
  ]);
  assert.equal(graph.nodes[0].cycle, true);
  assert.deepEqual(graph.edges, [{ from: "PT-1", to: "PT-1" }]);
});
