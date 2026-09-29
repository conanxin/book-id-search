import { describe, expect, it } from "vitest";
import {
  GOOGLE_SESSION_COOKIE_DEVELOPMENT,
  GOOGLE_SESSION_COOKIE_PRODUCTION,
  GOOGLE_SESSION_TTL_SECONDS,
  isGoogleSessionAuthConfigured,
  readGoogleSessionAuthConfig,
} from "./config.js";

describe("readGoogleSessionAuthConfig", () => {
  it("is disabled and unconfigured by default", () => {
    const config = readGoogleSessionAuthConfig({});
    expect(config).toEqual({
      enabled: false,
      clientId: null,
      ownerSub: null,
      sessionSecret: null,
      publicOrigin: null,
      production: false,
      cookieName: GOOGLE_SESSION_COOKIE_DEVELOPMENT,
      sessionTtlSeconds: GOOGLE_SESSION_TTL_SECONDS,
    });
    expect(isGoogleSessionAuthConfigured(config)).toBe(false);
  });

  it("reads only the dedicated Google/session settings", () => {
    const config = readGoogleSessionAuthConfig({
      GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: " client.apps.googleusercontent.com ",
      BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: " owner-sub ",
      BOOK_ID_SEARCH_SESSION_SECRET: " ssssssssssssssssssssssssssssssss ",
      BOOK_ID_SEARCH_PUBLIC_ORIGIN: " https://books.conanxin.com ",
      S32_PRIVATE_API_TOKEN: "must-not-be-used",
      WEREAD_PRIVATE_API_TOKEN: "must-not-be-used",
    });
    expect(config).toMatchObject({
      enabled: true,
      clientId: "client.apps.googleusercontent.com",
      ownerSub: "owner-sub",
      sessionSecret: "session-secret",
      publicOrigin: "https://books.conanxin.com",
      production: false,
      cookieName: GOOGLE_SESSION_COOKIE_DEVELOPMENT,
    });
    expect(isGoogleSessionAuthConfigured(config)).toBe(true);
  });

  it("uses the __Host cookie only in production", () => {
    expect(readGoogleSessionAuthConfig({ NODE_ENV: "production" }).cookieName)
      .toBe(GOOGLE_SESSION_COOKIE_PRODUCTION);
    expect(readGoogleSessionAuthConfig({ NODE_ENV: "development" }).cookieName)
      .toBe(GOOGLE_SESSION_COOKIE_DEVELOPMENT);
  });

  it.each([
    ["disabled", { GOOGLE_AUTH_ENABLED: "false" }],
    ["missing client id", { GOOGLE_AUTH_ENABLED: "true" }],
    ["missing owner sub", {
      GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client",
    }],
    ["missing secret", {
      GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client",
      BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "sub",
    }],
    ["short secret", {
      GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client",
      BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "sub",
      BOOK_ID_SEARCH_SESSION_SECRET: "short",
      BOOK_ID_SEARCH_PUBLIC_ORIGIN: "https://books.conanxin.com",
    }],
    ["missing public origin", {
      GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client",
      BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "sub",
      BOOK_ID_SEARCH_SESSION_SECRET: "ssssssssssssssssssssssssssssssss",
    }],
    ["origin has a path", {
      GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client",
      BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "sub",
      BOOK_ID_SEARCH_SESSION_SECRET: "ssssssssssssssssssssssssssssssss",
      BOOK_ID_SEARCH_PUBLIC_ORIGIN: "https://books.conanxin.com/login",
    }],
  ] as const)("reports %s as not configured", (_label, env) => {
    expect(isGoogleSessionAuthConfigured(readGoogleSessionAuthConfig(env))).toBe(false);
  });
});
