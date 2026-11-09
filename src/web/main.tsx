import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  LayoutGrid,
  ListTree,
  Users,
  Plus,
  ChevronRight,
  ArrowUpRight,
  Search,
  X,
  Check,
  LogOut,
  FileText,
  History,
  Settings2,
  Circle,
  Layers,
  AlertCircle,
  Code2,
  ArrowLeft,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  states,
  roles,
  kinds,
  rank,
  type Project,
  type Membership,
  type WorkItem,
  type Document,
  type Role,
  type State,
  type Kind,
  type Me,
} from "../shared/model.js";
import { api, all, initialize, login, logout } from "./api.js";
import "./style.css";

type Tab = "Board" | "Planning" | "Documentation" | "Members";
const stateClass = (state: string) => state.toLowerCase().replaceAll(" ", "-");
const shortDate = (date: string) =>
  new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
function Content({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close}>
      <div className="dialog-title">
        <h2>{title}</h2>
        <button className="icon" aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [local, setLocal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<Me>();
  const [projects, setProjects] = useState<(Project & { role: Role })[]>([]);
  const [slug, setSlug] = useState("");
  const [tab, setTab] = useState<Tab>("Board");
  const [items, setItems] = useState<WorkItem[]>([]);
  const [search, setSearch] = useState("");
  const [tree, setTree] = useState<Role>("User");
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<
    Document & { content: string }
  >();
  const [members, setMembers] = useState<Membership[]>([]);
  const [modal, setModal] = useState<
    "project" | "item" | "doc" | "member" | "history" | null
  >(null);
  const [editItem, setEditItem] = useState<WorkItem>();
  const [editDoc, setEditDoc] = useState(false);
  const [revisions, setRevisions] = useState<Document[]>([]);
  const project = projects.find((p) => p.slug === slug);
  const role = project?.role ?? "User";
  const loadGeneration = useRef(0);
  const [loading, setLoading] = useState(false);
  async function run(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadProjects(preferred?: string) {
    const [identity, memberships] = await Promise.all([
      api<Me>("/me"),
      all<Membership>("/projects"),
    ]);
    setMe(identity);
    const results = await Promise.all(
      memberships.map(async (m) => ({
        ...(await api<Project>(`/projects/${m.project}`)),
        role: m.role,
      })),
    );
    setProjects(results);
    setSlug(
      (current) =>
        preferred ??
        (results.some((p) => p.slug === current)
          ? current
          : (results[0]?.slug ?? "")),
    );
  }
  useEffect(() => {
    initialize()
      .then(({ config, authenticated }) => {
        setLocal(!!config.local);
        setAuthed(authenticated);
        if (authenticated) return loadProjects();
      })
      .catch((e) => setError(e.message))
      .finally(() => setReady(true));
  }, []);
  async function refresh() {
    const generation = ++loadGeneration.current;
    if (!slug) return;
    setLoading(true);
    try {
      const work = await all<WorkItem>(`/projects/${slug}/items`);
      const pages =
        tab === "Documentation"
          ? await all<Document>(`/projects/${slug}/docs/${tree}`)
          : [];
      const people =
        tab === "Members"
          ? await all<Membership>(`/projects/${slug}/members`)
          : [];
      if (generation !== loadGeneration.current) return;
      setItems(work);
      setDocs(pages);
      setMembers(people);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    setSelectedDoc(undefined);
    setEditDoc(false);
    setItems([]);
    setDocs([]);
    setMembers([]);
    refresh().catch((e) => setError(e.message));
    return () => {
      loadGeneration.current++;
    };
  }, [slug, tab, tree]);
  async function move(item: WorkItem, state: State) {
    await run(async () => {
      await api(
        `/projects/${slug}/items/${item.id}`,
        "PATCH",
        { state },
        item.version,
      );
      await refresh();
    });
  }
  function newItem() {
    setEditItem(undefined);
    setModal("item");
  }
  const filtered = items.filter((item) =>
    `${item.id} ${item.title}`.toLowerCase().includes(search.toLowerCase()),
  );
  const tasks = filtered.filter((i) => i.kind === "Task");
  const done = items.filter(
    (i) => i.kind === "Task" && i.state === "Done",
  ).length;
  const total = items.filter((i) => i.kind === "Task").length;
  const message = error && (
    <div className="error" role="alert">
      <AlertCircle size={18} />
      <span>{error}</span>
      <button
        className="icon"
        aria-label="Dismiss error"
        onClick={() => setError("")}
      >
        <X size={16} />
      </button>
    </div>
  );
  if (!ready)
    return (
      <div className="welcome">
        <div className="brand">
          dnt<span>docs & tasks</span>
        </div>
        <p>Opening your workspace…</p>
        {message}
      </div>
    );
  if (!authed)
    return (
      <div className="welcome">
        <div className="brand">
          dnt<span>docs & tasks</span>
        </div>
        <div className="eyebrow">A little less overhead.</div>
        <h1>
          Room to think.
          <br />
          Space to ship.
        </h1>
        <p>
          Your team’s documentation and work, together.
          <br />
          Sign in to open your projects.
        </p>
        {message}
        <button className="primary" disabled={busy} onClick={() => run(login)}>
          Sign in with ejtbrown.com <ArrowUpRight size={17} />
        </button>
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          dnt<span>docs & tasks</span>
        </a>
        <div className="workspace-label">
          WORKSPACE <span className="tiny-dot" />
        </div>
        <label className="sr-only" htmlFor="project-switch">
          Project
        </label>
        <select
          id="project-switch"
          disabled={busy || editDoc}
          className="project-switch"
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setTree("User");
            setTab("Board");
            setSearch("");
          }}
        >
          <option value="" disabled>
            Select project
          </option>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        {me?.canCreateProject && (
          <button
            className="quiet new-project"
            onClick={() => setModal("project")}
          >
            <Plus size={15} /> New project
          </button>
        )}
        <div className="nav-label">PROJECT</div>
        <nav>
          {(
            [
              "Board",
              "Planning",
              "Documentation",
              ...(role === "Administrator" ? ["Members"] : []),
            ] as Tab[]
          ).map((t) => {
            const Icon = {
              Board: LayoutGrid,
              Planning: ListTree,
              Documentation: BookOpen,
              Members: Users,
            }[t];
            return (
              <button
                disabled={!slug || busy || editDoc}
                className={tab === t ? "nav-item active" : "nav-item"}
                key={t}
                onClick={() => {
                  setTab(t);
                  setSearch("");
                }}
              >
                <Icon size={18} />
                {t}
                {t === "Board" && <span>{total}</span>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className="tiny-dot" />
            {local ? "Local development" : "Connected to your workspace"}
          </div>
          <div className="identity">
            <div className="avatar">{role[0]}</div>
            <div>
              <strong>{role}</strong>
              <small>{slug || "No project selected"}</small>
            </div>
            <button
              className="icon"
              title="Sign out"
              aria-label="Sign out"
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="muted">Projects</span>
            <ChevronRight size={14} />
            <span>{project?.name ?? "Your workspace"}</span>
            <ChevronRight size={14} />
            <strong>{tab}</strong>
          </div>
          <a
            href="/openapi.json"
            target="_blank"
            rel="noreferrer"
            className="api-link"
          >
            <Code2 size={16} /> API reference <ArrowUpRight size={13} />
          </a>
        </header>
        <div className="page">
          {message}
          {!project ? (
            <div className="empty hero-empty">
              <Layers size={36} />
              <h1>A home for your next idea.</h1>
              <p>
                {me?.canCreateProject
                  ? "Create a project to start organizing documentation and work."
                  : "Ask a project administrator to add your identity to a project."}
              </p>
              {me?.canCreateProject && (
                <button className="primary" onClick={() => setModal("project")}>
                  <Plus size={17} /> Create project
                </button>
              )}
              <code>{me?.principal}</code>
            </div>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {project.slug} /{" "}
                    {tab === "Board"
                      ? "MAKE PROGRESS"
                      : tab === "Documentation"
                        ? "SHARED KNOWLEDGE"
                        : tab === "Planning"
                          ? "THE BIG PICTURE"
                          : "PROJECT ACCESS"}
                  </div>
                  <h1>
                    {tab === "Board"
                      ? "Work board"
                      : tab === "Planning"
                        ? "From idea to action"
                        : tab === "Documentation"
                          ? "Documentation"
                          : "Project members"}
                  </h1>
                  <p>
                    {tab === "Board"
                      ? "A clear view of what’s next, what’s moving, and what needs you."
                      : tab === "Planning"
                        ? "Connect the everyday work to the things you want to achieve."
                        : tab === "Documentation"
                          ? "Give your team and agents the context they need."
                          : "The right people and agents, with the right access."}
                  </p>
                </div>
                <button
                  className="primary"
                  disabled={busy || loading}
                  onClick={() =>
                    tab === "Documentation"
                      ? setModal("doc")
                      : tab === "Members"
                        ? setModal("member")
                        : newItem()
                  }
                >
                  <Plus size={17} />
                  {tab === "Documentation"
                    ? "New page"
                    : tab === "Members"
                      ? "Add member"
                      : "New work item"}
                </button>
              </div>
              {(tab === "Board" || tab === "Planning") && (
                <>
                  <div className="summary">
                    <div>
                      <span className="summary-number">{total}</span>
                      <span>Total tasks</span>
                    </div>
                    <div>
                      <span className="summary-number">
                        {items.filter((i) => i.state === "Implement").length}
                      </span>
                      <span>Ready to implement</span>
                    </div>
                    <div>
                      <span className="summary-number attention-number">
                        {
                          items.filter((i) => i.state === "Needs Attention")
                            .length
                        }
                      </span>
                      <span>Need attention</span>
                    </div>
                    <div className="progress-summary">
                      <div>
                        <span className="summary-number">
                          {total ? Math.round((done / total) * 100) : 0}%
                        </span>
                        <span>Complete</span>
                      </div>
                      <div className="progress-track">
                        <span
                          style={{
                            width: `${total ? (done / total) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="toolbar">
                    <div className="segmented">
                      <button
                        className={tab === "Board" ? "selected" : ""}
                        onClick={() => setTab("Board")}
                      >
                        <LayoutGrid size={15} /> Board
                      </button>
                      <button
                        className={tab === "Planning" ? "selected" : ""}
                        onClick={() => setTab("Planning")}
                      >
                        <ListTree size={15} /> Hierarchy
                      </button>
                    </div>
                    <label className="search">
                      <Search size={16} />
                      <input
                        aria-label="Find work items"
                        placeholder="Find a work item…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      <span>{filtered.length}</span>
                    </label>
                  </div>
                </>
              )}
              {loading ? (
                <div className="empty">Loading project…</div>
              ) : tab === "Board" ? (
                <>
                  <div className="board">
                    {states.map((state) => (
                      <section
                        key={state}
                        className={`column ${stateClass(state)}`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const item = items.find(
                            (i) =>
                              i.id === e.dataTransfer.getData("text/plain"),
                          );
                          if (item && item.state !== state && !busy)
                            move(item, state);
                        }}
                      >
                        <div className="column-heading">
                          <span className="status-dot" />
                          <h2>{state}</h2>
                          <span className="count">
                            {tasks.filter((i) => i.state === state).length}
                          </span>
                        </div>
                        <div className="cards">
                          {tasks
                            .filter((i) => i.state === state)
                            .map((item) => (
                              <button
                                key={item.id}
                                className="task-card"
                                draggable={!busy}
                                onDragStart={(e) => {
                                  e.dataTransfer.effectAllowed = "move";
                                  e.dataTransfer.setData("text/plain", item.id);
                                }}
                                onClick={() => {
                                  setEditItem(item);
                                  setModal("item");
                                }}
                              >
                                <div className="card-top">
                                  <span>{item.id}</span>
                                  <ArrowUpRight size={14} />
                                </div>
                                <h3>{item.title}</h3>
                                <div className="card-parent">
                                  <Layers size={12} />
                                  {items.find((i) => i.id === item.parentId)
                                    ?.title ?? item.parentId}
                                </div>
                                <div className="card-footer">
                                  <span>{shortDate(item.updatedAt)}</span>
                                  <span className="assignee">
                                    {item.assignee ? "Assigned" : "Unassigned"}
                                  </span>
                                </div>
                              </button>
                            ))}
                          {!tasks.some((i) => i.state === state) && (
                            <div className="column-empty">
                              {state === "Concept"
                                ? "Every idea starts here"
                                : state === "Done"
                                  ? "Good work lands here"
                                  : "Nothing here yet"}
                            </div>
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                  <div className="board-note">
                    <Circle size={12} /> Drag a task to change its state, or
                    open it to edit.
                  </div>
                </>
              ) : tab === "Planning" ? (
                <div className="hierarchy">
                  {items
                    .filter((i) => i.kind === "Initiative")
                    .map((initiative) => (
                      <details key={initiative.id} open>
                        <summary>
                          <Layers size={17} />
                          <span className="item-id">{initiative.id}</span>
                          <strong>{initiative.title}</strong>
                          <button
                            className="quiet"
                            onClick={(e) => {
                              e.preventDefault();
                              setEditItem(initiative);
                              setModal("item");
                            }}
                          >
                            Edit
                          </button>
                        </summary>
                        {items
                          .filter((e) => e.parentId === initiative.id)
                          .map((epic) => (
                            <details className="epic" key={epic.id} open>
                              <summary>
                                <ListTree size={16} />
                                <span className="item-id">{epic.id}</span>
                                <strong>{epic.title}</strong>
                                <button
                                  className="quiet"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setEditItem(epic);
                                    setModal("item");
                                  }}
                                >
                                  Edit
                                </button>
                              </summary>
                              {filtered
                                .filter((t) => t.parentId === epic.id)
                                .map((task) => (
                                  <button
                                    className="hierarchy-task"
                                    key={task.id}
                                    onClick={() => {
                                      setEditItem(task);
                                      setModal("item");
                                    }}
                                  >
                                    <Circle size={14} />
                                    <span className="item-id">{task.id}</span>
                                    <span>{task.title}</span>
                                    <span
                                      className={`state-pill ${stateClass(task.state!)}`}
                                    >
                                      {task.state}
                                    </span>
                                  </button>
                                ))}
                            </details>
                          ))}
                      </details>
                    ))}
                  {!items.length && (
                    <div className="empty">
                      <Layers size={28} />
                      <h2>Start with an initiative</h2>
                      <p>
                        Add an initiative, organize it into epics, then create
                        tasks.
                      </p>
                      <button className="secondary" onClick={newItem}>
                        Create your first initiative
                      </button>
                    </div>
                  )}
                </div>
              ) : tab === "Documentation" ? (
                <>
                  <div className="tree-tabs">
                    {roles
                      .filter((t) => rank(t) <= rank(role))
                      .map((t) => (
                        <button
                          className={tree === t ? "selected" : ""}
                          key={t}
                          disabled={busy || editDoc}
                          onClick={() => setTree(t)}
                        >
                          <BookOpen size={15} />
                          {t}
                        </button>
                      ))}
                  </div>
                  <div className="docs-layout">
                    <aside className="doc-nav">
                      <div className="nav-label">
                        {tree.toUpperCase()} GUIDE
                      </div>
                      <DocTree
                        documents={docs}
                        disabled={busy || editDoc}
                        selected={selectedDoc?.id}
                        select={(doc) =>
                          run(async () => {
                            setSelectedDoc(
                              await api(
                                `/projects/${slug}/docs/${tree}/${doc.id}`,
                              ),
                            );
                            setEditDoc(false);
                          })
                        }
                      />
                      {!docs.length && <p className="muted">No pages yet.</p>}
                    </aside>
                    <article className="document">
                      {selectedDoc ? (
                        editDoc ? (
                          <DocForm
                            initial={selectedDoc}
                            docs={docs}
                            busy={busy}
                            save={(body, key) =>
                              run(async () => {
                                await api(
                                  `/projects/${slug}/docs/${tree}/${selectedDoc.id}`,
                                  "PATCH",
                                  { title: body.title, content: body.content },
                                  selectedDoc.version,
                                  key,
                                );
                                setSelectedDoc(
                                  await api(
                                    `/projects/${slug}/docs/${tree}/${selectedDoc.id}`,
                                  ),
                                );
                                setEditDoc(false);
                                await refresh();
                              })
                            }
                            cancel={() =>
                              run(async () => {
                                setSelectedDoc(
                                  await api(
                                    `/projects/${slug}/docs/${tree}/${selectedDoc.id}`,
                                  ),
                                );
                                setEditDoc(false);
                              })
                            }
                          />
                        ) : (
                          <>
                            <div className="doc-actions">
                              <span>
                                Updated {shortDate(selectedDoc.updatedAt)} ·
                                Revision {selectedDoc.version}
                              </span>
                              <button
                                className="quiet"
                                onClick={() =>
                                  run(async () => {
                                    setRevisions(
                                      await all(
                                        `/projects/${slug}/docs/${tree}/${selectedDoc.id}/revisions`,
                                      ),
                                    );
                                    setModal("history");
                                  })
                                }
                              >
                                <History size={16} /> History
                              </button>
                              <button
                                className="secondary"
                                onClick={() => setEditDoc(true)}
                              >
                                Edit page
                              </button>
                            </div>
                            <h1>{selectedDoc.title}</h1>
                            <Content>{selectedDoc.content}</Content>
                          </>
                        )
                      ) : (
                        <div className="empty">
                          <BookOpen size={32} />
                          <h2>Make knowledge easy to find.</h2>
                          <p>
                            Choose a page, or add the first page to this guide.
                          </p>
                          <button
                            className="secondary"
                            onClick={() => setModal("doc")}
                          >
                            <Plus size={16} /> New page
                          </button>
                        </div>
                      )}
                    </article>
                  </div>
                </>
              ) : (
                <>
                  <div className="member-info">
                    <Settings2 size={19} />
                    <p>
                      Roles include the permissions beneath them. Users manage
                      tasks and User documentation. Maintainers also manage
                      initiatives, epics, and Maintainer documentation.
                      Administrators manage all content and project access.
                    </p>
                  </div>
                  <div className="member-list">
                    {members.map((member) => (
                      <div key={member.principal}>
                        <div className="avatar">
                          {member.principal.startsWith("iam:") ? "AI" : "U"}
                        </div>
                        <code>{member.principal}</code>
                        <select
                          aria-label={`Role for ${member.principal}`}
                          value={member.role}
                          disabled={busy}
                          onChange={(e) => {
                            const selected = e.target.value;
                            run(async () => {
                              await api(
                                `/projects/${slug}/members`,
                                "POST",
                                { principal: member.principal, role: selected },
                                member.version,
                              );
                              await loadProjects();
                              if (member.principal === me?.principal) {
                                setTree("User");
                                setTab("Board");
                              } else await refresh();
                            });
                          }}
                        >
                          {roles.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                        <button
                          className="icon"
                          aria-label={`Remove ${member.principal}`}
                          disabled={busy}
                          onClick={() => {
                            if (
                              confirm(
                                `Remove ${member.principal} from ${slug}?`,
                              )
                            )
                              run(async () => {
                                await api(
                                  `/projects/${slug}/members/${encodeURIComponent(member.principal)}`,
                                  "DELETE",
                                  undefined,
                                  member.version,
                                );
                                await loadProjects();
                                if (member.principal === me?.principal) {
                                  setTree("User");
                                  setTab("Board");
                                } else await refresh();
                              });
                          }}
                        >
                          <X size={17} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="identity-note">
                    Your identity: <code>{me?.principal}</code>
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </main>
      {modal && (
        <Dialog
          title={
            modal === "project"
              ? "Create a project"
              : modal === "item"
                ? editItem
                  ? `Edit ${editItem.id}`
                  : "New work item"
                : modal === "doc"
                  ? "New documentation page"
                  : modal === "member"
                    ? "Add a project member"
                    : "Page history"
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          {message}
          {modal === "project" ? (
            <ProjectForm
              busy={busy}
              save={(body, key) =>
                run(async () => {
                  const result = await api<Project>(
                    "/projects",
                    "POST",
                    body,
                    undefined,
                    key,
                  );
                  await loadProjects(result.slug);
                  setModal(null);
                })
              }
            />
          ) : modal === "item" ? (
            <ItemForm
              key={editItem?.id ?? "new"}
              initial={editItem}
              items={items}
              role={role}
              busy={busy}
              save={(body, key) =>
                run(async () => {
                  const { kind, ...patch } = body;
                  await api(
                    `/projects/${slug}/items${editItem ? `/${editItem.id}` : ""}`,
                    editItem ? "PATCH" : "POST",
                    editItem ? patch : body,
                    editItem?.version,
                    key,
                  );
                  await refresh();
                  setModal(null);
                })
              }
            />
          ) : modal === "doc" ? (
            <DocForm
              docs={docs}
              busy={busy}
              save={(body, key) =>
                run(async () => {
                  const result = await api<Document>(
                    `/projects/${slug}/docs/${tree}`,
                    "POST",
                    body,
                    undefined,
                    key,
                  );
                  await refresh();
                  setSelectedDoc(
                    await api(`/projects/${slug}/docs/${tree}/${result.id}`),
                  );
                  setModal(null);
                })
              }
            />
          ) : modal === "member" ? (
            <MemberForm
              busy={busy}
              save={(body, key) =>
                run(async () => {
                  await api(
                    `/projects/${slug}/members`,
                    "POST",
                    body,
                    undefined,
                    key,
                  );
                  await refresh();
                  setModal(null);
                })
              }
            />
          ) : (
            <div className="revision-list">
              {[...revisions].reverse().map((rev) => (
                <div key={rev.version}>
                  <strong>Revision {rev.version}</strong>
                  <span>{shortDate(rev.updatedAt)}</span>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const old = await api<Document & { content: string }>(
                          `/projects/${slug}/docs/${tree}/${rev.id}/revisions/${rev.version}`,
                        );
                        setSelectedDoc({
                          ...selectedDoc!,
                          content: old.content,
                          title: old.title,
                        });
                        setEditDoc(true);
                        setModal(null);
                      })
                    }
                  >
                    Open in editor
                  </button>
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
function useRequestKey(body: unknown) {
  const value = JSON.stringify(body);
  const ref = useRef({ value, key: crypto.randomUUID() });
  if (ref.current.value !== value)
    ref.current = { value, key: crypto.randomUUID() };
  return ref.current.key;
}
function ProjectForm({
  save,
  busy,
}: {
  save: (body: any, key: string) => void;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const body = { name, slug, description };
  const key = useRequestKey(body);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(body, key);
      }}
    >
      <label>
        Project name
        <input
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Root"
          autoFocus
        />
      </label>
      <label>
        Project key
        <input
          required
          pattern="[A-Z][A-Z0-9]{1,9}"
          maxLength={10}
          value={slug}
          onChange={(e) => setSlug(e.target.value.toUpperCase())}
          placeholder="ROOT"
        />
        <small>
          2–10 characters. Shared by initiatives, epics, and tasks: ROOT-1,
          ROOT-2…
        </small>
      </label>
      <label>
        Description
        <textarea
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="form-actions">
        <button disabled={busy} className="primary">
          {busy ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}
function ItemForm({
  initial,
  items,
  role,
  save,
  busy,
}: {
  initial?: WorkItem;
  items: WorkItem[];
  role: Role;
  save: (body: any, key: string) => void;
  busy: boolean;
}) {
  const [kind, setKind] = useState<Kind>(
    initial?.kind ??
      (items.some((i) => i.kind === "Epic")
        ? "Task"
        : items.some((i) => i.kind === "Initiative")
          ? "Epic"
          : rank(role) > 0
            ? "Initiative"
            : "Task"),
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [parentId, setParent] = useState(initial?.parentId ?? "");
  const [state, setState] = useState<State>(initial?.state ?? "Concept");
  const [assignee, setAssignee] = useState(initial?.assignee ?? "");
  const parents = items.filter(
    (i) => i.kind === (kind === "Task" ? "Epic" : "Initiative"),
  );
  const body = {
    kind,
    title,
    description,
    parentId: kind === "Initiative" ? null : parentId || parents[0]?.id || null,
    ...(kind === "Task" ? { state } : {}),
    assignee: assignee || null,
  };
  const key = useRequestKey(body);
  const readOnly = initial && initial.kind !== "Task" && rank(role) < 1;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(body, key);
      }}
    >
      <div className="form-row">
        <label>
          Type
          <select
            value={kind}
            disabled={!!initial}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setParent("");
            }}
          >
            {kinds
              .filter(
                (k) => rank(role) > 0 || k === "Task" || k === initial?.kind,
              )
              .map((k) => (
                <option key={k}>{k}</option>
              ))}
          </select>
        </label>
        {kind === "Task" && (
          <label>
            State
            <select
              value={state}
              onChange={(e) => setState(e.target.value as State)}
            >
              {states.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {kind !== "Initiative" && (
        <label>
          {kind === "Task" ? "Epic" : "Initiative"}
          <select
            required
            value={parentId || parents[0]?.id || ""}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="" disabled>
              Select parent
            </option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.title}
              </option>
            ))}
          </select>
          {!parents.length && (
            <small>
              Create a {kind === "Task" ? "parent epic" : "parent initiative"}{" "}
              first.
            </small>
          )}
        </label>
      )}
      <label>
        Title
        <input
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="What needs to happen?"
        />
      </label>
      <label>
        Description
        <textarea
          className="description-input"
          value={description}
          maxLength={20000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Context, acceptance criteria, and helpful links…"
        />
      </label>
      <label>
        Assignee identity (optional)
        <input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="cognito:<sub> or iam:<role ARN>"
        />
      </label>
      <div className="form-actions">
        <button
          className="primary"
          disabled={
            busy || !!readOnly || (kind !== "Initiative" && !parents.length)
          }
        >
          <Check size={16} />
          {busy ? "Saving…" : initial ? "Save changes" : "Create work item"}
        </button>
      </div>
    </form>
  );
}
function DocForm({
  initial,
  docs,
  save,
  busy,
  cancel,
}: {
  initial?: Document & { content: string };
  docs: Document[];
  save: (body: any, key: string) => void;
  busy: boolean;
  cancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [parentId, setParent] = useState("");
  const [preview, setPreview] = useState(false);
  const body = { title, content, parentId: parentId || null };
  const key = useRequestKey(body);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(body, key);
      }}
    >
      <label>
        Page title
        <input
          required
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
      </label>
      {!initial && (
        <label>
          Parent page
          <select value={parentId} onChange={(e) => setParent(e.target.value)}>
            <option value="">Top level</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="editor-toolbar">
        <span>Markdown</span>
        <button
          type="button"
          className="quiet"
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </div>
      {preview ? (
        <Content>{content || "*Nothing to preview yet.*"}</Content>
      ) : (
        <textarea
          aria-label="Page content"
          className="markdown-input"
          value={content}
          maxLength={100000}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write something worth sharing…"
        />
      )}
      <div className="form-actions">
        {cancel && (
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        )}
        <button className="primary" disabled={busy}>
          <Check size={16} />
          {busy ? "Saving…" : "Save page"}
        </button>
      </div>
    </form>
  );
}
function MemberForm({
  save,
  busy,
}: {
  save: (body: any, key: string) => void;
  busy: boolean;
}) {
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<Role>("User");
  const body = { principal, role };
  const key = useRequestKey(body);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(body, key);
      }}
    >
      <label>
        Identity
        <input
          required
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
          placeholder="cognito:<sub> or iam:<IAM role ARN>"
          autoFocus
        />
        <small>
          Use the stable Cognito subject or a registered IAM role ARN. Email
          addresses are not identities.
        </small>
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roles.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button className="primary" disabled={busy}>
          Add member
        </button>
      </div>
    </form>
  );
}
function DocTree({
  documents,
  parent = null,
  selected,
  select,
  disabled,
}: {
  documents: Document[];
  disabled?: boolean;
  parent?: string | null;
  selected?: string;
  select: (doc: Document) => void;
}) {
  return (
    <ul>
      {documents
        .filter((d) => d.parentId === parent)
        .map((d) => (
          <li key={d.id}>
            <button
              disabled={disabled}
              className={selected === d.id ? "selected" : ""}
              onClick={() => select(d)}
            >
              <FileText size={15} />
              {d.title}
            </button>
            <DocTree
              documents={documents}
              disabled={disabled}
              parent={d.id}
              selected={selected}
              select={select}
            />
          </li>
        ))}
    </ul>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
