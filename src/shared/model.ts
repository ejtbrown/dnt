import { z } from "zod";

export const roles = ["User", "Maintainer", "Administrator"] as const;
export const states = [
  "Concept",
  "Implement",
  "Needs Attention",
  "Review",
  "Done",
  "Cancelled",
] as const;
export const kinds = ["Initiative", "Epic", "Task"] as const;
export type Role = (typeof roles)[number];
export type State = (typeof states)[number];
export type Kind = (typeof kinds)[number];
export const rank = (role: Role) => roles.indexOf(role);
export const slugSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9]{1,9}$/,
    "Use 2–10 uppercase letters or numbers, beginning with a letter",
  );
export const principalSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(cognito:[^\s#]+|iam:arn:aws:iam::\d{12}:(role|user)\/[^\s#]+)$/,
    "Use cognito:<sub> or iam:<IAM role/user ARN>",
  );
const title = z.string().trim().min(1).max(200);
const markdown = z
  .string()
  .max(100_000)
  .refine(
    (v) => new TextEncoder().encode(v).length <= 100_000,
    "Content must be at most 100 KB",
  );
export const agentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // Keep Unicode-category validation on the server. Publishing this regex in
  // JSON Schema breaks clients whose regex engine does not support JS \p escapes.
  .refine(
    (value) => /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u.test(value),
    "Use a single-line agent name without control characters",
  );
export interface Attribution {
  principal: string;
  userName: string;
  agentName?: string;
  source?: "web" | "mcp" | "agent" | "unknown";
}
export const attributionLabel = (value: Attribution) =>
  `${value.userName}${value.agentName ? ` via ${value.agentName}` : ""}`;

export const projectInput = z
  .object({
    slug: slugSchema,
    name: title,
    description: z.string().max(2000).default(""),
  })
  .strict();
const taskId = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,11}$/);
const taskLinks = z
  .array(taskId)
  .max(50)
  .refine((v) => new Set(v).size === v.length, "Duplicate task links");
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Invalid calendar date");
export const itemInput = z
  .object({
    kind: z.enum(kinds),
    title,
    description: z.string().max(20_000).default(""),
    parentId: z.string().max(32).nullable().default(null),
    state: z.enum(states).optional(),
    assignee: principalSchema.nullable().default(null),
    dueDate: dueDate.nullable().optional(),
    dependencies: taskLinks.default([]),
    relatedTasks: taskLinks.default([]),
  })
  .strict();
export const itemPatch = z
  .object({
    title: title.optional(),
    description: z.string().max(20_000).optional(),
    parentId: z.string().max(32).nullable().optional(),
    state: z.enum(states).optional(),
    assignee: principalSchema.nullable().optional(),
    dueDate: dueDate.nullable().optional(),
    dependencies: taskLinks.optional(),
    relatedTasks: taskLinks.optional(),
  })
  .strict();
export const docInput = z
  .object({
    title,
    content: markdown,
    public: z
      .boolean()
      .default(false)
      .describe(
        "Publish the current page at its direct link without authentication. Defaults to private; does not publish history.",
      ),
    parentId: z.string().uuid().nullable().default(null),
  })
  .strict();
export const docPatch = docInput
  .omit({ parentId: true, public: true })
  .partial()
  .extend({
    public: z
      .boolean()
      .optional()
      .describe(
        "True publishes the current page; false immediately revokes anonymous access. Requires the same tree permission as editing.",
      ),
  })
  .strict();
export const memberInput = z
  .object({ principal: principalSchema, role: z.enum(roles) })
  .strict();

export interface Project {
  deletedAt?: string;
  slug: string;
  name: string;
  description: string;
  sequence: number;
  administrators: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface Membership {
  // Added only by project listings when an administrator includes deleted projects.
  deletedAt?: string;
  username?: string;
  name?: string;
  email?: string;
  principal: string;
  project: string;
  role: Role;
  version: number;
}
export interface WorkItem {
  id: string;
  project: string;
  ordinal: number;
  kind: Kind;
  parentId: string | null;
  title: string;
  description: string;
  state?: State;
  assignee: string | null;
  dueDate?: string | null;
  dependencies?: string[];
  relatedTasks?: string[];
  deletedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  attribution: Attribution;
}
export interface Document {
  public: boolean;
  id: string;
  project: string;
  tree: Role;
  parentId: string | null;
  title: string;
  objectKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  attribution: Attribution;
}
export interface PublicDocument {
  id: string;
  tree: Role;
  title: string;
  content: string;
  updatedAt: string;
  public: true;
}
export const commentInput = z
  .object({
    parentCommentId: z.string().uuid().nullable().optional(),
    parentCommentVersion: z.number().int().positive().optional(),
    content: z
      .string()
      .min(1)
      .max(20_000)
      .refine((value) => !!value.trim(), "Comment cannot be blank"),
  })
  .strict();
export const commentPatch = commentInput.pick({ content: true });
export const reactionInput = z
  .object({
    kind: z.enum(["approval", "acknowledgement"]),
    commentVersion: z.number().int().positive(),
  })
  .strict();
export interface CommentReaction {
  id: string;
  project: string;
  itemId: string;
  commentId: string;
  commentVersion: number;
  kind: "approval" | "acknowledgement";
  principal: string;
  attribution: Attribution;
  createdAt: string;
  version: number;
  withdrawnAt?: string;
}
const historicalSource = z
  .object({
    system: z.enum(["jira", "confluence", "other"]),
    id: z.string().trim().min(1).max(300),
    url: z
      .string()
      .url()
      .max(2000)
      .refine(
        (v) => new URL(v).protocol === "https:",
        "Source URL must use HTTPS",
      ),
    author: z.string().trim().min(1).max(300),
    createdAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export const commentImportInput = commentInput
  .extend({
    source: historicalSource,
    historicalApprovals: z
      .array(
        z
          .object({
            kind: z.enum(["approval", "acknowledgement"]),
            author: z.string().trim().min(1).max(300),
            sourceId: z.string().trim().min(1).max(300).optional(),
            createdAt: z.string().datetime({ offset: true }).optional(),
            sourceRevision: z.string().trim().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export interface ImportedCommentEvidence {
  historical: true;
  source: z.infer<typeof historicalSource>;
  historicalApprovals: z.infer<
    typeof commentImportInput
  >["historicalApprovals"];
  importedAt: string;
  importedBy: string;
}
export interface WorkItemComment {
  importedEvidence?: ImportedCommentEvidence;
  parentCommentId?: string | null;
  parentCommentVersion?: number;
  itemId: string;
  updatedAt?: string;
  updatedBy?: string;
  editAttribution?: Attribution;
  id: string;
  project: string;
  content: string;
  version: number;
  createdAt: string;
  createdBy: string;
  attribution: Attribution;
}
export interface AuditEvent {
  before?: unknown;
  after?: unknown;
  changedFields?: string[];
  action: string;
  target: string;
  principal: string;
  at: string;
  attribution: Attribution;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface Me {
  principal: string;
  canCreateProject: boolean;
  isDntAdmin: boolean;
}
