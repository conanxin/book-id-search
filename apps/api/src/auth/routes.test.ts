import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import type { Request, Response, NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthRouter } from "./routes.js";
import { readGoogleSessionAuthConfig } from "./config.js";
import { issueWebSession } from "./web-session.js";
import { GoogleIdentityError, type GoogleIdentity } from "./google-identity.js";

const OWNER_SUB = "owner-sub-123";
const SECRET = "x".repeat(48);
const ORIGIN = "https://books.example.com";

type Verifier = (credential: string) => Promise<GoogleIdentity>;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    GOOGLE_AUTH_ENABLED: "true",
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: OWNER_SUB,
    BOOK_ID_SEARCH_SESSION_SECRET: SECRET,
    BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  };
}

interface Harness {
  app: Express;
  server: http.Server;
  baseUrl: string;
  verifier: Verifier;
  calls: { credential: string }[];
  now: number;
  close(): Promise<void>;
}

async function startHarness(envVars: NodeJS.ProcessEnv, identity?: GoogleIdentity | Error): Promise<Harness> {
  const config = readGoogleSessionAuthConfig(envVars);
  const calls: { credential: string }[] = [];
  const verifier: Verifier = async (credential) => {
    calls.push({ credential });
    if (identity instanceof Error) throw identity;
    return identity ?? { sub: OWNER_SUB, email: "owner@example.com", name: "Owner" };
  };
  const now = Math.floor(Date.now() / 1000);
  const app = express();
  app.use("/api/auth", createAuthRouter({
    config,
    verifyIdentity: verifier,
    nowSeconds: () => now,
  }));
  // minimal stand-ins proving auth failures never leak into other handlers
  const privateHits: string[] = [];
  app.post("/api/private/s32/probe", (_req, res) => { privateHits.push("s32"); res.json({ ok: true }); });
  app.get("/api/private/weread/probe", (_req, res) => { privateHits.push("weread"); res.json({ ok: true }); });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  return {
    app, server, calls, now,
    verifier,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

function post(app: Harness, path: string, body: string | object, headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: raw,
  });
}

function get(app: Harness, path: string, headers: Record<string, string> = {}) {
  return fetch(`${app.baseUrl}${path}`, { headers });
}

function sessionCookieName(production: boolean): string {
  return production ? "__Host-book_id_search_session" : "book_id_search_session_dev";
}

