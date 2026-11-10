import { Conflict, type Store, type Write, type Row } from "../api/store.js";
import type { Project, Membership, Role } from "../shared/model.js";
import {
  projectGroups,
  syncKey,
  GroupOwnershipError,
  type Directory,
  type GroupSync,
  type DirectoryGroup,
} from "./model.js";
export const ownership = (origin: string, project: string, role: Role) =>
  `Managed by dnt at ${origin}; project ${project}; role ${role}`;
export function isOwned(
  group: DirectoryGroup,
  origin: string,
  project: string,
  role: Role,
) {
  return (
    !group.roleArn && group.description === ownership(origin, project, role)
  );
}
export async function requestSync(db: Store, project: string): Promise<Write> {
  const key = syncKey(project);
  const old = await db.get<GroupSync>(key.pk, key.sk);
  return {
    row: {
      ...key,
      version: (old?.version ?? 0) + 1,
      value: {
        project,
        generation: (old?.value.generation ?? 0) + 1,
        status: "pending",
        requestedAt: new Date().toISOString(),
      } satisfies GroupSync,
    },
    expected: old?.version ?? null,
  };
}
class Superseded extends Error {}
// A single Lambda worker serializes Cognito changes. Every mutation checks the
// outbox generation; a newer transaction is always reconciled by a later event.
export async function synchronize(
  db: Store,
  directory: Directory,
  origin: string,
  slug: string,
) {
  const key = syncKey(slug);
  let sync = await db.get<GroupSync>(key.pk, key.sk);
  if (!sync || ["ready", "deleted"].includes(sync.value.status)) return;
  const generation = sync.value.generation;
  const guard = async () => {
    const latest = await db.get<GroupSync>(key.pk, key.sk);
    if (latest?.value.generation !== generation) throw new Superseded();
  };
  const update = async (values: Partial<GroupSync>) => {
    await guard();
    const next: Row<GroupSync> = {
      ...sync!,
      version: sync!.version + 1,
      value: { ...sync!.value, ...values },
    };
    await db.commit([{ row: next, expected: sync!.version }]);
    sync = next;
  };
  try {
    await update({ status: "syncing", error: undefined });
    const project = await db.get<Project>(key.pk, "META");
    if (!project) throw new Error("ProjectMissing");
    const groups = projectGroups(slug);
    // Verify every name before changing any of the three groups.
    for (const g of groups) {
      const existing = await directory.group(g.name);
      if (existing && !isOwned(existing, origin, slug, g.role))
        throw new GroupOwnershipError();
    }
    if (project.value.deletedAt) {
      for (const g of groups) {
        await guard();
        await directory.deleteGroup(g.name);
      }
      await update({
        status: "deleted",
        completedAt: new Date().toISOString(),
      });
      return;
    }
    const members: Membership[] = [];
    let cursor: string | undefined;
    do {
      const page = await db.query<Membership>(key.pk, "MEMBER#", 100, cursor);
      members.push(...page.rows.map((r) => r.value));
      cursor = page.next;
    } while (cursor);
    const desired = new Map<Role, Set<string>>(
      groups.map((g) => [g.role, new Set<string>()]),
    );
    let missingUsers = 0;
    for (const member of members) {
      if (!member.principal.startsWith("cognito:")) continue;
      // A deleted Cognito username can be reused by a different subject.
      // Verify the immutable principal even when a display snapshot is stored.
      const user = await directory.resolve(member.principal);
      if (user) desired.get(member.role)!.add(user.username);
      else missingUsers++;
    }
    for (const g of groups) {
      await guard();
      await directory.createGroup(g.name, ownership(origin, slug, g.role));
      const existing = await directory.group(g.name);
      if (!existing || !isOwned(existing, origin, slug, g.role))
        throw new GroupOwnershipError();
      const actual = new Set<string>();
      let next: string | undefined;
      do {
        const page = await directory.groupUsers(g.name, 60, next);
        page.items.forEach((user) => actual.add(user.username));
        next = page.nextCursor;
      } while (next);
      for (const username of actual)
        if (!desired.get(g.role)!.has(username)) {
          await guard();
          await directory.removeUser(g.name, username);
        }
      for (const username of desired.get(g.role)!)
        if (!actual.has(username)) {
          await guard();
          try {
            await directory.addUser(g.name, username);
          } catch (error) {
            if (
              error instanceof Error &&
              error.name === "UserNotFoundException"
            )
              missingUsers++;
            else throw error;
          }
        }
    }
    await update({
      status: "ready",
      completedAt: new Date().toISOString(),
      missingUsers,
    });
  } catch (error) {
    if (error instanceof Superseded) return;
    if (error instanceof Conflict) {
      const latest = await db.get<GroupSync>(key.pk, key.sk);
      if (
        latest?.value.generation !== generation ||
        ["ready", "deleted"].includes(latest.value.status)
      )
        return;
      // A transient DynamoDB transaction conflict is not evidence of a newer
      // generation. Keep the stream event retryable rather than losing work.
      throw new Error("GroupSynchronizationConflict");
    }
    console.error(
      JSON.stringify({
        event: "group_sync_failed",
        project: slug,
        generation,
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    try {
      await update({
        status: "error",
        error:
          error instanceof GroupOwnershipError
            ? error.message
            : "Cognito synchronization failed. Retry synchronization or contact an operator.",
      });
    } catch (statusError) {
      if (!(
        statusError instanceof Superseded || statusError instanceof Conflict
      ))
        throw statusError;
    }
    // No user data or SDK error payloads enter the stream failure logs.
    throw new Error(
      error instanceof GroupOwnershipError
        ? "GroupOwnershipConflict"
        : "GroupSynchronizationFailed",
    );
  }
}
