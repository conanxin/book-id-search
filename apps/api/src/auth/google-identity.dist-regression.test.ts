import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

/**
 * ESM-dist regression guard (M3-A production incident 2026-09-30).
 *
 * The API package compiles to ESM ("type": "module"). google-identity.ts
 * used a bare `require("google-auth-library")` for lazy loading: valid under
 * vitest's CJS-interop transform, but a ReferenceError in the compiled dist —
 * every POST /api/auth/google died with 500 AUTH_INTERNAL before any network
 * call. Unit tests never import the dist, so this guard executes the real
 * compiled module the way production does (plain `node`, no transform).
 *
 * It builds on the current source's dist output. If dist is stale the check
 * fails loudly rather than silently passing on old bytes.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "../../dist/auth");

describe("google-identity ESM dist regression (production incident guard)", () => {
  it("compiled dist constructs the default client without ReferenceError", () => {
    const require = createRequire(import.meta.url);
    require.resolve(path.join(distDir, "google-identity.js"));

    const probe = `
      import { createDefaultGoogleIdTokenClient } from ${JSON.stringify(path.join(distDir, "google-identity.js"))};
      const client = createDefaultGoogleIdTokenClient("probe-client-id");
      if (!client || typeof client.verifyIdToken !== "function") {
        throw new Error("client shape invalid");
      }
      console.log("ESM_DIST_OK");
    `;
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", probe],
      { encoding: "utf8", cwd: distDir },
    );
    expect(out.trim()).toBe("ESM_DIST_OK");
  });
});
