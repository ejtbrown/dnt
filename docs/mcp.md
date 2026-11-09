# dnt MCP

The production MCP endpoint is **https://dnt.ejtbrown.com/mcp**. It exposes every current product operation through the same service and project authorization rules as the web UI and REST API. MCP does not grant access merely because someone can sign in.

## Connect ChatGPT and your Dot

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose the plus button, then **Add custom MCP server**.
2. Name it **dnt**, enter `https://dnt.ejtbrown.com/mcp`, and select OAuth authentication with **Client ID Metadata Document (CIMD)** registration if offered. The server trusts ChatGPT's published client identifier `https://chatgpt.com/oauth/client.json`; no client secret is needed.
3. Create and install the plugin. Connect your account, sign in at `auth.ejtbrown.com`, complete any required password/MFA steps, and approve the requested access on dnt's consent page.
4. Enable the installed plugin for your Dot in the client. Custom plugin availability and use are subject to your account/workspace policy. In a new conversation, select `@dnt` and ask it to list your projects.
5. For writes, grant both `dnt:read` and `dnt:write`. Read-only connections can browse but cannot mutate. The client controls any additional confirmation prompts for write tools.

This follows OpenAI's [custom MCP connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt#test-an-mcp-server-optional) and [authentication requirements](https://developers.openai.com/plugins/build/auth). The endpoint supports the published ChatGPT MCP requirements; installing it, completing the human login, and verifying tool selection in your particular Dot remain client-side steps. After tool/auth changes, refresh the plugin's metadata and start a new conversation.

Example prompts:

- “List my dnt projects and show the tasks that need attention.”
- “Create an initiative and epic for the release, then a task under that epic.”
- “Move ROOT-3 to Review using its current version.”
- “Read the User documentation tree and update the installation guide.”
- “Show this page's revisions and restore revision 2 as a new revision.”
- “Grant this Cognito principal Maintainer access to ROOT.”

## Complete tool catalog

| Tools | Product capability |
| --- | --- |
| `get_identity`, `get_profile` | Current principal, project creation eligibility, stable account profile |
| `list_projects`, `get_project`, `create_project` | Project discovery and creation |
| `list_work_items`, `get_work_item`, `create_work_item`, `update_work_item` | Initiatives, Epics, Tasks, hierarchy, assignment, descriptions, all five task states |
| `list_documents`, `get_document`, `create_document`, `update_document` | All three nested documentation trees and Markdown content |
| `list_document_revisions`, `get_document_revision`, `restore_document_revision` | Revision history, historical reads, restoration as a new revision |
| `list_task_comments`, `create_task_comment` | Immutable Markdown task comments with author attribution |
| `list_members`, `set_member`, `remove_member` | Project role grants, role changes, and revocation |
| `list_audit_events` | Mutation audit history |

There are 22 tools. A regression test compares their operation identifiers with every operation in `public/openapi.json` and exercises the full lifecycle using the official MCP client. Profile and restoration are additional convenience tools. The product currently has no attachments, full-text search, hard deletion of projects/items/documents, or identity invitations; MCP does not imply those capabilities.

Creates require an `idempotencyKey`; reuse the same key and identical input only when retrying the same create. Updates and removals require `expectedVersion` from a recent read. Existing membership changes also require that version. Lists accept `limit` (default 25, maximum 100) and `cursor`; continue using `nextCursor` until absent. Large results may require a smaller page size. Successful product results are returned both as JSON text and under `structuredContent.result`. The profile tool returns its declared top-level profile object. Tool failures have `isError: true`; permission and conflict errors preserve the API status in their text.

## Agent attribution on every write

Every write tool accepts an optional top-level `agentName`. Supply your agent's name on **every** mutation, including project creation, task creation/updates, comments, documentation creation/updates/restoration, and membership grants/removal. Read tools do not accept this parameter. The name is trimmed, limited to 80 characters, and must be a single line without control or direction-changing characters.

```json
{
  "project": "ROOT",
  "id": "ROOT-3",
  "patch": { "state": "Review" },
  "expectedVersion": 2,
  "agentName": "Release Assistant"
}
```

For `update_work_item`, this records an attribution such as **Erick Brown via Release Assistant**. dnt derives the user name from the authenticated account; agents cannot supply or override it. The original immutable principal remains the authorization and audit identity. `agentName` is a self-reported display label, never a permission or verified agent identity. It is scoped to a single call so two agents sharing an OAuth connection cannot overwrite each other's names.

Attribution snapshots are saved with every mutation's audit event, each document revision, work-item updates, and comments. The UI uses them in document history, page and work-item bylines, task comments, and the Administrator's Activity view. Restoration records the agent performing the restoration; the source revision keeps its original author. A later human or untagged edit replaces the current byline without carrying forward an earlier agent name.

Reuse the same `agentName`, input, and idempotency key on retries. Reusing a create key with a different agent name returns a conflict and never rewrites the original attribution. Calls without `agentName` remain valid and show the account alone. Historical records without saved attribution keep their original principal as the fallback. When a display name is unavailable, dnt uses a verified account email if present, otherwise the principal.

