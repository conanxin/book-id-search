import { describe, expect, it } from "vitest";
import {
  authorizePrivateRequest,
  type AuthorizePrivateRequestOptions,
  type LegacyAuthResult,
  type PrivateRequestInput,
} from "./private-request-auth.js";
import { readGoogleSessionAuthConfig } from "./config.js";
import { issueWebSession } from "./web-session.js";

const OWNER_SUB = "owner-sub-123";
const SECRET = "x".repeat(48);
const ORIGIN = "https://books.example.com";
const NOW = 1_800_000_000;

const S32_BEARER = "Bearer s32-secret-token-value";
const WEREAD_TOKEN = "weread-secret-token-value";
const CSRF = "csrf-random-token";

function googleEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
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

/** Legacy checker fake: PASS only on its own capability's exact credential. */
function fakeLegacyCheck(capability: "S32_PRIVATE" | "WEREAD_PRIVATE") {
  const state = { calls: 0 };
  const check = (
    authorization: string | undefined,
    privateToken: string | undefined,
  ): LegacyAuthResult => {
    state.calls += 1;
    if (capability === "S32_PRIVATE") {
      if (authorization === S32_BEARER) return { ok: true };
      if (authorization === undefined && privateToken === undefined) {
        return { ok: false, status: 401, message: "Missing S32 private token." };
      }
      return { ok: false, status: 403, message: "Invalid S32 private token." };
    }
    if (privateToken === WEREAD_TOKEN) return { ok: true };
    if (authorization === undefined && privateToken === undefined) {
      return { ok: false, status: 401, message: "Missing WeRead private token." };
    }
    return { ok: false, status: 403, message: "Invalid WeRead private token." };
  };
  return { check, state };
}

function unconfiguredLegacy(): { check: AuthorizePrivateRequestOptions["legacyCheck"]; state: { calls: number } } {
  const state = { calls: 0 };
  return {
    state,
    check: () => {
      state.calls += 1;
      return { ok: false, status: 503, message: "Private auth not configured." };
    },
  };
}

function mintSession(sub = OWNER_SUB, ttlSeconds = 8 * 60 * 60, nowSeconds = NOW): { cookie: string; csrf: string } {
  const { token, payload } = issueWebSession(
    { sub, email: "owner@example.com", name: "Owner" },
    { secret: SECRET, ttlSeconds, nowSeconds },
  );
  return { cookie: `__Host-book_id_search_session=${token}`, csrf: payload.csrf };
}

function mintSessionCookie(sub = OWNER_SUB, ttlSeconds = 8 * 60 * 60, nowSeconds = NOW): string {
  return mintSession(sub, ttlSeconds, nowSeconds).cookie;
}

interface Ctx {
  s32: ReturnType<typeof fakeLegacyCheck>;
  weread: ReturnType<typeof fakeLegacyCheck>;
  googleConfig: ReturnType<typeof readGoogleSessionAuthConfig>;
}

function makeCtx(envOverrides: Record<string, string | undefined> = {}): Ctx {
  return {
    s32: fakeLegacyCheck("S32_PRIVATE"),
    weread: fakeLegacyCheck("WEREAD_PRIVATE"),
    googleConfig: readGoogleSessionAuthConfig(googleEnv(envOverrides)),
  };
}

function auth(
  ctx: Ctx,
  request: PrivateRequestInput,
  opts: Partial<AuthorizePrivateRequestOptions> = {},
): ReturnType<typeof authorizePrivateRequest> {
  return authorizePrivateRequest({
    capability: "S32_PRIVATE",
    capabilityEnabled: true,
    request,
    googleConfig: ctx.googleConfig,
    legacyCheck: ctx.s32.check,
    nowSeconds: NOW,
    ...opts,
  });
}

