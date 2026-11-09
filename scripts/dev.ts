import { createServer } from "node:http";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { Service } from "../src/api/service.js";
import {
  MemoryStore,
  type Write,
  type Check,
  type Blobs,
} from "../src/api/store.js";

const stateDirectory = process.env.DNT_LOCAL_DIRECTORY ?? ".local";
const dataPath = resolve(stateDirectory, "data.json");
mkdirSync(stateDirectory, { recursive: true });
class LocalStore extends MemoryStore {
  constructor() {
    super();
    if (existsSync(dataPath))
      this.rows = new Map(JSON.parse(readFileSync(dataPath, "utf8")));
  }
  override async commit(writes: Write[], checks?: Check[]) {
    await super.commit(writes, checks);
    writeFileSync(`${dataPath}.tmp`, JSON.stringify([...this.rows]));
    renameSync(`${dataPath}.tmp`, dataPath);
  }
}
class LocalBlobs implements Blobs {
  path(key: string) {
    const root = resolve(stateDirectory, "content");
    const path = resolve(root, key);
    if (!path.startsWith(`${root}/`)) throw new Error("Invalid key");
    return path;
  }
  async put(key: string, content: string) {
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { flag: "wx" });
  }
  async get(key: string) {
    return readFileSync(this.path(key), "utf8");
  }
}
const db = new LocalStore();
const principal = "cognito:local-developer";
const service = new Service(db, new LocalBlobs(), [principal]);
// Local identity exists only in this loopback development server, never in Lambda.
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa",
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, "http://127.0.0.1:5173");
  // Prevent another website from using the local developer's credentials.
  if (
    !["127.0.0.1:5173", "localhost:5173"].includes(
      request.headers.host ?? "",
    ) ||
    (request.headers.origin &&
      !["http://127.0.0.1:5173", "http://localhost:5173"].includes(
        request.headers.origin,
      ))
  ) {
    response.writeHead(403);
    response.end("Forbidden origin");
    return;
  }
  if (url.pathname === "/config.json") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ local: true }));
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    vite.middlewares(request, response);
    return;
  }
  try {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 150_000) {
        response.writeHead(413);
        response.end();
        return;
      }
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const result = await service.handle({
      method: request.method!,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers as Record<string, string>,
      principal,
      body,
    });
    response.writeHead(result.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...result.headers,
    });
    response.end(
      result.status === 204 ? undefined : JSON.stringify(result.body),
    );
  } catch {
    response.writeHead(500);
    response.end();
  }
});
server.listen(5173, "127.0.0.1", () =>
  console.log("dnt local development: http://127.0.0.1:5173"),
);
