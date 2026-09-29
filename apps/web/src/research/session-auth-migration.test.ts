// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const researchDir = join(dirname(fileURLToPath(import.meta.url)));

function listProductionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (/\.(test|spec)\.[jt]sx?$/.test(name)) continue;
    if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const productionFiles = listProductionFiles(researchDir);

describe("Task 8 session-auth migration completeness (structural)", () => {
  it("production research source has no legacy S32 token API usage", () => {
    const banned = /useS32Token|getS32Token|saveS32Token|S32_TOKEN_KEY/;
    const offenders: string[] = [];
    for (const file of productionFiles) {
      if (/access\.ts$/.test(file)) continue; // deprecated artifact itself
      const text = readFileSync(file, "utf8");
      if (banned.test(text)) offenders.push(file);
    }
    // access.ts stays as a deprecated artifact; nothing else may reference the legacy API.
    expect(offenders).toEqual([]);
  });

  it("no production file (access.ts included) imports ./access", () => {
    const offenders = productionFiles
      .filter(f => !/access\.ts$/.test(f))
      .filter(f => /from\s+["']\.\/access["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("research/api.ts sends no Authorization header / Bearer token", () => {
    const api = readFileSync(join(researchDir, "api.ts"), "utf8");
    expect(api).not.toMatch(/Authorization/);
    expect(api).not.toMatch(/Bearer\s/);
  });

  it("research/api.ts request() is session-gated with CSRF on unsafe methods", () => {
    const api = readFileSync(join(researchDir, "api.ts"), "utf8");
    expect(api).toContain('getWebAuthSnapshot()');
    expect(api).toContain('"authenticated"');
    expect(api).toContain('"X-CSRF-Token"');
    expect(api).toContain('credentials: "same-origin"');
    expect(api).toContain('cache: "no-store"');
  });

  it("production components declare no auth-token props", () => {
    // An auth-token prop would appear as `token: string` in component prop types or
    // `token="…"`/`token={…}` JSX. Business uses of the word (e.g. none expected in
    // research components) would show up here for manual allowlisting.
    const offenders: string[] = [];
    for (const file of productionFiles) {
      if (/access\.ts$/.test(file)) continue; // deprecated legacy artifact
      const text = readFileSync(file, "utf8");
      if (/\btoken: string/.test(text) || /\btoken=\{/.test(text) || /\btoken="/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ProjectsPage uses GoogleLoginPanel + session gate, not token storage", () => {
    const page = readFileSync(join(researchDir, "ProjectsPage.tsx"), "utf8");
    expect(page).toContain("GoogleLoginPanel");
    expect(page).toContain("useWebAuthSession");
    expect(page).toContain('session.status === "authenticated"');
    expect(page).not.toMatch(/useS32Token|saveS32Token|type="password"/);
  });

  it("AddToProject uses the session hook", () => {
    const text = readFileSync(join(researchDir, "AddToProject.tsx"), "utf8");
    expect(text).toContain("useWebAuthSession");
    expect(text).not.toMatch(/useS32Token|saveS32Token/);
  });

  it("SearchMemberships uses the session hook and unauthenticated state", () => {
    const text = readFileSync(join(researchDir, "SearchMemberships.tsx"), "utf8");
    expect(text).toContain("useWebAuthSession");
    expect(text).toContain('"unauthenticated"');
    expect(text).not.toMatch(/useS32Token|saveS32Token|no-token/);
  });

  it("WeRead business source is untouched by the Task 8 diff", () => {
    const root = join(researchDir, "..", "..");
    const diff = execSync(
      "git diff -- apps/web/src/weread apps/web/src/wereadPrivate.ts apps/web/src/wereadPrivate.test.ts",
      { cwd: root, encoding: "utf8" },
    );
    expect(diff).toBe("");
  });
});
