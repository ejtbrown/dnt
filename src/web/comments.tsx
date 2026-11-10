import { useEffect, useRef, useState } from "react";
import { attributionLabel, type TaskComment } from "../shared/model.js";
import { api, all } from "./api.js";
import { Content, MarkdownField } from "./markdown.js";
function Byline({ comment }: { comment: TaskComment }) {
  return (
    <div className="byline">
      <bdi>{attributionLabel(comment.attribution, comment.createdBy)}</bdi> ·{" "}
      {new Date(comment.createdAt).toLocaleString()}
      {comment.updatedBy && (
        <div>
          Edited {new Date(comment.updatedAt!).toLocaleString()} by{" "}
          <bdi>
            {attributionLabel(comment.editAttribution, comment.updatedBy)}
          </bdi>
        </div>
      )}
    </div>
  );
}
function Comment({
  comment,
  path,
  canEdit,
  updated,
}: {
  comment: TaskComment;
  path: string;
  canEdit: boolean;
  updated: (value: TaskComment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<TaskComment[]>();
  useEffect(() => {
    if (!showHistory) return;
    let active = true;
    setRevisions(undefined);
    setError("");
    all<TaskComment>(`${path}/${comment.id}/revisions`)
      .then((data) => {
        if (active) setRevisions(data.reverse());
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [showHistory, path, comment.id, comment.version]);
  return (
    <article className="task-comment">
      <Byline comment={comment} />
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              updated(
                await api<TaskComment>(
                  `${path}/${comment.id}`,
                  "PATCH",
                  { content: draft },
                  comment.version,
                ),
              );
              setEditing(false);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <MarkdownField
            label="Edit comment"
            value={draft}
            onChange={setDraft}
            maxLength={20000}
            disabled={busy}
          />
          <div className="history-controls">
            <button className="primary" disabled={busy || !draft.trim()}>
              Save comment
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel edit
            </button>
          </div>
        </form>
      ) : (
        <Content>{comment.content}</Content>
      )}
      <div className="history-controls">
        {canEdit && !editing && (
          <button
            className="quiet"
            onClick={() => {
              setDraft(comment.content);
              setEditing(true);
              setError("");
            }}
          >
            Edit comment
          </button>
        )}
        <button className="quiet" onClick={() => setShowHistory(!showHistory)}>
          {showHistory ? "Hide comment history" : "Comment history"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {showHistory && (
        <section aria-label="Comment revisions" className="comment-history">
          {!revisions && !error && <p>Loading comment history…</p>}
          {revisions?.map((revision) => (
            <details key={revision.version}>
              <summary>
                Revision {revision.version} ·{" "}
                {new Date(
                  revision.updatedAt ?? revision.createdAt,
                ).toLocaleString()}{" "}
                ·{" "}
                {attributionLabel(
                  revision.editAttribution ?? revision.attribution,
                  revision.updatedBy ?? revision.createdBy,
                )}
              </summary>
              <Content>{revision.content}</Content>
              <details>
                <summary>Markdown source</summary>
                <pre className="markdown-source">{revision.content}</pre>
              </details>
            </details>
          ))}
        </section>
      )}
    </article>
  );
}
export function WorkItemComments({
  project,
  itemId,
  principal,
  administrator,
}: {
  project: string;
  itemId: string;
  principal: string;
  administrator: boolean;
}) {
  const path = `/projects/${project}/items/${itemId}/comments`;
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const request = useRef({ content, key: crypto.randomUUID() });
  if (request.current.content !== content)
    request.current = { content, key: crypto.randomUUID() };
  useEffect(() => {
    let active = true;
    all<TaskComment>(path)
      .then((items) => {
        if (active) setComments(items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <section className="task-comments" aria-label="Work item comments">
      <h3>Comments</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p>Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        comments.map((comment) => (
          <Comment
            key={comment.id}
            comment={comment}
            path={path}
            canEdit={administrator || principal === comment.createdBy}
            updated={(value) =>
              setComments((current) =>
                current.map((c) => (c.id === value.id ? value : c)),
              )
            }
          />
        ))
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          try {
            await api(
              path,
              "POST",
              { content },
              undefined,
              request.current.key,
            );
            setComments(await all<TaskComment>(path));
            setContent("");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <MarkdownField
          label="Comment"
          value={content}
          onChange={setContent}
          maxLength={20000}
          disabled={saving}
        />
        <button
          className="secondary"
          disabled={loading || saving || !content.trim()}
        >
          {saving ? "Posting…" : "Post comment"}
        </button>
      </form>
    </section>
  );
}
