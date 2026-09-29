import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { S32Config } from "../config.js";
import type { GoogleSessionAuthConfig } from "../../auth/config.js";
import { authorizePrivateRequest } from "../../auth/private-request-auth.js";

export type S32AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 503; message: string };

/** Request-aware S32 authorizer (legacy bearer + Google owner session). */
export type S32RequestAuthorizer = (req: Request) => S32AuthResult;

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = a.length > b.length ? a : b;
    timingSafeEqual(Buffer.from(dummy), Buffer.from(dummy));
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function checkS32PrivateAuth(
  config: S32Config,
  authHeader: string | undefined,
  tokenHeader: string | undefined,
): S32AuthResult {
  if (!config.enabled) {
    return { ok: false, status: 404, message: "Not Found" };
  }
  if (!config.privateToken) {
    return { ok: false, status: 503, message: "S32 private token not configured." };
  }

  let provided: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    provided = authHeader.slice(7).trim();
  } else if (tokenHeader) {
    provided = tokenHeader.trim();
  }

  if (!provided) {
    return { ok: false, status: 401, message: "Missing token." };
  }
  if (!constantTimeCompare(provided, config.privateToken)) {
    return { ok: false, status: 403, message: "Invalid token." };
  }
  return { ok: true };
}

/**
 * Google-aware S32 request authorizer built on the Task 4 shared helper.
 * Maps the shared result back onto the legacy S32AuthResult shape so route
 * layers stay authKind-agnostic; legacy messages preserved verbatim.
 */
export function createS32RequestAuthorizer(
  config: S32Config,
  googleConfig: GoogleSessionAuthConfig,
): S32RequestAuthorizer {
  return (req: Request): S32AuthResult => {
    const result = authorizePrivateRequest({
      capability: "S32_PRIVATE",
      capabilityEnabled: config.enabled,
      request: {
        method: req.method,
        authorization: req.get("authorization"),
        privateToken: req.get("x-private-token"),
        cookie: req.get("cookie"),
        origin: req.get("origin"),
        csrfToken: req.get("x-csrf-token"),
      },
      googleConfig,
      legacyCheck: (authorization, privateToken) =>
        checkS32PrivateAuth(config, authorization, privateToken),
    });
    if (result.ok) return { ok: true };
    return { ok: false, status: result.status, message: result.message };
  };
}

/**
 * Migration-friendly gate: use the injected Google-aware authorizer when the
 * production wiring provides one; otherwise pure legacy header check. Route
 * unit tests that pass no authorizer keep their exact legacy behavior.
 */
export function authorizeS32RouteRequest(
  config: S32Config,
  req: Request,
  requestAuthorizer?: S32RequestAuthorizer,
): S32AuthResult {
  if (requestAuthorizer) return requestAuthorizer(req);
  // Plain-object request harnesses (unit tests) may expose only raw headers.
  const header = (name: string): string | undefined => {
    const viaGet = typeof (req as { get?: unknown }).get === "function"
      ? (req.get(name) as string | undefined)
      : undefined;
    if (viaGet !== undefined) return viaGet;
    const raw = (req as { headers?: Record<string, unknown> }).headers?.[name];
    return typeof raw === "string" ? raw : undefined;
  };
  return checkS32PrivateAuth(config, header("authorization"), header("x-private-token"));
}
