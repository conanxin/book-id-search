import { describe, expect, it } from "vitest";
import {
  GOOGLE_ID_TOKEN_ISSUERS,
  GoogleIdentityError,
  createDefaultGoogleIdTokenClient,
  verifyGoogleIdentity,
  type GoogleIdTokenClient,
  type GoogleIdTicketPayload,
} from "./google-identity.js";
import { readGoogleSessionAuthConfig, isGoogleSessionAuthConfigured } from "./config.js";

const OWNER_SUB = "1234567890-owner-sub";

function fullEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    GOOGLE_AUTH_ENABLED: "true",
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: OWNER_SUB,
    BOOK_ID_SEARCH_SESSION_SECRET: "x".repeat(48),
    BOOK_ID_SEARCH_PUBLIC_ORIGIN: "https://books.example.com",
  };
}

function okPayload(overrides: Partial<GoogleIdTicketPayload> = {}): GoogleIdTicketPayload {
  return {
    sub: OWNER_SUB,
    email: "owner@example.com",
    name: "Owner",
    iss: "https://accounts.google.com",
    ...overrides,
  };
}

/** Fake client capturing the exact options it was called with. */
function fakeClient(
  result: GoogleIdTicketPayload | undefined | null = okPayload(),
  opts: { audience?: string[]; calls: { idToken: string; audience: string }[] } = { calls: [] },
): GoogleIdTokenClient & { opts: typeof opts } {
  const effective = result ?? undefined;
  return {
    opts,
    async verifyIdToken(options) {
      opts.calls.push({ idToken: options.idToken, audience: options.audience });
      if (opts.audience && !opts.audience.includes(options.audience)) {
        throw new Error("audience mismatch in fake");
      }
      return effective;
    },
  } as unknown as GoogleIdTokenClient & { opts: typeof opts };
}

const CREDENTIAL = "a-valid-looking-google-id-token-string";

