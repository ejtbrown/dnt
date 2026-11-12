import { useDraftState } from "./session-drafts.js";
import React, { useEffect, useRef, useState } from "react";
import { all } from "./api.js";
type Person = { principal: string; name: string };
export function AssigneePicker({
  project,
  principal,
  onChange,
  readOnly,
}: {
  project: string;
  principal: string;
  onChange: (principal: string) => void;
  readOnly: boolean;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useDraftState(
    `assignee:${project}:query`,
    principal,
  );
  const [editing, setEditing] = useDraftState(
    `assignee:${project}:editing`,
    false,
  );
  const [error, setError] = useState("");
  const firstLoad = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    setPeople([]);
    setError("");
    if (!firstLoad.current) setEditing(false);
    firstLoad.current = false;
    if (!readOnly)
      all<Person>(`/projects/${project}/assignees`)
        .then((rows) => {
          if (active) setPeople(rows);
        })
        .catch(() => {
          if (active)
            setError(
              "Could not load project assignees. Existing assignment is unchanged; reopen to retry.",
            );
        });
    return () => {
      active = false;
    };
  }, [project, readOnly]);
  useEffect(() => {
    if (!editing)
      setQuery(
        people.find((p) => p.principal === principal)?.name ?? principal,
      );
  }, [people, principal, editing]);
  useEffect(() => {
    input.current?.setCustomValidity(
      editing && query
        ? "Select a project member from the suggestions, or clear to unassign."
        : "",
    );
  }, [editing, query]);
  const matches = people
    .filter((p) =>
      `${p.name} ${p.principal}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.principal.localeCompare(b.principal),
    );
  return (
    <div>
      <label>
        Assignee (optional)
        <input
          ref={input}
          value={query}
          disabled={readOnly}
          autoComplete="off"
          aria-controls="assignee-options"
          aria-expanded={editing}
          onChange={(e) => {
            setQuery(e.target.value);
            setEditing(!!e.target.value);
            if (!e.target.value) onChange("");
          }}
        />
      </label>
      {error && <p role="status">{error}</p>}
      {editing && (
        <ul id="assignee-options" aria-label="Matching project members">
          {matches.map((p) => (
            <li key={p.principal}>
              <button
                type="button"
                onClick={() => {
                  onChange(p.principal);
                  setQuery(p.name);
                  setEditing(false);
                }}
              >
                {p.name} <small>{p.principal}</small>
              </button>
            </li>
          ))}
          {!matches.length && <li>No matching project member</li>}
        </ul>
      )}
      {!editing && principal && <small>Stored identity: {principal}</small>}
    </div>
  );
}
