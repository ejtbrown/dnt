import { useDraftState } from "./session-drafts.js";
import { useEffect, useRef, useState } from "react";
import {
  attributionLabel,
  type WorkItemComment,
  type Attribution,
} from "../shared/model.js";
import { api, all } from "./api.js";
import { Content, MarkdownField } from "./markdown.js";
import { commentThreads } from "./comment-threads.js";
import { itemLink } from "../shared/links.js";
type Reaction = {
  id: string;
  kind: "approval" | "acknowledgement";
  commentVersion: number;
  principal: string;
  attribution: Attribution;
  createdAt: string;
  version: number;
  withdrawnAt?: string;
};
function Byline({ comment }: { comment: WorkItemComment }) {
  return (
    <div className="byline">
      <bdi>{attributionLabel(comment.attribution)}</bdi> ·{" "}
      {new Date(comment.createdAt).toLocaleString()} ·{" "}
      {comment.attribution.source ?? "unknown source"}
      {comment.updatedBy && (
        <div>
          Edited {new Date(comment.updatedAt!).toLocaleString()} by{" "}
          <bdi>{attributionLabel(comment.editAttribution!)}</bdi>
        </div>
      )}
    </div>
  );
}
function Comment({
  comment,
  path,
  canEdit,
  canWrite,
  principal,
  updated,
  reply,
}: {
  comment: WorkItemComment;
  path: string;
  canEdit: boolean;
  canWrite: boolean;
  principal: string;
  updated: (value: WorkItemComment) => void;
  reply: (comment: WorkItemComment) => void;
}) {
  const [editing, setEditing] = useDraftState(
      `comment:${comment.id}:editing`,
      false,
    ),
    [draft, setDraft] = useDraftState(
      `comment:${comment.id}:content`,
      comment.content,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [draftVersion, setDraftVersion] = useDraftState(
    `comment:${comment.id}:version`,
    comment.version,
  );
  useEffect(() => {
    if (!editing) setDraftVersion(comment.version);
  }, [editing, comment.version]);
  const [showHistory, setShowHistory] = useState(false),
    [revisions, setRevisions] = useState<WorkItemComment[]>();
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const reactionKeys = useRef(new Map<string, string>());
  const reactionInFlight = useRef(false);
  const [reactionsReady, setReactionsReady] = useState(false);
  const reactionPath = `${path}/${comment.id}/reactions`;
  useEffect(() => {
    let active = true;
    setReactionsReady(false);
    all<Reaction>(reactionPath)
      .then((data) => {
        if (active) {
          setReactions(data);
          setReactionsReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [reactionPath, comment.version]);
  useEffect(() => {
    if (!showHistory) return;
    let active = true;
    setRevisions(undefined);
    setError("");
    all<WorkItemComment>(`${path}/${comment.id}/revisions`)
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
  async function react(kind: Reaction["kind"]) {
    if (busy || reactionInFlight.current || !reactionsReady) return;
    if (
      kind === "approval" &&
      !confirm(
        `Approve the exact text of comment revision ${comment.version}? Acknowledgement is available separately and does not grant approval.`,
      )
    )
      return;
    const value = `${comment.id}/${comment.version}/${kind}`;
    if (!reactionKeys.current.has(value))
      reactionKeys.current.set(value, crypto.randomUUID());
    reactionInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const created = await api<Reaction>(
        reactionPath,
        "POST",
        { kind, commentVersion: comment.version },
        undefined,
        reactionKeys.current.get(value),
      );
      setReactions((current) => [
        ...current.filter((r) => r.id !== created.id),
        created,
      ]);
      setReactions(await all<Reaction>(reactionPath));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      reactionInFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <article
      className="task-comment"
      id={`comment-${comment.id}`}
      tabIndex={-1}
    >
      <Byline comment={comment} />
      {comment.importedEvidence && (
        <aside
          className="imported-evidence"
          aria-label="Imported historical evidence"
        >
          <strong>Imported historical evidence</strong>
          <p>
            Source author: {comment.importedEvidence.source.author} ·{" "}
            <a
              href={comment.importedEvidence.source.url}
              target="_blank"
              rel="noreferrer"
            >
              {comment.importedEvidence.source.system}{" "}
              {comment.importedEvidence.source.id}
            </a>
            {comment.importedEvidence.source.createdAt
              ? ` · ${new Date(comment.importedEvidence.source.createdAt).toLocaleString()}`
              : ""}
          </p>
          <p>
            Imported by {comment.importedEvidence.importedBy} at{" "}
            {new Date(comment.importedEvidence.importedAt).toLocaleString()}.
            Historical approvals are source evidence, not newly granted DNT
            approval.
          </p>
          {comment.importedEvidence.historicalApprovals.length > 0 && (
            <ul>
              {comment.importedEvidence.historicalApprovals.map(
                (approval, index) => (
                  <li key={index}>
                    {approval.kind === "approval"
                      ? "Historical approval"
                      : "Historical acknowledgement"}{" "}
                    by {approval.author}
                    {approval.createdAt
                      ? ` · ${new Date(approval.createdAt).toLocaleString()}`
                      : ""}
                    {approval.sourceRevision
                      ? ` · source revision ${approval.sourceRevision}`
                      : ""}
                    {approval.sourceId ? ` · source ${approval.sourceId}` : ""}
                  </li>
                ),
              )}
            </ul>
          )}
        </aside>
      )}
      {comment.parentCommentId && (
        <p className="byline">
          Reply to{" "}
          <a
            href={`${itemLink(comment.itemId)}#comment-${comment.parentCommentId}`}
          >
            original comment
          </a>{" "}
          revision {comment.parentCommentVersion ?? "unknown"}
        </p>
      )}
      <a
        className="comment-permalink"
        href={`${itemLink(comment.itemId)}#comment-${comment.id}`}
      >
        Link to comment · revision {comment.version}
      </a>
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              updated(
                await api<WorkItemComment>(
                  `${path}/${comment.id}`,
                  "PATCH",
                  { content: draft },
                  draftVersion,
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
          <p className="muted">
            Existing approvals remain tied to their original revision. Changing
            the text does not transfer approval.
          </p>
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
        {canWrite && !editing && (
          <button
            className="quiet"
            disabled={busy}
            onClick={() => reply(comment)}
          >
            Reply
          </button>
        )}
        {canEdit && !editing && (
          <button
            className="quiet"
            disabled={busy}
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
        {canWrite && !editing && (
          <>
            <button
              className="secondary"
              disabled={
                busy ||
                !reactionsReady ||
                reactions.some(
                  (r) =>
                    r.principal === principal &&
                    !r.withdrawnAt &&
                    r.kind === "approval" &&
                    r.commentVersion === comment.version,
                )
              }
              onClick={() => react("approval")}
            >
              👍 Approve revision {comment.version}
            </button>
            <button
              className="quiet"
              disabled={
                busy ||
                !reactionsReady ||
                reactions.some(
                  (r) =>
                    r.principal === principal &&
                    !r.withdrawnAt &&
                    r.kind === "acknowledgement" &&
                    r.commentVersion === comment.version,
                )
              }
              onClick={() => react("acknowledgement")}
            >
              👍 Acknowledge
            </button>
          </>
        )}
      </div>
      {!!reactions.length && (
        <ul
          className="comment-reactions"
          aria-label="Comment approvals and acknowledgements"
        >
          {reactions.map((r) => (
            <li key={r.id}>
              <strong>
                {r.kind === "approval" ? "Approval" : "Acknowledgement"}
              </strong>{" "}
              by <bdi>{attributionLabel(r.attribution)}</bdi> ·{" "}
              {r.attribution.source ?? "unknown source"} · revision{" "}
              {r.commentVersion} · {new Date(r.createdAt).toLocaleString()}
              {r.commentVersion !== comment.version && (
                <span className="muted">
                  {" "}
                  (earlier text, not the current revision)
                </span>
              )}
              {r.withdrawnAt ? (
                <span>
                  {" "}
                  · Withdrawn {new Date(r.withdrawnAt).toLocaleString()}
                </span>
              ) : (
                r.principal === principal && (
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const withdrawn = await api<Reaction>(
                          `${reactionPath}/${r.id}`,
                          "DELETE",
                          undefined,
                          r.version,
                        );
                        setReactions((current) =>
                          current.map((value) =>
                            value.id === withdrawn.id ? withdrawn : value,
                          ),
                        );
                        reactionKeys.current.delete(
                          `${comment.id}/${r.commentVersion}/${r.kind}`,
                        );
                        setReactions(await all<Reaction>(reactionPath));
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Withdraw {r.kind}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
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
  canWrite,
}: {
  project: string;
  itemId: string;
  principal: string;
  administrator: boolean;
  canWrite: boolean;
}) {
  const path = `/projects/${project}/items/${itemId}/comments`;
  const [comments, setComments] = useState<WorkItemComment[]>([]),
    [content, setContent] = useDraftState(path + ":content", ""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [replyTo, setReplyTo] = useDraftState<WorkItemComment | undefined>(
    path + ":replyTo",
    undefined,
  );
  const [replyContent, setReplyContent] = useDraftState(
    path + ":replyContent",
    "",
  );
  const composer = useRef<HTMLDivElement>(null);
  const [requestKeys, setRequestKeys] = useDraftState<Record<string, string>>(
    path + ":requestKeys",
    {},
  );
  const inFlight = useRef(false);
  useEffect(() => {
    if (replyTo) composer.current?.scrollIntoView({ block: "center" });
  }, [replyTo?.id]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    all<WorkItemComment>(path)
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
  useEffect(() => {
    const scroll = () => {
      if (!location.hash.startsWith("#comment-")) return;
      document
        .getElementById(location.hash.slice(1))
        ?.scrollIntoView({ block: "center" });
    };
    scroll();
    window.addEventListener("hashchange", scroll);
    return () => window.removeEventListener("hashchange", scroll);
  }, [comments]);
  async function post(reply = false) {
    if (inFlight.current) return;
    const body = {
      content: reply ? replyContent : content,
      parentCommentId: reply ? (replyTo?.id ?? null) : null,
      parentCommentVersion: reply ? replyTo?.version : undefined,
    };
    const value = JSON.stringify(body);
    const requestKey = requestKeys[value] ?? crypto.randomUUID();
    setRequestKeys((previous) => ({ ...previous, [value]: requestKey }));
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      await api(path, "POST", body, undefined, requestKey);
      setComments(await all<WorkItemComment>(path));
      // Retain the key on uncertain failure. A later deliberate identical post
      // after a successful completion is a different action.
      setRequestKeys((previous) => {
        const next = { ...previous };
        delete next[value];
        return next;
      });
      if (reply) {
        setReplyContent("");
        setReplyTo(undefined);
      } else setContent("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  const form = (reply = false) => (
    <form
      aria-label={reply ? "Reply composer" : "New comment composer"}
      onSubmit={(e) => {
        e.preventDefault();
        void post(reply);
      }}
    >
      {reply && replyTo && (
        <div className="reply-context">
          Replying to{" "}
          <a href={`${itemLink(itemId)}#comment-${replyTo.id}`}>
            {attributionLabel(replyTo.attribution)}’s root comment
          </a>
          <button
            type="button"
            className="quiet"
            disabled={saving}
            onClick={() => setReplyTo(undefined)}
          >
            Cancel reply
          </button>
        </div>
      )}
      <MarkdownField
        label={reply ? "Reply" : "Comment"}
        value={reply ? replyContent : content}
        onChange={reply ? setReplyContent : setContent}
        maxLength={20000}
        disabled={saving}
      />
      <button
        className="secondary"
        disabled={loading || saving || !(reply ? replyContent : content).trim()}
      >
        {saving ? "Posting…" : reply ? "Post reply" : "Post comment"}
      </button>
    </form>
  );
  const renderComment = (comment: WorkItemComment, root: WorkItemComment) => (
    <Comment
      key={comment.id}
      comment={comment}
      path={path}
      canWrite={canWrite}
      principal={principal}
      canEdit={canWrite}
      updated={(value) =>
        setComments((current) =>
          current.map((c) => (c.id === value.id ? value : c)),
        )
      }
      reply={() => {
        if (!saving) setReplyTo(root);
      }}
    />
  );
  return (
    <section className="task-comments" aria-label="Work item comments">
      <h3>Comments</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {canWrite && <div className="new-comment-composer">{form()}</div>}
      {loading ? (
        <p>Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        commentThreads(comments).map(({ root, replies }) => (
          <div
            key={root.id}
            className="comment-thread"
            data-root-comment={root.id}
          >
            {renderComment(root, root)}
            {canWrite && replyTo?.id === root.id && (
              <div className="inline-reply-composer" ref={composer}>
                {form(true)}
              </div>
            )}
            {replies.length > 0 && (
              <div className="comment-replies">
                {replies.map((comment) => renderComment(comment, root))}
              </div>
            )}
          </div>
        ))
      )}
    </section>
  );
}