describe("google identity verifier", () => {
  it("returns the exact owner identity on the happy path", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    expect(isGoogleSessionAuthConfigured(config)).toBe(true);
    const calls: { idToken: string; audience: string }[] = [];
    const identity = await verifyGoogleIdentity(config, CREDENTIAL, fakeClient(okPayload(), { calls }));
    expect(identity).toEqual({ sub: OWNER_SUB, email: "owner@example.com", name: "Owner" });
    // client received the exact configured audience
    expect(calls[0].audience).toBe(config.clientId);
    expect(calls[0].idToken).toBe(CREDENTIAL);
  });

  it("rejects a wrong owner sub with GOOGLE_ACCOUNT_NOT_ALLOWED", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    const client = fakeClient(okPayload({ sub: "someone-else" }));
    await expect(verifyGoogleIdentity(config, CREDENTIAL, client))
      .rejects.toMatchObject({ code: "GOOGLE_ACCOUNT_NOT_ALLOWED" });
  });

  it("maps verifyIdToken throws to GOOGLE_ID_TOKEN_INVALID", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    const throwing = {
      async verifyIdToken(): Promise<GoogleIdTicketPayload | undefined> {
        throw new Error("Token used too late, 1234567890 > 1234567000");
      },
    } as GoogleIdTokenClient;
    const err = await verifyGoogleIdentity(config, CREDENTIAL, throwing).catch(e => e);
    expect(err).toBeInstanceOf(GoogleIdentityError);
    expect(err.code).toBe("GOOGLE_ID_TOKEN_INVALID");
    // raw library error text (timestamps etc.) must not leak into the message
    expect(err.message).not.toContain("Token used too late");
    expect(err.message).toBe("GOOGLE_ID_TOKEN_INVALID");
  });

  it("treats a missing payload as invalid", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    const client = fakeClient(null);
    await expect(verifyGoogleIdentity(config, CREDENTIAL, client))
      .rejects.toMatchObject({ code: "GOOGLE_ID_TOKEN_INVALID" });
  });

  it("treats a missing or blank sub as invalid", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    await expect(verifyGoogleIdentity(config, CREDENTIAL, fakeClient(okPayload({ sub: undefined }))))
      .rejects.toMatchObject({ code: "GOOGLE_ID_TOKEN_INVALID" });
    await expect(verifyGoogleIdentity(config, CREDENTIAL, fakeClient(okPayload({ sub: "   " }))))
      .rejects.toMatchObject({ code: "GOOGLE_ID_TOKEN_INVALID" });
  });

  it("rejects a wrong issuer even if the library let it through", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    await expect(verifyGoogleIdentity(config, CREDENTIAL, fakeClient(okPayload({ iss: "https://evil.example" }))))
      .rejects.toMatchObject({ code: "GOOGLE_ID_TOKEN_INVALID" });
  });

  it("succeeds with null email/name when optional fields are missing", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    const identity = await verifyGoogleIdentity(
      config,
      CREDENTIAL,
      fakeClient(okPayload({ email: undefined, name: undefined })),
    );
    expect(identity).toEqual({ sub: OWNER_SUB, email: null, name: null });
  });

  it("returns GOOGLE_AUTH_NOT_CONFIGURED when config is disabled or incomplete", async () => {
    const disabledEnv = { ...fullEnv(), GOOGLE_AUTH_ENABLED: "false" };
    const disabled = readGoogleSessionAuthConfig(disabledEnv);
    await expect(verifyGoogleIdentity(disabled, CREDENTIAL, fakeClient())).rejects
      .toMatchObject({ code: "GOOGLE_AUTH_NOT_CONFIGURED" });

    for (const key of [
      "GOOGLE_CLIENT_ID",
      "BOOK_ID_SEARCH_OWNER_GOOGLE_SUB",
      "BOOK_ID_SEARCH_SESSION_SECRET",
      "BOOK_ID_SEARCH_PUBLIC_ORIGIN",
    ] as const) {
      const partial = readGoogleSessionAuthConfig({ ...fullEnv(), [key]: "" });
      await expect(verifyGoogleIdentity(partial, CREDENTIAL, fakeClient())).rejects
        .toMatchObject({ code: "GOOGLE_AUTH_NOT_CONFIGURED" });
    }
  });

  it("rejects blank or oversized credentials before any client call", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    const calls: { idToken: string; audience: string }[] = [];
    const client = fakeClient(okPayload(), { calls });
    await expect(verifyGoogleIdentity(config, "", client)).rejects.toMatchObject({ code: "GOOGLE_ID_TOKEN_INVALID" });
    await expect(verifyGoogleIdentity(config, "   ", client)).rejects.toMatchObject({ code: "GOOGLE_ID_TOKEN_INVALID" });
    await expect(verifyGoogleIdentity(config, "x".repeat(8193), client)).rejects
      .toMatchObject({ code: "GOOGLE_ID_TOKEN_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("never includes the raw credential in error messages", async () => {
    const config = readGoogleSessionAuthConfig(fullEnv());
    const secretCred = "eyJhbGciOiJSUz-secret-credential-value";
    const throwing = {
      async verifyIdToken(): Promise<GoogleIdTicketPayload | undefined> {
        throw new Error(`failed for ${secretCred}`);
      },
    } as GoogleIdTokenClient;
    const err = await verifyGoogleIdentity(config, secretCred, throwing).catch(e => e);
    expect(err.message).not.toContain(secretCred);
  });

  it("exposes the default client factory without touching the network", async () => {
    // Constructing OAuth2Client must be safe offline; no verify call is made here.
    const client = createDefaultGoogleIdTokenClient("test-client-id.apps.googleusercontent.com");
    expect(typeof client.verifyIdToken).toBe("function");
    expect(GOOGLE_ID_TOKEN_ISSUERS).toContain("https://accounts.google.com");
    expect(GOOGLE_ID_TOKEN_ISSUERS).toContain("accounts.google.com");
  });
});