Refresh the dnt plugin's tool metadata in ChatGPT to discover the new arguments and comment tools. Ask your agent to use its chosen name on every dnt write.

Comments are available on Tasks through `list_task_comments` and `create_task_comment`, and via GET/POST `/projects/{project}/items/{id}/comments`. Project members can read and post; comments are immutable, paginated oldest first, and limited to 20,000 characters. Their Markdown is rendered safely in the task dialog. REST bodies cannot set author or agent attribution.

## Transport and authorization

The server implements stateless MCP Streamable HTTP with the official TypeScript SDK. It negotiates supported protocol versions (including `2025-11-25`), returns JSON responses to POST, and acknowledges notifications with 202. It does not maintain session IDs, SSE streams, or server-to-client subscriptions. Clients send `Accept: application/json, text/event-stream`. Discovery (`initialize`, `tools/list`) is public; all tool execution requires an OAuth bearer token. GET returns an authentication challenge or 405 when authenticated.

Public metadata:

- Resource: `https://dnt.ejtbrown.com/.well-known/oauth-protected-resource/mcp`
- Authorization server: `https://dnt.ejtbrown.com/.well-known/oauth-authorization-server`
- Issuer: `https://dnt.ejtbrown.com`
- Canonical OAuth resource: `https://dnt.ejtbrown.com/mcp`

Tool definitions advertise OAuth scopes, read/write and destructive-action annotations, and output schemas. Missing authorization returns `mcp/www_authenticate`; invalid bearer credentials return HTTP 401 with `WWW-Authenticate`. A profile tool is marked `openai/profile`. OAuth redirects include the issuer parameter for ChatGPT's stable callback. Request origins are checked, and CloudFront caching is disabled for MCP, OAuth, and discovery.

The OAuth broker uses authorization codes with mandatory S256 PKCE and exact resource/redirect binding. Cognito is the upstream identity provider, with a separate public `dnt-mcp` client and independent PKCE and nonce validation. Explicit browser consent, an HttpOnly/Secure cookie, and a CSRF token bind each approval to the person signing in. Upstream Cognito tokens are verified and discarded; they are never passed to an MCP client.

MCP access tokens last 15 minutes. Refresh tokens rotate on every use, and reuse revokes the entire grant family. A connection expires absolutely after 30 days and must then be connected again. Refresh checks that the Cognito identity remains enabled and in a usable status. Project membership changes apply on every tool call; disabling a Cognito account blocks refresh, with already-issued access tokens valid for at most 15 minutes. Tokens are opaque random values, with only hashes stored in a dedicated DynamoDB table. Expiry is enforced in code as well as by DynamoDB TTL.

Clients can revoke a connection using form-encoded POST to `/oauth/revoke` with their `client_id` and an access or refresh `token`. This revokes the grant family. Removing a plugin in ChatGPT removes the client connection; whether it also invokes server revocation is client behavior. Do not assume uninstall alone immediately revokes already issued credentials.

Only explicitly trusted CIMD document URLs in `mcpClientMetadataUrls` are fetched. The default is ChatGPT's stable document. Redirects must exactly match that document. The server advertises public-client authentication (`none`) and uses PKCE; it selects that supported method from ChatGPT's plural auth-method list even when its legacy singular preference is `private_key_jwt`. Dynamic client registration and client secrets are not implemented. Other MCP clients require their HTTPS metadata document to be added deliberately and must support this OAuth flow. AWS agents can continue using the existing SigV4 regional REST endpoint; those credentials are not MCP bearer tokens.

## Deploy and verify

Register `config/cognito-mcp-application.json` in the shared identity project. Set its resulting public client ID in `mcpCognitoClientId`, alongside the existing browser client. Bootstrap the updated runtime permissions boundary once with administrator credentials before releasing the application through the normal GitHub Actions → CodeBuild → CDK pipeline. The new Lambda needs `cognito-idp:AdminGetUser` only on the configured pool. The retained OAuth table is on demand, with TTL and point-in-time recovery.

Run `npm run check` for transport, full product parity, OAuth consent/PKCE/replay/rotation/revocation, Cognito signature verification, permission, and infrastructure checks. Browser tests cover the existing UI. `npm run smoke:mcp` verifies the deployed endpoint with a temporary synthetic account that has no memberships; see the script for its exact isolated OAuth record cleanup. It requires operator AWS credentials. It does not sign in as a real person or prove the human MFA flow.

For manual verification, connect the plugin and exercise discovery, sign-in, permitted reads/writes, denied tree access, stale versions, and refresh. Inspect logs for errors without recording tokens or authorization codes. The server never logs request bodies or tokens.

OAuth recovery requires care: restoring an old OAuth table can resurrect revoked grants or used refresh tokens. Prefer a fresh empty OAuth table and require reconnection after recovery rather than restoring old credential state. Product data recovery is independent.
