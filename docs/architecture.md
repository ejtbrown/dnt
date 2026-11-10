# Architecture and design decisions

## Request paths

```mermaid
flowchart LR
    Human[Browser or Cognito API client] --> CF[CloudFront: dnt.ejtbrown.com]
    CF -->|static assets / OAC| Web[Private S3 web bucket]
    CF -->|/api/v1/* / no cache| Gateway[API Gateway HTTP API]
    Agent[Agent / AWS SigV4] -->|regional /agent/v1/*| Gateway
    Gateway -->|JWT or IAM authorizer| API[Lambda application]
    API -->|membership / metadata / transactions| DB[DynamoDB on demand]
    API -->|immutable Markdown objects| Content[Private versioned S3 content bucket]
    Human -->|code + PKCE| Cognito[Shared Cognito pool]
```

The deployed web origin is proposed as `dnt.ejtbrown.com`, in account `264702148921`, with regional resources in `us-east-2` and the CloudFront certificate in `us-east-1`. These settings are editable in `config/deploy.json`. No API response is cached. CloudFront rewrites only `/auth/callback` to the static application; API errors are never replaced by the SPA.

The implementation is TypeScript, React/Vite, the AWS SDK v3, and CDK. One Lambda owns the initial API to keep deployment and transactions straightforward. Its service layer is separate from HTTP authentication and the storage adapters. The local runner and tests reuse the service layer with a local store; the deployed Lambda always uses DynamoDB and S3.

## Why DynamoDB plus S3

Use DynamoDB as the authoritative record store for project metadata, memberships, work items, revision pointers, idempotency results, and audits. Use S3 for immutable Markdown bodies. DynamoDB on-demand has request-based capacity billing instead of an always-running database instance; storage, backups, logs, and network traffic still incur charges. [AWS on-demand mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html).

S3 alone can store documents efficiently, but coordinated membership updates, ticket-number allocation, and conditional metadata changes would require more application-level coordination. This workload's reads are naturally bounded by a known project, user, or object identifier. DynamoDB transactions keep the coordination in one service. A relational service such as Aurora DSQL would be worth revisiting if ad-hoc joins and reporting become central; it would change the storage adapters and query model. The initial implementation avoids that additional dependency.

This is deliberately more than a disposable S3 index: losing DynamoDB loses permissions, counters, work items, and the authoritative revision graph. Back up both stores. AWS documents both the S3 pointer pattern and the lack of a transaction spanning S3 and DynamoDB. [Large-item storage guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html).

## Data keys

All records have `pk`, `sk`, `version`, and `value`. No secondary indexes or scans are needed for initial access patterns.

| Partition key | Sort key | Record / access |
| --- | --- | --- |
| `PROJECT#ROOT` | `GROUP_SYNC` | Durable Cognito synchronization request, generation, status, and safe error |
| `PROJECT#ROOT` | `META` | Project, sequence, administrator count, mutation version |
| `PROJECT#ROOT` | `ITEM#000000000001` | Work item by project ordinal |
| `PROJECT#ROOT` | `COMMENT#ITEM#<ordinal>#<timestamp>#<uuid>` | Current work item comment |
| `PROJECT#ROOT` | `COMMENT_ID#ITEM#<ordinal>#<uuid>` | Stable ID lookup for a comment |
| `PROJECT#ROOT` | `COMMENT_REV#ITEM#<ordinal>#<uuid>#<version>` | Immutable comment revision |
| `PROJECT#ROOT` | `MEMBER#<principal>` | Project membership listing |
| `PRINCIPAL#<principal>` | `PROJECT#ROOT` | Authorization and user's project listing |
| `PROJECT#ROOT` | `DOC#User#<uuid>` | Current document metadata |
| `PROJECT#ROOT` | `REV#User#<uuid>#000000000001` | Immutable revision metadata |
| `PROJECT#ROOT` | `AUDIT#<timestamp>#<uuid>` | Mutation actor, time, action and target |
| `IDEMP#<sha256(actor,path,key)>` | `RESULT` | Request digest and successful response |