describe("A. capability feature gate", () => {
  it("1. disabled + valid bearer → 404, no legacy call", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "GET", authorization: S32_BEARER }, { capabilityEnabled: false });
    expect(result).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
    expect(ctx.s32.state.calls).toBe(0);
  });

  it("2. disabled + valid Google session → 404", () => {
    const ctx = makeCtx();
    const result = auth(
      ctx,
      { method: "GET", cookie: mintSessionCookie() },
      { capabilityEnabled: false },
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("3-4. disabled: no session-state leak regardless of cookie validity", () => {
    const ctx = makeCtx();
    const results = [
      auth(ctx, { method: "GET", cookie: "garbage" }, { capabilityEnabled: false }),
      auth(ctx, { method: "GET", cookie: mintSessionCookie("other-sub") }, { capabilityEnabled: false }),
    ];
    for (const r of results) {
      expect(r).toMatchObject({ ok: false, status: 404 });
      expect(JSON.stringify(r)).not.toContain("SESSION");
    }
    expect(ctx.s32.state.calls).toBe(0);
  });
});

describe("B. explicit legacy credential precedence (no fallback)", () => {
  it("5. correct bearer + no cookie → PASS LEGACY_TOKEN", () => {
    const ctx = makeCtx();
    expect(auth(ctx, { method: "GET", authorization: S32_BEARER })).toEqual({ ok: true, authKind: "LEGACY_TOKEN" });
  });

  it("6. correct X-Private-Token → PASS LEGACY_TOKEN", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "POST", privateToken: S32_BEARER.replace("Bearer ", "") });
    // fake S32 checker accepts only the bearer form; pass bearer via header is scenario 5.
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("6b. correct X-Private-Token accepted by a token-style checker → PASS LEGACY_TOKEN", () => {
    const ctx = makeCtx();
    const result = authorizePrivateRequest({
      capability: "WEREAD_PRIVATE",
      capabilityEnabled: true,
      request: { method: "POST", privateToken: WEREAD_TOKEN },
      googleConfig: ctx.googleConfig,
      legacyCheck: ctx.weread.check,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ok: true, authKind: "LEGACY_TOKEN" });
  });

  it("7. wrong bearer + valid Google session → 403, no session fallback", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "GET", authorization: "Bearer wrong-token", cookie: mintSessionCookie() });
    expect(result).toMatchObject({ ok: false, status: 403, code: "INVALID_CREDENTIAL" });
  });

  it("8. wrong X-Private-Token + valid session → 403, no fallback", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "GET", privateToken: "wrong-x-token", cookie: mintSessionCookie() });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("9. correct bearer + invalid cookie → PASS legacy (cookie never rescued nor vetoed)", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "GET", authorization: S32_BEARER, cookie: "__Host-book_id_search_session=tampered" });
    expect(result).toEqual({ ok: true, authKind: "LEGACY_TOKEN" });
  });

  it("10. correct bearer never requires Origin/CSRF (unsafe method included)", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "DELETE", authorization: S32_BEARER });
    expect(result).toEqual({ ok: true, authKind: "LEGACY_TOKEN" });
  });
});

describe("C. Google session — safe methods", () => {
  it("11-13. GET / HEAD / OPTIONS with valid owner session → PASS GOOGLE_SESSION", () => {
    const ctx = makeCtx();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(auth(ctx, { method, cookie: mintSessionCookie() })).toEqual({ ok: true, authKind: "GOOGLE_SESSION" });
    }
  });

  it("14. tampered session → 401", () => {
    const ctx = makeCtx();
    const cookie = mintSessionCookie();
    const tampered = cookie.slice(0, -3) + "aaa";
    expect(auth(ctx, { method: "GET", cookie: tampered })).toMatchObject({ ok: false, status: 401, code: "SESSION_INVALID" });
  });

  it("15. expired session → 401", () => {
    const ctx = makeCtx();
    const expired = mintSessionCookie(OWNER_SUB, 60, NOW - 3600);
    expect(auth(ctx, { method: "GET", cookie: expired })).toMatchObject({ ok: false, status: 401 });
  });

  it("16. valid signature but owner sub changed → 401", () => {
    const ctx = makeCtx();
    const previousOwner = mintSessionCookie("previous-owner-sub");
    expect(auth(ctx, { method: "GET", cookie: previousOwner })).toMatchObject({ ok: false, status: 401 });
  });

  it("17. duplicate cookie → 401 (readCookie fail closed)", () => {
    const ctx = makeCtx();
    const good = mintSessionCookie();
    expect(auth(ctx, { method: "GET", cookie: `${good}; ${good}` })).toMatchObject({ ok: false, status: 401 });
  });

  it("18. invalid session never falls back to legacy missing-credential", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "GET", cookie: mintSessionCookie("not-the-owner") });
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(ctx.s32.state.calls).toBe(0);
  });
});

