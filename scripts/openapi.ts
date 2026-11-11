import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  docInput,
  commentInput,
  commentPatch,
  commentImportInput,
  reactionInput,
  docPatch,
  itemInput,
  itemPatch,
  memberInput,
  projectInput,
  roles,
  states,
  kinds,
} from "../src/shared/model.js";
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const version = { type: "integer", minimum: 1 };
const date = { type: "string", format: "date-time" };
const string = { type: "string" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const project = object({
  slug: string,
  name: string,
  description: string,
  sequence: { type: "integer" },
  administrators: { type: "integer", minimum: 1 },
  version,
  createdAt: date,
  updatedAt: date,
});
(project.properties as Record<string, unknown>).deletedAt = date;
const membership = object({
  project: string,
  principal: string,
  role: { enum: roles },
  version,
});
(membership.properties as Record<string, unknown>).deletedAt = date;
for (const key of ["username", "name", "email"])
  (membership.properties as Record<string, unknown>)[key] = string;
const item = object(
  {
    id: string,
    url: { type: "string", format: "uri" },
    project: string,
    ordinal: { type: "integer", minimum: 1 },
    kind: { enum: kinds },
    parentId: { type: ["string", "null"] },
    title: string,
    description: string,
    state: { enum: states },
    assignee: { type: ["string", "null"] },
    dueDate: { type: ["string", "null"], format: "date" },
    dependencies: { type: "array", items: string },
    relatedTasks: { type: "array", items: string },
    deletedAt: date,
    version,
    createdAt: date,
    updatedAt: date,
    updatedBy: string,
    attribution: ref("Attribution"),
  },
  [
    "id",
    "url",
    "project",
    "ordinal",
    "kind",
    "parentId",
    "title",
    "description",
    "assignee",
    "version",
    "createdAt",
    "updatedAt",
    "updatedBy",
    "attribution",
  ],
);
const document = object({
  public: { type: "boolean" },
  url: { type: "string", format: "uri" },
  id: { type: "string", format: "uuid" },
  project: string,
  tree: { enum: roles },
  parentId: { type: ["string", "null"] },
  title: string,
  objectKey: string,
  version,
  createdAt: date,
  updatedAt: date,
  updatedBy: string,
  attribution: ref("Attribution"),
});
const schemas: Record<string, unknown> = {
  PublicDocument: object({
    id: { type: "string", format: "uuid" },
    tree: { enum: roles },
    title: string,
    content: string,
    updatedAt: date,
    public: { const: true },
    url: { type: "string", format: "uri" },
  }),
  Attribution: object(
    {
      principal: string,
      userName: string,
      agentName: { type: "string", maxLength: 80 },
      source: { enum: ["web", "mcp", "agent", "unknown"] },
    },
    ["principal", "userName"],
  ),
  WorkItemComment: object(
    {
      id: { type: "string", format: "uuid" },
      project: string,
      itemId: string,
      url: { type: "string", format: "uri" },
      parentCommentId: { type: ["string", "null"] },
      parentCommentVersion: version,
      importedEvidence: { type: "object" },
      updatedAt: date,
      updatedBy: string,
      editAttribution: ref("Attribution"),
      content: string,
      version,
      createdAt: date,
      createdBy: string,
      attribution: ref("Attribution"),
    },
    [
      "id",
      "project",
      "itemId",
      "content",
      "version",
      "createdAt",
      "createdBy",
      "attribution",
    ],
  ),
  CommentReaction: object(
    {
      id: string,
      project: string,
      itemId: string,
      commentId: string,
      commentVersion: version,
      kind: { enum: ["approval", "acknowledgement"] },
      principal: string,
      attribution: ref("Attribution"),
      createdAt: date,
      version,
      withdrawnAt: date,
    },
    [
      "id",
      "project",
      "itemId",
      "commentId",
      "commentVersion",
      "kind",
      "principal",
      "attribution",
      "createdAt",
      "version",
    ],
  ),
  TextDiff: object({
    simplified: { type: "boolean" },
    parts: {
      type: "array",
      items: object({
        type: { enum: ["unchanged", "added", "removed"] },
        text: string,
      }),
    },
  }),
  DocumentComparison: object({
    from: ref("Document"),
    to: ref("Document"),
    title: ref("TextDiff"),
    content: ref("TextDiff"),
  }),
  Project: project,
  DirectoryUser: object(
    {
      principal: string,
      username: string,
      name: string,
      email: string,
      enabled: { type: "boolean" },
      status: string,
    },
    ["principal", "username", "name", "enabled", "status"],
  ),
  GroupSync: object(
    {
      project: string,
      generation: version,
      status: { enum: ["pending", "syncing", "ready", "deleted", "error"] },
      requestedAt: date,
      completedAt: date,
      error: string,
      missingUsers: { type: "integer" },
    },
    ["project", "generation", "status", "requestedAt"],
  ),
  ProjectGroups: object({
    project: string,
    deleted: { type: "boolean" },
    groups: {
      type: "array",
      items: object({
        role: { enum: roles },
        name: string,
        exists: { type: "boolean" },
        owned: { type: "boolean" },
      }),
    },
    sync: ref("GroupSync"),
  }),
  GroupSyncQueued: object({ project: string, status: { const: "pending" } }),
  Membership: membership,
  WorkItem: item,
  Document: document,
  DocumentContent: {
    ...document,
    properties: { ...document.properties, content: string },
    required: [...document.required, "content"],
  },
  Me: object({
    principal: string,
    canCreateProject: { type: "boolean" },
    isDntAdmin: { type: "boolean" },
  }),
  Audit: object(
    {
      before: {},
      after: {},
      changedFields: { type: "array", items: string },
      action: string,
      target: string,
      principal: string,
      at: date,
      attribution: ref("Attribution"),
    },
    ["action", "target", "principal", "at", "attribution"],
  ),
  Error: object(
    { error: string, details: { type: "array", items: { type: "object" } } },
    ["error"],
  ),
};
for (const [name, schema] of Object.entries({
  ProjectInput: projectInput,
  CommentInput: commentInput,
  CommentPatch: commentPatch,
  CommentImportInput: commentImportInput,
  ReactionInput: reactionInput,
  ItemInput: itemInput,
  ItemPatch: itemPatch,
  DocInput: docInput,
  DocPatch: docPatch,
  MemberInput: memberInput,
}))
  schemas[name] = z.toJSONSchema(schema, { io: "input" });
for (const name of [
  "DirectoryUser",
  "Membership",
  "WorkItem",
  "Document",
  "Audit",
  "WorkItemComment",
  "CommentReaction",
])
  schemas[`${name}Page`] = object(
    { items: { type: "array", items: ref(name) }, nextCursor: string },
    ["items"],
  );
const pathParameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: ["tree", "role"].includes(name)
    ? { type: "string", enum: roles }
    : string,
});
const header = (name: string, required: boolean, description: string) => ({
  name,
  in: "header",
  required,
  description,
  schema: string,
});
const paths: Record<string, Record<string, unknown>> = {};
function route(
  path: string,
  method: string,
  operationId: string,
  summary: string,
  output?: string,
  input?: string,
  options: { paginated?: boolean; version?: boolean; status?: number } = {},
) {
  const parameters: unknown[] = [...path.matchAll(/\{([^}]+)\}/g)].map((m) =>
    pathParameter(m[1]),
  );
  if (method === "post")
    parameters.push(
      header(
        "Idempotency-Key",
        true,
        "8–128 letters, numbers, dots, underscores or hyphens. Reuse the same key and body when retrying. Retained indefinitely; scoped to actor and request path.",
      ),
    );
  if (options.version || operationId === "setMember")
    parameters.push(
      header(
        "If-Match",
        !!options.version,
        'Quoted numeric version from a read, for example "2". Required when changing an existing membership.',
      ),
    );
  if (options.paginated)
    parameters.push(
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      },
      {
        name: "cursor",
        in: "query",
        schema: string,
        description: "Pass nextCursor unchanged from the previous page.",
      },
    );
  if (operationId === "compareDocumentRevisions")
    parameters.push(
      ...["from", "to"].map((name) => ({
        name,
        in: "query",
        required: true,
        schema: { type: "integer", minimum: 1, maximum: 999999999999 },
      })),
    );
  if (operationId === "listProjectUsers")
    parameters.push({
      name: "search",
      in: "query",
      description: "Email prefix, case-sensitive",
      schema: { type: "string", maxLength: 128 },
    });
  if (["listProjectUsers", "listProjectGroupUsers"].includes(operationId)) {
    const limit = parameters.find((p: any) => p.name === "limit") as any;
    limit.schema.maximum = 60;
    limit.schema.default = 60;
  }
  if (operationId === "listProjects")
    parameters.push({
      name: "includeDeleted",
      in: "query",
      schema: { type: "boolean", default: false },
      description:
        "Include deleted projects only for their former administrators to monitor/retry group cleanup.",
    });
  const responses: Record<string, unknown> = {};
  for (const code of [400, 401, 403, 404, 409, 412, 413, 428, 429, 500, 503])
    responses[code] = {
      description: {
        400: "Invalid request",
        401: "Unauthenticated",
        403: "Insufficient permission",
        404: "Not found or concealed",
        409: "Conflict; retry a create with the same key, or reload",
        412: "Stale version; reload before editing",
        413: "Payload too large",
        428: "Missing If-Match",
        429: "Throttled; back off",
        500: "Internal error",
        503: "Cannot verify current administration-group membership",
      }[code],
      content: json(ref("Error")),
    };
  responses[
    options.status ??
      (method === "post" ? 201 : method === "delete" ? 204 : 200)
  ] = {
    description: "Success",
    ...(output
      ? {
          content: json(ref(output)),
          headers: {
            ETag: {
              description: "Quoted record version when returned",
              schema: string,
            },
          },
        }
      : {}),
  };
  if (operationId === "setMember")
    responses[200] = {
      description: "Membership updated",
      content: json(ref("Membership")),
    };
  (paths[path] ??= {})[method] = {
    operationId,
    summary,
    parameters,
    ...(input
      ? { requestBody: { required: true, content: json(ref(input)) } }
      : {}),
    responses,
  };
}
route(
  "/me",
  "get",
  "getIdentity",
  "Get the authenticated principal and project-creation capability",
  "Me",
);
route(
  "/projects",
  "get",
  "listProjects",
  "List the caller’s project memberships",
  "MembershipPage",
  undefined,
  { paginated: true },
);
route(
  "/projects",
  "post",
  "createProject",
  "Create a project; current dnt-admin Cognito group membership required",
  "Project",
  "ProjectInput",
);
route(
  "/projects/{project}",
  "get",
  "getProject",
  "Read a project; membership required",
  "Project",
);
route(
  "/projects/{project}/items",
  "get",
  "listWorkItems",
  "List work items in shared project ordinal order",
  "WorkItemPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/items",
  "post",
  "createWorkItem",
  "Create an initiative, epic, or task; Maintainer required",
  "WorkItem",
  "ItemInput",
);
route(
  "/projects/{project}/items/{id}",
  "get",
  "getWorkItem",
  "Read a work item",
  "WorkItem",
);
route(
  "/projects/{project}/items/{id}",
  "patch",
  "updateWorkItem",
  "Update an item using its current version; item kind is immutable",
  "WorkItem",
  "ItemPatch",
  { version: true },
);
route(
  "/projects/{project}/items/{id}/comments",
  "get",
  "listWorkItemComments",
  "List Initiative, Epic or Task comments; project membership required",
  "WorkItemCommentPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/items/{id}/comments",
  "post",
  "createWorkItemComment",
  "Add a Markdown comment/reply; Maintainer required",
  "WorkItemComment",
  "CommentInput",
);
route(
  "/projects/{project}/items/{id}/comments/{commentId}",
  "patch",
  "updateWorkItemComment",
  "Edit a comment as Maintainer, retaining immutable history",
  "WorkItemComment",
  "CommentPatch",
  { version: true },
);
route(
  "/projects/{project}/items/{id}/comments/{commentId}/revisions",
  "get",
  "listWorkItemCommentRevisions",
  "List immutable comment revisions including Markdown, oldest first; project membership required",
  "WorkItemCommentPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/items/{id}",
  "delete",
  "deleteWorkItem",
  "Soft-delete a work item; Maintainer required",
  "WorkItem",
  undefined,
  { version: true },
);
route(
  "/projects/{project}/items/{id}/revisions",
  "get",
  "listWorkItemRevisions",
  "List immutable work-item scope/state history",
  "WorkItemPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/items/{id}/revisions/{revision}",
  "get",
  "getWorkItemRevision",
  "Read an exact historical work-item version",
  "WorkItem",
);
route(
  "/projects/{project}/items/{id}/comments/{commentId}/reactions",
  "get",
  "listCommentReactions",
  "List attributed approval/acknowledgement records for exact revisions",
  "CommentReactionPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/items/{id}/comments/{commentId}/reactions",
  "post",
  "reactToComment",
  "Approve or acknowledge an exact revision; Maintainer required",
  "CommentReaction",
  "ReactionInput",
);
route(
  "/projects/{project}/items/{id}/comments/{commentId}/reactions/{reactionId}",
  "delete",
  "withdrawCommentReaction",
  "Withdraw your own reaction, retaining audit",
  "CommentReaction",
  undefined,
  { version: true },
);
route(
  "/projects/{project}/items/{id}/comments/import",
  "post",
  "importWorkItemComment",
  "Import historical evidence without creating a live approval",
  "WorkItemComment",
  "CommentImportInput",
);
route(
  "/documents/{reference}",
  "get",
  "resolveDocumentLink",
  "Resolve a direct document link with normal project/tree permissions",
  "DocumentContent",
);
route(
  "/public/documents/{reference}",
  "get",
  "getPublicDocument",
  "Read only the current page by direct link; no authentication or listing; private/deleted/missing pages return 404",
  "PublicDocument",
);
paths["/public/documents/{reference}"].get = {
  ...(paths["/public/documents/{reference}"].get as object),
  security: [],
};
route(
  "/projects/{project}/docs/{tree}/{id}",
  "delete",
  "deleteDocument",
  "Delete a page and revoke public access; same tree permission as editing; delete child pages first; retained revisions are inaccessible",
  undefined,
  undefined,
  { version: true },
);
route(
  "/projects/{project}/docs/{tree}/{id}/compare",
  "get",
  "compareDocumentRevisions",
  "Compare titles and Markdown from any two revisions; current tree permissions apply",
  "DocumentComparison",
);
route(
  "/projects/{project}/docs/{tree}",
  "get",
  "listDocuments",
  "List document metadata in a role-restricted tree",
  "DocumentPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/docs/{tree}",
  "post",
  "createDocument",
  "Create a Markdown page; same-tree parent only, at most 100 KB UTF-8 content",
  "Document",
  "DocInput",
);
route(
  "/projects/{project}/docs/{tree}/{id}",
  "get",
  "getDocument",
  "Read current document and Markdown body",
  "DocumentContent",
);
route(
  "/projects/{project}/docs/{tree}/{id}",
  "patch",
  "updateDocument",
  "Save a new immutable revision; parent and tree cannot change",
  "Document",
  "DocPatch",
  { version: true },
);
route(
  "/projects/{project}/docs/{tree}/{id}/revisions",
  "get",
  "listDocumentRevisions",
  "List document revision metadata, oldest first",
  "DocumentPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/docs/{tree}/{id}/revisions/{version}",
  "get",
  "getDocumentRevision",
  "Read a previous revision; save its content with PATCH to restore",
  "DocumentContent",
);
route(
  "/projects/{project}/members",
  "get",
  "listMembers",
  "List project members; Administrator required",
  "MembershipPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/members",
  "post",
  "setMember",
  "Grant or change a role; Administrator required, cannot demote final administrator",
  "Membership",
  "MemberInput",
);
route(
  "/projects/{project}/members/{principal}",
  "delete",
  "removeMember",
  "Remove a membership; URL-encode the principal; preserve final administrator",
  undefined,
  undefined,
  { version: true },
);
route(
  "/projects/{project}/audit",
  "get",
  "listAuditEvents",
  "Read mutation audit metadata; Administrator required",
  "AuditPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}",
  "delete",
  "deleteProject",
  "Revoke project access and delete managed Cognito groups asynchronously; dnt-admin membership and project Administrator required; records retained, slug reserved",
  "Project",
  undefined,
  { version: true, status: 202 },
);
route(
  "/projects/{project}/groups",
  "get",
  "getProjectGroups",
  "Read managed groups and synchronization status; Administrator required, including after deletion",
  "ProjectGroups",
);
route(
  "/projects/{project}/groups/reconcile",
  "post",
  "reconcileProjectGroups",
  "Queue reconciliation from dnt memberships to Cognito; Administrator required",
  "GroupSyncQueued",
  undefined,
  { status: 202 },
);
route(
  "/projects/{project}/users",
  "get",
  "listProjectUsers",
  "Search existing Cognito users by email prefix; Administrator required",
  "DirectoryUserPage",
  undefined,
  { paginated: true },
);
route(
  "/projects/{project}/groups/{role}/users",
  "get",
  "listProjectGroupUsers",
  "List actual users in a managed Cognito group; Administrator required",
  "DirectoryUserPage",
  undefined,
  { paginated: true },
);
export const specification = {
  openapi: "3.1.0",
  info: {
    title: "dnt API",
    version: "0.1.0",
    description:
      "Projects, documentation, and work. Bearer tokens use /api/v1; IAM SigV4 uses the regional API Gateway AgentApi endpoint /agent/v1 with the same relative paths. IDs share one sequence across initiatives, epics, and tasks. Lists are paginated; documents have direct-access URLs and optional public sharing of current content; deletion requires a leaf page and revokes its link. No reparent for documentation or hard delete for work items in v1.",
  },
  servers: [
    {
      url: "/api/v1",
      description: "Browser and Cognito clients via CloudFront",
    },
  ],
  security: [{ cognito: [] }, { sigv4: [] }],
  paths,
  components: {
    schemas,
    securitySchemes: {
      cognito: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Cognito access token",
        description:
          "dnt-browser app client; token_use=access and aws.cognito.signin.user.admin scope required",
      },
      sigv4: {
        type: "apiKey",
        in: "header",
        name: "Authorization",
        description:
          "AWS Signature Version 4, service execute-api; use the AgentApi regional URL",
        "x-amazon-apigateway-authtype": "awsSigv4",
      },
    },
  },
};
mkdirSync("public", { recursive: true });
writeFileSync(
  "public/openapi.json",
  JSON.stringify(specification, null, 2) + "\n",
);
