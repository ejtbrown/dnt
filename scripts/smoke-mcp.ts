import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../infra/config.js";
import { aws, verifyAccount } from "./aws.js";
import { DynamoStore } from "../src/api/aws-store.js";
import { hash } from "../src/mcp/oauth.js";

// Operator-only integration test. Mint a short-lived authorization code for an
// unpredictable synthetic subject with NO memberships or project-creator rights.
// Never create an identity, edit product data, or emit credentials. Clean only
// the exact random OAuth keys belonging to this run, even on a failed assertion.
const config = loadConfig();
verifyAccount(config.account);
process.env.AWS_REGION = config.region;
const origin = `https://${config.domain}`,
  resource = `${origin}/mcp`;
const clientId = "https://chatgpt.com/oauth/client.json";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const outputs = aws([
  "cloudformation",
  "describe-stacks",
  "--region",
  config.region,
  "--stack-name",
  "dnt-data",
]).Stacks[0].Outputs;
const db = new DynamoStore(
  outputs.find((o: any) => o.OutputKey === "OAuthTableName").OutputValue,
);
const keys = new Set<string>();
const key = (kind: string, value: string) => {
  const pk = `OAUTH#${kind}#${hash(value)}`;
  keys.add(pk);
  return pk;
};
const subject = randomUUID(),
  username = `mcp-smoke-${randomUUID()}`;
const identity = {
  principal: `cognito:${subject}`,
  username,
  scopes: [],
  profile: { id: subject, name: "Isolated MCP smoke" },
};
// Optional per-process DNS override for networks with broken local DNS. TLS
// still validates the real configured hostname; no system settings are changed.
const smokeFetch: typeof fetch = async (input, init) => {
  if (!process.env.DNT_SMOKE_ADDRESS) return fetch(input, init);
  const request = new Request(input, init);
  assert.equal(new URL(request.url).origin, origin);
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer());
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      request.url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [
                { address: process.env.DNT_SMOKE_ADDRESS!, family: 4 },
              ])
            : callback(null, process.env.DNT_SMOKE_ADDRESS!, 4),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            for (const entry of Array.isArray(value)
              ? value
              : value
                ? [value]
                : [])
              headers.append(name, entry);
          resolve(
            new Response(
              [204, 304].includes(response.statusCode!)
                ? null
                : Buffer.concat(chunks),
              { status: response.statusCode, headers },
            ),
          );
        });
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error("SmokeRequestTimeout")));
    req.on("error", reject);
    req.end(body);
  });
};
const post = (
  path: string,
  data: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  smokeFetch(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(data),
  });
