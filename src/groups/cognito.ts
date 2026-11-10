import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  ListUsersCommand,
  GetGroupCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Directory, DirectoryUser } from "./model.js";
const code = (error: unknown) =>
  error instanceof Error ? error.name : "UnknownError";
const quoted = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
export function directoryUser(user: UserType): DirectoryUser | undefined {
  const a = Object.fromEntries(
    (user.Attributes ?? []).map((a) => [a.Name!, a.Value]),
  );
  if (!a.sub || !user.Username) return;
  return {
    principal: `cognito:${a.sub}`,
    username: user.Username,
    name: a.name || a.preferred_username || a.email || user.Username,
    ...(a.email ? { email: a.email } : {}),
    enabled: user.Enabled ?? false,
    status: user.UserStatus ?? "UNKNOWN",
  };
}
export class CognitoDirectory implements Directory {
  constructor(
    readonly poolId: string,
    private client = new CognitoIdentityProviderClient({}),
  ) {}
  private options() {
    return { abortSignal: AbortSignal.timeout(5000) };
  }
  async resolve(principal: string) {
    if (!/^cognito:[0-9a-f-]{36}$/.test(principal)) return;
    const sub = principal.slice(8);
    try {
      const user = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.poolId, Username: sub }),
        this.options(),
      );
      const result = directoryUser({
        ...user,
        Attributes: user.UserAttributes,
      });
      if (result?.principal === principal) return result;
    } catch (e) {
      if (code(e) !== "UserNotFoundException") throw e;
    }
    // Federated accounts may require their immutable Cognito username rather than sub.
    const page = await this.client.send(
      new ListUsersCommand({
        UserPoolId: this.poolId,
        Filter: `sub = "${quoted(sub)}"`,
        Limit: 2,
      }),
      this.options(),
    );
    const match = page.Users?.map(directoryUser).find(
      (u) => u?.principal === principal,
    );
    if (!match) return;
    const user = await this.client.send(
      new AdminGetUserCommand({
        UserPoolId: this.poolId,
        Username: match.username,
      }),
      this.options(),
    );
    const result = directoryUser({ ...user, Attributes: user.UserAttributes });
    return result?.principal === principal ? result : undefined;
  }
  async users(search: string, limit: number, cursor?: string) {
    const result = await this.client.send(
      new ListUsersCommand({
        UserPoolId: this.poolId,
        Limit: limit,
        PaginationToken: cursor,
        ...(search ? { Filter: `email ^= "${quoted(search)}"` } : {}),
      }),
      this.options(),
    );
    return {
      items: (result.Users ?? [])
        .map(directoryUser)
        .filter((u): u is DirectoryUser => !!u),
      nextCursor: result.PaginationToken,
    };
  }
  async group(name: string) {
    try {
      const result = await this.client.send(
        new GetGroupCommand({ UserPoolId: this.poolId, GroupName: name }),
        this.options(),
      );
      return (
        result.Group && {
          name: result.Group.GroupName!,
          description: result.Group.Description,
          roleArn: result.Group.RoleArn,
        }
      );
    } catch (e) {
      if (code(e) === "ResourceNotFoundException") return;
      throw e;
    }
  }
  async groupUsers(name: string, limit: number, cursor?: string) {
    const result = await this.client.send(
      new ListUsersInGroupCommand({
        UserPoolId: this.poolId,
        GroupName: name,
        Limit: limit,
        NextToken: cursor,
      }),
      this.options(),
    );
    return {
      items: (result.Users ?? [])
        .map(directoryUser)
        .filter((u): u is DirectoryUser => !!u),
      nextCursor: result.NextToken,
    };
  }
  async createGroup(name: string, description: string) {
    try {
      await this.client.send(
        new CreateGroupCommand({
          UserPoolId: this.poolId,
          GroupName: name,
          Description: description,
        }),
        this.options(),
      );
    } catch (e) {
      if (code(e) !== "GroupExistsException") throw e;
    }
  }
  async deleteGroup(name: string) {
    try {
      await this.client.send(
        new DeleteGroupCommand({ UserPoolId: this.poolId, GroupName: name }),
        this.options(),
      );
    } catch (e) {
      if (code(e) !== "ResourceNotFoundException") throw e;
    }
  }
  async addUser(name: string, username: string) {
    await this.client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: this.poolId,
        GroupName: name,
        Username: username,
      }),
      this.options(),
    );
  }
  async removeUser(name: string, username: string) {
    try {
      await this.client.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: this.poolId,
          GroupName: name,
          Username: username,
        }),
        this.options(),
      );
    } catch (e) {
      if (
        !["UserNotFoundException", "ResourceNotFoundException"].includes(
          code(e),
        )
      )
        throw e;
    }
  }
}
