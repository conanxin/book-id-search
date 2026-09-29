import type { GoogleSessionAuthConfig } from "./config.js";

/**
 * Verified Google identity. `sub` is the ONLY authorization principal;
 * email/name are display metadata and may be null.
 */
export interface GoogleIdentity {
  sub: string;
  email: string | null;
  name: string | null;
}

export type GoogleIdentityFailureCode =
  | "GOOGLE_AUTH_NOT_CONFIGURED"
  | "GOOGLE_ID_TOKEN_INVALID"
  | "GOOGLE_ACCOUNT_NOT_ALLOWED";

export class GoogleIdentityError extends Error {
  readonly code: GoogleIdentityFailureCode;
  constructor(code: GoogleIdentityFailureCode) {
    // Message never includes the credential/token or any raw Google payload.
    super(code);
    this.code = code;
    this.name = "GoogleIdentityError";
  }
}

/** Minimal ID-token client surface the verifier needs (injectable for tests). */
export interface GoogleIdTokenClient {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<GoogleIdTicketPayload | undefined>;
}

/** Payload shape returned by google-auth-library's VerifyIdTokenOptions ticket. */
export interface GoogleIdTicketPayload {
  sub?: string;
  email?: string | null;
  name?: string | null;
  iss?: string | null;
}

/** Allowed Google ID-token issuers per OpenID Connect discovery. */
export const GOOGLE_ID_TOKEN_ISSUERS: readonly string[] = [
  "https://accounts.google.com",
  "accounts.google.com",
];

/** Credential length bounds; rejects blank/absurd input before any network call. */
export const MIN_GOOGLE_CREDENTIAL_LENGTH = 16;
export const MAX_GOOGLE_CREDENTIAL_LENGTH = 8192;

function isReasonableCredential(credential: string): boolean {
  return typeof credential === "string"
    && credential.length >= MIN_GOOGLE_CREDENTIAL_LENGTH
    && credential.length <= MAX_GOOGLE_CREDENTIAL_LENGTH;
}

export function createDefaultGoogleIdTokenClient(clientId: string): GoogleIdTokenClient {
  // Lazy import keeps google-auth-library out of cold paths and lets tests
  // inject fakes without touching the network.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OAuth2Client } = require("google-auth-library") as typeof import("google-auth-library");
  const client = new OAuth2Client(clientId);
  return {
    async verifyIdToken(options) {
      const ticket = await client.verifyIdToken({
        idToken: options.idToken,
        audience: options.audience,
      });
      return ticket.getPayload() as GoogleIdTicketPayload | undefined;
    },
  };
}

export async function verifyGoogleIdentity(
  config: GoogleSessionAuthConfig,
  credential: string,
  client: GoogleIdTokenClient,
): Promise<GoogleIdentity> {
  // Re-check completeness locally: the config gate lives in config.ts, but the
  // verifier must fail closed even if invoked with a partially-populated object.
  if (
    !config.enabled
    || !config.clientId
    || !config.ownerSub
    || !config.sessionSecret
    || !config.publicOrigin
  ) {
    throw new GoogleIdentityError("GOOGLE_AUTH_NOT_CONFIGURED");
  }

  if (!isReasonableCredential(credential)) {
    throw new GoogleIdentityError("GOOGLE_ID_TOKEN_INVALID");
  }

  let payload: GoogleIdTicketPayload | undefined;
  try {
    payload = await client.verifyIdToken({
      idToken: credential,
      audience: config.clientId,
    });
  } catch {
    // verifyIdToken failures (signature, audience, expiry, network...) are all
    // "invalid token" for our purposes; details stay out of the message.
    throw new GoogleIdentityError("GOOGLE_ID_TOKEN_INVALID");
  }

  if (!payload) {
    throw new GoogleIdentityError("GOOGLE_ID_TOKEN_INVALID");
  }

  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) {
    throw new GoogleIdentityError("GOOGLE_ID_TOKEN_INVALID");
  }

  // Explicit issuer contract even though the library validates it; keeps the
  // invariant testable independent of library behavior.
  if (typeof payload.iss !== "string" || !GOOGLE_ID_TOKEN_ISSUERS.includes(payload.iss)) {
    throw new GoogleIdentityError("GOOGLE_ID_TOKEN_INVALID");
  }

  if (sub !== config.ownerSub) {
    throw new GoogleIdentityError("GOOGLE_ACCOUNT_NOT_ALLOWED");
  }

  const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : null;
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null;
  return { sub, email, name };
}
