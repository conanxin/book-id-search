export interface GoogleSessionAuthConfig {
  enabled: boolean;
  clientId: string | null;
  ownerSub: string | null;
  sessionSecret: string | null;
  publicOrigin: string | null;
  production: boolean;
  cookieName: string;
  sessionTtlSeconds: number;
}

export const GOOGLE_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const GOOGLE_SESSION_COOKIE_PRODUCTION = "__Host-book_id_search_session";
export const GOOGLE_SESSION_COOKIE_DEVELOPMENT = "book_id_search_session_dev";

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function readGoogleSessionAuthConfig(env: NodeJS.ProcessEnv): GoogleSessionAuthConfig {
  const production = env.NODE_ENV === "production";
  return {
    enabled: env.GOOGLE_AUTH_ENABLED === "true",
    clientId: clean(env.GOOGLE_CLIENT_ID),
    ownerSub: clean(env.BOOK_ID_SEARCH_OWNER_GOOGLE_SUB),
    sessionSecret: clean(env.BOOK_ID_SEARCH_SESSION_SECRET),
    publicOrigin: clean(env.BOOK_ID_SEARCH_PUBLIC_ORIGIN),
    production,
    cookieName: production
      ? GOOGLE_SESSION_COOKIE_PRODUCTION
      : GOOGLE_SESSION_COOKIE_DEVELOPMENT,
    sessionTtlSeconds: GOOGLE_SESSION_TTL_SECONDS,
  };
}

export function isGoogleSessionAuthConfigured(config: GoogleSessionAuthConfig): boolean {
  return Boolean(
    config.enabled
      && config.clientId
      && config.ownerSub
      && config.sessionSecret
      && config.publicOrigin,
  );
}