A project always exposes all three logical trees, including empty trees. Documents store a same-tree parent UUID; work items store same-project parents of the required type. Project slugs are immutable uppercase keys, 2–10 alphanumeric characters beginning with a letter. The single ordinal namespace gives Jira-like display IDs without claiming Jira API compatibility.

Memberships are written in both access directions in the same transaction. Authorization reads are strongly consistent. The project row is read before membership and acts as a common conditional-write lock for project mutations, preventing concurrent parent/membership changes and administrator-count races. This intentionally serializes writes within one small-team project. If contention becomes significant, split locks by invariant and introduce targeted indexes; do not remove the checks without preserving those invariants.

## Write protocol

1. Authenticate the request and read project membership.
2. Validate the body, hierarchy, role, and required `If-Match` version.
3. For POST, look up the actor/path/idempotency key. A matching request returns its original response; a different body gets `409`.
4. For changed Markdown, write a new unique immutable S3 object first.
5. In one DynamoDB transaction, write the record, project lock/counter, authorization condition, audit event, revision metadata when applicable, and idempotency record when applicable.
6. Return success only after the transaction commits.

A storage failure before step 5 cannot create a dangling content pointer. A failed or ambiguous transaction after an S3 write may leave an unreferenced object. These objects are harmless and retained in v1. No lifecycle rule deletes current content or historical revisions. Future garbage collection must reconcile all committed revision references and wait out in-flight writes; it must not delete solely based on age.

DynamoDB condition failures retry up to five attempts with jitter. Stale caller versions return `412`; missing versions return `428`. A contended operation can return `409`; clients should reread before modifying an existing item, and reuse the same idempotency key/body when retrying a create. Deduplication records do not expire automatically. Reads/lists during concurrent edits are individually strongly consistent, but a multi-request paginated listing is not a snapshot.

## Authentication and authorization

