import React, { useEffect, useRef, useState } from "react";
export type ProjectSignals = { attention: boolean; concept: boolean };
export function ProjectPicker({
  projects,
  value,
  disabled,
  signals,
  onChange,
}: {
  projects: { slug: string; name: string }[];
  value: string;
  disabled: boolean;
  signals: Record<string, ProjectSignals | undefined>;
  onChange: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const dots = (slug: string) => (
    <span className="project-signals">
      {slug && !signals[slug] && (
        <span
          title="Project status not loaded"
          aria-label="Project status not loaded"
        >
          ?
        </span>
      )}
      {signals[slug]?.attention && (
        <span
          className="project-dot attention"
          role="img"
          aria-label="Contains Needs Attention work"
          title="Needs Attention"
        />
      )}
      {signals[slug]?.concept && (
        <span
          className="project-dot concept"
          role="img"
          aria-label="Contains Concept work"
          title="Concept"
        />
      )}
    </span>
  );
  return (
    <div
      className="project-picker"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="project-switch"
        aria-label="Project"
        value={value}
        disabled={disabled}
        aria-expanded={open}
        aria-controls="project-options"
        onClick={() => setOpen(!open)}
      >
        <span>
          {projects.find((p) => p.slug === value)?.name ?? "Select project"}
        </span>
        {dots(value)}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          id="project-options"
          className="project-options"
          aria-label="Projects"
        >
          {projects.map((p) => (
            <button
              key={p.slug}
              type="button"
              aria-current={p.slug === value ? "true" : undefined}
              onClick={() => {
                onChange(p.slug);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{p.name}</span>
              {dots(p.slug)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
