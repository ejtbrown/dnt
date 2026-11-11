# Task and document change events

Committed `AUDIT#` inserts in the existing product DynamoDB stream drive a small Lambda publisher and the private `ChangesTopicArn` SNS topic. There is no polling loop, VM, VPC, gateway, load balancer or persistent application connection. This adds usage-priced stream processing, Lambda/SNS requests, a failure queue and one CloudWatch alarm; it is intended for a small-team workload, not a promise of zero cost.

## Payload and privacy

```json
{
  "schemaVersion": 1,
  "id": "PROJECT#ROOT/AUDIT#<timestamp>#<uuid>",
  "project": "ROOT",
  "action": "item.updated",
  "target": "ROOT-3",
  "at": "2026-11-11T19:00:00.000Z"
}
```

Task/work-item, comment, reaction, document, project-deletion and membership-invalidation events include only identifiers and event metadata, never titles, descriptions, comment bodies, approval content or user identities. Consumers must fetch current content through the normally authenticated API and must revalidate current membership. SNS topic access is private to the operator; no automatic subscriptions or public endpoints are created. This is an operator integration feed, not a grant of project access to every subscriber. Do not give untrusted recipients topic access; project IDs themselves can be sensitive.

Subscribe an authorized HTTPS receiver, Lambda, or SQS queue through ordinary AWS configuration. Use SNS message attribute filters (`project`, `action`) for routing, but do not treat filters as an access-control boundary. HTTPS receivers must validate SNS signatures and exact topic ARN, explicitly handle subscription confirmation, and deduplicate by payload `id`. Never fetch an arbitrary SubscribeURL without validation. Subscription endpoints and permissions require their own authorization; deployment does not silently connect third parties.

## Delivery and recovery

Delivery is at least once. Duplicate records can occur, including when a later record in a DynamoDB batch fails. Consumers use the durable audit ID for deduplication and fetch current state rather than assuming ordering. Stream delivery starts at `LATEST` when first deployed: this is not a historical export. Normal service retries use idempotent request keys, so a replayed successful write does not create a second audit event.

The worker is capped at one concurrent invocation, batches of 25 and a 30-second timeout. Failed record sequence numbers trigger partial-batch retries, with six retries and a six-hour age limit. Exhausted records go to `ChangeFailuresQueue` (14-day retention); its visible-message alarm must be connected to an authorized operational destination. SNS downstream delivery has its own retry semantics: configure subscription DLQs and monitoring at the receiving integration. SNS successful publish is not proof a receiver processed an event.

After failure, inspect the DLQ and stream failure window promptly. SQS stream failure destinations contain invocation/sequence metadata, not a guaranteed retained full stream payload; DynamoDB Streams expires records after 24 hours. If stream records have expired, enumerate durable project audit records covering the failure interval and replay their metadata with original audit IDs. Consumers deduplicate overlapping recovery. Do not clear the queue until recovery is verified. No replay/cleanup is performed by this release.

## Assistant integration limit

A private SNS event feed is implemented, but it does not itself wake a ChatGPT dot. A supported inbound receiver/connector must be connected before replacing the dot's task polling. The current dot integration has no generic DNT/SNS inbound trigger. Keep existing review schedules until that bridge is available and its end-to-end delivery is verified; do not claim polling has been eliminated merely because SNS accepted a message.

## Rollout

The application adds a least-privilege publisher role (`sns:Publish` only on `dnt-app-changes`, existing table stream read, own DLQ write). Its runtime boundary and deployment policy must first be updated through the operator's existing tooling bootstrap. No broad SNS subscription-management permission is added. Review IAM and resource diffs before applying. The data table/stream identifier, bucket names, retained data and existing group-worker stream mapping are not replaced.
