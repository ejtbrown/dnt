import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryStore, MemoryBlobs } from "../src/api/store.js";
import { Service } from "../src/api/service.js";
import { OAuthBroker, hash } from "../src/mcp/oauth.js";
import { createHttpHandler } from "../src/mcp/http.js";
import type { LoginIdentity } from "../src/mcp/cognito.js";
export const origin = "https://dnt.example.com";
export const clientId = "https://chatgpt.com/oauth/client.json";
export const redirectUri =
  "https://chatgpt.com/connector_platform_oauth_redirect";
export const admin = "cognito:11111111-1111-4111-8111-111111111111";
export const member = "cognito:22222222-2222-4222-8222-222222222222";
export function fixture() {
  const db = new MemoryStore(),
    serviceDb = new MemoryStore();
  const fixture = {
    db,
    serviceDb,
    active: true,
    identity: {
      principal: admin,
      username: "owner",
      scopes: [],
      profile: { id: admin.slice(8), name: "Owner" },
    } as LoginIdentity,
    logins: new Map<string, { challenge: string; nonce: string }>(),
  };
  const broker = new OAuthBroker(
    origin,
    db,
    {
      async resolve(id) {
        if (id !== clientId) throw new Error("Invalid test client");
        return { id, name: "ChatGPT", redirects: [redirectUri] };
      },
    },
    {
      authorizationUrl(state, challenge, nonce) {
        fixture.logins.set(state, { challenge, nonce });
        return `https://login.example.com/?${new URLSearchParams({ state, code_challenge: challenge, nonce })}`;
      },
      async exchange(code, verifier, nonce) {
        assert.equal(code, "upstream-code");
        assert.ok(
          [...fixture.logins.values()].some(
            (v) => v.nonce === nonce && v.challenge === hash(verifier),
          ),
        );
        return structuredClone(fixture.identity);
      },
      async active() {
        return fixture.active;
      },
    },
  );
  const service = new Service(serviceDb, new MemoryBlobs(), [admin]);
  return {
    ...fixture,
    broker,
    service,
    http: createHttpHandler(service, broker),
    settings: fixture,
  };
}
export type Fixture = ReturnType<typeof fixture>;
export const formRequest = (
  path: string,
  data: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(data),
  });
export async function begin(f: Fixture, scope = "dnt:read dnt:write") {
  const verifier = randomBytes(32).toString("base64url");
  const query = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    resource: `${origin}/mcp`,
    scope,
    code_challenge_method: "S256",
    code_challenge: hash(verifier),
    state: "client-state",
  };
  const start = await f.broker.handle(
    new Request(`${origin}/oauth/authorize?${new URLSearchParams(query)}`),
  );
  assert.equal(start.status, 302);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const upstream = new URL(start.headers.get("location")!);
  const state = upstream.searchParams.get("state")!;
  return { verifier, query, cookie, state, start };
}
export async function consentPage(
  f: Fixture,
  begun: Awaited<ReturnType<typeof begin>>,
) {
  const response = await f.broker.handle(
    new Request(
      `${origin}/oauth/callback?${new URLSearchParams({ state: begun.state, code: "upstream-code" })}`,
      { headers: { cookie: begun.cookie } },
    ),
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  return { html, csrf, response };
}
export async function authorize(f: Fixture, scope?: string) {
  const begun = await begin(f, scope);
  const page = await consentPage(f, begun);
  const response = await f.broker.handle(
    formRequest(
      "/oauth/consent",
      { transaction: begun.state, csrf: page.csrf, decision: "approve" },
      { cookie: begun.cookie, origin },
    ),
  );
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get("location")!);
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("iss"), origin);
  assert.equal(redirect.searchParams.get("state"), "client-state");
  return { ...begun, code: redirect.searchParams.get("code")! };
}
export function codeForm(grant: Awaited<ReturnType<typeof authorize>>) {
  return {
    client_id: clientId,
    resource: `${origin}/mcp`,
    grant_type: "authorization_code",
    code: grant.code,
    code_verifier: grant.verifier,
    redirect_uri: redirectUri,
  };
}
export async function mint(f: Fixture, scope?: string) {
  const grant = await authorize(f, scope);
  const response = await f.broker.handle(
    formRequest("/oauth/token", codeForm(grant)),
  );
  assert.equal(response.status, 200);
  return await response.json();
}
