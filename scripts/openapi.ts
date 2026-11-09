import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  docInput,
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
const membership = object({
  project: string,
  principal: string,
  role: { enum: roles },
  version,
});
const item = object(
  {
    id: string,
    project: string,
    ordinal: { type: "integer", minimum: 1 },
    kind: { enum: kinds },
    parentId: { type: ["string", "null"] },
    title: string,
    description: string,
    state: { enum: states },
    assignee: { type: ["string", "null"] },
    version,
    createdAt: date,
    updatedAt: date,
    updatedBy: string,
  },
  [
    "id",
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
  ],
);
const document = object({
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
});
const schemas: Record<string, unknown> = {
  Project: project,
  Membership: membership,
  WorkItem: item,
  Document: document,
  DocumentContent: {
    ...document,
    properties: { ...document.properties, content: string },
    required: [...document.required, "content"],
  },
  Me: object({ principal: string, canCreateProject: { type: "boolean" } }),
  Audit: object({
    action: string,
    target: string,
    principal: string,
    at: date,
  }),
  Error: object(
    { error: string, details: { type: "array", items: { type: "object" } } },
    ["error"],
  ),
};
for (const [name, schema] of Object.entries({
  ProjectInput: projectInput,
  ItemInput: itemInput,
  ItemPatch: itemPatch,
  DocInput: docInput,
  DocPatch: docPatch,
  MemberInput: memberInput,
}))
  schemas[name] = z.toJSONSchema(schema, { io: "input" });
for (const name of ["Membership", "WorkItem", "Document", "Audit"])
  schemas[`${name}Page`] = object(
    { items: { type: "array", items: ref(name) }, nextCursor: string },
    ["items"],
  );
const pathParameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: name === "tree" ? { type: "string", enum: roles } : string,
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
  const responses: Record<string, unknown> = {};
  for (const code of [400, 401, 403, 404, 409, 412, 413, 428, 429, 500])
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
  "Create a project; configured operators only",
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
  "Create an initiative, epic, or task; Maintainer required except tasks",
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
export const specification = {
  openapi: "3.1.0",
  info: {
    title: "dnt API",
    version: "0.1.0",
    description:
      "Projects, documentation, and work. Bearer tokens use /api/v1; IAM SigV4 uses the regional API Gateway AgentApi endpoint /agent/v1 with the same relative paths. IDs share one sequence across initiatives, epics, and tasks. Lists are paginated; no delete/reparent for documentation or hard delete for work items in v1.",
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
          "dnt app client; token_use=access and openid scope required",
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
