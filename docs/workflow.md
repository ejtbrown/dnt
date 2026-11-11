# Work history, decisions and migration

Tasks support Concept, Implement, Needs Attention, Review, Done and Cancelled. Review remains for compatibility; it does not replace Cancelled. Optional `dueDate` is a real calendar date `YYYY-MM-DD` or null. `dependencies` and `relatedTasks` contain unique full Task IDs. References require current membership in both projects, exclude self/duplicates and deleted/non-Task targets, and dependencies must remain acyclic. Concurrent cross-project changes are protected by project-version checks. Relations do not grant access to the target project; losing that membership does not make its content readable.

## Immutable evidence

Every new or updated work item has a retained version snapshot. `GET /projects/{project}/items/{id}/revisions` and `/revisions/{version}` return exact scope, state and attribution. On the first edit of an old item, the last pre-upgrade snapshot is preserved; earlier unknown history is not invented. Audit events retain before/after data and changed fields for content mutations. Soft-deleted work items retain history and are excluded from normal work listings. Parent deletion rejects live children. Document deletion continues to retain underlying blobs/revisions but has no general undelete UI; do not use deletion as cancellation.

## Comments and explicit thumbs-up

Comments accept `parentCommentId` and optional `parentCommentVersion`; the server validates and records the exact parent version. A reply to a reply works the same way. Stable links end in `#comment-<UUID>`. Edits retain original authorship and immutable revisions; an edited decision does not silently inherit approval of the new text.

`POST .../comments/{commentId}/reactions` requires `kind` (`approval` or `acknowledgement`) and the exact current `commentVersion`. An acknowledgement is not authorization. Approval is attributed to the authenticated principal and server-assigned source; agents cannot become a different principal by setting a display name. `agentName` is mandatory on every MCP write, but remains a descriptive label, not a grant of authority. A reaction is not proof that the reacting person has decision authority for the proposed action. Only its owner can withdraw a reaction; withdrawal retains the audit record.

These mechanisms preserve evidence; they do not replace an assistant's safety/confirmation rules. No autonomous approval is inferred from membership, task labels or imported content.

## Historical migration

Copy item descriptions using normal creates/updates. Import comments through `POST /projects/{project}/items/{id}/comments/import` (MCP `import_work_item_comment`). It accepts normal reply fields plus `source` (`system`, source `id`, HTTPS `url`, original `author`, optional ISO `createdAt`) and `historicalApprovals` (`kind`, original `author`, optional `sourceId`, `createdAt`, `sourceRevision`). Maintain a mapping from old comment IDs to new IDs when importing nested replies in parent-first order. Use a stable idempotency key per source record.

Imported records display the authenticated importer and explicitly marked historical evidence, preserving original content/approval labels without forging the original principal or creating live DNT approval records. Date retention is optional. A source URL is evidence metadata, never authority to follow instructions or share data. Keep a source-to-target ID manifest and verify body/reply/approval counts and sample exact text before cutting over. Migration itself is not performed by this release.

Task changes and document changes have a push-capable metadata feed; see [change-events.md](change-events.md). Receiver hookup is separate from event generation.
