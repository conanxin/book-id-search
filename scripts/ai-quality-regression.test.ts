import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Tests for the AI quality regression runner.
 *
 * These tests check structural correctness, not live AI behavior.
 * Live behavior is exercised by `pnpm ai:quality` against the real API.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(ROOT, "scripts/ai-quality-regression.ts");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");

describe("ai-quality-regression.ts", () => {
  it("script file exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("script file does not contain hardcoded keys", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });

  it("runner accepts --public-url flag", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--public-url");
  });

  it("runner accepts --max-ai-calls flag", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--max-ai-calls");
  });

  it("runner accepts --case flag for filtering", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--case");
  });

  it("runner accepts --mode smoke", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--mode");
    expect(content).toContain("smoke");
  });

  it("runner accepts --json and --markdown output paths", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--json");
    expect(content).toContain("--markdown");
  });

  it("package.json registers ai:quality script", () => {
    const pkg = JSON.parse(execSync(`cat ${ROOT}/package.json`, { encoding: "utf8" }));
    expect(pkg.scripts["ai:quality"]).toBeTruthy();
  });

  it("tsx binary is available locally", () => {
    expect(existsSync(TSX)).toBe(true);
  });
});
