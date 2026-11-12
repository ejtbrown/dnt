import type { WorkItemComment } from "../shared/model.js";

// Display projection only: preserve every stored parent and revision. Missing
// parents and malformed cycles must not make imported evidence disappear.
export function commentThreads(comments: WorkItemComment[]) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment: WorkItemComment) => {
    const seen: string[] = [];
    let current = comment;
    while (current.parentCommentId && byId.has(current.parentCommentId)) {
      if (seen.includes(current.id)) {
        return byId.get(seen.slice(seen.indexOf(current.id)).sort()[0])!;
      }
      seen.push(current.id);
      current = byId.get(current.parentCommentId)!;
    }
    return current;
  };
  const newest = (a: WorkItemComment, b: WorkItemComment) =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
    b.id.localeCompare(a.id);
  const groups = new Map<
    string,
    { root: WorkItemComment; replies: WorkItemComment[] }
  >();
  for (const comment of comments) {
    const root = rootOf(comment);
    if (!groups.has(root.id)) groups.set(root.id, { root, replies: [] });
    if (comment.id !== root.id) groups.get(root.id)!.replies.push(comment);
  }
  return [...groups.values()]
    .sort((a, b) => newest(a.root, b.root))
    .map((group) => ({ ...group, replies: group.replies.sort(newest) }));
}
