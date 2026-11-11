export interface Row<T = Record<string, unknown>> {
  pk: string;
  sk: string;
  version: number;
  value: T;
  expiresAt?: number;
}
export interface Write {
  row: Row<any>;
  expected: number | null;
  remove?: boolean;
}
export interface Check {
  pk: string;
  sk: string;
  version: number;
}
export class Conflict extends Error {
  constructor() {
    super("The record changed. Reload and try again.");
  }
}
export interface Store {
  get<T>(pk: string, sk: string): Promise<Row<T> | undefined>;
  query<T>(
    pk: string,
    prefix: string,
    limit: number,
    after?: string,
  ): Promise<{ rows: Row<T>[]; next?: string }>;
  range<T>(
    pk: string,
    lower: string,
    upper: string,
    limit: number,
    after?: string,
  ): Promise<{ rows: Row<T>[]; next?: string }>;
  commit(writes: Write[], checks?: Check[]): Promise<void>;
}
export interface Blobs {
  put(key: string, content: string): Promise<void>;
  get(key: string): Promise<string>;
}

export class MemoryStore implements Store {
  rows = new Map<string, Row<any>>();
  key(pk: string, sk: string) {
    return JSON.stringify([pk, sk]);
  }
  async get<T>(pk: string, sk: string): Promise<Row<T> | undefined> {
    return structuredClone(this.rows.get(this.key(pk, sk)));
  }
  async query<T>(pk: string, prefix: string, limit: number, after?: string) {
    const rows = [...this.rows.values()]
      .filter(
        (r) =>
          r.pk === pk && r.sk.startsWith(prefix) && (!after || r.sk > after),
      )
      .sort((a, b) => (a.sk < b.sk ? -1 : 1));
    const page = rows.slice(0, limit);
    return {
      rows: structuredClone(page) as Row<T>[],
      next: rows.length > limit ? page.at(-1)!.sk : undefined,
    };
  }
  async range<T>(
    pk: string,
    lower: string,
    upper: string,
    limit: number,
    after?: string,
  ) {
    const rows = [...this.rows.values()]
      .filter(
        (r) =>
          r.pk === pk &&
          r.sk >= lower &&
          r.sk <= upper &&
          (!after || r.sk > after),
      )
      .sort((a, b) => (a.sk < b.sk ? -1 : 1));
    const page = rows.slice(0, limit);
    return {
      rows: structuredClone(page) as Row<T>[],
      next: rows.length > limit ? page.at(-1)!.sk : undefined,
    };
  }
  async commit(writes: Write[], checks: Check[] = []) {
    const keys = writes.map((w) => this.key(w.row.pk, w.row.sk));
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate transaction target");
    for (const w of writes)
      if (
        (this.rows.get(this.key(w.row.pk, w.row.sk))?.version ?? null) !==
        w.expected
      )
        throw new Conflict();
    for (const c of checks)
      if (this.rows.get(this.key(c.pk, c.sk))?.version !== c.version)
        throw new Conflict();
    for (const w of writes) {
      const key = this.key(w.row.pk, w.row.sk);
      if (w.remove) this.rows.delete(key);
      else this.rows.set(key, structuredClone(w.row));
    }
  }
}
export class MemoryBlobs implements Blobs {
  objects = new Map<string, string>();
  async put(key: string, content: string) {
    if (this.objects.has(key)) throw new Error("Object already exists");
    this.objects.set(key, content);
  }
  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) throw new Error("Missing content");
    return value;
  }
}
