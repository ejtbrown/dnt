import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Service } from "../api/service.js";
import { OAuthBroker } from "./oauth.js";
import { challenge, createMcpServer } from "./tools.js";
const common = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...common, "content-type": "application/json", ...headers },
  });
}
export function createHttpHandler(service: Service, broker: OAuthBroker) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (origin && ![broker.origin, "https://chatgpt.com"].includes(origin))
      return response(403, { error: "Origin not allowed" });
    const cors: Record<string, string> = origin
      ? {
          "access-control-allow-origin": origin,
          vary: "Origin",
          "access-control-expose-headers":
            "WWW-Authenticate, MCP-Protocol-Version",
        }
      : {};
    if (request.method === "OPTIONS")
      return response(204, null, {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers":
          "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
        "access-control-max-age": "600",
      });
    let result: Response;
    if (new URL(request.url).pathname !== "/mcp")
      result = await broker.handle(request);
    else {
      const authorization = request.headers.get("authorization");
      const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
      const identity = token ? await broker.authenticate(token) : undefined;
      if (
        (authorization && !identity) ||
        (request.method === "GET" && !identity)
      )
        result = response(
          401,
          { error: "Authentication required" },
          { "www-authenticate": challenge(broker.origin) },
        );
      else if (request.method !== "POST")
        result = response(
          405,
          {
            error:
              "Use MCP Streamable HTTP POST; server-initiated SSE and session deletion are not offered",
          },
          { allow: "POST, OPTIONS" },
        );
      else {
        const server = createMcpServer(service, broker.origin, identity);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          const streamed = await transport.handleRequest(request);
          // JSON mode is fully buffered, suitable for API Gateway HTTP API/Lambda.
          result = new Response(await streamed.arrayBuffer(), {
            status: streamed.status,
            headers: streamed.headers,
          });
        } finally {
          await server.close();
        }
      }
    }
    for (const [key, value] of Object.entries({ ...common, ...cors }))
      result.headers.set(key, value);
    return result;
  };
}
