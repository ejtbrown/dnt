import { DynamoStore, S3Blobs } from "../api/aws-store.js";
import { Service } from "../api/service.js";
import { CognitoLogin } from "./cognito.js";
import { MetadataClients, OAuthBroker } from "./oauth.js";
import { createHttpHandler } from "./http.js";
const origin = process.env.PUBLIC_ORIGIN!;
const broker = new OAuthBroker(
  origin,
  new DynamoStore(process.env.OAUTH_TABLE!),
  new MetadataClients(JSON.parse(process.env.MCP_CLIENT_METADATA_URLS ?? "[]")),
  new CognitoLogin({
    issuer: process.env.COGNITO_ISSUER!,
    poolId: process.env.COGNITO_POOL_ID!,
    clientId: process.env.MCP_COGNITO_CLIENT_ID!,
    domain: process.env.AUTH_DOMAIN!,
    callback: `${origin}/oauth/callback`,
  }),
);
const service = new Service(
  new DynamoStore(process.env.TABLE_NAME!),
  new S3Blobs(process.env.CONTENT_BUCKET!),
  JSON.parse(process.env.PROJECT_CREATORS ?? "[]"),
);
const handle = createHttpHandler(service, broker);
export async function handler(event: any) {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64")
      : Buffer.from(event.body ?? "", "utf8");
    if (raw.length > 150_000)
      return {
        statusCode: 413,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
        body: JSON.stringify({ error: "Request is too large" }),
      };
    const headers = new Headers(event.headers ?? {});
    // Payload format 2.0 moves Cookie headers into this separate field.
    if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
    const method = event.requestContext.http.method;
    const url = new URL(origin);
    url.pathname = event.rawPath;
    url.search = event.rawQueryString ?? "";
    const request = new Request(url, {
      method,
      headers,
      ...(["GET", "HEAD"].includes(method) ? {} : { body: raw }),
    });
    const response = await handle(request);
    const outgoing = Object.fromEntries(response.headers);
    delete outgoing["set-cookie"];
    return {
      statusCode: response.status,
      headers: outgoing,
      cookies: response.headers.getSetCookie(),
      body: await response.text(),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "McpError",
      }),
    );
    return {
      statusCode: 500,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}