People use the existing shared Cognito pool and a dedicated **public** dnt app client with exact HTTPS redirect/logout URLs and authorization-code + PKCE. API Gateway verifies token signatures, issuer, audience and `openid` scope. Lambda additionally requires `token_use=access`, the exact `client_id`, unexpired claims, and a nonempty subject. ID tokens and arbitrary tokens from other applications in the shared pool cannot authorize dnt operations. [HTTP API JWT validation](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

Agents use the separate IAM-authorized route namespace. The handler accepts only API Gateway's trusted authorizer context, maps registered STS role sessions to stable IAM role ARNs, and applies the same membership checks. The production handler never trusts local development headers. Lambda invoke permissions are granted to API Gateway, not anonymous callers.

Project roles are inherited `User < Maintainer < Administrator`. Unknown and unauthorized projects return `404`. A current member of the shared Cognito `dnt-admin` group can create projects but cannot bypass their project membership rules. Project deletion requires both that global group and project Administrator permission. The directory is queried for privileged calls; token group claims and deployment allowlists cannot grant this capability. Project grants are read from DynamoDB on each request rather than embedded in a long-lived Cognito claim. A request already in flight can finish after a concurrent revocation; mutations condition-check the membership and project lock at commit.

The static S3 bucket contains only application assets and public client configuration. The separate content bucket has no CloudFront origin and no public URLs. Document content is returned after authorization. Raw HTML is not rendered in Markdown. Production CSP also blocks external images, avoiding automatic external requests from project content. The browser retains access tokens only in memory and stores temporary OAuth state/verifier in session storage.

## Cost and operational boundaries

No VPC, NAT gateway, EC2, RDS instance, provisioned Lambda concurrency, or search cluster is created. Compute and request charges primarily follow usage. Persistent charges remain for S3/DynamoDB storage, DynamoDB recovery, logs, Route 53, and any shared Cognito plan. CodeBuild is on demand. This is a cost-conscious architecture, not a promise of a particular monthly bill; no regional price estimate has been invented.

Data has CloudFormation retention, DynamoDB deletion protection and point-in-time recovery, S3 versioning, and stack termination protection. Those controls do not replace a tested restore procedure. Logs retain 30 days and omit request bodies/tokens. An API server-error alarm is created without notification subscriptions; attach the team's operational destination before depending on it for alerts.

The deployment tooling owns the CodeBuild runner, GitHub role, CloudFormation execution policy, and runtime permissions boundary. Runtime roles are restricted to dnt resources. Infrastructure permissions are scoped by resource names where possible; API Gateway and CloudFront creation/management require broader service permissions in this first version. Treat deployment access as privileged infrastructure access. The tooling stack and its policies are administrator-owned, not part of the routine application deployment.

The checked-in CDK release bundles a `minimatch` version flagged by `npm audit` for a [moderate build-time denial-of-service advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249). It is not in the browser or Lambda bundle. CDK bundles this dependency, so an npm override does not replace it. Update CDK when its bundled dependency is fixed; do not downgrade infrastructure libraries solely to make an audit report empty.

## Project group synchronization

Project creation, role changes/removal, project deletion, and explicit reconciliation write `GROUP_SYNC` in the same transaction as permissions and audit. DynamoDB Streams delivers only pending synchronization rows to a dedicated Lambda. The worker reads current dnt memberships and creates/converges the three managed Cognito groups. Reserved concurrency 1 serializes Cognito changes; each change and completion checks the request generation, so newer requests supersede older work. Failed partial updates are idempotent and retry six times within six hours; exhausted events go to an encrypted SQS failure queue retained for 14 days. The queue has a CloudWatch alarm; like existing alarms, no notification subscription is configured.

The service records Cognito username/display snapshots with assignments after verifying their subject. The worker rechecks the immutable subject on synchronization so a deleted and recreated username cannot inherit an old account’s group assignment. Search uses a bounded, paginated email-prefix query; only project administrators can query the shared directory. API/MCP Lambdas have read-only directory privileges. Only the worker can mutate groups. Cognito grants are scoped to the shared user pool (Cognito IAM does not scope these operations to group names); code restricts names to validated project slugs. Every existing group must have the exact dnt origin/project/role ownership description and no IAM role before it can be changed. Name collisions become visible sync errors, never automatic adoption. No user accounts or memberships in unrelated groups are deleted.

DynamoDB remains the access authority; JWT group claims are not used for project authorization. Group changes made outside dnt are overwritten on reconciliation and never independently grant dnt access. Project deletion stores a tombstone under the original slug, blocks content reads/writes immediately, and queues group deletion. Membership rows are retained for recovery and for former administrators to monitor/retry cleanup; project lists filter tombstones while preserving pagination. Documentation, work, and audit remain retained. Slugs and ticket identifiers cannot be reused.

The Members page shows group names/status and actual users, searches existing Cognito accounts, changes/removes assignments, retries synchronization, and deletes projects. Legacy projects without a synchronization row can be provisioned using Retry synchronization or `reconcile_project_groups`; legacy memberships without usernames are resolved by the worker. Deleted Cognito accounts are reported as missing assignments for administrators to remove.

## Markdown and revision history

Document bodies remain native Markdown in immutable `.md` S3 objects with `text/markdown; charset=utf-8`. Each successful edit creates an immutable DynamoDB revision snapshot; title-only edits reuse the body object. Current and historical views use the same safe Markdown renderer. The browser lazily loads a CodeMirror Markdown source editor for pages, work item descriptions, and comments. Raw HTML is never executed.

Document comparisons read two authorized snapshots and their bodies, then return exact line-based title/content diff segments. Work is bounded; large unrelated inputs return a marked full-text diff. No database, new infrastructure, or migration is needed.

All work item kinds support comments. The current comment stays in its original chronological row. A `COMMENT_ID#` lookup points to that row and `COMMENT_REV#` rows retain immutable versions. Edits atomically update the current row, add a revision and write an audit event; the author or a project Administrator must provide the current version. Older comments without these rows are resolved through their existing list and backfilled on first edit. Original attribution remains unchanged; editor attribution is recorded separately on every edit and revision.
