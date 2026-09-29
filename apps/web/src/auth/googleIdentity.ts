/**
 * Google Identity Services singleton loader + initializer (Task 7).
 *
 * - One <script> (fixed id) per page; concurrent loads share one promise.
 * - initialize() runs once per clientId; a different clientId fail-closes.
 * - callback mode: the raw credential is forwarded straight to
 *   signInWithGoogleCredential — never decoded, stored, or logged.
 * - auto_select=false and One Tap prompt() are never used.
 */

export const GSI_SCRIPT_ID = "book-id-search-google-gsi";
export const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

interface GsiCredentialResponse {
  credential?: string;
}

interface GsiIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GsiCredentialResponse) => void;
    auto_select?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: Record<string, unknown>,
  ): void;
  disableAutoSelect(): void;
  prompt?: () => void;
}

interface GoogleNamespace {
  accounts: { id: GsiIdApi };
}

declare global {
  interface Window {
    google?: GoogleNamespace;
  }
}

let loadPromise: Promise<GoogleNamespace> | null = null;
let initializedClientId: string | null = null;
let credentialHandler: ((credential: string) => Promise<void>) | null = null;

function waitForScript(): Promise<GoogleNamespace> {
  return new Promise((resolve, reject) => {
    const check = (attempts = 0): void => {
      const existing = (globalThis as { google?: GoogleNamespace }).google;
      if (existing?.accounts?.id) {
        resolve(existing);
        return;
      }
      if (attempts > 100) {
        reject(new Error("GSI_SCRIPT_TIMEOUT"));
        return;
      }
      setTimeout(() => check(attempts + 1), 50);
    };
    check();
  });
}

/** Load the GSI script once; returns the window.google namespace. */
export function loadGoogleIdentityServices(): Promise<GoogleNamespace> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const existing = (globalThis as { google?: GoogleNamespace }).google;
    if (existing?.accounts?.id) return existing;
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) throw new Error("GSI_NO_DOCUMENT");
    const previous = doc.getElementById(GSI_SCRIPT_ID);
    if (previous) {
      return waitForScript();
    }
    await new Promise<void>((resolve, reject) => {
      const script = doc.createElement("script");
      script.id = GSI_SCRIPT_ID;
      script.src = GSI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", () => resolve());
      script.addEventListener("error", () => reject(new Error("GSI_SCRIPT_ERROR")));
      doc.head.appendChild(script);
    });
    return waitForScript();
  })();
  loadPromise = loadPromise.catch((error: unknown) => {
    // Allow a later retry after a hard load failure.
    loadPromise = null;
    throw error;
  }) as Promise<GoogleNamespace>;
  return loadPromise;
}

/** Test-only: forget the singleton so a fresh load can be simulated. */
export function __resetGoogleIdentityForTests(): void {
  loadPromise = null;
  initializedClientId = null;
  credentialHandler = null;
}

/** Test-only: inspect which clientId was initialized. */
export function __getInitializedClientIdForTests(): string | null {
  return initializedClientId;
}

/**
 * initialize() exactly once per page. A second call with the same clientId is
 * a no-op; a different clientId fails closed (throws) because Google's GIS
 * cannot be re-initialized safely.
 */
export async function initializeGoogleIdentity(
  clientId: string,
  onCredential: (credential: string) => Promise<void>,
): Promise<void> {
  if (initializedClientId !== null) {
    if (initializedClientId !== clientId) {
      throw new Error("GSI_CLIENT_ID_MISMATCH");
    }
    return;
  }
  const google = await loadGoogleIdentityServices();
  credentialHandler = onCredential;
  google.accounts.id.initialize({
    client_id: clientId,
    auto_select: false,
    callback: (response: GsiCredentialResponse) => {
      const credential = typeof response?.credential === "string" ? response.credential : "";
      if (credential && credentialHandler) {
        void credentialHandler(credential);
      }
    },
  });
  initializedClientId = clientId;
}

/** Render the official Google button into a container. */
export async function renderGoogleButton(
  parent: HTMLElement,
  options: { width?: number } = {},
): Promise<void> {
  const google = await loadGoogleIdentityServices();
  google.accounts.id.renderButton(parent, {
    theme: "outline",
    size: "large",
    ...(options.width !== undefined ? { width: options.width } : {}),
  });
}

/** Called after a successful logout so GIS stops auto-reissuing credentials. */
export function disableGoogleAutoSelect(): void {
  try {
    (globalThis as { google?: GoogleNamespace }).google?.accounts.id.disableAutoSelect();
  } catch {
    // best-effort only
  }
}
