import { roles, slugSchema, type Role, type Page } from "../shared/model.js";
export const groupSuffix: Record<Role, string> = {
  Administrator: "admin",
  Maintainer: "maintainer",
  User: "viewer",
};
export const groupName = (project: string, role: Role) =>
  `dnt-proj-${slugSchema.parse(project)}-${groupSuffix[role]}`;
export const projectGroups = (project: string) =>
  [...roles]
    .reverse()
    .map((role) => ({ role, name: groupName(project, role) }));
export const syncKey = (project: string) => ({
  pk: `PROJECT#${slugSchema.parse(project)}`,
  sk: "GROUP_SYNC",
});
export interface GroupSync {
  project: string;
  generation: number;
  status: "pending" | "syncing" | "ready" | "deleted" | "error";
  requestedAt: string;
  completedAt?: string;
  error?: string;
  missingUsers?: number;
}
export interface DirectoryUser {
  principal: string;
  username: string;
  name: string;
  email?: string;
  enabled: boolean;
  status: string;
}
export interface DirectoryGroup {
  name: string;
  description?: string;
  roleArn?: string;
}
export interface Directory {
  resolve(principal: string): Promise<DirectoryUser | undefined>;
  users(
    search: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<DirectoryUser>>;
  group(name: string): Promise<DirectoryGroup | undefined>;
  groupUsers(
    name: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<DirectoryUser>>;
  createGroup(name: string, description: string): Promise<void>;
  deleteGroup(name: string): Promise<void>;
  addUser(name: string, username: string): Promise<void>;
  removeUser(name: string, username: string): Promise<void>;
}
export class GroupOwnershipError extends Error {
  constructor() {
    super("A group name is already owned outside this dnt project");
    this.name = "GroupOwnershipError";
  }
}
