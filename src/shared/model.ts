import { z } from "zod";

export const roles = ["User", "Maintainer", "Administrator"] as const;
export const states = [
  "Concept",
  "Implement",
  "Needs Attention",
  "Review",
  "Done",
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
export const itemInput = z
  .object({
    kind: z.enum(kinds),
    title,
    description: z.string().max(20_000).default(""),
    parentId: z.string().max(32).nullable().default(null),
    state: z.enum(states).optional(),
    assignee: principalSchema.nullable().default(null),
  })
  .strict();
export const itemPatch = z
  .object({
    title: title.optional(),
    description: z.string().max(20_000).optional(),
    parentId: z.string().max(32).nullable().optional(),
    state: z.enum(states).optional(),
    assignee: principalSchema.nullable().optional(),
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
    content: z
      .string()
      .min(1)
      .max(20_000)
      .refine((value) => !!value.trim(), "Comment cannot be blank"),
  })
  .strict();
export interface WorkItemComment {
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
