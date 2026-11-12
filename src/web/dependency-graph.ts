import type { WorkItem } from "../shared/model.js";

export type DependencyTone =
  | "implement"
  | "concept"
  | "attention"
  | "blocked-attention"
  | "blocked-concept"
  | "other";
export interface DependencyNode {
  item: WorkItem;
  tone: DependencyTone;
  column: number;
  row: number;
  externalDependencies: number;
  cycle: boolean;
}
export interface DependencyEdge {
  from: string;
  to: string;
}
export const dependencyToneLabels: Record<DependencyTone, string> = {
  implement: "Implement",
  concept: "Concept",
  attention: "Needs Attention",
  "blocked-attention": "Implement, upstream Needs Attention",
  "blocked-concept": "Implement, upstream Concept",
  other: "Other active state",
};

// Input is a selected project's complete current work-item list. Never fetch
// or expose other projects to complete an edge. Terminal nodes are satisfied
// or stopped boundaries, not conduits for inherited graph warnings.
export function buildDependencyGraph(items: WorkItem[]) {
  const project = items[0]?.project;
  const scoped = items.filter((item) => item.project === project);
  const known = new Map(scoped.map((item) => [item.id, item]));
  const active = scoped.filter(
    (item) =>
      !item.deletedAt && item.state !== "Done" && item.state !== "Cancelled",
  );
  const byId = new Map(active.map((item) => [item.id, item]));
  const ids = [...byId.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const dependencies = new Map(
    ids.map((id) => [
      id,
      [...new Set(byId.get(id)!.dependencies ?? [])].filter((dep) =>
        byId.has(dep),
      ),
    ]),
  );
  const downstream = new Map(ids.map((id) => [id, [] as string[]]));
  const edges: DependencyEdge[] = [];
  for (const id of ids)
    for (const dep of dependencies.get(id)!) {
      downstream.get(dep)!.push(id);
      edges.push({ from: dep, to: id });
    }
  const pending = new Map(ids.map((id) => [id, dependencies.get(id)!.length]));
  const columns = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => pending.get(id) === 0);
  const processed = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    processed.add(id);
    for (const next of downstream.get(id)!) {
      columns.set(next, Math.max(columns.get(next)!, columns.get(id)! + 1));
      pending.set(next, pending.get(next)! - 1);
      if (pending.get(next) === 0) queue.push(next);
    }
  }
  // A malformed imported cycle must never hang rendering or hide its nodes.
  const cycleColumn = Math.max(0, ...columns.values()) + 1;
  for (const id of ids) if (!processed.has(id)) columns.set(id, cycleColumn);
  const rows = new Map<number, number>();
  const nodes: DependencyNode[] = ids.map((id) => {
    const item = byId.get(id)!;
    const seen = new Set<string>();
    const todo = [...dependencies.get(id)!];
    let upstreamAttention = false,
      upstreamConcept = false,
      cycle = false;
    while (todo.length) {
      const ancestor = todo.pop()!;
      if (ancestor === id) {
        cycle = true;
        continue;
      }
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      const state = byId.get(ancestor)!.state;
      upstreamAttention ||= state === "Needs Attention";
      upstreamConcept ||= state === "Concept";
      todo.push(...dependencies.get(ancestor)!);
    }
    const tone: DependencyTone =
      item.state === "Needs Attention"
        ? "attention"
        : item.state === "Concept"
          ? "concept"
          : item.state === "Implement"
            ? upstreamAttention
              ? "blocked-attention"
              : upstreamConcept
                ? "blocked-concept"
                : "implement"
            : "other";
    const column = columns.get(id)!;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      item,
      tone,
      column,
      row,
      cycle,
      externalDependencies: [...new Set(item.dependencies ?? [])].filter(
        (dep) => !known.has(dep),
      ).length,
    };
  });
  return { nodes, edges, project };
}