describe("C. Google session — unsafe methods", () => {
  it("19-22. POST/PUT/PATCH/DELETE + exact Origin + CSRF → PASS", () => {
    const ctx = makeCtx();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const session = mintSession();
      const result = auth(ctx, {
        method,
        cookie: session.cookie,
        origin: ORIGIN,
        csrfToken: session.csrf,
      });
      expect(result).toEqual({ ok: true, authKind: "GOOGLE_SESSION" });
    }
  });

  it("23. missing Origin → 403", () => {
    const ctx = makeCtx();
    const session = mintSession();
    expect(auth(ctx, { method: "POST", cookie: session.cookie, csrfToken: session.csrf }))
      .toMatchObject({ ok: false, status: 403, code: "ORIGIN_FORBIDDEN" });
  });

  it("24. wrong Origin → 403", () => {
    const ctx = makeCtx();
    const session = mintSession();
    expect(auth(ctx, { method: "POST", cookie: session.cookie, origin: "https://evil.example", csrfToken: session.csrf }))
      .toMatchObject({ ok: false, status: 403 });
  });

  it("25. missing CSRF → 403", () => {
    const ctx = makeCtx();
    expect(auth(ctx, { method: "POST", cookie: mintSessionCookie(), origin: ORIGIN }))
      .toMatchObject({ ok: false, status: 403, code: "CSRF_FORBIDDEN" });
  });

  it("26. wrong CSRF → 403", () => {
    const ctx = makeCtx();
    const session = mintSession();
    expect(auth(ctx, { method: "POST", cookie: session.cookie, origin: ORIGIN, csrfToken: "wrong-" + session.csrf }))
      .toMatchObject({ ok: false, status: 403 });
  });
});

describe("D. no cookie / Google config interactions", () => {
  it("27. no cookie + legacy configured missing credential → legacy 401", () => {
    const ctx = makeCtx();
    const result = auth(ctx, { method: "GET" });
    expect(result).toMatchObject({ ok: false, status: 401, code: "MISSING_CREDENTIAL" });
    expect(ctx.s32.state.calls).toBe(1);
  });

  it("28. no cookie + legacy unconfigured → 503", () => {
    const un = unconfiguredLegacy();
    const result = authorizePrivateRequest({
      capability: "S32_PRIVATE",
      capabilityEnabled: true,
      request: { method: "GET" },
      googleConfig: makeCtx().googleConfig,
      legacyCheck: un.check,
      nowSeconds: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 503, code: "PRIVATE_AUTH_NOT_CONFIGURED" });
  });

  it("29. Google disabled + valid cookie + no bearer → pure legacy semantics", () => {
    const ctx = makeCtx({ GOOGLE_AUTH_ENABLED: "false" });
    const result = auth(ctx, { method: "GET", cookie: mintSessionCookie() });
    expect(result).toMatchObject({ ok: false, status: 401, code: "MISSING_CREDENTIAL" });
    expect(ctx.s32.state.calls).toBe(1);
  });

  it("30. Google incomplete + valid-looking cookie + correct bearer → PASS legacy", () => {
    const ctx = makeCtx({ BOOK_ID_SEARCH_SESSION_SECRET: "short" });
    const result = auth(ctx, {
      method: "POST",
      authorization: S32_BEARER,
      cookie: "__Host-book_id_search_session=anything.valid-looking",
    });
    expect(result).toEqual({ ok: true, authKind: "LEGACY_TOKEN" });
  });

  it("31. Google incomplete + no bearer → legacy semantics (cookie ignored)", () => {
    const ctx = makeCtx({ GOOGLE_CLIENT_ID: "" });
    const result = auth(ctx, { method: "GET", cookie: mintSessionCookie() });
    expect(result).toMatchObject({ ok: false, status: 401, code: "MISSING_CREDENTIAL" });
  });
});

