import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WEB_SESSION_VERSION = 1 as const;
export const MIN_SESSION_SECRET_BYTES = 32;
export const DEFAULT_WEB_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface WebSessionIdentity {
  sub: string;
  email: string | null;
  name: string | null;
}

export interface WebSessionPayload extends WebSessionIdentity {
  v: typeof WEB_SESSION_VERSION;
  iat: number;
  exp: number;
  csrf: string;
}

export interface IssueWebSessionOptions {
  secret: string;
  nowSeconds?: number;
  ttlSeconds?: number;
  csrfToken?: string;
}

const csrfPattern = /^[A-Za-z0-9_-]{16,128}$/;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requireSessionSecret(secret: string): void {
  if (typeof secret !== "string" || utf8Bytes(secret) < MIN_SESSION_SECRET_BYTES) {
    throw new Error("WEB_SESSION_SECRET_TOO_SHORT");
  }
}

function canonicalString(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error("WEB_SESSION_IDENTITY_INVALID");
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > max || normalized.includes("\u0000")) {
    throw new Error("WEB_SESSION_IDENTITY_INVALID");
  }
  return normalized;
}

function encodePayload(payload: WebSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signature(payloadPart: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadPart, "utf8").digest("base64url");
}

function constantTimeTextEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (aa.length !== bb.length) {
    timingSafeEqual(aa, aa);
    return false;
  }
  return timingSafeEqual(aa, bb);
}

function strictPayload(value: unknown): WebSessionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const record = value as Record<string, unknown>;
  const expected = ["v", "sub", "email", "name", "iat", "exp", "csrf"];
  if (Reflect.ownKeys(record).some(key => typeof key !== "string" || !expected.includes(key))) return null;
  if (Object.keys(record).length !== expected.length || !expected.every(key => Object.hasOwn(record, key))) return null;
  if (record.v !== WEB_SESSION_VERSION) return null;
  if (typeof record.sub !== "string" || !record.sub.trim() || record.sub !== record.sub.trim()) return null;
  if (record.email !== null && (typeof record.email !== "string" || !record.email.trim())) return null;
  if (record.name !== null && (typeof record.name !== "string" || !record.name.trim())) return null;
  if (!Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.exp)) return null;
  if ((record.iat as number) < 0 || (record.exp as number) <= (record.iat as number)) return null;
  if (typeof record.csrf !== "string" || !csrfPattern.test(record.csrf)) return null;
  return record as unknown as WebSessionPayload;
}

export function issueWebSession(
  identity: WebSessionIdentity,
  options: IssueWebSessionOptions,
): { token: string; payload: WebSessionPayload } {
  requireSessionSecret(options.secret);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_WEB_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > DEFAULT_WEB_SESSION_TTL_SECONDS) {
    throw new Error("WEB_SESSION_TIME_INVALID");
  }
  const csrf = options.csrfToken ?? randomBytes(24).toString("base64url");
  if (!csrfPattern.test(csrf)) throw new Error("WEB_SESSION_CSRF_INVALID");

  const payload: WebSessionPayload = {
    v: WEB_SESSION_VERSION,
    sub: canonicalString(identity.sub, 255) as string,
    email: canonicalString(identity.email, 320, true),
    name: canonicalString(identity.name, 200, true),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    csrf,
  };
  const payloadPart = encodePayload(payload);
  return {
    token: `${payloadPart}.${signature(payloadPart, options.secret)}`,
    payload,
  };
}

export function verifyWebSession(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): WebSessionPayload | null {
  try {
    requireSessionSecret(secret);
    if (typeof token !== "string" || token.trim() !== token) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [payloadPart, providedSignature] = parts;
    const expectedSignature = signature(payloadPart, secret);
    if (!constantTimeTextEqual(providedSignature, expectedSignature)) return null;
    const parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    const payload = strictPayload(parsed);
    if (!payload) return null;
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < payload.iat - 60 || nowSeconds >= payload.exp) return null;
    if (payload.exp - payload.iat > DEFAULT_WEB_SESSION_TTL_SECONDS) return null;
    if (encodePayload(payload) !== payloadPart) return null;
    return payload;
  } catch {
    return null;
  }
}

export function verifyWebSessionCsrf(payload: WebSessionPayload, provided: string | undefined): boolean {
  return typeof provided === "string"
    && csrfPattern.test(provided)
    && constantTimeTextEqual(payload.csrf, provided);
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader || !name) return null;
  let found: string | null = null;
  let matches = 0;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    matches += 1;
    if (matches > 1) return null; // duplicate name: ambiguous header, fail closed
    const raw = part.slice(index + 1).trim();
    try { found = decodeURIComponent(raw); } catch { return null; }
  }
  return found;
}

export function serializeWebSessionCookie(args: {
  name: string;
  token: string;
  production: boolean;
  maxAgeSeconds?: number;
}): string {
  const maxAge = args.maxAgeSeconds ?? DEFAULT_WEB_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0 || maxAge > DEFAULT_WEB_SESSION_TTL_SECONDS) {
    throw new Error("WEB_SESSION_COOKIE_MAX_AGE_INVALID");
  }
  const parts = [
    `${args.name}=${encodeURIComponent(args.token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (args.production) parts.push("Secure");
  return parts.join("; ");
}

export function serializeClearWebSessionCookie(args: {
  name: string;
  production: boolean;
}): string {
  const parts = [
    `${args.name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (args.production) parts.push("Secure");
  return parts.join("; ");
}
