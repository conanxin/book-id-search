import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const expected = ["db/migrations/001_s32_core_schema.sql", "db/migrations/002_s32_m2e_issue_resolution.sql"];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function helper() {
  expect(existsSync(resolve(root, "scripts/s32-migration-chain.ts")), "shared chain exists").toBe(true);
  const modulePath = "./s32-migration-chain.ts";
  return import(modulePath);
}
describe("S32 current migration chain", () => {
  it("reads the explicit complete chain in order and ignores unconfigured files", async () => {
    const { S32_MIGRATION_PATHS, readS32MigrationChain } = await helper();
    expect(S32_MIGRATION_PATHS).toEqual(expected);
    const dir = mkdtempSync(resolve(tmpdir(), "s32-chain-")); dirs.push(dir);
    mkdirSync(resolve(dir, "db/migrations"), { recursive: true });
    expected.forEach((p, i) => writeFileSync(resolve(dir, p), `SELECT ${i + 1};`));
    writeFileSync(resolve(dir, "db/migrations/003_unknown.sql"), "MUST NOT EXECUTE");
    expect(readS32MigrationChain(dir)).toEqual(["SELECT 1;", "SELECT 2;"]);
  });
  it.each(expected)("fails closed when configured migration %s is missing or empty", async (missing) => {
    const { readS32MigrationChain } = await helper();
    const dir = mkdtempSync(resolve(tmpdir(), "s32-chain-")); dirs.push(dir);
    mkdirSync(resolve(dir, "db/migrations"), { recursive: true });
    for (const p of expected) if (p !== missing) writeFileSync(resolve(dir, p), "SELECT 1;");
    expect(() => readS32MigrationChain(dir)).toThrow(/REQUIRED_MIGRATION_MISSING/);
    writeFileSync(resolve(dir, missing), " \n");
    expect(() => readS32MigrationChain(dir)).toThrow(/REQUIRED_MIGRATION_EMPTY/);
  });
  const runners = ["s32-schema-check.ts", ...["m1a", "m1b", "m1c", "m1d", "m1e", "m2a", "m2b", "m2c", "m2d"].map(s => `s32-${s}-integration-check.ts`)];
  it.each(runners)("%s consumes the complete shared chain", file => {
    const source = readFileSync(resolve(root, "scripts", file), "utf8");
    expect(source).toMatch(/import\s+.*readS32MigrationChain.*from\s+["']\.\/s32-migration-chain/);
    expect(source).toMatch(/readS32MigrationChain\((root|ROOT)\)/);
    expect(source).not.toContain("db/migrations/001_s32_core_schema.sql");
    expect(source).not.toContain("db/migrations/002_s32_m2e_issue_resolution.sql");
  });
});
