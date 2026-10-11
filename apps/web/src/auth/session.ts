/**
 * Web auth session store/client (M3-A Auth Gate 1 Task 7).
 *
 * Module-level external store consumed via React's useSyncExternalStore.
 * Security invariants:
 *   - csrfToken lives in memory only; never localStorage/sessionStorage.
 *   - Google credential is passed straight to POST /api/auth/google and never
 *     enters state, error messages, logs, or storage.
 *   - The session GET response is strictly parsed; anything malformed is a
 *     generic error, never a raw backend detail echo.
 */

export type WebAuthStatus =
  | "idle"
  | "loading"
  | "disabled"
  | "unauthenticated"
  | "authenticated"
  | "unavailable"
  | "error"
  | "signing_in"
  | "signing_out";

export interface WebAuthUser {
  email: string | null;
  name: string | null;
}

export interface WebAuthSnapshot {
  status: WebAuthStatus;
  user: WebAuthUser | null;
  csrfToken: string | null;
  error: string | null;
}

const initialSnapshot: WebAuthSnapshot = {
  status: "idle",
  user: null,
  csrfToken: null,
  error: null,
};

let snapshot: WebAuthSnapshot = initialSnapshot;
const listeners = new Set<() => void>();
// Opaque, monotonic local epoch. Never expose the CSRF credential as a React key,
// URL, model field, DOM attribute or persistent value.
let authGeneration = 0;

export function getWebAuthAuthGeneration(): number {
  return authGeneration;
}

function setSnapshot(next: WebAuthSnapshot): void {
  const oldAuth = snapshot.status === "authenticated" ? snapshot.csrfToken : null;
  const newAuth = next.status === "authenticated" ? next.csrfToken : null;
  if (oldAuth !== newAuth || (newAuth !== null && snapshot.user?.email !== next.user?.email)) authGeneration += 1;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getWebAuthSnapshot(): WebAuthSnapshot {
  return snapshot;
}

export function subscribeWebAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: reset the store to its pristine state. */
/**
 * Task 8 test helper: directly install a snapshot WITHOUT any network GET.
 * Test-only; production code must never call this.
 */
export function __setWebAuthSnapshotForTests(next: WebAuthSnapshot): void {
  setSnapshot(next);
}

export function __resetWebAuthStoreForTests(): void {
  snapshot = initialSnapshot;
  authGeneration = 0;
  inFlightSessionLoad = null;
}

const GENERIC_SESSION_ERROR = "登录状态检查失败，请稍后重试。";
const GENERIC_LOGIN_ERROR = "Google 登录失败，请稍后重试。";
const GENERIC_LOGIN_CREDENTIAL_ERROR = "Google 登录凭据无效，请重新登录。";
const GENERIC_LOGIN_FORBIDDEN = "当前 Google 账号未被授权访问。";
const GENERIC_LOGIN_DISABLED = "Google 登录尚未启用。";
const GENERIC_LOGIN_UNAVAILABLE = "登录服务暂不可用，请稍后重试。";
const GENERIC_LOGOUT_ERROR = "退出登录失败，请稍后重试。";

function applySessionResponse(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) {
    setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
    return;
  }
  const body = payload as { authenticated?: unknown; user?: unknown; csrfToken?: unknown };
  if (body.authenticated === false) {
    setSnapshot({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    return;
  }
  if (body.authenticated === true) {
    let user: WebAuthUser | null = null;
    if (body.user !== null && body.user !== undefined) {
      if (typeof body.user !== "object") {
        setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
        return;
      }
      const u = body.user as { email?: unknown; name?: unknown };
      if ((u.email !== null && u.email !== undefined && typeof u.email !== "string")
        || (u.name !== null && u.name !== undefined && typeof u.name !== "string")) {
        setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
        return;
      }
      user = { email: u.email ?? null, name: u.name ?? null };
    }
    if (typeof body.csrfToken !== "string" || body.csrfToken.length === 0) {
      setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
      return;
    }
    setSnapshot({ status: "authenticated", user, csrfToken: body.csrfToken, error: null });
    return;
  }
  setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
}

let inFlightSessionLoad: Promise<void> | null = null;

/** GET /api/auth/session once; concurrent callers share one request. */
export function ensureAuthSessionLoaded(): Promise<void> {
  if (inFlightSessionLoad) return inFlightSessionLoad;
  setSnapshot({ ...snapshot, status: snapshot.status === "authenticated" ? snapshot.status : "loading", error: null });
  inFlightSessionLoad = (async () => {
    try {
      const res = await fetch("/api/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 404) {
        setSnapshot({ status: "disabled", user: null, csrfToken: null, error: null });
        return;
      }
      if (res.status === 503) {
        setSnapshot({ status: "unavailable", user: null, csrfToken: null, error: null });
        return;
      }
      if (!res.ok) {
        setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
        return;
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
        return;
      }
      applySessionResponse(payload);
    } catch {
      setSnapshot({ ...snapshot, status: "error", error: GENERIC_SESSION_ERROR });
    } finally {
      inFlightSessionLoad = null;
    }
  })();
  return inFlightSessionLoad;
}

function loginErrorFor(status: number): string {
  if (status === 401) return GENERIC_LOGIN_CREDENTIAL_ERROR;
  if (status === 403) return GENERIC_LOGIN_FORBIDDEN;
  if (status === 404) return GENERIC_LOGIN_DISABLED;
  if (status === 503) return GENERIC_LOGIN_UNAVAILABLE;
  return GENERIC_LOGIN_ERROR;
}

/** POST /api/auth/google with the GIS credential, then authoritative refresh. */
export async function signInWithGoogleCredential(credential: string): Promise<void> {
  if (typeof credential !== "string" || credential.length === 0) {
    setSnapshot({ ...snapshot, status: "error", error: GENERIC_LOGIN_CREDENTIAL_ERROR });
    return;
  }
  setSnapshot({ ...snapshot, status: "signing_in", error: null });
  try {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) {
      setSnapshot({ ...snapshot, status: "unauthenticated", error: loginErrorFor(res.status) });
      return;
    }
  } catch {
    setSnapshot({ ...snapshot, status: "unauthenticated", error: GENERIC_LOGIN_ERROR });
    return;
  }
  // Server-authoritative refresh: user + csrf come from GET /api/auth/session.
  await ensureAuthSessionLoaded();
  if (snapshot.status !== "authenticated") {
    setSnapshot({ status: "error", user: null, csrfToken: null, error: GENERIC_LOGIN_ERROR });
  }
}

/** POST /api/auth/logout with the CSRF header; failure never fakes success. */
export async function signOut(): Promise<void> {
  if (snapshot.status !== "authenticated" || snapshot.csrfToken === null) {
    return;
  }
  const csrfToken = snapshot.csrfToken;
  const userBeforeSignOut = snapshot.user;
  setSnapshot({ status: "signing_out", user: userBeforeSignOut, csrfToken, error: null });
  try {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-csrf-token": csrfToken },
    });
    if (res.status === 204) {
      setSnapshot({ status: "unauthenticated", user: null, csrfToken: null, error: null });
      return;
    }
    // Failure: keep the current session and surface a retryable error.
    setSnapshot({ status: "authenticated", user: userBeforeSignOut, csrfToken, error: GENERIC_LOGOUT_ERROR });
  } catch {
    setSnapshot({ status: "authenticated", user: userBeforeSignOut, csrfToken, error: GENERIC_LOGOUT_ERROR });
  }
}
