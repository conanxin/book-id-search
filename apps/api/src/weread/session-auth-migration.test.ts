import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 6 WeRead migration completeness. Fixed 9-endpoint method+path
 * allowlist — update explicitly if a WeRead private endpoint is added.
 * Proves: index.ts business handlers no longer call checkPrivateAuth
 * directly; all nine route through the WeRead request authorizer; the
 * authorizer singleton is created once; private-auth.ts keeps the legacy
 * checker; S32 wiring did not regress.
 */
const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = readFileSync(join(API_SRC, "index.ts"), "utf8");
const PRIVATE_AUTH = readFileSync(join(API_SRC, "weread/private-auth.ts"), "utf8");

const WEREAD_PRIVATE_ENDPOINTS = [
  "GET /api/private/weread/summary",
  "GET /api/private/weread/trends",
  "GET /api/private/weread/status",
  "POST /api/private/weread/status/batch",
  "GET /api/private/weread/notes",
  "GET /api/private/weread/reading-map",
  "GET /api/private/weread/annual-review",
  "POST /api/private/weread/related-books",
  "POST /api/private/weread/notes/summarize",
] as const;

describe("WeRead session-auth migration completeness", () => {
  it("allowlist covers exactly the nine known endpoints", () => {
    expect(WEREAD_PRIVATE_ENDPOINTS).toHaveLength(9);
  });

  it("every allowlisted endpoint exists in index.ts", () => {
    for (const entry of WEREAD_PRIVATE_ENDPOINTS) {
      const [method, path] = entry.split(" ");
      expect(INDEX).toMatch(new RegExp(`app\\.${method.toLowerCase()}\\(\\s*"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    }
  });

  it("index.ts has zero direct checkPrivateAuth calls in business handlers", () => {
    // The only permitted mention is none at all: import was swapped too.
    expect(INDEX).not.toMatch(/checkPrivateAuth\s*\(/);
    expect(INDEX).not.toContain("checkPrivateAuth,");
  });

  it("all nine handlers route through authorizeWereadRouteRequest", () => {
    const calls = INDEX.match(/authorizeWereadRouteRequest\(\s*\w+,\s*wereadRequestAuthorizer\s*\)/g) ?? [];
    expect(calls).toHaveLength(9);
  });

  it("createWereadRequestAuthorizer singleton created exactly once", () => {
    const creations = INDEX.match(/createWereadRequestAuthorizer\(googleAuthConfig\)/g) ?? [];
    expect(creations).toHaveLength(1);
  });

  it("private-auth.ts retains the unchanged legacy checker", () => {
    expect(PRIVATE_AUTH).toContain("export function checkPrivateAuth(");
    expect(PRIVATE_AUTH).toContain("export function isOverlayEnabled(");
    expect(PRIVATE_AUTH).toContain("export function hasPrivateTokenConfigured(");
    expect(PRIVATE_AUTH).toContain("export function createWereadRequestAuthorizer(");
    expect(PRIVATE_AUTH).toContain("export function authorizeWereadRouteRequest(");
  });

  it("S32 wiring did not regress", () => {
    expect(INDEX).toContain("const s32RequestAuthorizer = createS32RequestAuthorizer(s32Config, googleAuthConfig);");
    expect(INDEX).toContain("createIssueResolutionBodyParser(s32Config, s32RequestAuthorizer)");
    expect(INDEX).toContain("createProjectItemNoteBodyParser(s32Config, s32RequestAuthorizer)");
    expect(INDEX).toContain("requestAuthorizer: s32RequestAuthorizer");
  });
});
