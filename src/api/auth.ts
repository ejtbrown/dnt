import { HttpError } from "./service.js";
export interface AuthConfig {
  issuer: string;
  clientId: string;
  agentRoles: string[];
}
// Only API Gateway's authenticated request context is trusted, never client headers.
export function authenticate(event: any, config: AuthConfig): string {
  const context = event.requestContext?.authorizer;
  if (event.rawPath?.startsWith("/api/v1/")) {
    const claims = context?.jwt?.claims;
    if (
      !claims ||
      claims.iss !== config.issuer ||
      claims.client_id !== config.clientId ||
      claims.token_use !== "access" ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      Number(claims.exp) <= Date.now() / 1000 ||
      !Number.isFinite(Number(claims.exp))
    )
      throw new HttpError(
        401,
        "A valid Cognito access token for dnt is required",
      );
    return `cognito:${claims.sub}`;
  }
  if (event.rawPath?.startsWith("/agent/v1/")) {
    const arn = context?.iam?.userArn as string | undefined;
    if (!arn) throw new HttpError(401, "IAM authentication required");
    if (/^arn:aws:iam::\d{12}:user\/.+$/.test(arn)) return `iam:${arn}`;
    const session = arn.match(
      /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/,
    );
    const role =
      session &&
      config.agentRoles.find(
        (candidate) =>
          candidate.startsWith(`arn:aws:iam::${session[1]}:role/`) &&
          candidate.split("/").at(-1) === session[2],
      );
    if (!role)
      throw new HttpError(403, "This IAM role is not registered for dnt");
    return `iam:${role}`;
  }
  throw new HttpError(404, "Not found");
}
