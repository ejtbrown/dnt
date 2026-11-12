import { useDraftState } from "./session-drafts.js";
import React, { useEffect, useState } from "react";
import { api, all } from "./api.js";
import type { Project, Role, Page } from "../shared/model.js";
import type { DirectoryUser, GroupSync } from "../groups/model.js";
interface GroupStatus {
  project: string;
  deleted: boolean;
  groups: { role: Role; name: string; exists: boolean; owned: boolean }[];
  sync: GroupSync;
}
export function ProjectGroups({
  project,
  revision,
  deleted,
  onDelete,
}: {
  project: string;
  revision?: string;
  deleted?: boolean;
  onDelete?: () => Promise<void>;
}) {
  const [status, setStatus] = useState<GroupStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<Record<string, DirectoryUser[]>>({});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api<GroupStatus>(`/projects/${project}/groups`);
        if (cancelled) return;
        setStatus(value);
        setError("");
        if (["pending", "syncing"].includes(value.sync.status))
          timer = setTimeout(load, 2500);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    setUsers({});
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project, revision, refresh]);
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="project-groups"
      aria-label={`${project} Cognito groups`}
    >
      <h3>{deleted ? `${project} deletion` : "Cognito groups"}</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p role="status">
        {status ? `Synchronization: ${status.sync.status}` : "Loading groups…"}
      </p>
      {status?.sync.error && <p role="alert">{status.sync.error}</p>}
      {!!status?.sync.missingUsers && (
        <p>
          {status.sync.missingUsers} assigned account(s) no longer exist in
          Cognito. Remove their dnt memberships.
        </p>
      )}
      <div className="group-grid">
        {status?.groups.map((group) => (
          <div key={group.name}>
            <strong>
              {group.role === "User" ? "User (viewer)" : group.role}
            </strong>
            <code>{group.name}</code>
            <small>
              {!group.exists
                ? "Group absent"
                : group.owned
                  ? "Managed by this project"
                  : "Name conflict — another application owns this group"}
            </small>
            {!deleted && group.exists && group.owned && (
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  work(async () => {
                    const value = await all<DirectoryUser>(
                      `/projects/${project}/groups/${group.role}/users`,
                    );
                    setUsers((current) => ({
                      ...current,
                      [group.role]: value,
                    }));
                  })
                }
              >
                View {group.role} group users
              </button>
            )}
            {users[group.role] && (
              <ul>
                {users[group.role].length ? (
                  users[group.role].map((user) => (
                    <li key={user.principal}>
                      <bdi>{user.name}</bdi>
                      {user.email && ` (${user.email})`}
                    </li>
                  ))
                ) : (
                  <li>No users</li>
                )}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="muted">
        dnt role assignments control access immediately. Cognito groups update
        shortly afterward. User maps to viewer and can edit tasks and User
        documentation. IAM members have no Cognito group membership.
      </p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          work(async () => {
            await api(`/projects/${project}/groups/reconcile`, "POST");
            setRefresh((value) => value + 1);
          })
        }
      >
        Retry synchronization
      </button>
      {onDelete && (
        <div className="project-delete">
          <h3>Delete project</h3>
          <p>
            Remove access and the three Cognito groups. Records remain retained
            for recovery; this project slug cannot be reused.
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (
                prompt(
                  `Type ${project} to delete this project and its Cognito groups.`,
                ) !== project
              )
                return;
              void work(async () => {
                const current = await api<Project>(`/projects/${project}`);
                await api(
                  `/projects/${project}`,
                  "DELETE",
                  undefined,
                  current.version,
                );
                await onDelete();
              });
            }}
          >
            Delete {project}
          </button>
        </div>
      )}
    </section>
  );
}
export function UserPicker({
  project,
  select,
}: {
  project: string;
  select: (user: DirectoryUser) => void;
}) {
  const [search, setSearch] = useDraftState("member-picker:search", "");
  const [result, setResult] = useState<Page<DirectoryUser>>();
  const [queried, setQueried] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(cursor?: string) {
    setBusy(true);
    setError("");
    const query = cursor ? queried : search;
    try {
      const page = await api<Page<DirectoryUser>>(
        `/projects/${project}/users?${new URLSearchParams({ search: query, limit: "20", ...(cursor ? { cursor } : {}) })}`,
      );
      setResult((previous) => ({
        ...page,
        items: cursor
          ? [...(previous?.items ?? []), ...page.items]
          : page.items,
      }));
      setQueried(query);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="user-picker">
      <label>
        Find Cognito users by email
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Email starts with…"
          maxLength={128}
        />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => load()}
      >
        Find users
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <ul>
          {result.items.map((user) => (
            <li key={user.principal}>
              <button
                type="button"
                className="quiet"
                onClick={() => select(user)}
              >
                <bdi>{user.name}</bdi>
                {user.email && ` · ${user.email}`}
                {!user.enabled && " (disabled)"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {result && !result.items.length && <p>No accounts on this page.</p>}
      {result?.nextCursor && (
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => load(result.nextCursor)}
        >
          More users
        </button>
      )}
    </div>
  );
}
