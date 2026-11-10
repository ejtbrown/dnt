import { diffLines } from "diff";
export interface DiffPart {
  type: "unchanged" | "added" | "removed";
  text: string;
}
export interface TextDiff {
  parts: DiffPart[];
  simplified: boolean;
}
// Bound CPU for unrelated or adversarial 100 KB documents. A whole-text fallback
// still describes the exact transformation, but is explicitly marked nonminimal.
export function compareText(
  before: string,
  after: string,
  budget = 2000,
): TextDiff {
  const changes = diffLines(before, after, {
    timeout: 100,
    maxEditLength: budget,
  });
  if (!changes)
    return {
      simplified: true,
      parts: [
        ...(before ? [{ type: "removed" as const, text: before }] : []),
        ...(after ? [{ type: "added" as const, text: after }] : []),
      ],
    };
  return {
    simplified: false,
    parts: changes.map((part) => ({
      type: part.added ? "added" : part.removed ? "removed" : "unchanged",
      text: part.value,
    })),
  };
}