async function mint() {
  const code = `dntc_${randomBytes(32).toString("base64url")}`,
    verifier = randomBytes(32).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const pk = key("CODE", code);
  await db.commit([
    {
      expected: null,
      row: {
        pk,
        sk: "VALUE",
        version: 1,
        expiresAt,
        value: {
          clientId,
          redirectUri,
          challenge: hash(verifier),
          scopes: ["dnt:read"],
          identity,
          resource,
          used: false,
          expiresAt,
        },
      },
    },
  ]);
  const response = await post("/oauth/token", {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource,
  });
  const tokens = await response.json();
  if (tokens.access_token) key("ACCESS", tokens.access_token);
  if (tokens.refresh_token) key("REFRESH", tokens.refresh_token);
  const saved = await db.get<any>(pk, "VALUE");
  if (saved?.value.grant) key("GRANT", saved.value.grant);
  assert.equal(response.status, 200, "Synthetic code exchange failed");
  assert.equal(tokens.scope, "dnt:read");
  return tokens;
}
async function connect(token?: string) {
  const client = new Client({ name: "dnt-production-smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      fetch: smokeFetch,
      requestInit: {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    }),
  );
  return client;
}
try {
  const metadata = await smokeFetch(
    `${origin}/.well-known/oauth-authorization-server`,
  );
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get("cache-control"), "no-store");
  const auth = await metadata.json();
  assert.equal(auth.issuer, origin);
  assert.ok(auth.code_challenge_methods_supported.includes("S256"));
  const protectedResource = await (
    await smokeFetch(`${origin}/.well-known/oauth-protected-resource/mcp`)
  ).json();
  assert.equal(protectedResource.resource, resource);
  const missing = await smokeFetch(resource);
  assert.equal(missing.status, 401);
  assert.ok(
    missing.headers.get("www-authenticate")?.includes("resource_metadata"),
  );
  assert.equal(
    (
      await smokeFetch(resource, {
        headers: { authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await smokeFetch(resource, {
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const anonymous = await connect();
  try {
    const tools = await anonymous.listTools();
    assert.equal(tools.tools.length, 33);
    for (const tool of tools.tools)
      assert.equal(
        !!tool.inputSchema.properties?.agentName,
        !tool.annotations?.readOnlyHint,
        `${tool.name} attribution schema`,
      );
    const denied = await anonymous.callTool({
      name: "get_identity",
      arguments: {},
    });
    assert.equal(denied.isError, true);
    assert.ok(denied._meta?.["mcp/www_authenticate"]);
  } finally {
    await anonymous.close();
  }
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    resource,
    scope: "dnt:read",
    state: "production-smoke",
    code_challenge_method: "S256",
    code_challenge: hash(randomUUID()),
  });
  const start = await smokeFetch(`${origin}/oauth/authorize?${query}`, {
    redirect: "manual",
  });
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.origin, config.authDomain);
  assert.equal(
    location.searchParams.get("client_id"),
    config.mcpCognitoClientId,
  );
  const state = location.searchParams.get("state")!;
  key("LOGIN", state);
  const cookie = start.headers.get("set-cookie")!;
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("Secure"));
  const deniedLogin = await smokeFetch(
    `${origin}/oauth/callback?${new URLSearchParams({ state, error: "access_denied" })}`,
    { redirect: "manual", headers: { cookie: cookie.split(";")[0] } },
  );
  assert.equal(deniedLogin.status, 302);
  const back = new URL(deniedLogin.headers.get("location")!);
  assert.equal(back.searchParams.get("iss"), origin);
  assert.equal(back.searchParams.get("error"), "access_denied");
  const tokens = await mint(),
    client = await connect(tokens.access_token);
  try {
    const me = await client.callTool({ name: "get_identity", arguments: {} });
    assert.equal(
      (me.structuredContent as any).result.principal,
      identity.principal,
    );
    assert.equal((me.structuredContent as any).result.canCreateProject, false);
    const projects = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    assert.deepEqual((projects.structuredContent as any).result.items, []);
    const profile = await client.callTool({
      name: "get_profile",
      arguments: {},
    });
    assert.equal((profile.structuredContent as any).id, subject);
    const denied = await client.callTool({
      name: "create_project",
      arguments: {
        input: { slug: "SMOKE", name: "Must not create" },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(denied.isError, true);
    assert.ok(denied._meta?.["mcp/www_authenticate"]);
  } finally {
    await client.close();
  }
  // A nonexistent upstream identity must fail refresh and revoke its grant.
  const inactive = await post("/oauth/token", {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    resource,
  });
  assert.equal(inactive.status, 400);
  assert.equal((await inactive.json()).error, "invalid_grant");
  assert.equal(
    (
      await smokeFetch(resource, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
    ).status,
    401,
  );
  const revocable = await mint();
  assert.equal(
    (
      await post("/oauth/revoke", {
        client_id: clientId,
        token: revocable.refresh_token,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await smokeFetch(resource, {
        headers: { authorization: `Bearer ${revocable.access_token}` },
      })
    ).status,
    401,
  );
  console.log(
    "Live MCP passed: discovery, 30 tools, OAuth challenges, Cognito redirect/cookie, synthetic authenticated reads, scope denial, disabled identity refresh, revocation.",
  );
} finally {
  for (const pk of keys)
    await db.client.send(
      new DeleteCommand({ TableName: db.table, Key: { pk, sk: "VALUE" } }),
    );
  console.log(
    `Cleaned ${keys.size} exact synthetic OAuth records; product data unchanged.`,
  );
}
