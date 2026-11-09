import test from "node:test";
import assert from "node:assert/strict";
import { MetadataClients } from "../src/mcp/oauth.js";
import {
  fixture,
  origin,
  clientId,
  redirectUri,
  begin,
  consentPage,
  authorize,
  codeForm,
  mint,
  formRequest,
} from "./mcp-fixtures.js";

test("MCP metadata advertises resource binding, CIMD, S256, and issuer identification consistently", async () => {
  const f = fixture();
  const resource = await (
    await f.broker.handle(
      new Request(`${origin}/.well-known/oauth-protected-resource/mcp`),
    )
  ).json();
  const metadata = await (
    await f.broker.handle(
      new Request(`${origin}/.well-known/oauth-authorization-server`),
    )
  ).json();
  assert.equal(resource.resource, `${origin}/mcp`);
  assert.deepEqual(resource.authorization_servers, [metadata.issuer]);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
});

test("CIMD accepts OpenAI's plural auth-method declaration and limits metadata fetches to trusted URLs", async () => {
  let calls = 0;
  const clients = new MetadataClients([clientId], (async (url, options) => {
    calls++;
    assert.equal(url, clientId);
    assert.equal(options?.redirect, "error");
    return Response.json({
      client_id: clientId,
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    });
  }) as typeof fetch);
  assert.equal((await clients.resolve(clientId)).id, clientId);
  await clients.resolve(clientId);
  assert.equal(calls, 1);
  for (const id of [
    "http://169.254.169.254/latest/meta-data/",
    "https://chatgpt.com.evil.example/client.json",
    "https://chatgpt.com/oauth/client.json?redirect=evil",
  ])
    await assert.rejects(clients.resolve(id));
  assert.equal(calls, 1);
  for (const data of [
    { client_id: "https://other.example/client", redirect_uris: [redirectUri] },
    { client_id: clientId, redirect_uris: ["http://evil.example/callback"] },
    {
      client_id: clientId,
      redirect_uris: [redirectUri],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    },
  ])
    await assert.rejects(
      new MetadataClients([clientId], (async () =>
        Response.json(data)) as typeof fetch).resolve(clientId),
    );
});

test("authorization requires exact redirects, resource and S256; redirect errors include issuer", async () => {
  const f = fixture();
  const start = await begin(f);
  for (const changes of [
    { resource: "https://other.example/mcp" },
    { code_challenge_method: "plain" },
    { response_type: "token" },
    { scope: "admin" },
  ]) {
    const query = new URLSearchParams({ ...start.query, ...changes });
    const response = await f.broker.handle(
      new Request(`${origin}/oauth/authorize?${query}`),
    );
    assert.equal(response.status, 302);
    const back = new URL(response.headers.get("location")!);
    assert.equal(back.searchParams.get("iss"), origin);
    assert.ok(back.searchParams.get("error"));
  }
  const bad = await f.broker.handle(
    new Request(
      `${origin}/oauth/authorize?${new URLSearchParams({ ...start.query, redirect_uri: "https://evil.example/cb" })}`,
    ),
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("location"), null);
  assert.match(
    start.start.headers.get("set-cookie")!,
    /Secure; HttpOnly; SameSite=Lax/,
  );
});

