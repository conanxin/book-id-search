// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const wereadDir = join(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(wereadDir, "..");

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (/\.(test|spec)\.[jt]sx?$/.test(name)) continue;
    if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const wereadProduction = productionFiles(wereadDir);
const appTsx = readFileSync(join(srcRoot, "App.tsx"), "utf8");
const panelTsx = readFileSync(join(srcRoot, "WereadPrivatePanel.tsx"), "utf8");
const wereadPrivate = readFileSync(join(srcRoot, "wereadPrivate.ts"), "utf8");
const centerTsx = readFileSync(join(wereadDir, "WereadCenter.tsx"), "utf8");

describe("Task 9 WeRead session migration completeness (structural)", () => {
  it("wereadPrivate.ts has no legacy token storage auth usage", () => {
    expect(wereadPrivate).not.toMatch(/getWereadToken|saveWereadToken|clearWereadToken\b|isWereadEnabled/);
    // The legacy key appears only as the purge constant (plus its doc comment).
    const executableMatches =
      wereadPrivate.replace(/\/\*[\s\S]*?\*\//g, "").match(/book-id-search:weread-private-token/g) ?? [];
    expect(executableMatches.length).toBe(1);
    expect(wereadPrivate).toMatch(/removeItem\(LEGACY_WEREAD_TOKEN_KEY\)/);
    expect(wereadPrivate).not.toMatch(/getItem\(LEGACY_WEREAD_TOKEN_KEY\)|setItem\(LEGACY_WEREAD_TOKEN_KEY/);
  });

  it("wereadPrivate.ts sends no Authorization header / Bearer token", () => {
    expect(wereadPrivate).not.toMatch(/Bearer/);
    // Only "no Authorization header" prose remains.
    const authMatches = wereadPrivate.match(/Authorization/g) ?? [];
    for (const m of wereadPrivate.matchAll(/.{0,40}Authorization.{0,40}/g)) {
      expect(m[0]).toMatch(/no Authorization|No Authorization/);
    }
    void authMatches;
  });

  it("wereadPrivate.ts request core is session-gated with same-origin + CSRF on unsafe methods", () => {
    expect(wereadPrivate).toContain("getWebAuthSnapshot()");
    expect(wereadPrivate).toContain('credentials: "same-origin"');
    expect(wereadPrivate).toContain('cache: "no-store"');
    expect(wereadPrivate).toContain('"X-CSRF-Token"');
    expect(wereadPrivate).toContain("ensureAuthSessionLoaded()");
  });

  it("no weread production component declares or passes auth token props", () => {
    const offenders: string[] = [];
    for (const file of wereadProduction.filter((f) => f.endsWith(".tsx"))) {
      const text = readFileSync(file, "utf8");
      if (/\btoken: string\b/.test(text) || /\btoken=\{/.test(text) || /\btoken="/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    // Known leftover: wereadCenterModel.ts exports an orphaned WereadCenterState
    // type with token fields but has ZERO importers (verified by grep). Dead type
    // only — no runtime auth surface. Recorded as review note, not a defect.
    const modelText = readFileSync(join(wereadDir, "wereadCenterModel.ts"), "utf8");
    expect(modelText).toMatch(/WereadCenterState/);
  });

  it("no weread production file imports legacy token storage from wereadPrivate", () => {
    const offenders: string[] = [];
    for (const file of wereadProduction) {
      const text = readFileSync(file, "utf8");
      const importMatch = text.match(/from\s+["'][.]{2}\/wereadPrivate["']/);
      if (importMatch && /getWereadToken|saveWereadToken|clearWereadToken|isWereadEnabled/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("WereadCenter has no token UI and uses the session stack", () => {
    expect(centerTsx).not.toMatch(/type="password"|输入 private token|清除 token|私有 token/);
    // "sessionStorage" may only appear inside comments (the purge explanation).
    const executableCenter = centerTsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(executableCenter).not.toContain("sessionStorage");
    expect(centerTsx).toContain("useWebAuthSession");
    expect(centerTsx).toContain("GoogleLoginPanel");
    expect(centerTsx).toContain("purgeLegacyWereadTokenStorage");
    expect(centerTsx).toContain("clearWereadStatusCache");
  });

  it("WereadPrivatePanel has no token UI and uses the session stack", () => {
    expect(panelTsx).not.toMatch(/type="password"|输入 private token|清除 token|私有 token|saveWereadToken|getWereadToken/);
    expect(panelTsx).toContain("useWebAuthSession");
    expect(panelTsx).toContain("GoogleLoginPanel");
  });

  it("App.tsx has no getWereadToken/wereadToken auth state and gates WeRead on the session", () => {
    expect(appTsx).not.toMatch(/getWereadToken|wereadToken|isWereadEnabled/);
    expect(appTsx).toContain("useWebAuthSession");
    expect(appTsx).toContain("purgeLegacyWereadTokenStorage");
    expect(appTsx).toContain("clearWereadStatusCache");
  });

  it("no browser storage getItem/setItem of the legacy key anywhere in production web source", () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          scan(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
        const text = readFileSync(full, "utf8");
        if (/getItem\(\s*["']book-id-search:weread-private-token|setItem\(\s*["']book-id-search:weread-private-token/.test(text)) {
          offenders.push(full);
        }
      }
    };
    scan(srcRoot);
    expect(offenders).toEqual([]);
  });

  it("Research source has no Task 9 regression (git diff touches only weread surfaces)", () => {
    const diff = execSync(
      "git diff --name-only -- apps/web/src/research apps/web/src/auth",
      { cwd: join(srcRoot, "..", ".."), encoding: "utf8" },
    ).trim();
    // Task 9 must not touch research/auth (those were Task 7/8, already committed).
    expect(diff).toBe("");
  });

  it("backend source and db have zero Task 9 diff", () => {
    const diff = execSync(
      "git diff --name-only -- apps/api db",
      { cwd: join(srcRoot, "..", ".."), encoding: "utf8" },
    ).trim();
    expect(diff).toBe("");
  });
});
