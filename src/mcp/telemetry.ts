// All fields are fixed enums, bounded numbers, or Gateway-generated correlation
// IDs. Never add request/response text, headers, identities, or exception names.
export const oauthReasons = [
  "code_invalid",
  "code_used",
  "code_conflict",
  "refresh_invalid",
  "refresh_used",
  "grant_invalid",
  "account_inactive",
  "store_conflict",
  "internal_error",
] as const;
export type OAuthReason = (typeof oauthReasons)[number];
export interface RequestDiagnostic {
  oauthGrant?: "authorization_code" | "refresh_token" | "other";
  oauthReason?: OAuthReason;
}
const methods = ["GET", "POST", "OPTIONS", "HEAD", "DELETE", "PUT", "PATCH"];
const rpcMethods = [
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "ping",
  "notifications/cancelled",
];
const rpcCodes = [-32700, -32600, -32601, -32602, -32603, -32000, -32001];
const oauthCodes = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "invalid_scope",
  "invalid_target",
  "unsupported_grant_type",
  "unsupported_response_type",
  "access_denied",
  "server_error",
  "not_found",
];
function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
export function correlation(event: any) {
  const id = event?.requestContext?.requestId;
  const method = event?.requestContext?.http?.method;
  const path = event?.rawPath;
  const route =
    path === "/mcp"
      ? "mcp"
      : [
            "/oauth/token",
            "/oauth/authorize",
            "/oauth/callback",
            "/oauth/consent",
            "/oauth/revoke",
          ].includes(path)
        ? path.slice(1).replace("/", "_")
        : typeof path === "string" && path.startsWith("/.well-known/")
          ? "metadata"
          : "other";
  return {
    requestId:
      typeof id === "string" && /^[A-Za-z0-9_=+-]{1,80}$/.test(id) ? id : null,
    route: route as string,
    httpMethod: methods.includes(method) ? (method as string) : "other",
  };
}
export function completion(
  route: string,
  requestBody: string,
  status: number,
  responseBody: string,
  detail: RequestDiagnostic = {},
) {
  const rpc = route === "mcp" ? parse(requestBody) : undefined;
  const result = parse(responseBody);
  const error = result?.error;
  const rpcCode =
    route === "mcp" && rpcCodes.includes(error?.code)
      ? (error.code as number)
      : null;
  let category = status >= 400 ? "http_rejected" : "success";
  if (status >= 500) category = "server_error";
  else if (status === 401) category = "authentication_required";
  else if (status === 403) category = "forbidden";
  else if (status === 405) category = "method_unsupported";
  else if (status === 406) category = "accept_unsupported";
  else if (status === 413) category = "body_too_large";
  else if (status === 415) category = "content_type_unsupported";
  else if (route === "mcp" && error) {
    category = "rpc_error";
    if (status === 400) {
      category = "transport_unclassified";
      if (error.message === "Parse error: Invalid JSON")
        category = "invalid_json";
      else if (error.message === "Parse error: Invalid JSON-RPC message")
        category = "invalid_rpc";
      else if (
        typeof error.message === "string" &&
        error.message.startsWith("Bad Request: Unsupported protocol version:")
      )
        category = "protocol_unsupported";
      else if (
        typeof error.message === "string" &&
        /^Invalid Request: (Batch must not exceed \d+ messages|Only one initialization request is allowed)$/.test(
          error.message,
        )
      )
        category = "batch_rejected";
    }
  } else if (route === "mcp" && result?.result?.isError === true) {
    category = result.result._meta?.["mcp/www_authenticate"]
      ? "tool_authentication_required"
      : "tool_error";
  } else if (route.startsWith("oauth_") && status >= 400)
    category = "oauth_rejected";
  return {
    status:
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    category,
    rpcMethod: rpcMethods.includes(rpc?.method)
      ? (rpc.method as string)
      : route === "mcp"
        ? "other"
        : null,
    rpcErrorCode: rpcCode,
    oauthError:
      route.startsWith("oauth_") && oauthCodes.includes(error)
        ? (error as string)
        : null,
    oauthGrant: ["authorization_code", "refresh_token", "other"].includes(
      detail.oauthGrant ?? "",
    )
      ? detail.oauthGrant!
      : null,
    oauthReason: oauthReasons.includes(detail.oauthReason!)
      ? detail.oauthReason!
      : null,
  };
}

// Injection makes the exact Lambda boundary testable without AWS or credentials.
export function createGatewayHandler(
  origin: string,
  handle: (request: Request, detail: RequestDiagnostic) => Promise<Response>,
  emit: (record: Record<string, unknown>) => void = (record) =>
    console.info(JSON.stringify(record)),
) {
  return async (event: any) => {
    const context = correlation(event);
    const started = Date.now();
    const safeEmit = (record: Record<string, unknown>) => {
      try {
        emit(record);
      } catch {
        /* Telemetry must not change a request outcome. */
      }
    };
    safeEmit({ event: "mcp_request_started", ...context });
    let requestBody = "";
    const detail: RequestDiagnostic = {};
    let response: Response;
    let body: string;
    try {
      const raw = Buffer.from(
        event.body ?? "",
        event.isBase64Encoded ? "base64" : "utf8",
      );
      if (raw.length > 150_000) {
        response = new Response(
          JSON.stringify({ error: "Request is too large" }),
          {
            status: 413,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json",
            },
          },
        );
      } else {
        requestBody = raw.toString("utf8");
        const headers = new Headers(event.headers ?? {});
        if (event.cookies?.length)
          headers.set("cookie", event.cookies.join("; "));
        const method = event.requestContext.http.method;
        const url = new URL(origin);
        url.pathname = event.rawPath;
        url.search = event.rawQueryString ?? "";
        response = await handle(
          new Request(url, {
            method,
            headers,
            ...(["GET", "HEAD"].includes(method) ? {} : { body: raw }),
          }),
          detail,
        );
      }
      body = await response.text();
    } catch {
      response = new Response(null, {
        status: 500,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
      body = JSON.stringify({ error: "Internal error" });
    }
    safeEmit({
      event: "mcp_request_completed",
      ...context,
      ...completion(context.route, requestBody, response.status, body, detail),
      durationMs: Math.max(0, Math.min(120_000, Date.now() - started)),
    });
    const outgoing = Object.fromEntries(response.headers);
    delete outgoing["set-cookie"];
    return {
      statusCode: response.status,
      headers: outgoing,
      cookies: response.headers.getSetCookie(),
      body,
    };
  };
}
