import type { GoogleSessionAuthConfig } from "./config.js";
import { isGoogleSessionAuthConfigured } from "./config.js";
import { readCookie, verifyWebSession, verifyWebSessionCsrf, type WebSessionPayload } from "./web-session.js";

/** Private capability a request wants to exercise. */
export type PrivateCapability = "S32_PRIVATE" | "WEREAD_PRIVATE";

/** Result contract of a capability-specific legacy bearer check (injected). */
export type LegacyAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 503; message: string };

/** Request surface the helper needs — pure data, no Express dependency. */
export interface PrivateRequestInput {
  method: string;
  authorization?: string;
  privateToken?: string;
  cookie?: string;
  origin?: string;
  csrfToken?: string;
}

export interface AuthorizePrivateRequestOptions {
  capability: PrivateCapability;
  /** Feature gate for the capability itself (S32_FEATURES / WEREAD_OVERLAY); NO session may bypass it. */
  capabilityEnabled: boolean;
  request: PrivateRequestInput;
  googleConfig: GoogleSessionAuthConfig;
  /** Capability-specific legacy bearer check (checkS32PrivateAuth / checkPrivateAuth in Task 5/6). */
  legacyCheck: (
    authorization: string | undefined,
    privateToken: string | undefined,
  ) => LegacyAuthResult;
  nowSeconds?: number;
}

export type PrivateRequestAuthResult =
  | { ok: true; authKind: "LEGACY_TOKEN" | "GOOGLE_SESSION" }
  | { ok: false; status: 401 | 403 | 404 | 503; code: PrivateAuthFailureCode; message: string };

/** Neutral internal codes; Task 5/6 map them onto their legacy response shapes. */
export type PrivateAuthFailureCode =
  | "NOT_FOUND"
  | "MISSING_CREDENTIAL"
  | "INVALID_CREDENTIAL"
  | "PRIVATE_AUTH_NOT_CONFIGURED"
  | "SESSION_INVALID"
  | "ORIGIN_FORBIDDEN"
  | "CSRF_FORBIDDEN";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function fail(status: 401 | 403 | 404 | 503, code: PrivateAuthFailureCode, message: string): PrivateRequestAuthResult {
  // Messages are neutral; never echo raw credentials, cookies, or tokens.
  return { ok: false, status, code, message };
}

function mapLegacyFailure(result: Extract<LegacyAuthResult, { ok: false }>): PrivateRequestAuthResult {
  switch (result.status) {
    case 401:
      return fail(401, "MISSING_CREDENTIAL", result.message);
    case 403:
      return fail(403, "INVALID_CREDENTIAL", result.message);
    case 503:
      return fail(503, "PRIVATE_AUTH_NOT_CONFIGURED", result.message);
    default:
      return fail(404, "NOT_FOUND", result.message);
  }
}

/**
 * Shared private-request authorization.
 *
 * Fixed order:
 *  A. capability feature gate → 404 before anything is inspected
 *  B. explicit legacy credential (Authorization header OR X-Private-Token present)
 *     → legacyCheck decides, NO fallback to Google session
 *  C. otherwise, if Google auth fully configured, a session cookie may authorize:
 *     invalid/expired/tampered/owner-mismatched cookie → 401 (no legacy fallback)
 *  D. no usable session → legacyCheck(undefined, undefined) preserves bearer-only semantics
 *
 * Unsafe methods under GOOGLE_SESSION additionally require exact Origin + CSRF.
 */
export function authorizePrivateRequest(options: AuthorizePrivateRequestOptions): PrivateRequestAuthResult {
  const { capability, capabilityEnabled, request, googleConfig, legacyCheck } = options;
  void capability; // reserved for logging/metrics; never used for token selection

  // A. Feature gate first: Google login must never bypass capability flags.
  if (!capabilityEnabled) {
    return fail(404, "NOT_FOUND", "Not Found");
  }

  // B. Explicit legacy credential takes precedence — and never falls back.
  const hasAuthorization = request.authorization !== undefined && request.authorization !== "";
  const hasPrivateToken = request.privateToken !== undefined && request.privateToken !== "";
  if (hasAuthorization || hasPrivateToken) {
    const legacy = legacyCheck(request.authorization, request.privateToken);
    return legacy.ok
      ? { ok: true, authKind: "LEGACY_TOKEN" }
      : mapLegacyFailure(legacy);
  }

  // C. Google owner session (only when the Google config is complete).
  if (isGoogleSessionAuthConfigured(googleConfig)) {
    const cookie = readCookie(request.cookie, googleConfig.cookieName);
    if (cookie) {
      const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
      const payload: WebSessionPayload | null = verifyWebSession(
        cookie,
        googleConfig.sessionSecret as string,
        now,
      );
      // Single neutral failure: no distinction between tampered/expired/owner-mismatch.
      if (!payload || payload.sub !== googleConfig.ownerSub) {
        return fail(401, "SESSION_INVALID", "会话无效。");
      }

      const method = request.method.toUpperCase();
      if (SAFE_METHODS.has(method)) {
        return { ok: true, authKind: "GOOGLE_SESSION" };
      }

      // Unsafe method: exact Origin, then CSRF.
      if (request.origin !== googleConfig.publicOrigin) {
        return fail(403, "ORIGIN_FORBIDDEN", "来源不允许。");
      }
      if (!verifyWebSessionCsrf(payload, request.csrfToken)) {
        return fail(403, "CSRF_FORBIDDEN", "CSRF 校验失败。");
      }
      return { ok: true, authKind: "GOOGLE_SESSION" };
    }
  }

  // D. No session involved: preserve legacy missing-credential semantics.
  const legacy = legacyCheck(undefined, undefined);
  return legacy.ok
    ? { ok: true, authKind: "LEGACY_TOKEN" }
    : mapLegacyFailure(legacy);
}
