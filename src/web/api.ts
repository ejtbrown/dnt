import type { Page } from "../shared/model.js";
import { parseDirectLink } from "../shared/links.js";
export interface Config {
  local?: boolean;
  clientId?: string;
  authDomain?: string;
}
let config: Config;
let token: string | undefined;
let expiresAt = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let renewalPending = false;
let cancelRenewal: (() => void) | undefined;
export function cancelSessionRenewal() {
  cancelRenewal?.();
}
function expired() {
  window.dispatchEvent(new Event("dnt-session-expired"));
}
function acceptToken(value: string, expiresIn?: number) {
  token = value;
  clearTimeout(expiryTimer);
  expiresAt = typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : 0;
  if (expiresAt)
    expiryTimer = setTimeout(expired, Math.max(0, expiresAt - Date.now()));
}
function subject(value: string | undefined) {
  try {
    return JSON.parse(
      atob(value!.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
    ).sub;
  } catch {
    return undefined;
  }
}

export async function initialize() {
  const response = await fetch("/config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Application configuration is unavailable");
  config = await response.json();
  if (location.pathname === "/auth/callback") {
    let renewalState: string | undefined;
    try {
      const query = new URLSearchParams(location.search);
      const expected = sessionStorage.getItem("dnt.oauth");
      sessionStorage.removeItem("dnt.oauth");
      history.replaceState({}, "", "/");
      if (!expected) throw new Error("Sign-in expired. Please try again.");
      const { state, verifier, createdAt, returnTo, renewal } =
        JSON.parse(expected);
      if (renewal) renewalState = state;
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
      if (typeof tokens.access_token !== "string" || !tokens.access_token)
        throw new Error("Sign-in did not return an access token");
      if (renewal) {
        // A random per-attempt channel survives the broker's opener isolation.
        // Credentials travel in memory only, never through browser storage.
        const channel = new BroadcastChannel(`dnt-renew-${state}`);
        channel.postMessage({
          accessToken: tokens.access_token,
          expiresIn: tokens.expires_in,
        });
        channel.close();
        window.close();
        return { config, authenticated: false, renewalComplete: true };
      }
      acceptToken(tokens.access_token, tokens.expires_in);
      if (typeof returnTo === "string" && returnTo.startsWith("/")) {
        const destination = new URL(returnTo, location.origin);
        if (
          destination.origin === location.origin &&
          parseDirectLink(destination.pathname)
        )
          history.replaceState({}, "", destination.pathname + destination.hash);
      }
    } catch (error) {
      if (renewalState) {
        const channel = new BroadcastChannel(`dnt-renew-${renewalState}`);
        channel.postMessage({
          error: error instanceof Error ? error.message : "Sign-in failed",
        });
        channel.close();
        window.close();
      }
      throw error;
    }
    // Tokens stay in memory. The existing broker decides whether its fixed SSO session can be reused.
  }
  return { config, authenticated: !!config.local || !!token };
}
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function authorization(renewal = false) {
  if (!config?.clientId || !config.authDomain)
    throw new Error("Cognito has not been configured");
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const transaction = JSON.stringify({
    state,
    verifier,
    createdAt: Date.now(),
    returnTo: location.pathname + location.hash,
    renewal,
  });
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: `${location.origin}/auth/callback`,
    scope: "openid email profile",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return {
    state,
    transaction,
    url: `${config.authDomain}/oauth2/authorize?${query}`,
  };
}
export async function login() {
  const attempt = await authorization();
  sessionStorage.setItem("dnt.oauth", attempt.transaction);
  location.assign(attempt.url);
}
export async function renewSession() {
  if (renewalPending) return;
  // Open directly from a click so popup blockers cannot silently discard drafts.
  const popup = window.open(
    "about:blank",
    "_blank",
    "popup,width=520,height=720",
  );
  if (!popup)
    throw new Error(
      "Allow the sign-in window, then try Continue session again. Your draft is still here.",
    );
  renewalPending = true;
  try {
    const attempt = await authorization(true);
    popup.sessionStorage.setItem("dnt.oauth", attempt.transaction);
    await new Promise<void>((resolve, reject) => {
      const channel = new BroadcastChannel(`dnt-renew-${attempt.state}`);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        cancelRenewal = undefined;
        channel.close();
        popup.close();
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              "Sign-in timed out. Your draft is still here; try Continue session again.",
            ),
          ),
        600_000,
      );
      // COOP can sever the window handle during broker navigation, so the
      // callback channel, not popup.closed, determines successful completion.
      cancelRenewal = () =>
        finish(new Error("Sign-in cancelled. Your draft is still here."));
      channel.onmessage = ({ data }) => {
        if (typeof data?.error === "string") {
          finish(new Error(data.error));
          return;
        }
        if (typeof data?.accessToken !== "string") return;
        if (subject(token) && subject(token) !== subject(data.accessToken)) {
          finish(
            new Error(
              "Sign in with the same account to keep editing this draft.",
            ),
          );
          return;
        }
        acceptToken(data.accessToken, data.expiresIn);
        window.dispatchEvent(new Event("dnt-session-renewed"));
        finish();
      };
      popup.location.assign(attempt.url);
    });
  } finally {
    renewalPending = false;
  }
}
export function logout() {
  cancelSessionRenewal();
  token = undefined;
  expiresAt = 0;
  clearTimeout(expiryTimer);
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
  if (!config.local && token && expiresAt && Date.now() >= expiresAt) {
    expired();
    throw new ApiError(
      401,
      "Your session needs renewal. Continue session, then retry your action. Your draft is still here.",
    );
  }
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
  if (response.status === 401) expired();
  if (!response.ok)
    throw new ApiError(
      response.status,
      response.status === 401
        ? "Your session needs renewal. Continue session, then retry your action. Your draft is still here."
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
