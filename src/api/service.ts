import { compareText } from "../shared/diff.js";
import {
  projectGroups,
  syncKey,
  type Directory,
  type GroupSync,
} from "../groups/model.js";
import { requestSync, isOwned } from "../groups/sync.js";
import { createHash, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  projectInput,
  agentNameSchema,
  commentInput,
  type WorkItemComment,
  type Attribution,
  itemInput,
  itemPatch,
  docInput,
  docPatch,
  memberInput,
  slugSchema,
  roles,
  rank,
  type Project,
  type Membership,
  type WorkItem,
  type Document,
  type Role,
} from "../shared/model.js";
import {
  Conflict,
  type Store,
  type Blobs,
  type Row,
  type Write,
} from "./store.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Request {
  method: string;
  path: string;
  principal: string;
  // Trusted adapter context, never copied from HTTP headers or request bodies.
  userName?: string;
  agentName?: string;
  headers: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  body?: unknown;
}
export interface Response {
  status: number;
  body: any;
  headers?: Record<string, string>;
}
const projectKey = (slug: string) => `PROJECT#${slug}`;
const memberKey = (principal: string, slug: string) => ({
  pk: `PRINCIPAL#${principal}`,
  sk: `PROJECT#${slug}`,
});
const now = () => new Date().toISOString();
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const row = <T>(
  pk: string,
  sk: string,
  value: T & { version: number },
): Row<T> => ({ pk, sk, version: value.version, value });
const need = <T>(value: T | undefined, message = "Not found"): T => {
  if (value === undefined) throw new HttpError(404, message);
  return value;
};
const itemKey = (slug: string, id: string) => {
  const match = id.match(/^([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,11})$/);
  if (!match || match[1] !== slug)
    throw new HttpError(404, "Work item not found");
  return `ITEM#${match[2].padStart(12, "0")}`;
};
const docKey = (tree: string, id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id))
    throw new HttpError(404, "Document not found");
  return `DOC#${tree}#${id}`;
};

