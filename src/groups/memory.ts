import type { Directory, DirectoryUser, DirectoryGroup } from "./model.js";
// Development/test directory. Never imported by a production handler.
export class MemoryDirectory implements Directory {
  accounts = new Map<string, DirectoryUser>();
  groups = new Map<string, DirectoryGroup & { users: Set<string> }>();
  readonly administrators: Set<string>;
  constructor(
    private permissive = false,
    adminPrincipals: string[] = [],
  ) {
    this.administrators = new Set(adminPrincipals);
    for (const [id, name] of [
      ["local-developer", "Local Developer"],
      ["teammate", "Teammate"],
    ])
      this.accounts.set(`cognito:${id}`, {
        principal: `cognito:${id}`,
        username: id,
        name,
        email: `${id}@example.com`,
        enabled: true,
        status: "CONFIRMED",
      });
  }
  async resolve(principal: string) {
    if (
      !this.accounts.has(principal) &&
      this.permissive &&
      principal.startsWith("cognito:")
    )
      this.accounts.set(principal, {
        principal,
        username: principal.slice(8),
        name: principal.slice(8),
        enabled: true,
        status: "CONFIRMED",
      });
    return this.accounts.get(principal);
  }
  async isDntAdmin(principal: string) {
    return (
      principal.startsWith("cognito:") &&
      this.administrators.has(principal) &&
      !!(await this.resolve(principal))?.enabled
    );
  }
  async users(search: string, limit: number, cursor?: string) {
    const rows = [...this.accounts.values()].filter(
      (u) => !search || u.email?.startsWith(search),
    );
    const start = +(cursor ?? 0);
    return {
      items: rows.slice(start, start + limit),
      nextCursor:
        start + limit < rows.length ? String(start + limit) : undefined,
    };
  }
  async group(name: string) {
    return this.groups.get(name);
  }
  async groupUsers(name: string, limit: number, cursor?: string) {
    const rows = [...(this.groups.get(name)?.users ?? [])]
      .map((username) =>
        [...this.accounts.values()].find((u) => u.username === username)!,
      )
      .filter(Boolean);
    const start = +(cursor ?? 0);
    return {
      items: rows.slice(start, start + limit),
      nextCursor:
        start + limit < rows.length ? String(start + limit) : undefined,
    };
  }
  async createGroup(name: string, description: string) {
    if (!this.groups.has(name))
      this.groups.set(name, { name, description, users: new Set() });
  }
  async deleteGroup(name: string) {
    this.groups.delete(name);
  }
  async addUser(name: string, username: string) {
    this.groups.get(name)!.users.add(username);
  }
  async removeUser(name: string, username: string) {
    this.groups.get(name)?.users.delete(username);
  }
}
