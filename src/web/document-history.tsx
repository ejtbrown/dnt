import { useEffect, useState } from "react";
import { attributionLabel, type Document } from "../shared/model.js";
import type { TextDiff } from "../shared/diff.js";
import { api } from "./api.js";
import { Content } from "./markdown.js";
type Page = Document & { content: string };
interface Comparison {
  from: Document;
  to: Document;
  title: TextDiff;
  content: TextDiff;
}
function Diff({ diff }: { diff: TextDiff }) {
  return (
    <div className="revision-diff">
      {diff.simplified && (
        <p className="muted">
          These revisions differ extensively. Showing complete removed and added
          text.
        </p>
      )}
      {diff.parts.every((p) => p.type === "unchanged") && (
        <p className="muted">No changes.</p>
      )}
      {diff.parts.map((part, index) => {
        const text = <pre>{part.text}</pre>;
        return (
          <div key={index} className={`diff-${part.type}`}>
            {part.type === "unchanged" && part.text.split("\n").length > 12 ? (
              <details>
                <summary>
                  Unchanged text ({part.text.split("\n").length} lines)
                </summary>
                {text}
              </details>
            ) : (
              <>
                <span className="diff-label">
                  {part.type === "added"
                    ? "+ Added"
                    : part.type === "removed"
                      ? "− Removed"
                      : "Unchanged"}
                </span>
                {text}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
export function DocumentHistory({
  project,
  tree,
  revisions,
  restore,
  busy,
}: {
  project: string;
  tree: string;
  revisions: Document[];
  restore: (revision: Document) => void;
  busy: boolean;
}) {
  const ordered = [...revisions].sort((a, b) => b.version - a.version);
  const [selected, setSelected] = useState(ordered[0]?.version ?? 1);
  const [from, setFrom] = useState(ordered[1]?.version ?? selected);
  const [to, setTo] = useState(selected);
  const [page, setPage] = useState<Page>();
  const [source, setSource] = useState(false);
  const [comparison, setComparison] = useState<Comparison>();
  const [mode, setMode] = useState<"view" | "compare">("view");
  const [error, setError] = useState("");
  const path = `/projects/${project}/docs/${tree}/${ordered[0]?.id}`;
  useEffect(() => {
    let active = true;
    setError("");
    setPage(undefined);
    setComparison(undefined);
    const request =
      mode === "view"
        ? api<Page>(`${path}/revisions/${selected}`)
        : api<Comparison>(`${path}/compare?from=${from}&to=${to}`);
    request
      .then((result) => {
        if (active) {
          if ("content" in result && typeof result.content === "string")
            setPage(result as Page);
          else setComparison(result as Comparison);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path, selected, from, to, mode]);
  const options = ordered.map((r) => (
    <option key={r.version} value={r.version}>
      Revision {r.version}
    </option>
  ));
  return (
    <section className="document-history">
      <div className="history-controls">
        <button
          className={mode === "view" ? "primary" : "secondary"}
          onClick={() => setMode("view")}
        >
          View history
        </button>
        <button
          className={mode === "compare" ? "primary" : "secondary"}
          onClick={() => setMode("compare")}
        >
          Compare revisions
        </button>
      </div>
      {mode === "view" ? (
        <>
          <label>
            Revision
            <select
              aria-label="Revision"
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {options}
            </select>
          </label>
          {page && (
            <>
              <p className="byline">
                Revision {page.version} ·{" "}
                {new Date(page.updatedAt).toLocaleString()} ·{" "}
                <bdi>{attributionLabel(page.attribution)}</bdi>
              </p>
              <div className="history-controls">
                <button
                  className="secondary"
                  onClick={() => setSource(!source)}
                >
                  {source ? "Show formatted" : "Show Markdown source"}
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => restore(page)}
                >
                  Open in editor
                </button>
              </div>
              <h3>{page.title}</h3>
              {source ? (
                <pre className="markdown-source">{page.content}</pre>
              ) : (
                <Content>{page.content}</Content>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="form-row">
            <label>
              From revision
              <select
                aria-label="From revision"
                value={from}
                onChange={(e) => setFrom(Number(e.target.value))}
              >
                {options}
              </select>
            </label>
            <label>
              To revision
              <select
                aria-label="To revision"
                value={to}
                onChange={(e) => setTo(Number(e.target.value))}
              >
                {options}
              </select>
            </label>
          </div>
          {comparison && (
            <>
              <p>
                Revision {comparison.from.version} → Revision{" "}
                {comparison.to.version}
              </p>
              {[comparison.from, comparison.to].map((revision, index) => (
                <p className="byline" key={index}>
                  {index === 0 ? "From" : "To"}: Revision {revision.version} ·{" "}
                  {new Date(revision.updatedAt).toLocaleString()} ·{" "}
                  <bdi>{attributionLabel(revision.attribution)}</bdi>
                </p>
              ))}
              <h3>Title changes</h3>
              <Diff diff={comparison.title} />
              <h3>Markdown changes</h3>
              <Diff diff={comparison.content} />
            </>
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : !page && !comparison ? (
        <p>Loading revisions…</p>
      ) : null}
    </section>
  );
}
