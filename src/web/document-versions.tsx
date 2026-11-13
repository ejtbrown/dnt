import { useEffect, useState } from "react";
import type { Document } from "../shared/model.js";
import { all, api } from "./api.js";

export type DocumentPage = Document & { content: string };
export type DocumentView = {
  documentId: string;
  historical: boolean;
  page?: DocumentPage;
  loading?: boolean;
  error?: string;
};
// The migration stores source evidence as numbered child pages. Only this exact
// convention with an existing parent is grouped; ordinary history pages remain.
export function archiveParent(doc: Document, documents: Document[]) {
  return /^Source revision archive [1-9]\d* of [1-9]\d*$/.test(doc.title)
    ? documents.find(
        (p) =>
          p.id === doc.parentId &&
          p.project === doc.project &&
          p.tree === doc.tree,
      )
    : undefined;
}
export function currentDocumentTree(documents: Document[]) {
  return documents
    .filter((d) => !archiveParent(d, documents))
    .map((d) => {
      const parent = documents.find((p) => p.id === d.parentId);
      const owner = parent && archiveParent(parent, documents);
      return owner ? { ...d, parentId: owner.id } : d;
    });
}
export function DocumentVersions({
  document,
  documents,
  navigate,
  onView,
}: {
  document: DocumentPage;
  documents: Document[];
  navigate: (doc: Document) => void;
  onView: (view: DocumentView) => void;
}) {
  const [revisions, setRevisions] = useState<Document[]>([]);
  const [selection, setSelection] = useState("current");
  const [listError, setListError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const parent = archiveParent(document, documents);
  const owner = parent ?? document;
  const archives = documents
    .filter((d) => archiveParent(d, documents)?.id === owner.id)
    .sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true }),
    );
  const path = `/projects/${document.project}/docs/${document.tree}/${document.id}`;
  useEffect(() => {
    let active = true;
    setListLoading(true);
    setListError("");
    all<Document>(`${path}/revisions`)
      .then((result) => {
        if (active) setRevisions(result);
      })
      .catch((e) => {
        if (active) setListError(e.message);
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, retry]);
  useEffect(() => {
    let active = true;
    if (selection === "current") {
      onView({ documentId: document.id, historical: false });
      return;
    }
    onView({ documentId: document.id, historical: true, loading: true });
    api<DocumentPage>(`${path}/revisions/${selection}`)
      .then((page) => {
        if (active) onView({ documentId: document.id, historical: true, page });
      })
      .catch((e) => {
        if (active)
          onView({
            documentId: document.id,
            historical: true,
            error: e.message,
          });
      });
    return () => {
      active = false;
    };
  }, [path, selection, retry]);
  return (
    <div className="document-version-picker">
      <select
        aria-label="Document history"
        value={parent ? `archive:${document.id}` : selection}
        onChange={(e) => {
          const value = e.target.value;
          if (value.startsWith("archive:")) {
            const target = documents.find((d) => d.id === value.slice(8));
            if (target) navigate(target);
          } else if (value === "owner" && parent) navigate(parent);
          else setSelection(value);
        }}
      >
        <option value={parent ? "owner" : "current"}>
          Current version
          {parent ? ` — ${parent.title}` : ` · Revision ${document.version}`}
        </option>
        {!parent &&
          revisions
            .filter((r) => r.version !== document.version)
            .sort((a, b) => b.version - a.version)
            .map((r) => (
              <option key={r.version} value={String(r.version)}>
                Revision {r.version} ·{" "}
                {new Date(r.updatedAt).toLocaleDateString()}
              </option>
            ))}
        {!!archives.length && (
          <optgroup label="Imported source history">
            {archives.map((d) => (
              <option key={d.id} value={`archive:${d.id}`}>
                {d.title}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {listLoading && <span role="status">Loading history…</span>}
      {listError && (
        <span role="alert">
          History unavailable: {listError}{" "}
          <button className="quiet" onClick={() => setRetry((n) => n + 1)}>
            Retry history
          </button>
        </span>
      )}
      {selection !== "current" && (
        <button className="quiet" onClick={() => setRetry((n) => n + 1)}>
          Reload revision
        </button>
      )}
    </div>
  );
}
