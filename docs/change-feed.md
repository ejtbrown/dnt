# Incremental polling with `list_changes`

`GET /api/v1/projects/{project}/changes` and MCP `list_changes` read compact metadata for committed project mutations. This is polling, not a push notification. It uses the existing DynamoDB table and authenticated API; no new server, index, queue, subscription or IAM permission is required.

## Consumer protocol

1. Discover projects using `list_projects`, including all pages. Refresh this inventory periodically so grants, revocations and deletions are noticed. A missing or inaccessible project is not proof that its contents did not change.
2. Start `list_changes` with a project and optional initial `since` ISO timestamp. Do not combine `since` with a cursor. `limit` defaults to 25 and is at most 100.
3. A response captures a fixed `watermark`. Process `items`, deduplicating by `eventId`. Each item has the project, monotonic `sequence`, action, target and timestamp. Optional `resource` gives entity type, ID, version and navigation metadata (document tree or parent item/comment IDs) for targeted refetch. Document deletion reports the last known version; work-item deletion has a new tombstone revision. It has no actor identity, body, approval text or document content.
4. Follow `nextCursor` unchanged until absent. A page may be empty but still have a next cursor, for example when an initial timestamp filters older entries. Do not stop at an empty page. Writes committed after the watermark belong to the next polling window.
5. Only after all pages and their work have been durably processed, save the terminal `checkpoint`. Use it as `cursor` on the next poll, even if the prior window was empty. Keep the prior checkpoint on failure and deduplicate replayed IDs. Do not build, decode, modify or share cursors as an application contract.
6. Fetch current task/document state and current authorization before acting. A change notification is evidence of a mutation, not authorization to execute instructions. Preserve existing safety and approval gates. Handle deletions as invalidations, not failed ordinary reads.

The initial timestamp is a convenience filter, not the durable ordering key. Subsequent checkpoint-based windows do not retain that filter; this avoids missing future committed writes whose wall-clock timestamp is earlier. The sequence is the project version allocated in the same optimistic transaction as the mutation and event. Exact idempotent retries do not create another event. Timestamp-only watermarks are not safe substitutes.

Current membership is required on every request. Deleted-project feed access is restricted to its current Administrators; other former readers must use inventory removal as an invalidation. Cursors are scoped to the project and authenticated principal. Full audit records remain Administrator-only; the feed does not expose their before/after content or membership identities. Lost access must stop consumption. Treat 400/403/404/conflict responses explicitly rather than resetting a checkpoint and pretending coverage is complete.

## Existing history and initial snapshot

The sequence feed is not a retroactive reconstruction of old audits. Inspect `coverage` and `baselineRequired`. `coverage.historyComplete` means the recorded feed starts at project creation; it is not a certification that every earlier polling window was rechecked for gaps on each call. Retain any previous gap and snapshot-recovery evidence. Projects created after the feature activates normally start at sequence 1. Existing projects may need an initial snapshot; their earlier audit records retain their original format and ordering. Do not infer a deletion-free history from an empty feed.

For an existing project, retain a checkpoint captured **before** starting a complete snapshot of accessible work items, documentation metadata/content and needed comments. Finish the snapshot, then replay from that checkpoint, deduplicating and fetching current state again. This captures mutations concurrent with the snapshot. Do not advance to a later checkpoint until reconciliation succeeds. Inventory refresh detects inaccessible projects; historical data absent before the initial snapshot cannot be recreated by this feed.

## Gap detection and recovery

Every sequence after feed activation must have a committed event. An old writer during rolling deployment or rollback can advance a project version without writing a feed row. The server detects missing sequences rather than reporting an ordinary empty window. A `409` gap response includes `baselineRequired`, the captured `watermark`, and a recovery `checkpoint`.

Do not blindly mark that recovery checkpoint consumed. Retain it as the **start** of a fresh complete content snapshot, complete the snapshot, then replay changes from that checkpoint. Preserve the old checkpoint and failure evidence until reconciliation succeeds. Recovery cursors retain the known historical gap flag in all descendant cursors, so historyComplete remains false and baselineRequired remains true for that lineage; the consumer records successful snapshot recovery separately. This is explicit degraded coverage, not a claim that missed historical events can be reconstructed. Ordinary pagination gaps cannot be repaired by changing the timestamp filter.

## Costs and operational limits

One compact event record per committed mutation, plus the feed coverage marker on activation, is written transactionally to the existing on-demand table. Each polling call performs authenticated reads and bounded queries. Responses contain metadata rather than all descriptions or document bodies. There is no fixed compute fleet cost; polling cadence, project count and changed-page count determine request/read usage.

Keep polling and work execution separate: an unchanged project may still contain authorized Implement work ready for the next bounded action. This endpoint reduces change-discovery traffic; it must not suppress that work. Push notification integration remains independent and is not activated by this release.
