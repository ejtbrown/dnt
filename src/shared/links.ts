import type { Role } from "./model.js";

const trees: Record<Role, string> = {
  User: "user",
  Maintainer: "maintainer",
  Administrator: "admin",
};
export const itemLink = (id: string) => `/t/${id}`;
export const documentReference = (tree: Role, id: string) =>
  `${trees[tree]}-${id}`;
export const documentLink = (tree: Role, id: string) =>
  `/d/${documentReference(tree, id)}`;
export function parseDocumentReference(reference: string) {
  const match =
    /^(user|maintainer|admin)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
      reference,
    );
  if (!match) return;
  return {
    tree: Object.entries(trees).find(
      ([, name]) => name === match[1],
    )![0] as Role,
    id: match[2],
  };
}
export function parseDirectLink(path: string) {
  const item = /^\/t\/([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,11})$/.exec(path);
  if (item)
    return {
      kind: "item" as const,
      project: item[1],
      id: `${item[1]}-${item[2]}`,
    };
  if (path.startsWith("/d/")) {
    const doc = parseDocumentReference(path.slice(3));
    if (doc)
      return { kind: "document" as const, ...doc, reference: path.slice(3) };
  }
}

export const isPublicDocumentRequest = (method: string, path: string) =>
  method === "GET" && /^\/api\/v1\/public\/documents\/[^/]+$/.test(path);
