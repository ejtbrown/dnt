import { useId, useMemo } from "react";
import type { WorkItem } from "../shared/model.js";
import { itemLink } from "../shared/links.js";
import {
  buildDependencyGraph,
  dependencyToneLabels,
  type DependencyTone,
} from "./dependency-graph.js";
import "./dependency-view.css";

const WIDTH = 236,
  HEIGHT = 104,
  X_STEP = 312,
  Y_STEP = 148,
  PAD = 28;
export function DependencyView({ items }: { items: WorkItem[] }) {
  const graph = useMemo(() => buildDependencyGraph(items), [items]);
  const marker = `dependency-arrow-${useId().replaceAll(":", "")}`;
  const position = new Map(
    graph.nodes.map((node) => [
      node.item.id,
      {
        x: PAD + node.column * X_STEP,
        y: PAD + node.row * Y_STEP,
      },
    ]),
  );
  const width =
    PAD * 2 +
    WIDTH +
    56 +
    Math.max(0, ...graph.nodes.map((n) => n.column)) * X_STEP;
  const height =
    PAD * 2 + HEIGHT + Math.max(0, ...graph.nodes.map((n) => n.row)) * Y_STEP;
  const tones = Object.keys(dependencyToneLabels) as DependencyTone[];
  return (
    <section className="dependency-view" aria-label="Project dependency graph">
      <p>
        Arrows point from a prerequisite (dependee) to the item that depends on
        it. Done and Cancelled items are hidden. Related links are not
        dependencies. Arrow colors show the prerequisite’s state or upstream
        risk.
      </p>
      <ul className="dependency-legend" aria-label="Dependency color legend">
        {tones.map((tone) => (
          <li key={tone}>
            <span
              className={`dependency-swatch dependency-tone-${tone}`}
              aria-hidden="true"
            />
            {dependencyToneLabels[tone]}
          </li>
        ))}
      </ul>
      {graph.nodes.length === 0 ? (
        <p>No active work items to display.</p>
      ) : (
        <>
          {graph.nodes.some((node) => node.cycle) && (
            <p role="status">
              A dependency cycle exists. Its nodes remain visible; resolve the
              cycle before relying on execution order.
            </p>
          )}
          {graph.nodes.some((node) => node.externalDependencies) && (
            <p>
              Some prerequisites are outside this project or unavailable. Their
              states are unknown and are not included in the colors below.
            </p>
          )}
          <div
            className="dependency-canvas"
            tabIndex={0}
            aria-label="Scrollable dependency diagram"
          >
            <svg
              width={width}
              height={height}
              role="group"
              aria-label="Dependency nodes and arrows"
            >
              <defs>
                {tones.map((tone) => (
                  <marker
                    key={tone}
                    className={`dependency-tone-${tone}`}
                    id={`${marker}-${tone}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                ))}
              </defs>
              {graph.edges.map(({ from, to }) => {
                const a = position.get(from)!,
                  b = position.get(to)!;
                const tone = graph.nodes.find(
                  (node) => node.item.id === from,
                )!.tone;
                const sameColumn = a.x === b.x;
                const startX = a.x + WIDTH,
                  startY = a.y + HEIGHT / 2;
                const endX = sameColumn ? b.x + WIDTH : b.x,
                  endY = b.y + HEIGHT / 2;
                const bend = sameColumn ? startX + 40 : (startX + endX) / 2;
                return (
                  <path
                    key={`${from}/${to}`}
                    className={`dependency-edge dependency-tone-${tone}`}
                    d={
                      from === to
                        ? `M ${startX} ${startY - 18} C ${startX + 48} ${startY - 48}, ${startX + 48} ${startY + 48}, ${endX} ${endY + 18}`
                        : `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`
                    }
                    markerEnd={`url(#${marker}-${tone})`}
                  >
                    <title>
                      {from} is required by {to}
                    </title>
                  </path>
                );
              })}
              {graph.nodes.map(
                ({ item, tone, cycle, externalDependencies }) => {
                  const p = position.get(item.id)!;
                  const title =
                    item.title.length > 32
                      ? `${item.title.slice(0, 31)}…`
                      : item.title;
                  const label = `${item.id}: ${item.title}. ${item.kind}. ${dependencyToneLabels[tone]}${cycle ? ". Dependency cycle" : ""}${externalDependencies ? `. ${externalDependencies} external or unavailable prerequisites` : ""}`;
                  return (
                    <a
                      key={item.id}
                      href={itemLink(item.id)}
                      aria-label={label}
                      className={`dependency-node dependency-tone-${tone}`}
                    >
                      <title>{label}</title>
                      <rect
                        x={p.x}
                        y={p.y}
                        width={WIDTH}
                        height={HEIGHT}
                        rx="10"
                      />
                      <text
                        x={p.x + 12}
                        y={p.y + 23}
                        className="dependency-node-id"
                      >
                        {item.id} · {item.kind}
                      </text>
                      <text x={p.x + 12} y={p.y + 46}>
                        {title}
                      </text>
                      <text x={p.x + 12} y={p.y + 68}>
                        {item.state ?? "No state"}
                        {tone === "blocked-attention"
                          ? " · attention upstream"
                          : tone === "blocked-concept"
                            ? " · concept upstream"
                            : ""}
                      </text>
                      <text x={p.x + 12} y={p.y + 89}>
                        {cycle ? "Cycle" : ""}
                        {cycle && externalDependencies ? " · " : ""}
                        {externalDependencies
                          ? `${externalDependencies} outside project / unavailable`
                          : ""}
                      </text>
                    </a>
                  );
                },
              )}
            </svg>
          </div>
          <details className="dependency-text">
            <summary>
              Accessible dependency list ({graph.nodes.length} work items)
            </summary>
            <ul>
              {graph.nodes.map(
                ({ item, tone, cycle, externalDependencies }) => (
                  <li key={item.id}>
                    <a href={itemLink(item.id)}>
                      {item.id}: {item.title}
                    </a>{" "}
                    · {item.kind} · {dependencyToneLabels[tone]}
                    {cycle ? " · Dependency cycle" : ""}
                    <div>
                      Visible prerequisites:{" "}
                      {graph.edges
                        .filter((edge) => edge.to === item.id)
                        .map((edge) => edge.from)
                        .join(", ") || "None"}
                      {externalDependencies
                        ? `; ${externalDependencies} outside project or unavailable (state unknown)`
                        : ""}
                    </div>
                  </li>
                ),
              )}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
