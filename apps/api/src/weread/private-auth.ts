import { timingSafeEqual } from "node:crypto";
import process from "node:process";

/**
 * Check whether the WeRead private overlay feature is enabled.
 */
export function isOverlayEnabled(): boolean {
  return process.env.WEREAD_OVERLAY_ENABLED === "true";
}

/**
 * Check whether the private API token is configured. Returns true if a token is set.
 */
export function hasPrivateTokenConfigured(): boolean {
  return Boolean(process.env.WEREAD_PRIVATE_API_TOKEN && process.env.WEREAD_PRIVATE_API_TOKEN.length > 0);
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Keep the timing comparison length equal so it does not leak length difference.
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

export type AuthCheckResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 503; message: string };

/**
 * Verify the overlay is enabled and the token is valid.
 * Supports:
 *   Authorization: Bearer <token>
 *   X-Private-Token: <token>
 */
export function checkPrivateAuth(authHeader: string | undefined, tokenHeader: string | undefined): AuthCheckResult {
  if (!isOverlayEnabled()) {
    return { ok: false, status: 404, message: "Not Found" };
  }
  if (!hasPrivateTokenConfigured()) {
    return { ok: false, status: 503, message: "Private token not configured." };
  }

  const token = process.env.WEREAD_PRIVATE_API_TOKEN as string;

  let provided: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice(7).trim();
  } else if (tokenHeader) {
    provided = tokenHeader.trim();
  }

  if (!provided) {
    return { ok: false, status: 401, message: "Missing token." };
  }
  if (!constantTimeCompare(provided, token)) {
    return { ok: false, status: 403, message: "Invalid token." };
  }
  return { ok: true };
}
