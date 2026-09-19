import { describe, expect, it } from "vitest";
import { checkS32PrivateAuth } from "./private-auth.js";
import type { S32Config } from "../config.js";

const base: S32Config = {
  enabled: true,
  databaseUrl: "postgresql://example/test",
  privateToken: "secret",
};

describe("checkS32PrivateAuth", () => {
  it("returns 404 when S32 is disabled", () => {
    expect(checkS32PrivateAuth({ ...base, enabled: false }, undefined, undefined))
      .toEqual({ ok: false, status: 404, message: "Not Found" });
  });

  it("returns 503 when token is not configured", () => {
    expect(checkS32PrivateAuth({ ...base, privateToken: null }, undefined, undefined))
      .toEqual({ ok: false, status: 503, message: "S32 private token not configured." });
  });

  it("returns 401 when no token is supplied", () => {
    expect(checkS32PrivateAuth(base, undefined, undefined))
      .toEqual({ ok: false, status: 401, message: "Missing token." });
  });

  it("returns 403 for a wrong token", () => {
    expect(checkS32PrivateAuth(base, "Bearer wrong", undefined))
      .toEqual({ ok: false, status: 403, message: "Invalid token." });
  });

  it("accepts the correct bearer token", () => {
    expect(checkS32PrivateAuth(base, "Bearer secret", undefined)).toEqual({ ok: true });
  });

  it("accepts the correct X-Private-Token", () => {
    expect(checkS32PrivateAuth(base, undefined, "secret")).toEqual({ ok: true });
  });

  it("does not authenticate with a WeRead token", () => {
    const envLike = { ...base } as S32Config & { WEREAD_PRIVATE_API_TOKEN?: string };
    envLike.WEREAD_PRIVATE_API_TOKEN = "weread-secret";
    expect(checkS32PrivateAuth(envLike, "Bearer weread-secret", undefined))
      .toEqual({ ok: false, status: 403, message: "Invalid token." });
  });
});
