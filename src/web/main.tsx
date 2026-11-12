import { AssigneePicker } from "./assignee-picker.js";
import { ProjectGroups, UserPicker } from "./groups.js";
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
  Link as LinkIcon,
  Trash2,
} from "lucide-react";
import { Content, MarkdownField } from "./markdown.js";
import { DocumentHistory } from "./document-history.js";
import { WorkItemComments } from "./comments.js";
import { ItemHistory } from "./item-history.js";
import {
  states,
  attributionLabel,
  type Attribution,
  type AuditEvent,
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
  type PublicDocument,
} from "../shared/model.js";
import { itemLink, documentLink, parseDirectLink } from "../shared/links.js";
import { api, ApiError, all, initialize, login, logout } from "./api.js";
import "./style.css";

type Tab = "Board" | "Planning" | "Documentation" | "Members" | "Activity";
const stateClass = (state: string) => state.toLowerCase().replaceAll(" ", "-");
const shortDate = (date: string) =>
  new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
function Byline({
  attribution,
  principal,
}: {
  attribution: Attribution;
  principal: string;
}) {
  return (
    <span className="attribution" title={principal}>
      <bdi>{attributionLabel(attribution)}</bdi>
      <span className="muted"> · {attribution.source ?? "unknown source"}</span>
    </span>
  );
}
function Dialog({
  title,
  children,
  close,
  className,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} className={className}>
      <div className="dialog-title">
        <h2>{title}</h2>
        <button className="icon" aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
function Brand({
  onHome,
}: {
  onHome?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <a href="/" className="brand" aria-label="dnt home" onClick={onHome}>
      <img
        src="/brand/dnt-hero.png"
        alt="dnt — Docs ’n Tasks"
        width={1082}
        height={411}
      />
    </a>
  );
}
function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [local, setLocal] = useState(false);
  const [path, setPath] = useState(location.pathname);
  const [linkLoading, setLinkLoading] = useState(false);
  const [publicDoc, setPublicDoc] = useState<PublicDocument>();
  const [linkUnavailable, setLinkUnavailable] = useState(false);
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
  const [deletedProjects, setDeletedProjects] = useState<Membership[]>([]);
  const [deletedProject, setDeletedProject] = useState("");
  const [members, setMembers] = useState<Membership[]>([]);
  const [modal, setModal] = useState<
    "project" | "item" | "doc" | "member" | "history" | null
  >(null);
  const [editItem, setEditItem] = useState<WorkItem>();
  const [editDoc, setEditDoc] = useState(false);
  const [revisions, setRevisions] = useState<Document[]>([]);
  const project = projects.find((p) => p.slug === slug);
  const role = project?.role ?? "User";
  const canWrite = rank(role) >= 1;
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
      all<Membership>("/projects?includeDeleted=true"),
    ]);
    setMe(identity);
    setDeletedProjects(memberships.filter((m) => m.deletedAt));
    const results = await Promise.all(
      memberships
        .filter((m) => !m.deletedAt)
        .map(async (m) => ({
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
        setPath(location.pathname);
        setLocal(!!config.local);
        setAuthed(authenticated);
        if (authenticated) return loadProjects();
      })
      .catch((e) => setError(e.message))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    const pop = () => setPath(location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function navigate(next: string) {
    if (next !== location.pathname + location.hash)
      history.pushState({}, "", next);
    setPath(new URL(next, location.origin).pathname);
    window.dispatchEvent(new Event("hashchange"));
  }
  function followInternalLink(event: React.MouseEvent) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = (event.target as Element).closest("a");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || !parseDirectLink(url.pathname))
      return;
    event.preventDefault();
    if (busy || (editDoc && !confirm("Discard unsaved page changes?"))) return;
    navigate(url.pathname + url.hash);
  }
  function closeItem() {
    setModal(null);
    if (path.startsWith("/t/")) navigate("/");
  }
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setError("");
    setPublicDoc(undefined);
    setLinkUnavailable(false);
    setModal(null);
    setEditDoc(false);
    setSelectedDoc(undefined);
    const link = parseDirectLink(path);
    if (!link) {
      setLinkLoading(false);
      if (path !== "/") setError("This link is not valid.");
      return;
    }
    if (!authed && link.kind === "item") return;
    setLinkLoading(true);
    (async () => {
      if (link.kind === "item") {
        const item = await api<WorkItem>(
          `/projects/${link.project}/items/${link.id}`,
        );
        if (cancelled) return;
        setSlug(item.project);
        // Keep the current work view when opening a card within the project.
        setTab((current) => (current === "Planning" ? current : "Board"));
        setEditItem(item);
        setModal("item");
      } else {
        if (authed) {
          try {
            const doc = await api<Document & { content: string }>(
              `/documents/${link.reference}`,
            );
            if (cancelled) return;
            setSlug(doc.project);
            setTree(doc.tree);
            setTab("Documentation");
            setSelectedDoc(doc);
            return;
          } catch (e) {
            if (!(e instanceof ApiError) || ![403, 404].includes(e.status))
              throw e;
          }
        }
        const doc = await api<PublicDocument>(
          `/public/documents/${link.reference}`,
        );
        if (!cancelled) setPublicDoc(doc);
      }
    })()
      .catch((e) => {
        if (cancelled) return;
        setLinkUnavailable(true);
        setError(
          e instanceof ApiError && [403, 404].includes(e.status)
            ? "This page is unavailable or you do not have access."
            : e.message,
        );
      })
      .finally(() => {
        if (!cancelled) setLinkLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, authed, path]);
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
    setSelectedDoc((current) =>
      current?.project === slug &&
      current.tree === tree &&
      tab === "Documentation"
        ? current
        : undefined,
    );
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
  function goHome(event: React.MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (
      busy ||
      (editDoc && !confirm("Discard unsaved page changes and return home?"))
    )
      return;
    setTab("Board");
    setSearch("");
    setSelectedDoc(undefined);
    setEditDoc(false);
    setModal(null);
    navigate("/");
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
        <Brand />
        <p>Opening your workspace…</p>
        {message}
      </div>
    );
  if (linkLoading || publicDoc || (linkUnavailable && path.startsWith("/d/")))
    return (
      <div className="public-page" onClick={followInternalLink}>
        <header>
          <Brand onHome={goHome} />
          {!authed && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => run(login)}
            >
              Sign in
            </button>
          )}
        </header>
        {message}
        {linkLoading ? (
          <p>Opening page…</p>
        ) : (
          publicDoc && (
            <article className="document">
              <p className="eyebrow">Public page</p>
              <h1>{publicDoc.title}</h1>
              <p className="muted">Updated {shortDate(publicDoc.updatedAt)}</p>
              <Content>{publicDoc.content}</Content>
            </article>
          )
        )}
      </div>
    );
  if (!authed)
    return (
      <div className="welcome">
        <Brand />
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
    <div className="shell" onClick={followInternalLink}>
      <aside className="sidebar">
        <Brand onHome={goHome} />
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
            navigate("/");
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
              ...(role === "Administrator" ? ["Members", "Activity"] : []),
            ] as Tab[]
          ).map((t) => {
            const Icon = {
              Board: LayoutGrid,
              Planning: ListTree,
              Documentation: BookOpen,
              Members: Users,
              Activity: History,
            }[t];
            return (
              <button
                disabled={!slug || busy || editDoc}
                className={tab === t ? "nav-item active" : "nav-item"}
                key={t}
                onClick={() => {
                  navigate("/");
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
        {!!deletedProjects.length && (
          <details className="deleted-projects">
            <summary>Deleted projects</summary>
            {deletedProjects.map((p) => (
              <button
                className="quiet"
                key={p.project}
                onClick={() => setDeletedProject(p.project)}
              >
                Check {p.project} deletion
              </button>
            ))}
          </details>
        )}
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
              <img
                className="app-mark"
                src="/brand/dnt-logo.png"
                alt=""
                width={601}
                height={411}
              />
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
                          : tab === "Activity"
                            ? "PROJECT ACTIVITY"
                            : "PROJECT ACCESS"}
                  </div>
                  <h1>
                    {tab === "Board"
                      ? "Work board"
                      : tab === "Planning"
                        ? "From idea to action"
                        : tab === "Documentation"
                          ? "Documentation"
                          : tab === "Activity"
                            ? "Project activity"
                            : "Project members"}
                  </h1>
                  <p>
                    {tab === "Board"
                      ? "A clear view of what’s next, what’s moving, and what needs you."
                      : tab === "Planning"
                        ? "Connect the everyday work to the things you want to achieve."
                        : tab === "Documentation"
                          ? "Give your team and agents the context they need."
                          : tab === "Activity"
                            ? "Who changed what, including work done through agents."
                            : "The right people and agents, with the right access."}
                  </p>
                </div>
                {tab !== "Activity" && canWrite && (
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
                )}
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
                          if (canWrite && item && item.state !== state && !busy)
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
                                draggable={canWrite && !busy}
                                onDragStart={(e) => {
                                  e.dataTransfer.effectAllowed = "move";
                                  e.dataTransfer.setData("text/plain", item.id);
                                }}
                                onClick={() => {
                                  navigate(itemLink(item.id));
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
                                  <span>
                                    {item.dueDate
                                      ? `Due ${item.dueDate}`
                                      : shortDate(item.updatedAt)}
                                  </span>
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
                    <Circle size={12} />{" "}
                    {canWrite
                      ? "Drag a task to change its state, or open it to edit."
                      : "Open a task to read its details and history."}
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
                          <span
                            className={`state-pill ${stateClass(initiative.state ?? "Concept")}`}
                            title="Derived from descendant Tasks"
                          >
                            {initiative.state ?? "Concept"}
                          </span>
                          <button
                            className="quiet"
                            onClick={(e) => {
                              e.preventDefault();
                              navigate(itemLink(initiative.id));
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
                                <span
                                  className={`state-pill ${stateClass(epic.state ?? "Concept")}`}
                                  title="Derived from descendant Tasks"
                                >
                                  {epic.state ?? "Concept"}
                                </span>
                                <button
                                  className="quiet"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    navigate(itemLink(epic.id));
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
                                      navigate(itemLink(task.id));
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
                      <button
                        className="secondary"
                        disabled={!canWrite}
                        onClick={newItem}
                      >
                        Create your first initiative
                      </button>
                    </div>
                  )}
                </div>
              ) : tab === "Documentation" ? (
                <>
                  <div className="tree-tabs">
                    {roles.map((t) => (
                      <button
                        className={tree === t ? "selected" : ""}
                        key={t}
                        disabled={busy || editDoc}
                        onClick={() => {
                          navigate("/");
                          setTree(t);
                        }}
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
                          navigate(documentLink(doc.tree, doc.id))
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
                                  {
                                    title: body.title,
                                    content: body.content,
                                    public: body.public,
                                  },
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
                                disabled={busy || !canWrite}
                                onClick={() => setEditDoc(true)}
                              >
                                Edit page
                              </button>
                              <button
                                className="secondary danger"
                                disabled={busy || !canWrite}
                                onClick={() => {
                                  if (
                                    !confirm(
                                      `Are you sure you want to delete “${selectedDoc.title}”? Its direct link and public access will stop working.`,
                                    )
                                  )
                                    return;
                                  run(async () => {
                                    await api(
                                      `/projects/${slug}/docs/${tree}/${selectedDoc.id}`,
                                      "DELETE",
                                      undefined,
                                      selectedDoc.version,
                                    );
                                    navigate("/");
                                    setSelectedDoc(undefined);
                                    await refresh();
                                  });
                                }}
                              >
                                <Trash2 size={16} /> Delete page
                              </button>
                            </div>
                            <div className="page-sharing">
                              <a
                                href={documentLink(
                                  selectedDoc.tree,
                                  selectedDoc.id,
                                )}
                                onClick={(e) => {
                                  if (
                                    !e.ctrlKey &&
                                    !e.metaKey &&
                                    !e.shiftKey &&
                                    !e.altKey
                                  )
                                    e.preventDefault();
                                }}
                              >
                                <LinkIcon size={15} /> Direct link
                              </a>
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={selectedDoc.public}
                                  disabled={busy || !canWrite}
                                  onChange={(e) => {
                                    const isPublic = e.target.checked;
                                    const original = selectedDoc;
                                    setSelectedDoc({
                                      ...original,
                                      public: isPublic,
                                    });
                                    run(async () => {
                                      let updated: Document;
                                      try {
                                        updated = await api<Document>(
                                          `/projects/${slug}/docs/${tree}/${selectedDoc.id}`,
                                          "PATCH",
                                          { public: isPublic },
                                          selectedDoc.version,
                                        );
                                      } catch (e) {
                                        setSelectedDoc(original);
                                        throw e;
                                      }
                                      setSelectedDoc({
                                        ...updated,
                                        content: selectedDoc.content,
                                      });
                                      await refresh();
                                    });
                                  }}
                                />{" "}
                                Public
                              </label>
                              <small>
                                Anyone with the link can read a public page.
                              </small>
                            </div>
                            <h1>{selectedDoc.title}</h1>
                            <p className="byline">
                              Updated {shortDate(selectedDoc.updatedAt)} by{" "}
                              <Byline
                                attribution={selectedDoc.attribution}
                                principal={selectedDoc.updatedBy}
                              />
                            </p>
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
                            disabled={!canWrite}
                          >
                            <Plus size={16} /> New page
                          </button>
                        </div>
                      )}
                    </article>
                  </div>
                </>
              ) : tab === "Activity" ? (
                <ProjectActivity key={slug} project={slug} />
              ) : (
                <>
                  <div className="member-info">
                    <Settings2 size={19} />
                    <p>
                      Users have read-only access. Maintainers create, update
                      and delete documents and tasks across all documentation
                      trees. Administrators also manage project access.
                    </p>
                  </div>
                  <ProjectGroups
                    key={slug}
                    project={slug}
                    revision={JSON.stringify(
                      members.map((m) => [m.principal, m.version]),
                    )}
                    onDelete={
                      me?.isDntAdmin
                        ? async () => {
                            setDeletedProject(slug);
                            setTab("Board");
                            await loadProjects();
                          }
                        : undefined
                    }
                  />
                  <div className="member-list">
                    {members.map((member) => (
                      <div key={member.principal}>
                        <div className="avatar">
                          {member.principal.startsWith("iam:") ? "AI" : "U"}
                        </div>
                        <div className="member-identity">
                          <bdi>{member.name ?? member.principal}</bdi>
                          {member.email && <small>{member.email}</small>}
                          <code>{member.principal}</code>
                        </div>
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
      {deletedProject && (
        <Dialog title="Project deletion" close={() => setDeletedProject("")}>
          <ProjectGroups project={deletedProject} deleted />
        </Dialog>
      )}
      {modal && (
        <Dialog
          className={
            modal === "item"
              ? "work-item-dialog"
              : modal === "history"
                ? "wide-dialog"
                : undefined
          }
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
            if (!busy) {
              if (modal === "item") closeItem();
              else setModal(null);
            }
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
            <>
              {editItem && (
                <a
                  className="direct-link"
                  href={itemLink(editItem.id)}
                  onClick={(e) => {
                    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey)
                      e.preventDefault();
                  }}
                >
                  <LinkIcon size={15} /> Direct link
                </a>
              )}
              {editItem && (
                <p className="byline">
                  Updated {shortDate(editItem.updatedAt)} by{" "}
                  <Byline
                    attribution={editItem.attribution}
                    principal={editItem.updatedBy}
                  />
                </p>
              )}
              <ItemForm
                key={editItem?.id ?? "new"}
                initial={editItem}
                project={slug}
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
                    closeItem();
                  })
                }
              />
              {editItem && canWrite && (
                <button
                  className="secondary danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !confirm(
                        `Delete ${editItem.id} “${editItem.title}”? It will leave active lists; its revision history remains retained. Use Cancelled instead to keep intentionally stopped work visible.`,
                      )
                    )
                      return;
                    run(async () => {
                      await api(
                        `/projects/${slug}/items/${editItem.id}`,
                        "DELETE",
                        undefined,
                        editItem.version,
                      );
                      await refresh();
                      closeItem();
                    });
                  }}
                >
                  <Trash2 size={16} /> Delete work item
                </button>
              )}
              {editItem && <ItemHistory key={editItem.id} item={editItem} />}
              {editItem && (
                <WorkItemComments
                  key={`${slug}/${editItem.id}`}
                  project={slug}
                  itemId={editItem.id}
                  principal={me?.principal ?? ""}
                  administrator={role === "Administrator"}
                  canWrite={canWrite}
                />
              )}
            </>
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
                  setModal(null);
                  navigate(documentLink(result.tree, result.id));
                })
              }
            />
          ) : modal === "member" ? (
            <MemberForm
              project={slug}
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
            <DocumentHistory
              project={slug}
              tree={tree}
              revisions={revisions}
              busy={busy || !canWrite}
              restore={(rev) =>
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
            />
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
  project,
  initial,
  items,
  role,
  save,
  busy,
}: {
  project: string;
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
  const [editDescription, setEditDescription] = useState(!initial);
  const [parentId, setParent] = useState(initial?.parentId ?? "");
  const [state, setState] = useState<State>(initial?.state ?? "Concept");
  const [assignee, setAssignee] = useState(initial?.assignee ?? "");
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [dependencies, setDependencies] = useState(
    (initial?.dependencies ?? []).join(", "),
  );
  const [relatedTasks, setRelatedTasks] = useState(
    (initial?.relatedTasks ?? []).join(", "),
  );
  const taskIds = (value: string) => [
    ...new Set(
      value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((id) => id.toUpperCase()),
    ),
  ];
  const parents = items.filter(
    (i) => i.kind === (kind === "Task" ? "Epic" : "Initiative"),
  );
  const body = {
    kind,
    title,
    description,
    parentId: kind === "Initiative" ? null : parentId || parents[0]?.id || null,
    ...(kind === "Task"
      ? {
          state,
          dueDate: dueDate || null,
        }
      : {}),
    ...(!initial ||
    JSON.stringify(taskIds(dependencies)) !==
      JSON.stringify(initial.dependencies ?? [])
      ? { dependencies: taskIds(dependencies) }
      : {}),
    ...(!initial ||
    JSON.stringify(taskIds(relatedTasks)) !==
      JSON.stringify(initial.relatedTasks ?? [])
      ? { relatedTasks: taskIds(relatedTasks) }
      : {}),
    assignee: assignee || null,
  };
  const key = useRequestKey(body);
  const readOnly = rank(role) < 1;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!readOnly) save(body, key);
      }}
    >
      <fieldset disabled={busy || readOnly} className="item-fields">
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
          {kind !== "Task" && initial && (
            <p>
              State: {initial.state ?? "Concept"} (derived from descendant
              Tasks)
            </p>
          )}
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
        <section aria-label="Work item description">
          {editDescription && !readOnly ? (
            <MarkdownField
              label="Description"
              value={description}
              onChange={setDescription}
              maxLength={20000}
              disabled={busy}
            />
          ) : (
            <>
              <div className="editor-toolbar">
                <span>Description</span>
                {!readOnly && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setEditDescription(true)}
                  >
                    Edit description
                  </button>
                )}
              </div>
              <Content>{description || "*No description yet.*"}</Content>
            </>
          )}
        </section>
        <AssigneePicker
          project={project}
          principal={assignee}
          onChange={setAssignee}
          readOnly={readOnly}
        />
        <section aria-label="Work item scheduling and links">
          {kind === "Task" && (
            <label>
              Due date (optional)
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
          )}
          <label>
            Depends on work items
            <input
              value={dependencies}
              onChange={(e) => setDependencies(e.target.value)}
              placeholder="ROOT-3, PT-7"
              list="task-link-options"
            />
          </label>
          <small>
            Enter full work item IDs, separated by commas. Dependencies express
            prerequisites; check their current state before proceeding.
          </small>
          <label>
            Related work items
            <input
              value={relatedTasks}
              onChange={(e) => setRelatedTasks(e.target.value)}
              placeholder="ROOT-4"
              list="task-link-options"
            />
          </label>
          <small>
            Related work items provide context, not a blocking relationship.
          </small>
          <datalist id="task-link-options">
            {items
              .filter((i) => i.id !== initial?.id)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
          </datalist>
          {[...taskIds(dependencies), ...taskIds(relatedTasks)].length > 0 && (
            <p className="task-links">
              {[
                ...new Set([
                  ...taskIds(dependencies),
                  ...taskIds(relatedTasks),
                ]),
              ].map((id) => (
                <a key={id} href={itemLink(id)}>
                  {id}
                </a>
              ))}
            </p>
          )}
        </section>
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
      </fieldset>
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
  const [isPublic, setPublic] = useState(initial?.public ?? false);
  const body = { title, content, public: isPublic, parentId: parentId || null };
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
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={isPublic}
          disabled={busy}
          onChange={(e) => setPublic(e.target.checked)}
        />{" "}
        Public
      </label>
      <p className="muted">Anyone with the link can read a public page.</p>
      <MarkdownField
        label="Page content"
        value={content}
        onChange={setContent}
        maxLength={100000}
        disabled={busy}
      />
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
  project,
  save,
  busy,
}: {
  project: string;
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
      <UserPicker
        project={project}
        select={(user) => setPrincipal(user.principal)}
      />
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

function ProjectActivity({ project }: { project: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    all<AuditEvent>(`/projects/${project}/audit`)
      .then((items) => {
        if (active) setEvents(items.reverse());
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [project]);
  const actions: Record<string, string> = {
    "project.created": "Created project",
    "item.created": "Created work item",
    "item.updated": "Updated work item",
    "document.created": "Created document",
    "document.updated": "Updated document",
    "membership.set": "Set membership",
    "membership.removed": "Removed membership",
    "comment.updated": "Edited comment",
    "comment.created": "Commented on work item",
    "comment.reaction.created": "Recorded comment reaction",
    "comment.reaction.withdrawn": "Withdrew comment reaction",
  };
  return (
    <section className="activity-list" aria-label="Project activity">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p>Loading activity…</p>
      ) : events.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        events.map((event, index) => (
          <article key={`${event.at}/${index}`}>
            <strong>{actions[event.action] ?? event.action}</strong>{" "}
            <span>{event.target}</span>
            <p className="byline">
              <Byline
                attribution={event.attribution}
                principal={event.principal}
              />{" "}
              · {new Date(event.at).toLocaleString()}
            </p>
            <details>
              <summary>Audit details</summary>
              <pre className="markdown-source">
                {JSON.stringify(event, null, 2)}
              </pre>
            </details>
          </article>
        ))
      )}
    </section>
  );
}
