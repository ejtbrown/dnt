import { z } from "zod";
import { createHash } from "node:crypto";

// Project META is the serialization lock. Sequence numbers are allocated only by
// the same transaction that commits the mutation and its immutable change row.
export const changeKey = (sequence: number) =>
  `CHANGES#${String(sequence).padStart(16, "0")}`;
export interface ChangeEvent {
  eventId: string;
  sequence: number;
  project: string;
  action: string;
  target: string;
  at: string;
  resource?: {
    entityType: "work_item" | "document" | "comment" | "reaction";
    id: string;
    version: number;
    itemId?: string;
    commentId?: string;
    tree?: string;
    kind?: string;
  };
}
export interface ChangeCoverage {
  firstSequence: number;
}
export interface ChangeCursor {
  v: 1;
  principal: string;
  project: string;
  mode: "page" | "checkpoint";
  after: number;
  watermark: number;
  since?: string;
  historyGap?: boolean;
}
const checksum = (s: string) => createHash("sha256").update(s).digest("hex");
// Opaque, integrity-checked encoding, not an authorization credential or MAC.
// Every read independently authorizes membership and bounds against server META.
export function encodeChangeCursor(cursor: ChangeCursor) {
  const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${body}.${checksum(body)}`;
}
export function decodeChangeCursor(
  raw: string,
  principal: string,
  project: string,
  current: number,
): ChangeCursor {
  if (raw.length > 4096 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(raw))
    throw new Error("Invalid change cursor");
  const [body, hash] = raw.split(".");
  if (checksum(body!) !== hash) throw new Error("Invalid change cursor");
  const c = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
  if (
    (c.historyGap !== undefined && typeof c.historyGap !== "boolean") ||
    c.v !== 1 ||
    c.principal !== principal ||
    c.project !== project ||
    !["page", "checkpoint"].includes(c.mode) ||
    !Number.isSafeInteger(c.after) ||
    !Number.isSafeInteger(c.watermark) ||
    c.after < 0 ||
    c.watermark < c.after ||
    c.watermark > current ||
    (c.mode === "checkpoint" &&
      (c.after !== c.watermark || c.since !== undefined)) ||
    (c.mode === "page" && c.after >= c.watermark) ||
    (c.since !== undefined && !validSince(c.since))
  )
    throw new Error("Invalid change cursor");
  return c;
}
const sinceSchema = z.iso.datetime({ offset: true });
export function validSince(s: unknown): s is string {
  return sinceSchema.safeParse(s).success;
}
