import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Conflict, type Row, type Store, type Write } from "../api/store.js";
import type { Identity } from "./tools.js";
import type { LoginIdentity, LoginProvider } from "./cognito.js";
const now = () => Math.floor(Date.now() / 1000);
const secret = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieName = "__Host-dnt_mcp_auth";
const cookie = (value: string, age = 600) =>
  `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const baseHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
function fail(code = "invalid_request"): never {
  throw new OAuthError(code);
}
function required(form: URLSearchParams, name: string, max = 2048): string {
  const values = form.getAll(name);
  if (values.length !== 1 || !values[0] || values[0].length > max)
    return fail();
  return values[0];
}
function params(request: Request, text?: string) {
  const values = new URLSearchParams(text ?? new URL(request.url).search);
  for (const key of values.keys()) if (values.getAll(key).length !== 1) fail();
  return values;
}
function scopes(value: string) {
  const result = [...new Set(value.split(" ").filter(Boolean))].sort();
  if (
    !result.length ||
    result.some((v) => !["dnt:read", "dnt:write"].includes(v))
  )
    fail("invalid_scope");
  if (!result.includes("dnt:read")) fail("invalid_scope");
  return result;
}
function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...baseHeaders, "content-type": "application/json", ...headers },
  });
}
function redirect(url: string, clearCookie = false) {
  return new Response(null, {
    status: 302,
    headers: {
      ...baseHeaders,
      location: url,
      ...(clearCookie ? { "set-cookie": cookie("", 0) } : {}),
    },
  });
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
interface Client {
  id: string;
  name: string;
  redirects: string[];
}
const clientMetadata = z.object({
  client_id: z.url(),
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.url()).min(1).max(20),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});
export class MetadataClients {
  private cache = new Map<string, { client: Client; until: number }>();
  constructor(
    private allowed: string[],
    private get = fetch,
  ) {}
  async resolve(id: string): Promise<Client> {
    if (!this.allowed.includes(id)) fail("invalid_client");
    const cached = this.cache.get(id);
    if (cached && cached.until > now()) return cached.client;
    const url = new URL(id);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname === "/"
    )
      fail("invalid_client");
    const response = await this.get(id, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      fail("invalid_client");
    const reader = response.body?.getReader();
    if (!reader) fail("invalid_client");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) fail("invalid_client");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let document: unknown;
    try {
      document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("invalid_client");
    }
    const parsed = clientMetadata.safeParse(document);
    if (!parsed.success) fail("invalid_client");
    const data = parsed.data;
    // Select public-client PKCE from the client’s supported methods. The singular
    // field declares a preference, which need not be the only supported method.
    const methods = data.token_endpoint_auth_methods_supported ?? [
      data.token_endpoint_auth_method ?? "none",
    ];
    if (
      data.client_id !== id ||
      !methods.includes("none") ||
      (data.grant_types && !data.grant_types.includes("authorization_code")) ||
      (data.response_types && !data.response_types.includes("code"))
    )
      fail("invalid_client");
    for (const redirect of data.redirect_uris) {
      const u = new URL(redirect);
      if (u.protocol !== "https:" || u.username || u.password || u.hash)
        fail("invalid_client");
    }
    const client = {
      id,
      name: data.client_name ?? url.hostname,
      redirects: data.redirect_uris,
    };
    this.cache.set(id, { client, until: now() + 300 });
    return client;
  }
}
type Timed = { expiresAt: number };
type Login = Timed & {
  client: Client;
  redirectUri: string;
  clientState: string;
  challenge: string;
  scopes: string[];
  browserHash: string;
  verifier: string;
  nonce: string;
  phase: "login" | "exchanging" | "consent" | "used";
  csrfHash?: string;
  identity?: LoginIdentity;
};
type Code = Timed & {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  identity: LoginIdentity;
  resource: string;
  used: boolean;
  grant?: string;
};
type Grant = Timed & {
  clientId: string;
  scopes: string[];
  identity: LoginIdentity;
  resource: string;
  revoked: boolean;
};
type Token = Timed & {
  clientId: string;
  grant: string;
  scopes: string[];
  resource: string;
  used: boolean;
};
export class OAuthBroker {
  readonly resource: string;
  constructor(
    readonly origin: string,
    private db: Store,
    private clients: Pick<MetadataClients, "resolve">,
    private login: LoginProvider,
  ) {
    this.resource = `${origin}/mcp`;
  }
  private row<T extends Timed>(kind: string, value: string, data: T): Row<T> {
    return {
      pk: `OAUTH#${kind}#${hash(value)}`,
      sk: "VALUE",
      version: 1,
      expiresAt: data.expiresAt,
      value: data,
    };
  }
  private async get<T extends Timed>(
    kind: string,
    value: string,
  ): Promise<Row<T> | undefined> {
    if (!value || value.length > 2048) return;
    const row = await this.db.get<T>(`OAUTH#${kind}#${hash(value)}`, "VALUE");
    return row && row.value.expiresAt > now() ? row : undefined;
  }
  private update<T>(row: Row<T>, value: T): Write {
    return {
      row: { ...row, value, version: row.version + 1 },
      expected: row.version,
    };
  }
  protectedMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.origin],
      scopes_supported: ["dnt:read", "dnt:write"],
      bearer_methods_supported: ["header"],
      resource_name: "dnt",
      resource_documentation: `${this.origin}/openapi.json`,
    };
  }
  authorizationMetadata() {
    return {
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/oauth/authorize`,
      token_endpoint: `${this.origin}/oauth/token`,
      revocation_endpoint: `${this.origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["dnt:read", "dnt:write"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    };
  }
  private callbackUrl(login: Login, result: Record<string, string>) {
    const url = new URL(login.redirectUri);
    for (const [key, value] of Object.entries({
      ...result,
      iss: this.origin,
      ...(login.clientState ? { state: login.clientState } : {}),
    }))
      url.searchParams.set(key, value);
    return url.toString();
  }
  private checkBrowser(request: Request, value: Login) {
    const browser = request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!browser || !same(hash(browser), value.browserHash))
      fail("invalid_request");
  }
  async authorize(request: Request) {
    const query = params(request);
    const client = await this.clients.resolve(required(query, "client_id"));
    const redirectUri = required(query, "redirect_uri");
    if (!client.redirects.includes(redirectUri)) fail("invalid_request");
    const clientState = query.get("state") ?? "";
    if (clientState.length > 512) fail();
    const partial = { redirectUri, clientState } as Login;
    try {
      if (required(query, "response_type") !== "code")
        fail("unsupported_response_type");
      if (required(query, "resource") !== this.resource) fail("invalid_target");
      const challenge = required(query, "code_challenge");
      if (
        query.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      )
        fail();
      const allowedScopes = scopes(query.get("scope") ?? "dnt:read");
      const state = secret(),
        browser = secret(),
        verifier = secret(),
        nonce = secret();
      await this.db.commit([
        {
          row: this.row<Login>("LOGIN", state, {
            client,
            redirectUri,
            clientState,
            challenge,
            scopes: allowedScopes,
            browserHash: hash(browser),
            verifier,
            nonce,
            phase: "login",
            expiresAt: now() + 600,
          }),
          expected: null,
        },
      ]);
      const response = redirect(
        this.login.authorizationUrl(state, hash(verifier), nonce),
      );
      response.headers.set("set-cookie", cookie(browser));
      return response;
    } catch (error) {
      if (error instanceof OAuthError)
        return redirect(this.callbackUrl(partial, { error: error.code }));
      throw error;
    }
  }
  async callback(request: Request) {
    const query = params(request),
      state = required(query, "state");
    const row = await this.get<Login>("LOGIN", state);
    if (!row || row.value.phase !== "login") fail();
    const value = row.value;
    this.checkBrowser(request, value);
    if (query.has("error")) {
      await this.db.commit([
        this.update(row, { ...value, phase: "used", verifier: "" }),
      ]);
      return redirect(
        this.callbackUrl(value, { error: "access_denied" }),
        true,
      );
    }
    const code = required(query, "code");
    await this.db.commit([this.update(row, { ...value, phase: "exchanging" })]);
    let identity: LoginIdentity;
    try {
      identity = await this.login.exchange(code, value.verifier, value.nonce);
    } catch {
      return redirect(
        this.callbackUrl(value, { error: "access_denied" }),
        true,
      );
    }
    const csrf = secret();
    await this.db.commit([
      {
        row: {
          ...row,
          version: row.version + 2,
          value: {
            ...value,
            phase: "consent",
            verifier: "",
            csrfHash: hash(csrf),
            identity,
          },
        },
        expected: row.version + 1,
      },
    ]);
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f7f8f5" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#111916" media="(prefers-color-scheme: dark)"><title>Connect dnt</title><link rel="icon" type="image/png" href="/brand/dnt-logo.png"><style>
:root{color-scheme:light;--background:#f7f8f5;--text:#26342f;--paper:#fff;--line:#a0aea2;--primary:#285d44;--on-primary:#fff;--focus:#507e62;--brand-surface:transparent}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--background:#111916;--text:#e1eae4;--paper:#1b2520;--line:#748b7b;--primary:#94d0ab;--on-primary:#102419;--focus:#94d0ab;--brand-surface:#f0f3ee}}
body{font:17px system-ui;background:var(--background);color:var(--text);margin:4rem auto;padding:1.5rem;max-width:38rem}
button{font:inherit;padding:.7rem 1rem;margin:.5rem .7rem .5rem 0;background:var(--paper);color:var(--text);border:1px solid var(--line);border-radius:6px;cursor:pointer}
button[value=approve]{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
h1{font-size:2rem}code{overflow-wrap:anywhere}.brand{display:block;width:300px;max-width:100%;margin-bottom:2rem;background:var(--brand-surface);border-radius:4px}.brand img{display:block;width:100%;height:auto}.brand:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:5px}
</style><main><a class="brand" href="/" aria-label="dnt home"><img src="/brand/dnt-hero.png" alt="dnt — Docs ’n Tasks" width="1082" height="411"></a><h1>Connect ${escape(value.client.name)} to dnt?</h1><p>Signed in as ${escape(identity.profile.name ?? identity.profile.id)}.</p><p>This connection can:</p><ul><li>Read projects, work items, documentation, members, and audit records that your project roles permit.</li>${value.scopes.includes("dnt:write") ? "<li>Create and edit projects, work items, and documentation, and manage project membership where your roles permit.</li>" : ""}</ul><p>Your existing project permissions still apply. This connection expires after 30 days unless reconnected. You can disconnect the plugin in ChatGPT.</p><p>Client: <code>${escape(value.client.id)}</code><br>Return to: <code>${escape(value.redirectUri)}</code></p><form method="post" action="/oauth/consent"><input type="hidden" name="transaction" value="${escape(state)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="approve">Allow connection</button><button name="decision" value="deny">Cancel</button></form></main></html>`;
    return new Response(html, {
      headers: {
        ...baseHeaders,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "x-frame-options": "DENY",
      },
    });
  }
  async consent(request: Request, form: URLSearchParams) {
    if (
      request.headers.has("origin") &&
      request.headers.get("origin") !== this.origin
    )
      fail();
    const row = await this.get<Login>("LOGIN", required(form, "transaction"));
    if (!row || row.value.phase !== "consent" || !row.value.identity) fail();
    const value = row.value;
    this.checkBrowser(request, value);
    if (!same(hash(required(form, "csrf")), value.csrfHash!)) fail();
    const decision = required(form, "decision");
    if (!["approve", "deny"].includes(decision)) fail();
    const writes: Write[] = [
      this.update(row, { ...value, phase: "used", csrfHash: "" }),
    ];
    const code = `dntc_${secret()}`;
    if (decision === "approve")
      writes.push({
        row: this.row<Code>("CODE", code, {
          clientId: value.client.id,
          redirectUri: value.redirectUri,
          challenge: value.challenge,
          scopes: value.scopes,
          identity: value.identity!,
          resource: this.resource,
          used: false,
          expiresAt: now() + 120,
        }),
        expected: null,
      });
    await this.db.commit(writes);
    return redirect(
      this.callbackUrl(
        value,
        decision === "approve" ? { code } : { error: "access_denied" },
      ),
      true,
    );
  }
  private tokens(grantId: string, grant: Grant, grantedScopes: string[]) {
    const access = `dnta_${secret()}`,
      refresh = `dntr_${secret()}`;
    const lifetime = Math.min(900, grant.expiresAt - now());
    const value: Token = {
      clientId: grant.clientId,
      grant: grantId,
      scopes: grantedScopes,
      resource: this.resource,
      used: false,
      expiresAt: now() + lifetime,
    };
    return {
      writes: [
        { row: this.row<Token>("ACCESS", access, value), expected: null },
        {
          row: this.row<Token>("REFRESH", refresh, {
            ...value,
            expiresAt: grant.expiresAt,
          }),
          expected: null,
        },
      ] as Write[],
      response: {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: lifetime,
        scope: grantedScopes.join(" "),
      },
    };
  }
  private async revokeGrant(id: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.get<Grant>("GRANT", id);
      if (!row || row.value.revoked) return;
      try {
        await this.db.commit([
          this.update(row, { ...row.value, revoked: true }),
        ]);
        return;
      } catch (e) {
        if (!(e instanceof Conflict) || attempt === 2) throw e;
      }
    }
  }
  async token(form: URLSearchParams) {
    const client = await this.clients.resolve(required(form, "client_id"));
    if (form.has("client_secret") || form.has("client_assertion"))
      fail("invalid_client");
    if (required(form, "resource") !== this.resource) fail("invalid_target");
    const type = required(form, "grant_type");
    if (type === "authorization_code") {
      const row = await this.get<Code>("CODE", required(form, "code"));
      const verifier = required(form, "code_verifier", 128);
      if (
        !row ||
        row.value.clientId !== client.id ||
        row.value.redirectUri !== required(form, "redirect_uri") ||
        row.value.resource !== this.resource ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !same(hash(verifier), row.value.challenge)
      )
        fail("invalid_grant");
      if (row.value.used) {
        if (row.value.grant) await this.revokeGrant(row.value.grant);
        fail("invalid_grant");
      }
      const grantId = secret();
      const grant: Grant = {
        clientId: client.id,
        scopes: row.value.scopes,
        identity: row.value.identity,
        resource: this.resource,
        revoked: false,
        expiresAt: now() + 30 * 86400,
      };
      const issued = this.tokens(grantId, grant, grant.scopes);
      try {
        await this.db.commit([
          this.update(row, { ...row.value, used: true, grant: grantId }),
          { row: this.row("GRANT", grantId, grant), expected: null },
          ...issued.writes,
        ]);
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        const replay = await this.get<Code>("CODE", required(form, "code"));
        if (replay?.value.used && replay.value.grant)
          await this.revokeGrant(replay.value.grant);
        fail("invalid_grant");
      }
      return json(issued.response);
    }
    if (type !== "refresh_token") fail("unsupported_grant_type");
    const raw = required(form, "refresh_token");
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.get<Token>("REFRESH", raw);
      if (
        !row ||
        row.value.clientId !== client.id ||
        row.value.resource !== this.resource
      )
        fail("invalid_grant");
      if (row.value.used) {
        await this.revokeGrant(row.value.grant);
        fail("invalid_grant");
      }
      const grant = await this.get<Grant>("GRANT", row.value.grant);
      if (
        !grant ||
        grant.value.revoked ||
        grant.value.clientId !== client.id ||
        grant.value.resource !== this.resource
      )
        fail("invalid_grant");
      if (!(await this.login.active(grant.value.identity))) {
        await this.revokeGrant(row.value.grant);
        fail("invalid_grant");
      }
      const narrowed = form.has("scope")
        ? scopes(required(form, "scope"))
        : row.value.scopes;
      if (narrowed.some((s) => !row.value.scopes.includes(s)))
        fail("invalid_scope");
      const issued = this.tokens(row.value.grant, grant.value, narrowed);
      try {
        await this.db.commit(
          [this.update(row, { ...row.value, used: true }), ...issued.writes],
          [{ pk: grant.pk, sk: grant.sk, version: grant.version }],
        );
        return json(issued.response);
      } catch (e) {
        if (!(e instanceof Conflict) || attempt === 1) throw e;
      }
    }
    return fail("invalid_grant");
  }
  async authenticate(token: string): Promise<Identity | undefined> {
    if (!/^dnta_[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = await this.get<Token>("ACCESS", token);
    if (!row || row.value.resource !== this.resource) return;
    const grant = await this.get<Grant>("GRANT", row.value.grant);
    if (
      !grant ||
      grant.value.revoked ||
      grant.value.resource !== this.resource ||
      grant.value.clientId !== row.value.clientId ||
      row.value.scopes.some((s) => !grant.value.scopes.includes(s))
    )
      return;
    return {
      principal: grant.value.identity.principal,
      profile: grant.value.identity.profile,
      scopes: row.value.scopes,
    };
  }
  async revoke(form: URLSearchParams) {
    const client = await this.clients.resolve(required(form, "client_id"));
    if (form.has("client_secret") || form.has("client_assertion"))
      fail("invalid_client");
    const token = required(form, "token");
    const row = await this.get<Token>(
      token.startsWith("dnta_") ? "ACCESS" : "REFRESH",
      token,
    );
    if (row?.value.clientId === client.id)
      await this.revokeGrant(row.value.grant);
    return new Response(null, { status: 200, headers: baseHeaders });
  }
  async handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        if (
          [
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
          ].includes(path)
        )
          return json(this.protectedMetadata());
        if (path === "/.well-known/oauth-authorization-server")
          return json(this.authorizationMetadata());
        if (path === "/oauth/authorize") return await this.authorize(request);
        if (path === "/oauth/callback") return await this.callback(request);
      }
      if (
        request.method === "POST" &&
        ["/oauth/token", "/oauth/revoke", "/oauth/consent"].includes(path)
      ) {
        if (
          !request.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/x-www-form-urlencoded")
        )
          throw new OAuthError("invalid_request", 415);
        if (request.headers.has("authorization")) fail("invalid_client");
        const text = await request.text();
        if (Buffer.byteLength(text) > 16384)
          throw new OAuthError("invalid_request", 413);
        const form = params(request, text);
        if (path === "/oauth/token") return await this.token(form);
        if (path === "/oauth/revoke") return await this.revoke(form);
        return await this.consent(request, form);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof OAuthError)
        return json({ error: error.code }, error.status);
      if (error instanceof Conflict)
        return json({ error: "invalid_grant" }, 400);
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.name : "OAuthError",
        }),
      );
      return json({ error: "server_error" }, 500);
    }
  }
}