export class Service {
  constructor(
    readonly db: Store,
    readonly blobs: Blobs,
    readonly directory: Directory,
    readonly origin = "http://localhost:5173",
  ) {}
  async handle(req: Request): Promise<Response> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.dispatch(req);
      } catch (error) {
        if (error instanceof Conflict && attempt < 4) {
          await new Promise((resolve) =>
            setTimeout(resolve, 5 + Math.random() * 25),
          );
          continue;
        }
        if (error instanceof HttpError)
          return { status: error.status, body: { error: error.message } };
        if (error instanceof ZodError)
          return {
            status: 400,
            body: {
              error: "Invalid request",
              details: error.issues.map((i) => ({
                path: i.path,
                message: i.message,
              })),
            },
          };
        if (error instanceof Conflict)
          return { status: 409, body: { error: error.message } };
        // Never include tokens, document bodies, or untrusted request data in logs.
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        return { status: 500, body: { error: "Internal error" } };
      }
    }
    throw new Error("Unreachable");
  }
  async isDntAdmin(principal: string) {
    try {
      return await this.directory.isDntAdmin(principal);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.name : "DirectoryError",
        }),
      );
      throw new HttpError(
        503,
        "Cannot verify dnt-admin membership. Try again.",
      );
    }
  }
  async requireDntAdmin(principal: string) {
    if (!(await this.isDntAdmin(principal)))
      throw new HttpError(
        403,
        "Membership in the dnt-admin Cognito group is required to create or delete projects",
      );
  }
  async memberDetails(principal: string) {
    if (!principal.startsWith("cognito:")) return {};
    const user = await this.directory.resolve(principal);
    if (!user)
      throw new HttpError(
        400,
        "Cognito user does not exist; select an existing account",
      );
    return {
      username: user.username,
      name: user.name,
      ...(user.email ? { email: user.email } : {}),
    };
  }
  async membership(principal: string, slug: string, minimum: Role = "User") {
    const key = memberKey(principal, slug);
    const membership = await this.db.get<Membership>(key.pk, key.sk);
    // Conceal whether projects exist from non-members.
    if (!membership) throw new HttpError(404, "Project not found");
    if (rank(membership.value.role) < rank(minimum))
      throw new HttpError(403, `${minimum} permission required`);
    return membership;
  }
  requireRole(membership: Row<Membership>, minimum: Role) {
    if (rank(membership.value.role) < rank(minimum))
      throw new HttpError(403, `${minimum} permission required`);
  }
  expected(req: Request, current: Row<any>) {
    const header = req.headers["if-match"];
    if (!header)
      throw new HttpError(
        428,
        "If-Match is required; use the quoted version from the latest read",
      );
    if (header !== `"${current.version}"`)
      throw new HttpError(412, "Version changed. Reload before saving.");
  }
  async page<T>(pk: string, prefix: string, req: Request) {
    const raw = req.query?.limit ?? "100";
    if (!/^\d+$/.test(raw) || +raw < 1 || +raw > 100)
      throw new HttpError(400, "limit must be between 1 and 100");
    const after = req.query?.cursor;
    if (after && (after.length > 500 || !after.startsWith(prefix)))
      throw new HttpError(400, "Invalid cursor");
    const result = await this.db.query<T>(pk, prefix, +raw, after);
    return { items: result.rows.map((r) => r.value), nextCursor: result.next };
  }
  attribution(req: Request): Attribution {
    return {
      principal: req.principal,
      userName: req.userName?.trim() || req.principal,
      ...(req.agentName === undefined
        ? {}
        : { agentName: agentNameSchema.parse(req.agentName) }),
    };
  }
  async mutate(
    req: Request,
    membership: Row<Membership> | undefined,
    project: Row<Project> | undefined,
    work: () => Promise<{
      response: Response;
      writes: Write[];
      action: string;
      target: string;
    }>,
  ): Promise<Response> {
    const attribution = this.attribution(req);
    let idempotency: { pk: string; hash: string } | undefined;
    if (req.method === "POST") {
      const token = req.headers["idempotency-key"];
      if (!token || !/^[\w.-]{8,128}$/.test(token))
        throw new HttpError(
          400,
          "Idempotency-Key must contain 8–128 letters, numbers, dots, underscores or hyphens",
        );
      idempotency = {
        pk: `IDEMP#${digest(`${req.principal}\n${req.path}\n${token}`)}`,
        hash: digest(
          JSON.stringify(req.body ?? null) +
            (attribution.agentName === undefined
              ? ""
              : `\nagentName:${JSON.stringify(attribution.agentName)}`),
        ),
      };
      const old = await this.db.get<{ hash: string; response: Response }>(
        idempotency.pk,
        "RESULT",
      );
      if (old) {
        if (old.value.hash !== idempotency.hash)
          throw new HttpError(
            409,
            "Idempotency-Key was used with a different request",
          );
        return old.value.response;
      }
    }
    const { response, writes, action, target } = await work();
    const pk = project?.pk ?? writes.find((w) => w.row.sk === "META")!.row.pk;
    if (
      project &&
      !writes.some((w) => w.row.pk === project.pk && w.row.sk === "META")
    ) {
      const value = {
        ...project.value,
        version: project.version + 1,
        updatedAt: now(),
      };
      writes.push({
        row: row(project.pk, "META", value),
        expected: project.version,
      });
    }
    if (
      [
        "project.created",
        "project.deleted",
        "membership.set",
        "membership.removed",
        "groups.reconciled",
      ].includes(action)
    )
      writes.push(await requestSync(this.db, pk.slice("PROJECT#".length)));
    writes.push({
      row: {
        pk,
        sk: `AUDIT#${now()}#${randomUUID()}`,
        version: 1,
        value: {
          action,
          target,
          principal: req.principal,
          attribution,
          at: now(),
        },
      },
      expected: null,
    });
    // Retain deduplication records. Never silently repeat a create after TTL expiry.
    if (idempotency)
      writes.push({
        row: {
          pk: idempotency.pk,
          sk: "RESULT",
          version: 1,
          value: { hash: idempotency.hash, response },
        },
        expected: null,
      });
    const checks =
      membership &&
      !writes.some(
        (w) => w.row.pk === membership.pk && w.row.sk === membership.sk,
      )
        ? [
            {
              pk: membership.pk,
              sk: membership.sk,
              version: membership.version,
            },
          ]
        : [];
    await this.db.commit(writes, checks);
    return response;
  }
  async dispatch(req: Request): Promise<Response> {
    let path: string[];
    try {
      path = req.path
        .replace(/^\/(api|agent)\/v1\/?/, "")
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "Invalid path encoding");
    }
    if (!/^\/(api|agent)\/v1(?:\/|$)/.test(req.path))
      throw new HttpError(404, "Not found");
    const [resource, slug, child, id, action, revision] = path;
    const method = req.method;
    if (resource === "me" && path.length === 1 && method === "GET") {
      const isDntAdmin = await this.isDntAdmin(req.principal);
      return {
        status: 200,
        body: {
          principal: req.principal,
          isDntAdmin,
          canCreateProject: isDntAdmin,
        },
      };
    }
    if (resource !== "projects") throw new HttpError(404, "Not found");
    if (!slug) {
      if (method === "GET") {
        const includeDeleted = req.query?.includeDeleted;
        if (
          includeDeleted !== undefined &&
          !["true", "false"].includes(includeDeleted)
        )
          throw new HttpError(400, "includeDeleted must be true or false");
        const page = await this.page<Membership>(
          `PRINCIPAL#${req.principal}`,
          "PROJECT#",
          req,
        );
        const visible = await Promise.all(
          page.items.map(async (m) => {
            const project = await this.db.get<Project>(
              projectKey(m.project),
              "META",
            );
            if (!project) return undefined;
            if (!project.value.deletedAt) return m;
            return includeDeleted === "true" && m.role === "Administrator"
              ? { ...m, deletedAt: project.value.deletedAt }
              : undefined;
          }),
        );
        return {
          status: 200,
          body: { ...page, items: visible.filter(Boolean) },
        };
      }
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      await this.requireDntAdmin(req.principal);
      const input = projectInput.parse(req.body);
      return this.mutate(req, undefined, undefined, async () => {
        const pk = projectKey(input.slug);
        if (await this.db.get(pk, "META"))
          throw new HttpError(409, "Project slug already exists");
        const project: Project = {
          ...input,
          sequence: 0,
          administrators: 1,
          version: 1,
          createdAt: now(),
          updatedAt: now(),
        };
        const membership: Membership = {
          ...(await this.memberDetails(req.principal)),
          principal: req.principal,
          project: input.slug,
          role: "Administrator",
          version: 1,
        };
        const key = memberKey(req.principal, input.slug);
        return {
          response: { status: 201, body: project, headers: { etag: '"1"' } },
          action: "project.created",
          target: input.slug,
          writes: [
            { row: row(pk, "META", project), expected: null },
            { row: row(key.pk, key.sk, membership), expected: null },
            {
              row: row(pk, `MEMBER#${req.principal}`, membership),
              expected: null,
            },
          ],
        };
      });
    }
    slugSchema.parse(slug);
    const pk = projectKey(slug);
    // Read the project lock before authorization: it also prevents membership ABA races.
    const existingProject = await this.db.get<Project>(pk, "META");
    const membership = await this.membership(req.principal, slug);
    const project = need(existingProject);
    if (child === "groups" || child === "users") {
      this.requireRole(membership, "Administrator");
      if (
        child === "groups" &&
        id === "reconcile" &&
        path.length === 4 &&
        method === "POST"
      )
        return this.mutate(req, membership, project, async () => ({
          response: { status: 202, body: { project: slug, status: "pending" } },
          writes: [],
          action: "groups.reconciled",
          target: slug,
        }));
      if (child === "groups" && !id && method === "GET") {
        const sync = need(
          await this.db.get<GroupSync>(pk, syncKey(slug).sk),
          "Project synchronization not found",
        );
        const groups = await Promise.all(
          projectGroups(slug).map(async (g) => {
            const existing = await this.directory!.group(g.name);
            return {
              ...g,
              exists: !!existing,
              owned: !!existing && isOwned(existing, this.origin, slug, g.role),
            };
          }),
        );
        return {
          status: 200,
          body: {
            project: slug,
            deleted: !!project.value.deletedAt,
            groups,
            sync: sync.value,
          },
        };
      }
      if (project.value.deletedAt)
        throw new HttpError(404, "Project not found");
      if (
        method === "GET" &&
        ((child === "users" && !id) ||
          (child === "groups" && action === "users" && path.length === 5))
      ) {
        const limit = req.query?.limit ?? "60";
        if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 60)
          throw new HttpError(400, "limit must be between 1 and 60");
        const cursor = req.query?.cursor;
        if (cursor && cursor.length > 4096)
          throw new HttpError(400, "Invalid cursor");
        if (child === "users") {
          const search = req.query?.search ?? "";
          if (search.length > 128)
            throw new HttpError(400, "Search is too long");
          return {
            status: 200,
            body: await this.directory.users(search, +limit, cursor),
          };
        }
        const group = projectGroups(slug).find((g) => g.role === id);
        if (!group) throw new HttpError(400, "Invalid project role");
        const existing = await this.directory.group(group.name);
        if (!existing) return { status: 200, body: { items: [] } };
        if (!isOwned(existing, this.origin, slug, group.role))
          throw new HttpError(409, "Group belongs to another application");
        return {
          status: 200,
          body: await this.directory.groupUsers(group.name, +limit, cursor),
        };
      }
      throw new HttpError(405, "Method not allowed");
    }
    if (project.value.deletedAt) throw new HttpError(404, "Project not found");
    if (!child && method === "DELETE") {
      this.requireRole(membership, "Administrator");
      await this.requireDntAdmin(req.principal);
      this.expected(req, project);
      return this.mutate(req, membership, project, async () => {
        const value = {
          ...project.value,
          deletedAt: now(),
          updatedAt: now(),
          version: project.version + 1,
        };
        return {
          response: { status: 202, body: value },
          writes: [{ row: row(pk, "META", value), expected: project.version }],
          action: "project.deleted",
          target: slug,
        };
      });
    }
    if (!child && method === "GET")
      return {
        status: 200,
        body: project.value,
        headers: { etag: `"${project.version}"` },
      };
    if (child === "members") {
      this.requireRole(membership, "Administrator");
      if (!id && method === "GET")
        return {
          status: 200,
          body: await this.page<Membership>(pk, "MEMBER#", req),
        };
      if (!id && method === "POST") {
        const input = memberInput.parse(req.body);
        return this.mutate(req, membership, project, async () => {
          const key = memberKey(input.principal, slug);
          const old = await this.db.get<Membership>(key.pk, key.sk);
          if (old) this.expected(req, old);
          else if (req.headers["if-match"])
            throw new HttpError(412, "Membership no longer exists");
          const administrators =
            project.value.administrators +
            (input.role === "Administrator" ? 1 : 0) -
            (old?.value.role === "Administrator" ? 1 : 0);
          if (administrators < 1)
            throw new HttpError(409, "A project must retain an administrator");
          const value: Membership = {
            ...(await this.memberDetails(input.principal)),
            ...input,
            project: slug,
            version: (old?.version ?? 0) + 1,
          };
          return {
            response: { status: old ? 200 : 201, body: value },
            action: "membership.set",
            target: input.principal,
            writes: [
              {
                row: row(key.pk, key.sk, value),
                expected: old?.version ?? null,
              },
              {
                row: row(pk, `MEMBER#${input.principal}`, value),
                expected: old?.version ?? null,
              },
              {
                row: row(pk, "META", {
                  ...project.value,
                  administrators,
                  version: project.version + 1,
                  updatedAt: now(),
                }),
                expected: project.version,
              },
            ],
          };
        });
      }
      if (id && !action && method === "DELETE") {
        const key = memberKey(id, slug);
        const old = need(await this.db.get<Membership>(key.pk, key.sk));
        this.expected(req, old);
        return this.mutate(req, membership, project, async () => {
          const administrators =
            project.value.administrators -
            (old.value.role === "Administrator" ? 1 : 0);
          if (administrators < 1)
            throw new HttpError(409, "A project must retain an administrator");
          return {
            response: { status: 204, body: null },
            action: "membership.removed",
            target: id,
            writes: [
              { row: old, expected: old.version, remove: true },
              {
                row: { ...old, pk, sk: `MEMBER#${id}` },
                expected: old.version,
                remove: true,
              },
              {
                row: row(pk, "META", {
                  ...project.value,
                  administrators,
                  version: project.version + 1,
                  updatedAt: now(),
                }),
                expected: project.version,
              },
            ],
          };
        });
      }
    }
    if (
      child === "items" &&
      id &&
      action === "comments" &&
      [5, 6, 7].includes(path.length)
    ) {
      need(
        await this.db.get<WorkItem>(pk, itemKey(slug, id)),
        "Work item not found",
      );
      const prefix = `COMMENT#${itemKey(slug, id)}#`;
      const commentId = path[5];
      const revisionPrefix = (cid: string) =>
        `COMMENT_REV#${itemKey(slug, id)}#${cid}#`;
      if (commentId) {
        if (!/^[0-9a-f-]{36}$/.test(commentId))
          throw new HttpError(404, "Comment not found");
        const indexKey = `COMMENT_ID#${itemKey(slug, id)}#${commentId}`;
        const index = need(
          await this.db.get<{ key: string }>(pk, indexKey),
          "Comment not found",
        );
        const old = need(
          await this.db.get<WorkItemComment>(pk, index.value.key),
          "Comment not found",
        );
        if (path[6] === "revisions" && path.length === 7 && method === "GET") {
          const page = await this.page<WorkItemComment>(
            pk,
            revisionPrefix(commentId),
            req,
          );
          return { status: 200, body: page };
        }
        if (path.length !== 6 || method !== "PATCH")
          throw new HttpError(405, "Method not allowed");
        if (req.principal !== old.value.createdBy)
          this.requireRole(membership, "Administrator");
        this.expected(req, old);
        const input = commentInput.parse(req.body);
        return this.mutate(req, membership, project, async () => {
          const value: WorkItemComment = {
            ...old.value,
            ...input,
            itemId: id,
            version: old.version + 1,
            updatedAt: now(),
            updatedBy: req.principal,
            editAttribution: this.attribution(req),
          };
          const writes: Write[] = [
            { row: row(pk, old.sk, value), expected: old.version },
            {
              row: row(
                pk,
                `${revisionPrefix(commentId)}${String(value.version).padStart(12, "0")}`,
                value,
              ),
              expected: null,
            },
          ];
          return {
            response: { status: 200, body: value },
            writes,
            action: "comment.updated",
            target: `${id}/${commentId}`,
          };
        });
      }
      if (path.length !== 5) throw new HttpError(404, "Not found");
      if (method === "GET")
        return {
          status: 200,
          body: await this.page<WorkItemComment>(pk, prefix, req),
        };
      if (method === "POST") {
        const input = commentInput.parse(req.body);
        return this.mutate(req, membership, project, async () => {
          const value: WorkItemComment = {
            ...input,
            id: randomUUID(),
            project: slug,
            itemId: id,
            version: 1,
            createdAt: now(),
            createdBy: req.principal,
            attribution: this.attribution(req),
          };
          const key = `${prefix}${value.createdAt}#${value.id}`;
          return {
            response: { status: 201, body: value },
            action: "comment.created",
            target: id,
            writes: [
              {
                row: row(pk, key, value),
                expected: null,
              },
              {
                row: {
                  pk,
                  sk: `COMMENT_ID#${itemKey(slug, id)}#${value.id}`,
                  version: 1,
                  value: { key },
                },
                expected: null,
              },
              {
                row: row(pk, `${revisionPrefix(value.id)}000000000001`, value),
                expected: null,
              },
            ],
          };
        });
      }
    }
    if (child === "items" && !action) {
      if (!id && method === "GET")
        return {
          status: 200,
          body: await this.page<WorkItem>(pk, "ITEM#", req),
        };
      if (!id && method === "POST") {
        const input = itemInput.parse(req.body);
        this.requireRole(
          membership,
          input.kind === "Task" ? "User" : "Maintainer",
        );
        return this.mutate(req, membership, project, async () => {
          await this.validateItem(slug, input);
          const ordinal = project.value.sequence + 1;
          if (ordinal > 999999999999)
            throw new HttpError(409, "Project identifier space exhausted");
          const value: WorkItem = {
            ...input,
            state:
              input.kind === "Task" ? (input.state ?? "Concept") : undefined,
            id: `${slug}-${ordinal}`,
            ordinal,
            project: slug,
            version: 1,
            createdAt: now(),
            updatedAt: now(),
            updatedBy: req.principal,
            attribution: this.attribution(req),
          };
          return {
            response: { status: 201, body: value, headers: { etag: '"1"' } },
            action: "item.created",
            target: value.id,
            writes: [
              { row: row(pk, itemKey(slug, value.id), value), expected: null },
              {
                row: row(pk, "META", {
                  ...project.value,
                  sequence: ordinal,
                  version: project.version + 1,
                  updatedAt: now(),
                }),
                expected: project.version,
              },
            ],
          };
        });
      }
      if (id) {
        const current = need(
          await this.db.get<WorkItem>(pk, itemKey(slug, id)),
          "Work item not found",
        );
        if (method === "GET")
          return {
            status: 200,
            body: current.value,
            headers: { etag: `"${current.version}"` },
          };
        if (method === "PATCH") {
          this.requireRole(
            membership,
            current.value.kind === "Task" ? "User" : "Maintainer",
          );
          this.expected(req, current);
          const patch = itemPatch.parse(req.body);
          return this.mutate(req, membership, project, async () => {
            const value = {
              ...current.value,
              ...patch,
              version: current.version + 1,
              updatedAt: now(),
              updatedBy: req.principal,
              attribution: this.attribution(req),
            };
            await this.validateItem(
              slug,
              value,
              value.assignee !== current.value.assignee,
            );
            return {
              response: {
                status: 200,
                body: value,
                headers: { etag: `"${value.version}"` },
              },
              action: "item.updated",
              target: id,
              writes: [
                { row: row(pk, current.sk, value), expected: current.version },
              ],
            };
          });
        }
      }
    }
    if (child === "docs" && id && roles.includes(id as Role)) {
      const tree = id as Role;
      this.requireRole(membership, tree);
      const documentId = action;
      if (!documentId && method === "GET")
        return {
          status: 200,
          body: await this.page<Document>(pk, `DOC#${tree}#`, req),
        };
      if (!documentId && method === "POST") {
        const input = docInput.parse(req.body);
        return this.mutate(req, membership, project, async () => {
          if (input.parentId)
            need(
              await this.db.get(pk, docKey(tree, input.parentId)),
              "Parent document not found in this tree",
            );
          const uuid = randomUUID();
          const objectKey = `${slug}/${tree}/${uuid}/${randomUUID()}.md`;
          await this.blobs.put(objectKey, input.content);
          const value: Document = {
            id: uuid,
            project: slug,
            tree,
            parentId: input.parentId,
            title: input.title,
            objectKey,
            version: 1,
            createdAt: now(),
            updatedAt: now(),
            updatedBy: req.principal,
            attribution: this.attribution(req),
          };
          return {
            response: { status: 201, body: value, headers: { etag: '"1"' } },
            action: "document.created",
            target: uuid,
            writes: [
              { row: row(pk, docKey(tree, uuid), value), expected: null },
              {
                row: row(pk, `REV#${tree}#${uuid}#000000000001`, value),
                expected: null,
              },
            ],
          };
        });
      }
      if (documentId) {
        const current = need(
          await this.db.get<Document>(pk, docKey(tree, documentId)),
          "Document not found",
        );
        if (method === "GET" && revision === "compare" && path.length === 6) {
          const numbers = [req.query?.from, req.query?.to];
          if (numbers.some((n) => !n || !/^[1-9]\d{0,11}$/.test(n)))
            throw new HttpError(
              400,
              "from and to must be positive revision numbers",
            );
          const [from, to] = await Promise.all(
            numbers.map(async (n) => {
              const record = need(
                await this.db.get<Document>(
                  pk,
                  `REV#${tree}#${documentId}#${n!.padStart(12, "0")}`,
                ),
                "Revision not found",
              );
              return {
                ...record.value,
                content: await this.blobs.get(record.value.objectKey),
              };
            }),
          );
          const { content: before, ...fromMetadata } = from;
          const { content: after, ...toMetadata } = to;
          return {
            status: 200,
            body: {
              from: fromMetadata,
              to: toMetadata,
              title: compareText(from.title, to.title),
              content: compareText(before, after),
            },
          };
        }
        if (method === "GET" && revision === "revisions") {
          if (!path[6])
            return {
              status: 200,
              body: await this.page<Document>(
                pk,
                `REV#${tree}#${documentId}#`,
                req,
              ),
            };
          if (!/^[1-9]\d{0,11}$/.test(path[6]))
            throw new HttpError(400, "Invalid revision");
          const old = need(
            await this.db.get<Document>(
              pk,
              `REV#${tree}#${documentId}#${path[6].padStart(12, "0")}`,
            ),
          );
          return {
            status: 200,
            body: {
              ...old.value,
              content: await this.blobs.get(old.value.objectKey),
            },
          };
        }
        if (!revision && method === "GET")
          return {
            status: 200,
            body: {
              ...current.value,
              content: await this.blobs.get(current.value.objectKey),
            },
            headers: { etag: `"${current.version}"` },
          };
        if (!revision && method === "PATCH") {
          this.expected(req, current);
          const patch = docPatch.parse(req.body);
          return this.mutate(req, membership, project, async () => {
            const objectKey =
              patch.content === undefined
                ? current.value.objectKey
                : `${slug}/${tree}/${documentId}/${randomUUID()}.md`;
            if (patch.content !== undefined)
              await this.blobs.put(objectKey, patch.content);
            const value: Document = {
              ...current.value,
              title: patch.title ?? current.value.title,
              objectKey,
              version: current.version + 1,
              updatedAt: now(),
              updatedBy: req.principal,
              attribution: this.attribution(req),
            };
            return {
              response: {
                status: 200,
                body: value,
                headers: { etag: `"${value.version}"` },
              },
              action: "document.updated",
              target: documentId,
              writes: [
                { row: row(pk, current.sk, value), expected: current.version },
                {
                  row: row(
                    pk,
                    `REV#${tree}#${documentId}#${String(value.version).padStart(12, "0")}`,
                    value,
                  ),
                  expected: null,
                },
              ],
            };
          });
        }
      }
    }
    if (child === "audit" && !id && method === "GET") {
      this.requireRole(membership, "Administrator");
      return { status: 200, body: await this.page(pk, "AUDIT#", req) };
    }
    throw new HttpError(404, "Not found");
  }
  async validateItem(
    slug: string,
    value: Pick<WorkItem, "kind" | "parentId" | "state" | "assignee">,
    validateAssignee = true,
  ) {
    if (value.kind !== "Task" && value.state !== undefined)
      throw new HttpError(400, "Only tasks have a workflow state");
    if (value.kind === "Initiative") {
      if (value.parentId)
        throw new HttpError(400, "Initiatives cannot have a parent");
    } else {
      if (!value.parentId)
        throw new HttpError(400, `${value.kind} requires a parent`);
      const parent = need(
        await this.db.get<WorkItem>(
          projectKey(slug),
          itemKey(slug, value.parentId),
        ),
        "Parent not found",
      );
      if (parent.value.kind !== (value.kind === "Task" ? "Epic" : "Initiative"))
        throw new HttpError(400, "Invalid parent type");
    }
    if (validateAssignee && value.assignee) {
      const key = memberKey(value.assignee, slug);
      if (!(await this.db.get(key.pk, key.sk)))
        throw new HttpError(400, "Assignee must be a project member");
    }
  }
}
