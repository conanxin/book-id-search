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
