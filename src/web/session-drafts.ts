import { useEffect, useState, type SetStateAction, type Dispatch } from "react";
const storageKey = "dnt.renewal-drafts";
const readers = new Map<string, () => unknown>();
let restored: Record<string, unknown> = {};
export type DraftSnapshot = {
  subject: string;
  destination: string;
  values: Record<string, unknown>;
};
export function pendingDrafts(): DraftSnapshot | undefined {
  const raw = sessionStorage.getItem(storageKey);
  return raw ? JSON.parse(raw) : undefined;
}
export function saveDrafts(subject: string, destination: string) {
  const values = Object.fromEntries(
    [...readers].map(([key, read]) => [key, read()]),
  );
  // Storage failure must abort navigation, leaving the editing page intact.
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ subject, destination, values }),
  );
}
export function restoreDrafts(subject: string) {
  const pending = pendingDrafts();
  if (!pending) return false;
  if (pending.subject !== subject)
    throw new Error(
      "Sign in with the same account to restore your unsaved work.",
    );
  restored = pending.values;
  sessionStorage.removeItem(storageKey);
  return true;
}
export function clearDrafts() {
  restored = {};
  sessionStorage.removeItem(storageKey);
}
export function hasRestoredDrafts() {
  return Object.keys(restored).length > 0;
}
export function useDraftState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (Object.hasOwn(restored, key)) {
      const saved = restored[key] as T;
      delete restored[key];
      return saved;
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  readers.set(key, () => value);
  useEffect(
    () => () => {
      readers.delete(key);
    },
    [key],
  );
  return [value, setValue];
}
