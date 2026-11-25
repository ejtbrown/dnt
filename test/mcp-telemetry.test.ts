import test from "node:test";
import assert from "node:assert/strict";
import {
  completion,
  correlation,
  createGatewayHandler,
  oauthReasons,
  type RequestDiagnostic,
} from "../src/mcp/telemetry.js";
import {
  fixture,
  mint,
  origin,
  clientId,
  formRequest,
} from "./mcp-fixtures.js";
import { OAuthError } from "../src/mcp/oauth.js";
import { Conflict } from "../src/api/store.js";

const canary = "SECRET_TOKEN_IDENTITY_QUERY_CONTENT_EXCEPTION";
const event = (body: string, id = "gateway-test_001=") => ({
  rawPath: "/mcp",
  rawQueryString: `secret=${canary}`,
  body,
  requestContext: { requestId: id, http: { method: "POST" } },
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
});

test("diagnostic classifiers output bounded categories, never input or error text", () => {
  const messages = [
    ["Parse error: Invalid JSON", "invalid_json"],
    ["Parse error: Invalid JSON-RPC message", "invalid_rpc"],
    [
      `Bad Request: Unsupported protocol version: ${canary}`,
      "protocol_unsupported",
    ],
    [
      "Invalid Request: Only one initialization request is allowed",
      "batch_rejected",
    ],
    [canary, "transport_unclassified"],
  ];
  for (const [message, category] of messages) {
    const result = completion(
      "mcp",
      JSON.stringify({ method: canary, id: canary, params: canary }),
      400,
      JSON.stringify({ error: { code: -32700, message, data: canary } }),
    );
    assert.equal(result.category, category);
    assert.equal(result.rpcMethod, "other");
    assert.equal(result.rpcErrorCode, -32700);
    assert.ok(!JSON.stringify(result).includes(canary));
  }
  assert.equal(
    completion(
      "mcp",
      "",
      200,
      JSON.stringify({ result: { isError: true, content: canary } }),
    ).category,
    "tool_error",
  );
  assert.equal(
    completion(
      "mcp",
      "",
      200,
      JSON.stringify({
        result: { isError: true, _meta: { "mcp/www_authenticate": canary } },
      }),
    ).category,
    "tool_authentication_required",
  );
  assert.equal(
    completion("mcp", "", 401, "").category,
    "authentication_required",
  );
  assert.equal(completion("mcp", "", 405, "").category, "method_unsupported");
  assert.equal(completion("mcp", "", 500, "").category, "server_error");
  const unknown = completion(
    "oauth_token",
    canary,
    400,
    JSON.stringify({ error: canary }),
    {
      oauthGrant: canary,
      oauthReason: canary,
    } as any,
  );
  assert.equal(unknown.oauthError, null);
  assert.equal(unknown.oauthReason, null);
  assert.equal(unknown.oauthGrant, null);
  assert.equal(
    completion("mcp", "", 400, '{"error":{"code":123456}}').rpcErrorCode,
    null,
  );
  assert.deepEqual(
    correlation({
      rawPath: `/oauth/${canary}`,
      requestContext: { requestId: `${canary}\n`, http: { method: canary } },
    }),
    {
      requestId: null,
      route: "other",
      httpMethod: "other",
    },
  );
});

