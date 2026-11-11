import type { Page } from "../shared/model.js";
import { parseDirectLink } from "../shared/links.js";
export interface Config {
  local?: boolean;
  clientId?: string;
  authDomain?: string;
}
let config: Config;
let token: string | undefined;
export async function initialize() {
  const response = await fetch("/config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Application configuration is unavailable");
  config = await response.json();
  if (location.pathname === "/auth/callback") {
    const query = new URLSearchParams(location.search);
    const expected = sessionStorage.getItem("dnt.oauth");
    sessionStorage.removeItem("dnt.oauth");
    history.replaceState({}, "", "/");
    if (!expected) throw new Error("Sign-in expired. Please try again.");
    const { state, verifier, createdAt, returnTo } = JSON.parse(expected);
    if (query.get("state") !== state || Date.now() - createdAt > 600_000)
      throw new Error("Invalid or expired sign-in response");
    if (query.has("error"))
      throw new Error(
        query.get("error_description") ?? "Sign-in was unsuccessful",
      );
    if (!query.get("code")) throw new Error("Missing authorization code");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId!,
      code: query.get("code")!,
      redirect_uri: `${location.origin}/auth/callback`,
      code_verifier: verifier,
    }).toString();
    const bodyHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const result = await fetch(`${config.authDomain}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-amz-content-sha256": bodyHash,
      },
      body,
    });
    if (!result.ok)
      throw new Error("Could not complete sign-in. Please try again.");
    const tokens = await result.json();
    token = tokens.access_token;
    if (typeof returnTo === "string" && parseDirectLink(returnTo))
      history.replaceState({}, "", returnTo);
    // Tokens stay in memory. New sign-ins check the password; browser MFA trust is managed centrally.
  }
  return { config, authenticated: !!config.local || !!token };
}
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export async function login() {
  if (!config?.clientId || !config.authDomain)
    throw new Error("Cognito has not been configured");
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  sessionStorage.setItem(
    "dnt.oauth",
    JSON.stringify({
      state,
      verifier,
      createdAt: Date.now(),
      returnTo: location.pathname,
    }),
  );
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: `${location.origin}/auth/callback`,
    scope: "openid email profile",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  location.assign(`${config.authDomain}/oauth2/authorize?${query}`);
}
export function logout() {
  token = undefined;
  sessionStorage.removeItem("dnt.oauth");
  if (config.local) location.reload();
  else
    location.assign(
      `${config.authDomain}/logout?${new URLSearchParams({ client_id: config.clientId!, logout_uri: `${location.origin}/` })}`,
    );
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  version?: number,
  key?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST")
    headers["idempotency-key"] = key ?? crypto.randomUUID();
  if (version !== undefined) headers["if-match"] = `"${version}"`;
  const response = await fetch(`/api/v1${path}`, {
    cache: "no-store",
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      response.status === 401
        ? "Your session expired. Sign out and sign in again."
        : `${data.error ?? data.message ?? `Request failed (${response.status})`}${data.details?.length ? ": " + data.details.map((d: any) => d.message).join("; ") : ""}`,
    );
  return data;
}
export async function all<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  do {
    const page: Page<T> = await api(
      `${path}${cursor ? `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
