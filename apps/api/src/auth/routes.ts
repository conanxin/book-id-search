import { Router, type Request, type Response } from "express";
import type { GoogleSessionAuthConfig } from "./config.js";
import { isGoogleSessionAuthConfigured } from "./config.js";
import {
  createDefaultGoogleIdTokenClient,
  verifyGoogleIdentity,
  GoogleIdentityError,
  type GoogleIdentity,
} from "./google-identity.js";
import {
  issueWebSession,
  verifyWebSession,
  verifyWebSessionCsrf,
  readCookie,
  serializeWebSessionCookie,
  serializeClearWebSessionCookie,
} from "./web-session.js";

const AUTH_BODY_LIMIT_BYTES = 16 * 1024;
const CSRF_HEADER = "x-csrf-token";

export interface AuthRouterOptions {
  config: GoogleSessionAuthConfig;
  /** Injectable for tests; production default lazily builds the OAuth2Client. */
  verifyIdentity?: (credential: string) => Promise<GoogleIdentity>;
  nowSeconds?: () => number;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

function safeJson(res: Response, status: number, body: Record<string, unknown>): void {
  noStore(res);
  res.status(status).json(body);
}

/**
 * Gate order (per M3-A design): feature flag → completeness → endpoint logic.
 * 404 when the feature is off (indistinguishable from absent route);
 * 503 when on but misconfigured. Never builds a Google client in either case.
 */
function featureGate(config: GoogleSessionAuthConfig, res: Response): boolean {
  if (!config.enabled) {
    safeJson(res, 404, { error: { code: "NOT_FOUND", message: "Not Found" } });
    return false;
  }
  if (!isGoogleSessionAuthConfigured(config)) {
    safeJson(res, 503, { error: { code: "AUTH_NOT_CONFIGURED", message: "认证服务尚未配置。" } });
    return false;
  }
  return true;
}

/** Exact-origin check; the global cors() is never a security boundary. */
function originAllowed(req: Request, config: GoogleSessionAuthConfig): boolean {
  return req.get("origin") === config.publicOrigin;
}

interface AuthBody {
  credential: string;
}

/**
 * Bounded strict JSON parsing for the auth credential endpoint.
 * Mounted before the global 256kb express.json so malformed/oversized
 * payloads fail here with safe errors and never reach other handlers.
 */
function parseAuthBody(raw: unknown, onOk: (body: AuthBody) => void, res: Response): void {
  if (typeof raw !== "string" || raw.length === 0) {
    safeJson(res, 400, { error: { code: "AUTH_BODY_INVALID", message: "请求体无效。" } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeJson(res, 400, { error: { code: "AUTH_BODY_MALFORMED", message: "请求体不是合法 JSON。" } });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype) {
    safeJson(res, 400, { error: { code: "AUTH_BODY_INVALID", message: "请求体必须是 JSON 对象。" } });
    return;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "credential") {
    safeJson(res, 400, { error: { code: "AUTH_BODY_INVALID", message: "请求体字段无效。" } });
    return;
  }
  const credential = record.credential;
  if (typeof credential !== "string") {
    safeJson(res, 400, { error: { code: "AUTH_BODY_INVALID", message: "credential 必须是字符串。" } });
    return;
  }
  // Length bounds remain authoritative in verifyGoogleIdentity.
  onOk({ credential });
}

function mapIdentityError(res: Response, error: unknown): void {
  if (error instanceof GoogleIdentityError) {
    if (error.code === "GOOGLE_ID_TOKEN_INVALID") {
      safeJson(res, 401, { error: { code: "GOOGLE_ID_TOKEN_INVALID", message: "Google 凭证无效。" } });
      return;
    }
    if (error.code === "GOOGLE_ACCOUNT_NOT_ALLOWED") {
      safeJson(res, 403, { error: { code: "GOOGLE_ACCOUNT_NOT_ALLOWED", message: "该 Google 账号未被授权。" } });
      return;
    }
    safeJson(res, 503, { error: { code: "AUTH_NOT_CONFIGURED", message: "认证服务尚未配置。" } });
    return;
  }
  safeJson(res, 500, { error: { code: "AUTH_INTERNAL", message: "认证失败，请稍后再试。" } });
}

/** Reads and validates the current-owner session; null when absent/invalid. */
function currentSession(
  req: Request,
  config: GoogleSessionAuthConfig,
  nowSeconds: number,
): ReturnType<typeof verifyWebSession> {
  const cookie = readCookie(req.get("cookie"), config.cookieName);
  if (!cookie) return null;
  const payload = verifyWebSession(cookie, config.sessionSecret as string, nowSeconds);
  if (!payload) return null;
  if (payload.sub !== config.ownerSub) return null; // owner rotation invalidates old sessions
  return payload;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { config } = options;
  const now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const verifyIdentity = options.verifyIdentity ?? (async (credential: string) => {
    const client = createDefaultGoogleIdTokenClient(config.clientId as string);
    return verifyGoogleIdentity(config, credential, client);
  });

  const router = Router();

  router.use((req, res, next) => {
    if (!featureGate(config, res)) return;
    next();
  });

  router.post("/google", (req, res) => {
    // 1. exact origin gate (before any body consumption or verifier call)
    if (!originAllowed(req, config)) {
      safeJson(res, 403, { error: { code: "ORIGIN_FORBIDDEN", message: "来源不允许。" } });
      return;
    }
    // 2. JSON content-type gate
    const contentType = req.get("content-type") ?? "";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (mime !== "application/json") {
      safeJson(res, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "仅接受 application/json。" } });
      return;
    }
    // 3. bounded raw-body capture, then strict parse
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > AUTH_BODY_LIMIT_BYTES) {
        aborted = true;
        safeJson(res, 413, { error: { code: "AUTH_BODY_TOO_LARGE", message: "请求体过大。" } });
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      parseAuthBody(raw, async (body) => {
        try {
          const identity = await verifyIdentity(body.credential);
          const { token } = issueWebSession(
            { sub: identity.sub, email: identity.email, name: identity.name },
            {
              secret: config.sessionSecret as string,
              ttlSeconds: config.sessionTtlSeconds,
              nowSeconds: now(),
            },
          );
          noStore(res);
          res.setHeader("Set-Cookie", serializeWebSessionCookie({
            name: config.cookieName,
            token,
            production: config.production,
            maxAgeSeconds: config.sessionTtlSeconds,
          }));
          res.status(200).json({ authenticated: true, user: { email: identity.email, name: identity.name } });
        } catch (error) {
          mapIdentityError(res, error);
        }
      }, res);
    });
    req.on("error", () => {
      if (!aborted) safeJson(res, 400, { error: { code: "AUTH_BODY_INVALID", message: "请求体无效。" } });
    });
  });

  router.get("/session", (req, res) => {
    const payload = currentSession(req, config, now());
    if (!payload) {
      // Never reveal why; an unauthenticated state is a normal 200.
      safeJson(res, 200, { authenticated: false });
      return;
    }
    safeJson(res, 200, {
      authenticated: true,
      user: { email: payload.email, name: payload.name },
      csrfToken: payload.csrf,
    });
  });

  router.post("/logout", (req, res) => {
    if (!originAllowed(req, config)) {
      safeJson(res, 403, { error: { code: "ORIGIN_FORBIDDEN", message: "来源不允许。" } });
      return;
    }
    const payload = currentSession(req, config, now());
    if (!payload) {
      safeJson(res, 401, { error: { code: "NOT_AUTHENTICATED", message: "未登录。" } });
      return;
    }
    if (!verifyWebSessionCsrf(payload, req.get(CSRF_HEADER))) {
      safeJson(res, 403, { error: { code: "CSRF_FORBIDDEN", message: "CSRF 校验失败。" } });
      return;
    }
    noStore(res);
    res.setHeader("Set-Cookie", serializeClearWebSessionCookie({
      name: config.cookieName,
      production: config.production,
    }));
    res.status(204).end();
  });

  return router;
}