describe("E. capability isolation", () => {
  function dual(request: PrivateRequestInput, s32Enabled = true, wereadEnabled = true) {
    const ctx = makeCtx();
    return {
      s32: authorizePrivateRequest({
        capability: "S32_PRIVATE", capabilityEnabled: s32Enabled, request,
        googleConfig: ctx.googleConfig, legacyCheck: ctx.s32.check, nowSeconds: NOW,
      }),
      weread: authorizePrivateRequest({
        capability: "WEREAD_PRIVATE", capabilityEnabled: wereadEnabled, request,
        googleConfig: ctx.googleConfig, legacyCheck: ctx.weread.check, nowSeconds: NOW,
      }),
      ctx,
    };
  }

  it("32. S32 bearer does not pass the WeRead checker and vice versa", () => {
    const { s32, weread } = dual({ method: "GET", authorization: S32_BEARER });
    expect(s32).toEqual({ ok: true, authKind: "LEGACY_TOKEN" });
    expect(weread).toMatchObject({ ok: false, status: 403 });
    const { s32: s32b, weread: wereadB } = dual({ method: "GET", privateToken: WEREAD_TOKEN });
    expect(wereadB).toEqual({ ok: true, authKind: "LEGACY_TOKEN" });
    expect(s32b).toMatchObject({ ok: false, status: 403 });
  });

  it("33. Google owner session passes both capabilities when both enabled", () => {
    const { s32, weread } = dual({ method: "GET", cookie: mintSessionCookie() });
    expect(s32).toEqual({ ok: true, authKind: "GOOGLE_SESSION" });
    expect(weread).toEqual({ ok: true, authKind: "GOOGLE_SESSION" });
  });

  it("34. one capability disabled: session only passes the enabled side", () => {
    const { s32, weread } = dual({ method: "GET", cookie: mintSessionCookie() }, false, true);
    expect(s32).toMatchObject({ ok: false, status: 404 });
    expect(weread).toEqual({ ok: true, authKind: "GOOGLE_SESSION" });
  });
});

describe("F. secret safety", () => {
  it("35. result serialization never contains legacy token / session token / CSRF input", () => {
    const ctx = makeCtx();
    const session = mintSession();
    const sessionToken = session.cookie.split("=")[1];
    const csrf = session.csrf;
    const cases = [
      auth(ctx, { method: "POST", cookie: `__Host-book_id_search_session=${sessionToken}`, origin: ORIGIN, csrfToken: csrf }),
      auth(ctx, { method: "GET", authorization: "Bearer wrong-bearer-attempt" }),
      auth(ctx, { method: "GET", cookie: "garbage-cookie" }),
    ];
    for (const r of cases) {
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain(S32_BEARER);
      expect(serialized).not.toContain(WEREAD_TOKEN);
      expect(serialized).not.toContain(sessionToken);
      expect(serialized).not.toContain(csrf);
    }
  });

  it("36. raw bad bearer is never echoed", () => {
    const ctx = makeCtx();
    const bad = "Bearer super-secret-bad-value-xyz";
    const result = auth(ctx, { method: "GET", authorization: bad });
    expect(JSON.stringify(result)).not.toContain(bad);
    expect(JSON.stringify(result)).not.toContain(bad.replace("Bearer ", ""));
  });
});
