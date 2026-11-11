import { useEffect, useState } from "react";
import { attributionLabel, type WorkItem } from "../shared/model.js";
import { all } from "./api.js";
import { Content } from "./markdown.js";
import { itemLink } from "../shared/links.js";
export function ItemHistory({ item }: { item: WorkItem }) {
  const [show, setShow] = useState(false),
    [revisions, setRevisions] = useState<WorkItem[]>(),
    [error, setError] = useState("");
  useEffect(() => {
    if (!show) return;
    let active = true;
    setRevisions(undefined);
    setError("");
    all<WorkItem>(`/projects/${item.project}/items/${item.id}/revisions`)
      .then((rows) => {
        if (active) setRevisions(rows.sort((a, b) => b.version - a.version));
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [item.id, item.version, item.project, show]);
  return (
    <section className="item-history" aria-label="Work item history">
      <button
        type="button"
        className="secondary"
        onClick={() => setShow(!show)}
      >
        {show ? "Hide work item history" : "Work item history"}
      </button>
      {show && (
        <>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!revisions && !error && <p>Loading history…</p>}
          {revisions?.length === 0 && (
            <p>
              No retained revisions. History begins when revision recording is
              enabled; earlier edits are not reconstructed.
            </p>
          )}
          {revisions?.map((r) => (
            <details key={r.version}>
              <summary>
                Revision {r.version} · {new Date(r.updatedAt).toLocaleString()}{" "}
                · {attributionLabel(r.attribution)}
                {r.state ? ` · ${r.state}` : ""}
              </summary>
              <h4>{r.title}</h4>
              <dl>
                <dt>Parent</dt>
                <dd>{r.parentId ?? "None"}</dd>
                <dt>Assignee</dt>
                <dd>{r.assignee ?? "Unassigned"}</dd>
                {r.kind === "Task" && (
                  <>
                    <dt>Due date</dt>
                    <dd>{r.dueDate ?? "None"}</dd>
                    <dt>Dependencies</dt>
                    <dd>
                      {r.dependencies?.length
                        ? r.dependencies.map((id) => (
                            <a
                              className="history-link"
                              key={id}
                              href={itemLink(id)}
                            >
                              {id}
                            </a>
                          ))
                        : "None"}
                    </dd>
                    <dt>Related tasks</dt>
                    <dd>
                      {r.relatedTasks?.length
                        ? r.relatedTasks.map((id) => (
                            <a
                              className="history-link"
                              key={id}
                              href={itemLink(id)}
                            >
                              {id}
                            </a>
                          ))
                        : "None"}
                    </dd>
                  </>
                )}
              </dl>
              <Content>{r.description || "*No description.*"}</Content>
              <details>
                <summary>Recorded snapshot</summary>
                <pre className="markdown-source">
                  {JSON.stringify(r, null, 2)}
                </pre>
              </details>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
