import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_SESSION_TTL_SECONDS,
  MIN_SESSION_SECRET_BYTES,
  issueWebSession,
  readCookie,
  serializeClearWebSessionCookie,
  serializeWebSessionCookie,
  verifyWebSession,
  verifyWebSessionCsrf,
} from "./web-session.js";

const SECRET = "s".repeat(MIN_SESSION_SECRET_BYTES);
const NOW = 1_800_000_000;
const CSRF = "csrf_token_1234567890";
const IDENTITY = {
  sub: "google-sub-123",
  email: "owner@gmail.com",
  name: "Owner",
};

describe("web session token", () => {
  it("issues and verifies a canonical signed session", () => {
    const issued = issueWebSession(IDENTITY, {
      secret: SECRET,
      nowSeconds: NOW,
      csrfToken: CSRF,
    });
    expect(issued.payload).toEqual({
      v: 1,
      ...IDENTITY,
      iat: NOW,
      exp: NOW + DEFAULT_WEB_SESSION_TTL_SECONDS,
      csrf: CSRF,
    });
    expect(verifyWebSession(issued.token, SECRET, NOW + 1)).toEqual(issued.payload);
  });

  it("rejects tampering, the wrong secret, expiry and far-future iat", () => {
    const { token } = issueWebSession(IDENTITY, {
      secret: SECRET,
      nowSeconds: NOW,
      csrfToken: CSRF,
    });
    const [payload, sig] = token.split(".");
    expect(verifyWebSession(`${payload}x.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifyWebSession(token, "x".repeat(MIN_SESSION_SECRET_BYTES), NOW)).toBeNull();
    expect(verifyWebSession(token, SECRET, NOW + DEFAULT_WEB_SESSION_TTL_SECONDS)).toBeNull();
    expect(verifyWebSession(token, SECRET, NOW - 61)).toBeNull();
  });

  it("rejects noncanonical or extra payload fields even with a valid-looking token shape", () => {
    const { token } = issueWebSession(IDENTITY, {
      secret: SECRET,
      nowSeconds: NOW,
      csrfToken: CSRF,
    });
    expect(verifyWebSession(` ${token}`, SECRET, NOW)).toBeNull();
    expect(verifyWebSession("not-a-session", SECRET, NOW)).toBeNull();
  });

  it("requires a sufficiently long signing secret", () => {
    expect(() => issueWebSession(IDENTITY, {
      secret: "short",
      nowSeconds: NOW,
      csrfToken: CSRF,
    })).toThrow("WEB_SESSION_SECRET_TOO_SHORT");
    expect(verifyWebSession("x.y", "short", NOW)).toBeNull();
  });

  it("normalizes identity display strings and preserves nulls", () => {
    const issued = issueWebSession(
      { sub: " sub ", email: null, name: " Name " },
      { secret: SECRET, nowSeconds: NOW, csrfToken: CSRF },
    );
    expect(issued.payload).toMatchObject({ sub: "sub", email: null, name: "Name" });
  });

  it("rejects invalid identity and invalid CSRF input", () => {
    expect(() => issueWebSession(
      { sub: " ", email: null, name: null },
      { secret: SECRET, nowSeconds: NOW, csrfToken: CSRF },
    )).toThrow("WEB_SESSION_IDENTITY_INVALID");
    expect(() => issueWebSession(
      IDENTITY,
      { secret: SECRET, nowSeconds: NOW, csrfToken: "short" },
    )).toThrow("WEB_SESSION_CSRF_INVALID");
  });

  it("limits explicit TTL to the v0.1 maximum", () => {
    expect(() => issueWebSession(IDENTITY, {
      secret: SECRET,
      nowSeconds: NOW,
      ttlSeconds: DEFAULT_WEB_SESSION_TTL_SECONDS + 1,
      csrfToken: CSRF,
    })).toThrow("WEB_SESSION_TIME_INVALID");
  });
});

describe("web session CSRF", () => {
  it("accepts only the exact session nonce", () => {
    const { payload } = issueWebSession(IDENTITY, {
      secret: SECRET,
      nowSeconds: NOW,
      csrfToken: CSRF,
    });
    expect(verifyWebSessionCsrf(payload, CSRF)).toBe(true);
    expect(verifyWebSessionCsrf(payload, `${CSRF}x`)).toBe(false);
    expect(verifyWebSessionCsrf(payload, undefined)).toBe(false);
  });
});

describe("web session cookies", () => {
  it("serializes a production __Host-style cookie with Secure", () => {
    const cookie = serializeWebSessionCookie({
      name: "__Host-book_id_search_session",
      token: "payload.signature",
      production: true,
    });
    expect(cookie).toContain("__Host-book_id_search_session=payload.signature");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${DEFAULT_WEB_SESSION_TTL_SECONDS}`);
  });

  it("keeps local development cookie insecure-but-HttpOnly without pretending __Host", () => {
    const cookie = serializeWebSessionCookie({
      name: "book_id_search_session_dev",
      token: "payload.signature",
      production: false,
    });
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });

  it("clears with the same security attributes", () => {
    expect(serializeClearWebSessionCookie({
      name: "__Host-book_id_search_session",
      production: true,
    })).toBe("__Host-book_id_search_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });

  it("reads only the requested cookie and safely handles bad encoding", () => {
    expect(readCookie("a=1; book_id_search_session_dev=payload.signature; z=3", "book_id_search_session_dev"))
      .toBe("payload.signature");
    expect(readCookie("book_id_search_session_dev=%E0%A4%A", "book_id_search_session_dev"))
      .toBeNull();
    expect(readCookie(undefined, "book_id_search_session_dev")).toBeNull();
  });

  it("fails closed on duplicate same-name session cookies", () => {
    expect(readCookie(
      "book_id_search_session_dev=first.sig; other=2; book_id_search_session_dev=second.sig",
      "book_id_search_session_dev",
    )).toBeNull();
    expect(readCookie(
      "book_id_search_session_dev=first.sig; book_id_search_session_dev=first.sig",
      "book_id_search_session_dev",
    )).toBeNull();
    // adjacent duplicates separated by multiple spaces
    expect(readCookie(
      "book_id_search_session_dev=a.sig;  book_id_search_session_dev=b.sig",
      "book_id_search_session_dev",
    )).toBeNull();
  });
});
