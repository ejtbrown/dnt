# Work history, decisions and migration

Tasks support Concept, Implement, Needs Attention, Review, Done and Cancelled. Review remains for compatibility; it does not replace Cancelled. Optional `dueDate` is a real calendar date `YYYY-MM-DD` or null. `dependencies` and `relatedTasks` contain unique full work item IDs and are supported on Initiatives, Epics and Tasks. The legacy field name `relatedTasks` is retained for API compatibility. References require current membership in both projects, exclude self/duplicates and deleted targets, and dependencies must remain acyclic. Concurrent cross-project changes are protected by project-version checks. Relations do not grant access to the target project; losing that membership does not make its content readable.

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

## Derived container state

Epic state is derived from its active child Tasks; Initiative state is derived from all active Tasks under its active Epics. Empty containers and containers with all Tasks in Concept are Concept. All Tasks Done means Done. Every other combination is Implement, including all Cancelled, Needs Attention, Review and mixed Done/Concept. States are not directly writable on containers; due dates remain Task-only. Deleted Tasks do not count. Reads paginate the entire project as necessary and reject concurrent mutations with 409 rather than return a torn rollup. The work item version remains its own content version, not a rollup revision: child changes can change the displayed state without changing the container version. Historical item revisions retain the actual recorded fields, not reconstructed past rollups.

Links express explicit prerequisites or related context, not automatic workflow gates or inherited child links. Consumers must inspect ancestor prerequisites too before executing descendant work. A change to a child Task can affect both ancestors' derived state: change-feed consumers should refresh the hierarchy, not wait for a synthetic parent-change event.

## Exact ticket numbers for migration

`create_work_item` / POST items accepts optional `ordinal` (integer 1 through 999999999999). It creates exactly `<project>-<ordinal>`, provided that number has never been used, including soft-deleted records. A collision fails with 409; it never updates or replaces existing content. The project allocator advances to the larger of its current value and the requested number, so later automatic allocation cannot reuse a lower number. Concurrent creates serialize through the existing project transaction. Retry an uncertain create only with identical input and the same idempotency key. `ordinal` is immutable and not accepted on update.

Use the existing exact uppercase source project key as the DNT project slug. Inventory the maximum source issue number before creating synthetic containers: assign those above that maximum, then import source issues with their original explicit numbers. Never create padding tickets or assume import order alone preserves numbers. Keep a source-to-target manifest and verify collisions before import. This API enables an authorized migration; this release does not migrate any data.

## Comment and assignment UI

The new-comment Markdown composer appears above the conversation. Root comments and each root's replies display newest-first by DNT creation time, with a stable ID tie-break. Replies to replies are displayed under the original root; new replies target that root and its current revision. Historical parent IDs/revisions and imported provenance remain intact and visible. A Reply button opens its separate Markdown composer between that root and its existing replies; it does not discard an unsent top-level draft. Source timestamps on imported comments remain historical metadata.

The assignment picker searches project member names and saves the selected principal ID, never a typed display name. Duplicate names are distinguished by principal; unmatched text cannot be submitted, and clearing unassigns. Existing unavailable assignments are preserved unless changed. `GET /projects/{project}/assignees` and MCP `list_assignees` expose only current project members' principal and name, paginated, to current Maintainers and Administrators. They expose neither global directory accounts, email nor membership roles, and do not allow inviting or changing access. User remains read-only and cannot use the assignment directory.
