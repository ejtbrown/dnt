# dnt — docs & tasks

A self-hosted workspace for small teams and AI agents: project documentation and work tracking without a server or database instance to keep running. The API is the product; the web UI is one client of it.

The production deployment targets [dnt.ejtbrown.com](https://dnt.ejtbrown.com), with sign-in through the shared Cognito service at login.auth.ejtbrown.com/signin. The same application runs locally and can be deployed to another AWS account using the CDK configuration.

## Run locally

Use Node.js 24 (see `.nvmrc`) and Python 3 for the MCP catalog interoperability check (standard library only).

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Create your first project, then an Initiative, an Epic beneath it, and Tasks beneath the Epic. The local server uses a development identity and persists data in ignored `.local/`. Restarting it preserves your work. It binds only to loopback and rejects foreign origins. This identity shortcut is absent from the Lambda handler.

```sh
npm run check        # TypeScript, production build, API/infrastructure tests, CDK synthesis
npx playwright install chromium
npm run test:browser # Browser workflow and mobile layout checks; isolated .local/browser-test data
```

For an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. Browser tests need port 5173 free. `npm test` expects built Lambda/web assets; use `npm run check` on a fresh checkout.

## What works

- Projects with independent User, Maintainer, and Administrator membership grants.
- Three nested Markdown documentation trees per project, syntax-colored native Markdown editing, formatted history, arbitrary revision comparisons, and restoration through the editor.
- Initiatives → Epics → Tasks, with validated same-project parents and optional member assignment.
- Tasks in **Concept**, **Implement**, **Needs Attention**, **Review**, **Done**, and **Cancelled**; draggable board and editable hierarchy.
- Markdown descriptions and editable comments on Initiatives, Epics, and Tasks, with retained comment history and consistent author attribution: MCP writes must identify the agent and show **user name via agent name** in comments, document history, work-item details, and project activity.
- A single project-wide identifier sequence across all work item types, such as `ROOT-1`, `ROOT-2`, `ROOT-3`. An initiative may take `ROOT-1`, so the first task is not necessarily ordinal 1. IDs remain stable when work is moved between compatible parents.
- A versioned REST-style JSON API with an [OpenAPI contract](public/openapi.json), pagination, required idempotency keys for creates, optimistic concurrency for edits, and mutation audit records.
- Shared sign-in authorization-code + PKCE login backed by Cognito for people; IAM/SigV4 access for agents. Every operation also checks project membership.
- A [complete MCP server](docs/mcp.md) at `https://dnt.ejtbrown.com/mcp`, with versioned workflow tools and OAuth account linking for ChatGPT and compatible clients.
- CloudFront → API Gateway HTTP API → Lambda, private S3 origins for the web application, private S3 content storage, and on-demand DynamoDB tables for product records and OAuth grants.
- GitHub Actions jobs hosted by CodeBuild; CDK deployment from `main` through a separate OIDC role.

## Permission model

Roles apply across all project content. Documentation trees organize audiences, not access boundaries.

| Operation                                             | User | Maintainer | Administrator |
| ----------------------------------------------------- | ---- | ---------- | ------------- |
| Read tasks, comments and every documentation tree     | Yes  | Yes        | Yes           |
| Add/edit content, replies and explicit reactions      | No   | Yes        | Yes           |
| Delete work items (recoverable history) and documents | No   | Yes        | Yes           |
| Manage project membership/invite existing accounts    | No   | No         | Yes           |
| Read full project audit                               | No   | No         | Yes           |

Task scope/state revisions and before/after audit events are immutable. Tasks support Cancelled, optional due dates, cross-project dependency and related-task IDs. Replies link the exact parent revision, and thumbs-up is explicitly either approval or acknowledgement. Historical Jira evidence can be imported without manufacturing a new live approval. See [workflow and migration](workflow.md) and [change notifications](change-events.md).

Creating and deleting projects requires current membership in the shared Cognito `dnt-admin` group. Deletion also requires Administrator access to the target project. Creation grants the creator Administrator on that project; the global group does not grant access to other projects. Identity operators manage `dnt-admin` membership in Cognito. IAM principals cannot create or delete projects. The final project Administrator cannot be removed or demoted.

## API examples

Cognito clients use `https://dnt.ejtbrown.com/api/v1`; access tokens must be issued for the registered dnt app client. Requests to private content always go through the API. OpenAPI describes every implemented endpoint.

```sh
# Token is supplied by the caller's environment, never a checked-in file.
curl --fail-with-body "$DNT_URL/api/v1/projects/ROOT/items" \
  -H "Authorization: Bearer $DNT_ACCESS_TOKEN"

curl --fail-with-body "$DNT_URL/api/v1/projects/ROOT/items" \
  -H "Authorization: Bearer $DNT_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-task-2026-11-09-001' \
  --data '{"kind":"Task","title":"Implement the endpoint","parentId":"ROOT-2"}'

curl --fail-with-body -X PATCH "$DNT_URL/api/v1/projects/ROOT/items/ROOT-3" \
  -H "Authorization: Bearer $DNT_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -H 'If-Match: "1"' \
  --data '{"state":"Review"}'
```

IAM clients use the **regional `AgentApi` stack output**, ending in `/agent/v1`. SigV4 signs the Host header, so the first version gives agents the regional endpoint instead of changing the signed host through CloudFront. Relative paths and operations are identical. [AWS signature elements](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-elements.html), [CloudFront origin Host behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).

```sh
export DNT_AGENT_API='https://API_ID.execute-api.us-east-2.amazonaws.com/agent/v1'
AWS_PROFILE=default npm run agent -- GET /me
AWS_PROFILE=default DNT_REQUEST_KEY=create-root-task-001 npm run agent -- \
  POST /projects/ROOT/items '{"kind":"Task","title":"Implement endpoint","parentId":"ROOT-2"}'
# Reuse DNT_REQUEST_KEY and the same body to retry a create.
# Last argument on updates is the version returned by the previous read.
AWS_PROFILE=default npm run agent -- PATCH /projects/ROOT/items/ROOT-3 '{"state":"Review"}' 1
```

An IAM principal needs both `execute-api:Invoke` on the `AgentInvokeArn` output and a dnt project membership. Register IAM role ARNs in `agentRoles` so temporary assumed-role sessions resolve to the stable identity. Membership identifiers are `cognito:<sub>` or `iam:<full IAM role/user ARN>`, not emails or STS session ARNs.

See [architecture](docs/architecture.md) for storage, consistency, and security decisions, and [deployment](docs/deployment.md) for initial setup and operations.

## Incremental change polling

Use MCP `list_changes` for compact per-project changes with fixed-watermark pagination and durable sequence checkpoints. Read [change-feed.md](docs/change-feed.md) before relying on initial history coverage or handling an empty page. No new infrastructure or notification subscription is needed.

## Initial-version limits

There are no attachments, full-text search, project renaming, or hard deletion of work items and documents. Tasks can move among all six states. Comments support explicit revision-bound approval and acknowledgement, not an automatic workflow gate. Historical comment/approval imports preserve source evidence; a full Jira migration tool is not included. Private change-event plumbing is available, but needs an authorized receiver before replacing polling. Document parents and trees are immutable; revisions support content restoration. The UI loads paginated project metadata for small-team boards; very large projects will need server-side filters and indexes. Page bodies are limited to 100 KB of UTF-8 Markdown, work item descriptions and comments to 20,000 characters.

The deployment runbook includes production smoke checks and recovery procedures. Browser access tokens stay in memory; reloading requires another sign-in redirect, and expired sessions require sign-in again. Cognito's shared invitation and MFA policy remains owned by `ejtbrown-cognito`.

`.codex-resume` is ignored local session state. Never commit it or delete it as cleanup.

Work items have stable `/t/ROOT-1` links. Documents have `/d/user-<id>`, `/d/maintainer-<id>`, or `/d/admin-<id>` links. Opening a private link preserves the destination through sign-in. Each page has a **Public** checkbox: checked pages expose only their current formatted content to anyone with the link, without a public directory or revision history. Unchecking it revokes anonymous access. **Delete page** asks for confirmation and requires child pages to be deleted first. Deletion removes the page and its links; immutable revision content remains retained privately for recovery.

Browser sign-in uses the shared identity broker. Cognito still signs API access tokens; the broker signs nonce-bound ID tokens. Password sign-in can remember MFA for seven days in a browser, with an unchanged deadline on subsequent password logins. The browser and MCP clients use distinct confidential Cognito clients whose secrets remain in the broker.
