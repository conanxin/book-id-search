import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("root Vitest script vs real Playwright browser suites", () => {
  it("explicitly excludes every standalone whole-slice Playwright suite", () => {
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: { test: string } };
    const script = packageJson.scripts.test;
    const excluded = new Set([...script.matchAll(/--exclude\s+([^\s]+)/g)].map(match => match[1]));
    const browserSuites = readdirSync(resolve(ROOT, "scripts"))
      .filter(filename => filename.endsWith("-browser-acceptance.spec.ts"))
      .map(filename => "scripts/" + filename);
    expect(browserSuites.length).toBeGreaterThanOrEqual(4);
    const missing = browserSuites.filter(filename => !excluded.has(filename));
    expect(missing, "Playwright files must run through Playwright and disposable PG, never the root Vitest test runner").toEqual([]);
  });
});
