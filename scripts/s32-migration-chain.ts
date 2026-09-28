import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Explicitly reviewed migrations only; never execute an unknown glob result.
export const S32_MIGRATION_PATHS = [
  "db/migrations/001_s32_core_schema.sql",
  "db/migrations/002_s32_m2e_issue_resolution.sql",
] as const;

// Read and validate the entire chain before the caller applies any migration.
// Docker/psql lifecycle belongs to each existing disposable-PG runner.
export function readS32MigrationChain(root: string): string[] {
  return S32_MIGRATION_PATHS.map(relative => {
    const path = resolve(root, relative);
    if (!existsSync(path)) throw new Error(`REQUIRED_MIGRATION_MISSING: ${relative}`);
    const sql = readFileSync(path, "utf8");
    if (!sql.trim()) throw new Error(`REQUIRED_MIGRATION_EMPTY: ${relative}`);
    return sql;
  });
}