test("browser binding, explicit consent, CSRF, and one-use callback prevent silent connection", async () => {
  const f = fixture(),
    start = await begin(f);
  const callback = `${origin}/oauth/callback?state=${start.state}&code=upstream-code`;
  assert.equal((await f.broker.handle(new Request(callback))).status, 400);
  const page = await consentPage(f, start);
  assert.match(page.html, /Allow connection/);
  assert.match(page.html, /manage project membership/);
  assert.equal(
    (
      await f.broker.handle(
        new Request(callback, { headers: { cookie: start.cookie } }),
      )
    ).status,
    400,
  );
  for (const headers of [
    { cookie: start.cookie, origin: "https://evil.example" },
    { cookie: "wrong", origin },
  ]) {
    assert.equal(
      (
        await f.broker.handle(
          formRequest(
            "/oauth/consent",
            { transaction: start.state, csrf: page.csrf, decision: "approve" },
            headers,
          ),
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await f.broker.handle(
        formRequest(
          "/oauth/consent",
          { transaction: start.state, csrf: "wrong", decision: "approve" },
          { cookie: start.cookie, origin },
        ),
      )
    ).status,
    400,
  );
  const denied = await f.broker.handle(
    formRequest(
      "/oauth/consent",
      { transaction: start.state, csrf: page.csrf, decision: "deny" },
      { cookie: start.cookie, origin },
    ),
  );
  const url = new URL(denied.headers.get("location")!);
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("iss"), origin);
  assert.equal(url.searchParams.has("code"), false);
});

test("code exchange enforces PKCE, redirect and resource, and stores only token hashes", async () => {
  const f = fixture(),
    grant = await authorize(f),
    body = codeForm(grant);
  for (const change of [
    { code_verifier: "x".repeat(43) },
    { redirect_uri: "https://evil.example/cb" },
    { resource: "https://other.example/mcp" },
  ]) {
    assert.equal(
      (
        await f.broker.handle(
          formRequest("/oauth/token", { ...body, ...change }),
        )
      ).status,
      400,
    );
  }
  const response = await f.broker.handle(formRequest("/oauth/token", body));
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal(tokens.expires_in, 900);
  assert.equal(
    (await f.broker.authenticate(tokens.access_token))?.principal,
    f.settings.identity.principal,
  );
  const stored = JSON.stringify([...f.db.rows.values()]);
  for (const raw of [grant.code, tokens.access_token, tokens.refresh_token])
    assert.ok(!stored.includes(raw));
  assert.equal(
    await f.broker.authenticate("eyJ.fake.cognito-token"),
    undefined,
  );
  assert.equal(
    (await f.broker.handle(formRequest("/oauth/token", body))).status,
    400,
  );
  assert.equal(
    await f.broker.authenticate(tokens.access_token),
    undefined,
    "code reuse revokes issued grant",
  );
});

test("refresh rotates once, narrows scopes, preserves identity and revokes the family on replay", async () => {
  const f = fixture(),
    first = await mint(f);
  const input = {
    client_id: clientId,
    resource: `${origin}/mcp`,
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    scope: "dnt:read",
  };
  const next = await f.broker.handle(formRequest("/oauth/token", input));
  assert.equal(next.status, 200);
  const second = await next.json();
  assert.notEqual(second.refresh_token, first.refresh_token);
  const identity = await f.broker.authenticate(second.access_token);
  assert.deepEqual(identity?.scopes, ["dnt:read"]);
  assert.equal(identity?.profile.id, f.settings.identity.profile.id);
  const escalation = await f.broker.handle(
    formRequest("/oauth/token", {
      ...input,
      refresh_token: second.refresh_token,
      scope: "dnt:read dnt:write",
    }),
  );
  assert.equal(escalation.status, 400);
  const replay = await f.broker.handle(formRequest("/oauth/token", input));
  assert.equal(replay.status, 400);
  assert.equal(await f.broker.authenticate(first.access_token), undefined);
  assert.equal(await f.broker.authenticate(second.access_token), undefined);
});

test("concurrent refresh attempts cannot both succeed; explicit revocation and disabled Cognito accounts invalidate grants", async () => {
  const f = fixture(),
    first = await mint(f);
  const input = {
    client_id: clientId,
    resource: `${origin}/mcp`,
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
  };
  const results = await Promise.all([
    f.broker.handle(formRequest("/oauth/token", input)),
    f.broker.handle(formRequest("/oauth/token", input)),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(await f.broker.authenticate(first.access_token), undefined);
  const second = await mint(f);
  assert.equal(
    (
      await f.broker.handle(
        formRequest("/oauth/revoke", {
          client_id: clientId,
          token: second.refresh_token,
        }),
      )
    ).status,
    200,
  );
  assert.equal(await f.broker.authenticate(second.access_token), undefined);
  const third = await mint(f);
  f.settings.active = false;
  assert.equal(
    (
      await f.broker.handle(
        formRequest("/oauth/token", {
          ...input,
          refresh_token: third.refresh_token,
        }),
      )
    ).status,
    400,
  );
  assert.equal(await f.broker.authenticate(third.access_token), undefined);
});

test("expired rows are rejected before eventual DynamoDB TTL deletion; duplicate parameters are rejected", async () => {
  const f = fixture(),
    tokens = await mint(f);
  for (const row of f.db.rows.values())
    if (row.pk.startsWith("OAUTH#ACCESS#")) row.value.expiresAt = 1;
  assert.equal(await f.broker.authenticate(tokens.access_token), undefined);
  const request = formRequest("/oauth/token", { client_id: clientId });
  const duplicate = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: `client_id=${encodeURIComponent(clientId)}&client_id=evil`,
  });
  assert.equal((await f.broker.handle(duplicate)).status, 400);
});

test("concurrent authorization code reuse revokes the winning grant", async () => {
  const f = fixture(),
    authorization = await authorize(f);
  const responses = await Promise.all([
    f.broker.handle(formRequest("/oauth/token", codeForm(authorization))),
    f.broker.handle(formRequest("/oauth/token", codeForm(authorization))),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
  const token = await responses.find((r) => r.status === 200)!.json();
  assert.equal(await f.broker.authenticate(token.access_token), undefined);
});
