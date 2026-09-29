import { describe, expect, it, afterEach } from "vitest";
import {
  checkPrivateAuth,
  hasPrivateTokenConfigured,
  isOverlayEnabled,
} from "./private-auth.js";

describe("private-auth", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.WEREAD_OVERLAY_ENABLED = originalEnv.WEREAD_OVERLAY_ENABLED;
    process.env.WEREAD_PRIVATE_API_TOKEN = originalEnv.WEREAD_PRIVATE_API_TOKEN;
  });

  it("disabled -> 404", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "false";
    process.env.WEREAD_PRIVATE_API_TOKEN = "secret-token";
    const result = checkPrivateAuth("Bearer secret-token", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("enabled but missing token env -> 503", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    delete process.env.WEREAD_PRIVATE_API_TOKEN;
    const result = checkPrivateAuth("Bearer any", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("missing header -> 401", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "secret-token";
    const result = checkPrivateAuth(undefined, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("wrong bearer -> 403", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "secret-token";
    const result = checkPrivateAuth("Bearer wrong", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("correct bearer -> ok", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "secret-token";
    const result = checkPrivateAuth("Bearer secret-token", undefined);
    expect(result.ok).toBe(true);
  });

  it("correct X-Private-Token -> ok", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "secret-token";
    const result = checkPrivateAuth(undefined, "secret-token");
    expect(result.ok).toBe(true);
  });

  it("token does not appear in error", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "secret-token";
    const result = checkPrivateAuth("Bearer wrong", undefined);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});

// ─── M3-A Task 6: request-aware WeRead authorizer ───
import type { Request } from "express";
import type { GoogleSessionAuthConfig } from "../auth/config.js";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { issueWebSession } from "../auth/web-session.js";
import {
  authorizeWereadRouteRequest,
  createWereadRequestAuthorizer,
} from "./private-auth.js";

const OWNER_SUB = "owner-sub-t6";
const G_SECRET = "y".repeat(48);
const G_ORIGIN = "https://books.example.com";
const MINT_NOW = Math.floor(Date.now() / 1000) - 60;

function googleCfg(overrides: Record<string, string | undefined> = {}): GoogleSessionAuthConfig {
  return readGoogleSessionAuthConfig({
    NODE_ENV: "production",
    GOOGLE_AUTH_ENABLED: "true",
    GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
    BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: OWNER_SUB,
    BOOK_ID_SEARCH_SESSION_SECRET: G_SECRET,
    BOOK_ID_SEARCH_PUBLIC_ORIGIN: G_ORIGIN,
    ...overrides,
  });
}

function fakeReq(overrides: {
  method?: string;
  authorization?: string;
  xPrivateToken?: string;
  cookie?: string;
  origin?: string;
  csrfToken?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (overrides.authorization !== undefined) headers.authorization = overrides.authorization;
  if (overrides.xPrivateToken !== undefined) headers["x-private-token"] = overrides.xPrivateToken;
  if (overrides.cookie !== undefined) headers.cookie = overrides.cookie;
  if (overrides.origin !== undefined) headers.origin = overrides.origin;
  if (overrides.csrfToken !== undefined) headers["x-csrf-token"] = overrides.csrfToken;
  return {
    method: overrides.method ?? "GET",
    headers,
    get(name: string) { return headers[name.toLowerCase()]; },
  } as unknown as Request;
}

function mint(sub = OWNER_SUB): { cookie: string; csrf: string } {
  const { token, payload } = issueWebSession(
    { sub, email: "owner@example.com", name: "Owner" },
    { secret: G_SECRET, nowSeconds: MINT_NOW },
  );
  return { cookie: `__Host-book_id_search_session=${token}`, csrf: payload.csrf };
}

describe("createWereadRequestAuthorizer (Task 6)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env.WEREAD_OVERLAY_ENABLED = originalEnv.WEREAD_OVERLAY_ENABLED;
    process.env.WEREAD_PRIVATE_API_TOKEN = originalEnv.WEREAD_PRIVATE_API_TOKEN;
  });

  function setup(overlay = true, token = "weread-secret") {
    process.env.WEREAD_OVERLAY_ENABLED = overlay ? "true" : "false";
    if (token === null) delete process.env.WEREAD_PRIVATE_API_TOKEN;
    else process.env.WEREAD_PRIVATE_API_TOKEN = token;
  }

  it("valid owner session GET → PASS", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ cookie: mint().cookie }))).toEqual({ ok: true });
  });

  it("valid owner session POST + Origin + CSRF → PASS", () => {
    setup();
    const session = mint();
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ method: "POST", cookie: session.cookie, origin: G_ORIGIN, csrfToken: session.csrf }))).toEqual({ ok: true });
  });

  it("session POST missing Origin → 403", () => {
    setup();
    const session = mint();
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ method: "POST", cookie: session.cookie, csrfToken: session.csrf }))).toMatchObject({ ok: false, status: 403 });
  });

  it("session POST missing CSRF → 403", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ method: "POST", cookie: mint().cookie, origin: G_ORIGIN }))).toMatchObject({ ok: false, status: 403 });
  });

  it("tampered cookie → 401, no fallback", () => {
    setup();
    const cookie = mint().cookie.slice(0, -3) + "aaa";
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ cookie }))).toMatchObject({ ok: false, status: 401 });
  });

  it("expired cookie → 401, no fallback", () => {
    setup();
    const expiredNow = Math.floor(Date.now() / 1000) - 9 * 60 * 60; // 9h old vs 8h TTL
    const { token } = issueWebSession(
      { sub: OWNER_SUB, email: "owner@example.com", name: "Owner" },
      { secret: G_SECRET, nowSeconds: expiredNow },
    );
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ cookie: `__Host-book_id_search_session=${token}` }))).toMatchObject({ ok: false, status: 401 });
  });

  it("owner mismatch → 401, no fallback", () => {
    setup();
    const other = mint("someone-else");
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ cookie: other.cookie }))).toMatchObject({ ok: false, status: 401 });
  });

  it("duplicate cookie name → 401, no fallback", () => {
    setup();
    const a = mint();
    const b = mint();
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ cookie: `${a.cookie}; ${b.cookie}` }))).toMatchObject({ ok: false, status: 401 });
  });

  it("wrong WeRead bearer + valid session → 403, no fallback", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg());
    const res = auth(fakeReq({ authorization: "Bearer wrong", cookie: mint().cookie }));
    expect(res).toMatchObject({ ok: false, status: 403, message: "Invalid token." });
  });

  it("correct WeRead bearer + bad cookie → PASS legacy", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ authorization: "Bearer weread-secret", cookie: "__Host-book_id_search_session=junk" }))).toEqual({ ok: true });
  });

  it("correct WeRead X-Private-Token (no bearer) → PASS legacy", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ xPrivateToken: "weread-secret" }))).toEqual({ ok: true });
  });

  it("overlay disabled + valid session → 404 (session cannot bypass)", () => {
    setup(false);
    const auth = createWereadRequestAuthorizer(googleCfg());
    expect(auth(fakeReq({ cookie: mint().cookie }))).toMatchObject({ ok: false, status: 404, message: "Not Found" });
  });

  it("Google incomplete + correct bearer → PASS legacy", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg({ GOOGLE_CLIENT_ID: "" }));
    expect(auth(fakeReq({ authorization: "Bearer weread-secret" }))).toEqual({ ok: true });
  });

  it("Google incomplete + no bearer → legacy 401 semantics", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg({ BOOK_ID_SEARCH_SESSION_SECRET: "short" }));
    expect(auth(fakeReq({}))).toMatchObject({ ok: false, status: 401, message: "Missing token." });
  });

  it("S32 bearer rejected by WeRead capability", () => {
    setup();
    // S32 bearer is a different token namespace; any non-matching explicit
    // credential must fail with 403 and never fall through to session.
    process.env.S32_PRIVATE_API_TOKEN = "s32-only-token";
    const auth = createWereadRequestAuthorizer(googleCfg());
    const res = auth(fakeReq({ authorization: "Bearer s32-only-token", cookie: mint().cookie }));
    expect(res).toMatchObject({ ok: false, status: 403, message: "Invalid token." });
    delete process.env.S32_PRIVATE_API_TOKEN;
  });

  it("no token in any failure message (no secret leak)", () => {
    setup();
    const auth = createWereadRequestAuthorizer(googleCfg());
    for (const req of [
      fakeReq({ authorization: "Bearer wrong" }),
      fakeReq({ cookie: "junk" }),
      fakeReq({ method: "POST", cookie: mint().cookie }),
    ]) {
      const res = auth(req);
      if (!res.ok) {
        expect(res.message).not.toContain("weread-secret");
        expect(res.message).not.toContain("s32-only-token");
      }
    }
  });
});

describe("authorizeWereadRouteRequest (migration gate)", () => {
  it("without injected authorizer falls back to legacy header check", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "weread-secret";
    expect(authorizeWereadRouteRequest(fakeReq({ authorization: "Bearer weread-secret" }))).toEqual({ ok: true });
    expect(authorizeWereadRouteRequest(fakeReq({}))).toMatchObject({ ok: false, status: 401 });
  });
  it("with injected authorizer uses it exclusively", () => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "weread-secret";
    const injected: ReturnType<typeof createWereadRequestAuthorizer> = () => ({ ok: true });
    expect(authorizeWereadRouteRequest(fakeReq({}), injected)).toEqual({ ok: true });
  });
});