describe("auth routes / feature gate", () => {
  let h: Harness;
  afterEach(async () => { await h?.close(); });

  it("returns 404 for all three endpoints when disabled, verifier uncalled", async () => {
    h = await startHarness(env({ GOOGLE_AUTH_ENABLED: "false" }));
    expect((await post(h, "/api/auth/google", { credential: "x".repeat(32) })).status).toBe(404);
    expect((await get(h, "/api/auth/session")).status).toBe(404);
    expect((await post(h, "/api/auth/logout", {})).status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });

  it("returns 503 for all three endpoints when enabled but incomplete", async () => {
    h = await startHarness(env({ BOOK_ID_SEARCH_SESSION_SECRET: "short" }));
    expect((await post(h, "/api/auth/google", { credential: "x".repeat(32) })).status).toBe(503);
    expect((await get(h, "/api/auth/session")).status).toBe(503);
    expect((await post(h, "/api/auth/logout", {})).status).toBe(503);
    expect(h.calls).toHaveLength(0);
  });
});

describe("POST /api/auth/google", () => {
  let h: Harness;
  afterEach(async () => { await h?.close(); });

  it("happy path: 200, production Set-Cookie, safe body, no token/sub leaked", async () => {
    h = await startHarness(env());
    const res = await post(h, "/api/auth/google", { credential: "cred-" + "a".repeat(40) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${sessionCookieName(true)}=`);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
    const body = await res.json();
    expect(body).toEqual({ authenticated: true, user: { email: "owner@example.com", name: "Owner" } });
    expect(JSON.stringify(body)).not.toContain(OWNER_SUB);
    // signed token must not appear in the JSON body
    const token = setCookie.split(`${sessionCookieName(true)}=`)[1]?.split(";")[0] ?? "unset";
    expect(token).not.toBe("unset");
    expect(JSON.stringify(body)).not.toContain(token);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("verifier receives the credential exactly once", async () => {
    h = await startHarness(env());
    await post(h, "/api/auth/google", { credential: "cred-" + "b".repeat(40) });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].credential).toBe("cred-" + "b".repeat(40));
  });

  it("wrong or missing Origin → 403 before verifier", async () => {
    h = await startHarness(env());
    const wrong = await post(h, "/api/auth/google", { credential: "x".repeat(40) }, { origin: "https://evil.example" });
    expect(wrong.status).toBe(403);
    const missing = await fetch(`${h.baseUrl}/api/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "x".repeat(40) }),
    });
    expect(missing.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("non-JSON content type → 415 before verifier", async () => {
    h = await startHarness(env());
    const res = await fetch(`${h.baseUrl}/api/auth/google`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: ORIGIN },
      body: "credential=abc",
    });
    expect(res.status).toBe(415);
    expect(h.calls).toHaveLength(0);
  });

  it("malformed JSON → 400 safe JSON", async () => {
    h = await startHarness(env());
    const res = await post(h, "/api/auth/google", "{not json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBeTruthy();
    expect(h.calls).toHaveLength(0);
  });

  it("oversized body → 413 safe JSON", async () => {
    h = await startHarness(env());
    const res = await post(h, "/api/auth/google", { credential: "x".repeat(64 * 1024) });
    expect(res.status).toBe(413);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ["array", '["credential"]'],
    ["null body", "null"],
    ["string body", '"credential"'],
    ["missing credential", "{}"],
    ["extra key", '{"credential":"aaaa-bbbb-cccc-dddd","extra":1}'],
    ["non-string credential", '{"credential":123}'],
  ])("invalid body (%s) → 400", async (_name, rawBody) => {
    h = await startHarness(env());
    const res = await post(h, "/api/auth/google", rawBody);
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("invalid token → 401", async () => {
    h = await startHarness(env(), new GoogleIdentityError("GOOGLE_ID_TOKEN_INVALID"));
    const res = await post(h, "/api/auth/google", { credential: "cred-" + "c".repeat(40) });
    expect(res.status).toBe(401);
  });

  it("non-owner → 403", async () => {
    h = await startHarness(env(), new GoogleIdentityError("GOOGLE_ACCOUNT_NOT_ALLOWED"));
    const res = await post(h, "/api/auth/google", { credential: "cred-" + "d".repeat(40) });
    expect(res.status).toBe(403);
  });

  it("unexpected verifier error → generic 500 without internals", async () => {
    h = await startHarness(env(), new Error("secret internal detail xyz"));
    const res = await post(h, "/api/auth/google", { credential: "cred-" + "e".repeat(40) });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret internal detail");
  });

  it("raw credential never appears in response body or headers", async () => {
    h = await startHarness(env(), new GoogleIdentityError("GOOGLE_ID_TOKEN_INVALID"));
    const secretCred = "eyJraWQi-super-secret-credential-value";
    const res = await post(h, "/api/auth/google", { credential: secretCred });
    const text = await res.text();
    expect(text).not.toContain(secretCred);
    expect([...res.headers.entries()].map(([k, v]) => v).join("\n")).not.toContain(secretCred);
  });

  it("dev config uses the dev cookie name without Secure", async () => {
    h = await startHarness(env({ NODE_ENV: "development" }));
    const res = await post(h, "/api/auth/google", { credential: "cred-" + "f".repeat(40) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(sessionCookieName(false));
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });
});

describe("GET /api/auth/session", () => {
  let h: Harness;
  afterEach(async () => { await h?.close(); });

  function mintCookie(sub = OWNER_SUB, overrides: Record<string, unknown> = {}): string {
    const { token } = issueWebSession(
      { sub, email: "owner@example.com", name: "Owner" },
      { secret: SECRET, nowSeconds: h.now },
    );
    void overrides;
    return `${sessionCookieName(true)}=${token}`;
  }

  it("no cookie → 200 authenticated:false", async () => {
    h = await startHarness(env());
    const res = await get(h, "/api/auth/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
    expect(h.calls).toHaveLength(0);
  });

  it("valid cookie → authenticated:true with display user and csrfToken", async () => {
    h = await startHarness(env());
    const res = await get(h, "/api/auth/session", { cookie: mintCookie() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user).toEqual({ email: "owner@example.com", name: "Owner" });
    expect(typeof body.csrfToken).toBe("string");
    expect(JSON.stringify(body)).not.toContain(OWNER_SUB);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("tampered/expired/duplicate cookie → authenticated:false", async () => {
    h = await startHarness(env());
    const good = mintCookie();
    const tampered = good.slice(0, -3) + "aaa";
    const expired = `${sessionCookieName(true)}=${issueWebSession(
      { sub: OWNER_SUB, email: null, name: null },
      { secret: SECRET, nowSeconds: h.now - 9 * 60 * 60, ttlSeconds: 8 * 60 * 60 },
    ).token}`;
    for (const cookie of [tampered, expired, `${good}; ${good}`]) {
      const res = await get(h, "/api/auth/session", { cookie });
      expect(res.status).toBe(200);
      expect((await res.json()).authenticated).toBe(false);
    }
  });

  it("valid signature but sub != current ownerSub → authenticated:false", async () => {
    h = await startHarness(env());
    const otherOwner = `${sessionCookieName(true)}=${issueWebSession(
      { sub: "previous-owner-sub", email: null, name: null },
      { secret: SECRET, nowSeconds: h.now },
    ).token}`;
    const res = await get(h, "/api/auth/session", { cookie: otherOwner });
    expect((await res.json()).authenticated).toBe(false);
  });

  it("response never contains the signed token or ownerSub", async () => {
    h = await startHarness(env());
    const cookie = mintCookie();
    const token = cookie.split("=")[1];
    const res = await get(h, "/api/auth/session", { cookie });
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(OWNER_SUB);
  });
});

describe("POST /api/auth/logout", () => {
  let h: Harness;
  afterEach(async () => { await h?.close(); });

  async function mint(): Promise<{ cookie: string; csrf: string }> {
    const { token, payload } = issueWebSession(
      { sub: OWNER_SUB, email: "owner@example.com", name: "Owner" },
      { secret: SECRET, nowSeconds: h.now },
    );
    return { cookie: `${sessionCookieName(true)}=${token}`, csrf: payload.csrf };
  }

  it("happy path → 204, clear cookie with same name+attributes, empty body", async () => {
    h = await startHarness(env());
    const { cookie, csrf } = await mint();
    const res = await post(h, "/api/auth/logout", {}, { cookie, "x-csrf-token": csrf });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${sessionCookieName(true)}=;`);
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(h.calls).toHaveLength(0);
  });

  it("missing/invalid session → 401", async () => {
    h = await startHarness(env());
    const noCookie = await post(h, "/api/auth/logout", {});
    expect(noCookie.status).toBe(401);
    const { cookie } = await mint();
    const garbage = await post(h, "/api/auth/logout", {}, { cookie: `${sessionCookieName(true)}=garbage.sig` });
    expect(garbage.status).toBe(401);
  });

  it("missing/wrong Origin → 403", async () => {
    h = await startHarness(env());
    const { cookie, csrf } = await mint();
    const missing = await post(h, "/api/auth/logout", {}, { cookie, "x-csrf-token": csrf, origin: "" });
    expect(missing.status).toBe(403);
    const wrong = await post(h, "/api/auth/logout", {}, { cookie, "x-csrf-token": csrf, origin: "https://evil.example" });
    expect(wrong.status).toBe(403);
  });

  it("missing/wrong CSRF → 403", async () => {
    h = await startHarness(env());
    const { cookie, csrf } = await mint();
    const missing = await post(h, "/api/auth/logout", {}, { cookie });
    expect(missing.status).toBe(403);
    const wrong = await post(h, "/api/auth/logout", {}, { cookie, "x-csrf-token": "not-" + csrf });
    expect(wrong.status).toBe(403);
  });
});

describe("router/global safety", () => {
  let h: Harness;
  afterEach(async () => { await h?.close(); });

  it("no-store present on auth error responses too", async () => {
    h = await startHarness(env());
    const res = await post(h, "/api/auth/google", "{bad");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("malformed/oversized auth bodies never reach other handlers", async () => {
    h = await startHarness(env());
    const malformed = await post(h, "/api/auth/google", "{bad json");
    expect(malformed.status).toBe(400);
    const oversized = await post(h, "/api/auth/google", { credential: "x".repeat(64 * 1024) });
    expect(oversized.status).toBe(413);
    // probes still work and were untouched by auth failures
    const s32 = await fetch(`${h.baseUrl}/api/private/s32/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(s32.status).toBe(200);
    const weread = await get(h, "/api/private/weread/probe");
    expect(weread.status).toBe(200);
  });
});
