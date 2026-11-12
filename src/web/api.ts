import {
  saveDrafts,
  pendingDrafts,
  restoreDrafts,
  clearDrafts,
} from "./session-drafts.js";
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
let activeRequests = 0;
let renewalQueued = false;
let authGeneration = 0;
function expired() {
  window.dispatchEvent(new Event("dnt-session-expired"));
}
function acceptToken(value: string, expiresIn?: number) {
  token = value;
  sessionStorage.removeItem("dnt.auto-signin-blocked");
  sessionStorage.setItem("dnt.previous-session", "true");
  clearTimeout(expiryTimer);
  expiresAt = typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : 0;
  if (expiresAt)
    expiryTimer = setTimeout(
      () => queueRenewal(),
      Math.max(0, expiresAt - Date.now() - 30_000),
    );
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
  const callback = location.pathname === "/auth/callback";
  if (callback) {
    sessionStorage.setItem("dnt.auto-signin-blocked", "true");
    const query = new URLSearchParams(location.search);
    const expected = sessionStorage.getItem("dnt.oauth");
    sessionStorage.removeItem("dnt.oauth");
    history.replaceState({}, "", "/");
    if (!expected) throw new Error("Sign-in expired. Please try again.");
    const { state, verifier, createdAt, returnTo } = JSON.parse(expected);

    if (query.get("state") !== state || Date.now() - createdAt > 600_000)
      throw new Error("Invalid or expired sign-in response");
    if (typeof returnTo === "string" && returnTo.startsWith("/")) {
      const destination = new URL(returnTo, location.origin);
      if (
        destination.origin === location.origin &&
        (destination.pathname === "/" || parseDirectLink(destination.pathname))
      )
        history.replaceState({}, "", destination.pathname + destination.hash);
    }
    if (query.has("error"))
      throw new Error(
        query.get("error") === "login_required"
          ? "Your shared session has ended. Sign in to restore your unsaved work."
          : (query.get("error_description") ?? "Sign-in was unsuccessful"),
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
    if (
      typeof tokens.expires_in !== "undefined" &&
      (!Number.isFinite(tokens.expires_in) || tokens.expires_in < 60)
    )
      throw new Error(
        "Sign-in returned an unusable session. Please try again.",
      );
    const pending = pendingDrafts();
    if (pending && subject(tokens.access_token) !== pending.subject)
      throw new Error(
        "Sign in with the same account to restore your unsaved work.",
      );
    restoreDrafts(subject(tokens.access_token));
    acceptToken(tokens.access_token, tokens.expires_in);
    // Tokens stay in memory. The existing broker decides whether its fixed SSO session can be reused.
  }
  if (
    !callback &&
    !config.local &&
    !token &&
    !sessionStorage.getItem("dnt.auto-signin-blocked") &&
    (location.pathname === "/" ||
      location.pathname.startsWith("/t/") ||
      sessionStorage.getItem("dnt.previous-session"))
  ) {
    const attempt = await authorization(true);
    sessionStorage.setItem("dnt.auto-signin-blocked", "true");
    sessionStorage.setItem("dnt.oauth", attempt.transaction);
    location.replace(attempt.url);
    await new Promise(() => {});
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
    returnTo: pendingDrafts()?.destination ?? location.pathname + location.hash,
  });
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: `${location.origin}/auth/callback`,
    scope: "openid email profile",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    ...(renewal ? { prompt: "none" } : {}),
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
function queueRenewal() {
  // A freshly renewed token rejected by the API must not create a redirect loop.
  const lastAttempt = Number(sessionStorage.getItem("dnt.silent-attempt") ?? 0);
  if (Date.now() - lastAttempt < 60_000) {
    expired();
    return;
  }
  if (renewalPending || renewalQueued || !token || config.local) return;
  renewalQueued = true;
  const generation = authGeneration;
  const ready = () => {
    if (generation !== authGeneration) {
      renewalQueued = false;
      return;
    }
    if (activeRequests) {
      setTimeout(ready, 100);
      return;
    }
    // Let completed requests commit their React state before capturing drafts.
    setTimeout(() => {
      renewalQueued = false;
      if (generation !== authGeneration) return;
      void renewSession().catch(expired);
    }, 0);
  };
  ready();
}
export async function renewSession(interactive = false) {
  if (renewalPending) return;
  const account = subject(token);
  if (!account) throw new Error("Sign in again to continue your session.");
  renewalPending = true;
  const generation = authGeneration;
  try {
    const attempt = await authorization(!interactive);
    if (generation !== authGeneration) return;
    // Authorization hashes asynchronously. A request may start while it is
    // being prepared, or after the queue's idle check. Recheck immediately
    // before the synchronous snapshot/navigation, allowing React to settle.
    do {
      await new Promise((resolve) =>
        setTimeout(resolve, activeRequests ? 100 : 0),
      );
      if (generation !== authGeneration) return;
    } while (activeRequests);
    if (generation !== authGeneration) return;
    saveDrafts(account, location.pathname + location.hash);
    sessionStorage.setItem("dnt.auto-signin-blocked", "true");
    sessionStorage.setItem("dnt.oauth", attempt.transaction);
    sessionStorage.setItem("dnt.silent-attempt", String(Date.now()));
    location.replace(attempt.url);
  } catch (error) {
    renewalPending = false;
    throw error;
  }
}
export function logout() {
  authGeneration++;
  renewalPending = false;
  clearDrafts();
  sessionStorage.setItem("dnt.auto-signin-blocked", "true");
  sessionStorage.removeItem("dnt.previous-session");
  sessionStorage.removeItem("dnt.silent-attempt");
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
    queueRenewal();
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
  activeRequests++;
  try {
    const response = await fetch(`/api/v1${path}`, {
      cache: "no-store",
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? undefined : await response.json();
    if (response.status === 401) queueRenewal();
    if (!response.ok)
      throw new ApiError(
        response.status,
        response.status === 401
          ? "Your session needs renewal. Continue session, then retry your action. Your draft is still here."
          : `${data.error ?? data.message ?? `Request failed (${response.status})`}${data.details?.length ? ": " + data.details.map((d: any) => d.message).join("; ") : ""}`,
      );
    return data;
  } finally {
    activeRequests--;
  }
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
