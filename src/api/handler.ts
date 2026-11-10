import { CognitoDirectory } from "../groups/cognito.js";
import { DynamoStore, S3Blobs } from "./aws-store.js";
import { Service, HttpError } from "./service.js";
import { AccountNames } from "./names.js";
import { authenticate } from "./auth.js";
import { isPublicDocumentRequest } from "../shared/links.js";
const names = new AccountNames(process.env.COGNITO_POOL_ID!);
const service = new Service(
  new DynamoStore(process.env.TABLE_NAME!),
  new S3Blobs(process.env.CONTENT_BUCKET!),
  new CognitoDirectory(process.env.COGNITO_POOL_ID!),
  process.env.PUBLIC_ORIGIN!,
);
export async function handler(event: any) {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  try {
    const principal = isPublicDocumentRequest(
      event.requestContext.http.method,
      event.rawPath,
    )
      ? ""
      : authenticate(event, {
          issuer: process.env.COGNITO_ISSUER!,
          clientId: process.env.COGNITO_CLIENT_ID!,
          agentRoles: JSON.parse(process.env.AGENT_ROLES ?? "[]"),
        });
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    if (Buffer.byteLength(raw) > 150_000)
      throw new HttpError(413, "Request is too large");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
    const response = await service.handle({
      method: event.requestContext.http.method,
      path: event.rawPath,
      headers: event.headers ?? {},
      query: event.queryStringParameters ?? {},
      principal,
      userName: ["POST", "PATCH", "DELETE"].includes(
        event.requestContext.http.method,
      )
        ? await names.resolve(
            principal,
            event.requestContext.authorizer?.jwt?.claims?.username,
          )
        : undefined,
      body,
    });
    return {
      statusCode: response.status,
      headers: { ...headers, ...response.headers },
      body: response.status === 204 ? "" : JSON.stringify(response.body),
    };
  } catch (error) {
    if (!(error instanceof HttpError))
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    return {
      statusCode: error instanceof HttpError ? error.status : 500,
      headers,
      body: JSON.stringify({
        error: error instanceof HttpError ? error.message : "Internal error",
      }),
    };
  }
}