test("Gateway lifecycle emits only the fixed schema for ordinary concurrent reads and preserves responses", async () => {
  const f = fixture();
  const tokens = await mint(f);
  const records: Record<string, unknown>[] = [];
  const gateway = createGatewayHandler(origin, f.http, (record) =>
    records.push(record),
  );
  const request = event(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_identity", arguments: {} },
    }),
  );
  request.headers = {
    ...request.headers,
    authorization: `Bearer ${tokens.access_token}`,
    cookie: canary,
  } as any;
  const baseline = await f.http(
    new Request(`${origin}/mcp?secret=${canary}`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    }),
  );
  const expectedBody = await baseline.text();
  const outputs = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      gateway({
        ...request,
        requestContext: {
          ...request.requestContext,
          requestId: `gateway-${i}=`,
        },
      }),
    ),
  );
  for (const output of outputs) {
    assert.equal(output.statusCode, baseline.status);
    assert.equal(output.body, expectedBody);
    assert.deepEqual(output.headers, Object.fromEntries(baseline.headers));
  }
  assert.equal(records.length, 16);
  const completedKeys = [
    "event",
    "requestId",
    "route",
    "httpMethod",
    "status",
    "category",
    "rpcMethod",
    "rpcErrorCode",
    "oauthError",
    "oauthGrant",
    "oauthReason",
    "durationMs",
  ].sort();
  for (const record of records) {
    const completed = record.event === "mcp_request_completed";
    assert.deepEqual(
      Object.keys(record).sort(),
      completed
        ? completedKeys
        : ["event", "requestId", "route", "httpMethod"].sort(),
    );
    if (completed) {
      assert.equal(record.category, "success");
      assert.equal(record.rpcMethod, "tools/call");
      assert.equal(record.status, 200);
    }
  }
  const serialized = JSON.stringify(records);
  for (const forbidden of [
    canary,
    tokens.access_token,
    tokens.refresh_token,
    f.settings.identity.principal,
    f.settings.identity.profile.id,
    "get_identity",
  ])
    assert.ok(!serialized.includes(forbidden));
  const throwingLogger = createGatewayHandler(origin, f.http, () => {
    throw new Error(canary);
  });
  assert.equal((await throwingLogger(request)).body, expectedBody);
});

test("ordinary refresh diagnostics identify grant type without credentials and remain request-local", async () => {
  const f = fixture();
  const first = await mint(f);
  const records: Record<string, unknown>[] = [];
  const gateway = createGatewayHandler(origin, f.http, (record) =>
    records.push(record),
  );
  const request = formRequest("/oauth/token", {
    client_id: clientId,
    resource: `${origin}/mcp`,
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
  });
  const renewed = await gateway({
    ...event(await request.text()),
    rawPath: "/oauth/token",
    headers: Object.fromEntries(request.headers),
  });
  assert.equal(renewed.statusCode, 200);
  const second = JSON.parse(renewed.body);
  assert.equal(
    (await f.broker.authenticate(second.access_token))?.principal,
    f.settings.identity.principal,
  );
  assert.equal(records[1].oauthGrant, "refresh_token");
  assert.equal(records[1].oauthReason, null);
  assert.equal(records[1].category, "success");
  for (const forbidden of [
    first.access_token,
    first.refresh_token,
    second.access_token,
    second.refresh_token,
  ])
    assert.ok(!JSON.stringify(records).includes(forbidden));
});

test("internal OAuth rejection reasons propagate without changing protocol errors or exercising reuse", async (t) => {
  const f = fixture();
  // Synthetic exceptions test diagnostic wiring; no code or refresh token is reused.
  for (const reason of oauthReasons) {
    const mocked = t.mock.method(f.broker, "token", async () => {
      throw new OAuthError("invalid_grant", 400, reason);
    });
    const detail: RequestDiagnostic = {};
    const response = await f.broker.handle(
      formRequest("/oauth/token", {}),
      detail,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
    assert.equal(detail.oauthReason, reason);
    mocked.mock.restore();
  }
  for (const [error, status, reason] of [
    [new Conflict(), 400, "store_conflict"],
    [new Error(canary), 500, "internal_error"],
  ] as const) {
    const mocked = t.mock.method(f.broker, "token", async () => {
      throw error;
    });
    const detail: RequestDiagnostic = {};
    const response = await f.broker.handle(
      formRequest("/oauth/token", {}),
      detail,
    );
    assert.equal(response.status, status);
    assert.equal(detail.oauthReason, reason);
    mocked.mock.restore();
  }
});

test("Lambda exception completion is correlated without exception strings", async () => {
  const records: Record<string, unknown>[] = [];
  const gateway = createGatewayHandler(
    origin,
    async () => {
      throw new Error(canary);
    },
    (record) => records.push(record),
  );
  assert.equal((await gateway(event("{}"))).statusCode, 500);
  assert.equal(records[1].category, "server_error");
  assert.equal(records[0].requestId, records[1].requestId);
  assert.ok(!JSON.stringify(records).includes(canary));
});
