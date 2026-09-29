import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 5 migration completeness. Fixed 11-file allowlist — update explicitly
 * when a new S32 route module is added. Business route files must not call
 * checkS32PrivateAuth directly; they route through authorizeS32RouteRequest,
 * and private-auth.ts remains the only legacy-checker implementation site.
 */
const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)));

const MIGRATED_ROUTE_FILES = [
  "assessment-routes.ts",
  "candidate-claim-routes.ts",
  "catalog-promotion-route.ts",
  "evidence-selection-routes.ts",
  "issue-resolution-routes.ts",
  "project-item-note-routes.ts",
  "project-item-routes.ts",
  "project-overview-route.ts",
  "project-routes.ts",
  "research-issue-routes.ts",
  "research-membership-route.ts",
] as const;

function source(name: string): string {
  return readFileSync(join(ROUTES_DIR, name), "utf8");
}

describe("S32 session-auth migration completeness", () => {
  it("covers exactly the 11 known route modules", () => {
    expect(MIGRATED_ROUTE_FILES).toHaveLength(11);
  });

  for (const file of MIGRATED_ROUTE_FILES) {
    it(`${file}: no direct checkS32PrivateAuth call and uses the request gate`, () => {
      const text = source(file);
      // No direct legacy invocation (import allowed only for the gate re-export? no: none).
      expect(text).not.toMatch(/checkS32PrivateAuth\s*\(/);
      // Uses the migration gate.
      expect(text).toContain("authorizeS32RouteRequest(");
      // Accepts an optional requestAuthorizer (factory or deps object).
      expect(text).toContain("requestAuthorizer");
    });
  }

  it("private-auth.ts is the only remaining legacy checker implementation site", () => {
    for (const file of MIGRATED_ROUTE_FILES) {
      expect(source(file)).not.toMatch(/export function checkS32PrivateAuth/);
    }
    const impl = source("private-auth.ts");
    expect(impl).toContain("export function checkS32PrivateAuth(");
    expect(impl).toContain("export function createS32RequestAuthorizer(");
    expect(impl).toContain("export function authorizeS32RouteRequest(");
  });

  it("register.ts injects the same requestAuthorizer into all factories", () => {
    const reg = readFileSync(join(ROUTES_DIR, "..", "register.ts"), "utf8");
    // 10 router.use factory calls + 1 deps-object handler = 11 injections.
    const routerInjections = reg.match(/, requestAuthorizer\)/g) ?? [];
    const depsInjection = reg.match(/\{ config, command, requestAuthorizer \}/g) ?? [];
    expect(routerInjections.length).toBe(10);
    expect(depsInjection.length).toBe(1);
    // Authorizer comes from deps (production wiring) and is reused everywhere.
    expect(reg).toContain("const requestAuthorizer = deps.requestAuthorizer;");
  });
});
