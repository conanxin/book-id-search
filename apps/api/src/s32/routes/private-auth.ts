import { timingSafeEqual } from "node:crypto";
import type { S32Config } from "../config.js";

export type S32AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 503; message: string };

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
