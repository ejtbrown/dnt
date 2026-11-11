const discoveryMethods = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

// Record discovery outcomes, never credentials, RPC parameters, or tool results.
export function discoveryDiagnostic(
  request: Request,
  requestBody: string,
  status: number,
  responseBody: string,
) {
  if (new URL(request.url).pathname !== "/mcp") return;
  let rpc: any;
  try {
    rpc = JSON.parse(requestBody);
  } catch {
    return;
  }
  if (!discoveryMethods.has(rpc?.method)) return;
  let result: any;
  try {
    result = JSON.parse(responseBody);
  } catch {
    /* Notifications have no body. */
  }
  const version = request.headers.get("mcp-protocol-version");
  const accept = request.headers.get("accept") ?? "";
  return {
    event: "mcp_discovery",
    method: rpc.method as string,
    status,
    authenticatedRequest: request.headers.has("authorization"),
    protocolVersion:
      version && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : null,
    acceptsJson: accept.includes("application/json"),
    acceptsEventStream: accept.includes("text/event-stream"),
    rpcErrorCode:
      typeof result?.error?.code === "number" ? result.error.code : null,
    toolCount:
      rpc.method === "tools/list" && Array.isArray(result?.result?.tools)
        ? result.result.tools.length
        : null,
  };
}
