import test from "node:test";
import assert from "node:assert/strict";
import { discoveryDiagnostic } from "../src/mcp/diagnostics.js";

test("discovery diagnostics distinguish negotiation and catalog responses without recording secrets or content", () => {
  const secret = "private-token-and-content";
  const request = new Request("https://dnt.example.com/mcp", {
    headers: {
      authorization: `Bearer ${secret}`,
      cookie: secret,
      origin: secret,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
  });
  const body = JSON.stringify({
    method: "tools/list",
    params: { cursor: secret },
    id: secret,
  });
  const catalog = discoveryDiagnostic(
    request,
    body,
    200,
    JSON.stringify({ result: { tools: [{ name: secret }] } }),
  )!;
  assert.equal(catalog.toolCount, 1);
  assert.equal(catalog.authenticatedRequest, true);
  assert.equal(catalog.protocolVersion, "2025-11-25");
  assert.ok(!JSON.stringify(catalog).includes(secret));
  const error = discoveryDiagnostic(
    request,
    body,
    406,
    JSON.stringify({ error: { code: -32000, message: secret, data: secret } }),
  )!;
  assert.equal(error.rpcErrorCode, -32000);
  assert.equal(error.status, 406);
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.equal(
    discoveryDiagnostic(
      request,
      JSON.stringify({ method: "tools/call", params: { name: "get_profile" } }),
      200,
      secret,
    ),
    undefined,
  );
  assert.equal(
    discoveryDiagnostic(
      new Request("https://dnt.example.com/oauth/token"),
      body,
      200,
      secret,
    ),
    undefined,
  );
  assert.equal(
    discoveryDiagnostic(request, "not json", 400, secret),
    undefined,
  );
  assert.equal(
    discoveryDiagnostic(
      request,
      '{"method":"notifications/initialized"}',
      202,
      "",
    )!.rpcErrorCode,
    null,
  );
});
