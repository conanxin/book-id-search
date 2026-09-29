// S32-M0 schema-check harness (ESM-compatible, fail-closed)
// Usage: ./node_modules/.bin/tsx scripts/s32-schema-check.ts
// Exit codes:
//   0 = SCHEMA_OK (both DB A + DB B passed, no cleanup failure)
//   1 = SCHEMA_CHECK_FAIL (any thrown error)
//   2 = cleanup failure (docker rm unexpected error)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { S32_MIGRATION_PATHS, readS32MigrationChain } from "./s32-migration-chain.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = process.env.S32_ROOT_OVERRIDE
  ? resolve(process.env.S32_ROOT_OVERRIDE)
  : resolve(__dirname, "..");
const MIGRATIONS = S32_MIGRATION_PATHS.map(path => resolve(ROOT, path));
const ASSERTIONS = [
  resolve(ROOT, "db/tests/001_s32_schema_assertions.sql"),
  resolve(ROOT, "db/tests/002_s32_negative_invariants.sql"),
  resolve(ROOT, "db/tests/003_s32_m2e_schema_assertions.sql"),
  resolve(ROOT, "db/tests/004_s32_m2e_negative_invariants.sql"),
];
const UPGRADE_FIXTURES = [
  resolve(ROOT, "scripts/fixtures/s32-m2d-browser.sql"),
  resolve(ROOT, "scripts/fixtures/s32-m2e-schema-upgrade.sql"),
];
let evidenceDir = "";
const IMAGE = "postgres:16-alpine";
const USER = "s32test";
const PASS = "s32testpw";
let CONTAINER = `s32-m0-${Date.now()}`;

// Track unexpected cleanup failures for non-zero exit
export let lastCleanupError: string | null = null;

function run(cmd: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? -1 };
}
function docker(args: string[]) { return run(["sudo", "docker", ...args]); }

// Test-injectable docker runner (defaults to real docker). Allows tests to
// simulate underlying command failure (docker rm) without touching real Docker.
let dockerRunner: typeof docker = docker;

// --- Pre-flight: must check inputs BEFORE creating container ---
export function checkInputs(mig: string, files: string[]): void {
  for (const f of [mig, ...files]) {
    if (!existsSync(f)) throw new Error(`REQUIRED_FILE_MISSING: ${f}`);
    const content = readFileSync(f, "utf8");
    if (content.trim().length === 0) throw new Error(`REQUIRED_FILE_EMPTY: ${f}`);
  }
}

// --- Cleanup: must detect unexpected failures (not "already removed") ---
// Exported so tests can invoke the real cleanup path with an injected docker runner.
export function cleanup(): void {
  const r = dockerRunner(["rm", "-f", CONTAINER]);
  // "No such container" / "not found" is OK (already removed by --rm or prior cleanup)
  if (r.status !== 0 && !/No such container|not found/i.test(r.stderr)) {
    lastCleanupError = r.stderr || `docker rm exited ${r.status}`;
  }
}

// Post-cleanup decision logic (extracted so tests can verify the real exit path
// without spawning the full harness). main() consults this after withContainer().
//   "OK"               → main() prints SCHEMA_OK and exits 0
//   { error: string }   → main() prints error to stderr and exits 2 (no SCHEMA_OK)
export function postCleanupDecision(): "OK" | { error: string } {
  if (lastCleanupError) {
    return { error: lastCleanupError };
  }
  return "OK";
}

// --- Test-only hooks (clearly marked for simulation) ---
export function _resetCleanupForTest(): void {
  lastCleanupError = null;
}
export function _getCleanupErrorForTest(): string | null {
  return lastCleanupError;
}
// Inject a fake docker runner so cleanup() takes the simulated path without
// touching real Docker. Clearly marked [SIMULATED] in the resulting error.
export function _setDockerRunnerForTest(fn: typeof docker): void {
  dockerRunner = fn;
}
export function _resetDockerRunnerForTest(): void {
  dockerRunner = docker;
}
export function _setContainerForTest(name: string): void {
  CONTAINER = name;
}
export function _resetContainerForTest(): void {
  CONTAINER = `s32-m0-${Date.now()}`;
}
// Direct injection of lastCleanupError for tests that only want to verify the
// exit-decision surface (not the cleanup detection path).
export function _simulateCleanupFailureForTest(msg: string): void {
  lastCleanupError = `[SIMULATED] ${msg}`;
}

async function withContainer<T>(fn: () => Promise<T>): Promise<T> {
  process.on("SIGINT", () => { cleanup(); });
  process.on("SIGTERM", () => { cleanup(); });
  try {
    const img = docker(["image", "inspect", IMAGE]);
    if (img.status !== 0) {
      console.log(`[harness] pulling ${IMAGE}`);
      const p = docker(["pull", IMAGE]);
      if (p.status !== 0) throw new Error(`docker pull failed: ${p.stderr}`);
    }
    const up = docker([
      "run", "-d", "--rm", "--name", CONTAINER,
      "-e", `POSTGRES_USER=${USER}`, "-e", `POSTGRES_PASSWORD=***`, "-e", "POSTGRES_DB=postgres",
      "--tmpfs", "/var/lib/postgresql/data:rw,size=1073741824",
      IMAGE,
    ]);
    if (up.status !== 0) throw new Error(`docker run failed: ${up.stderr}`);
    CONTAINER = up.stdout.trim();
    let ready = false;
    for (let i = 0; i < 90; i++) {
      const r = docker(["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", USER]);
      if (r.status === 0) { ready = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!ready) throw new Error(`PG_READY=NO: ${CONTAINER} never became ready`);
    console.log(`[harness] ${CONTAINER.slice(0,12)} pg_isready OK`);
    return await fn();
  } finally {
    cleanup();
  }
}

function psqlFile(dbName: string, sql: string): { stdout: string; stderr: string; status: number } {
  const tmp = `/tmp/s32-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`;
  writeFileSync(tmp, sql);
  try {
    const cp = docker(["cp", tmp, `${CONTAINER}:/tmp/q.sql`]);
    if (cp.status !== 0) throw new Error(`docker cp failed: ${cp.stderr}`);
    return docker(["exec","-i",CONTAINER,"psql","-U",USER,"-X","-v","ON_ERROR_STOP=1","-d",dbName,"-f","/tmp/q.sql"]);
  } finally {
    docker(["exec", CONTAINER, "rm", "-f", "/tmp/q.sql"]);
    try { unlinkSync(tmp); } catch {}
  }
}

function createDatabase(dbName: string) {
  console.log(`[harness] ===== ${dbName} =====`);
  const dr = psqlFile("postgres", `DROP DATABASE IF EXISTS "${dbName}";`);
  if (dr.status !== 0) console.warn(`[harness] drop db warn: ${dr.stderr}`);
  const cr = psqlFile("postgres", `CREATE DATABASE "${dbName}";`);
  if (cr.status !== 0) throw new Error(`create db failed: ${cr.stderr}`);
}

function apply(dbName: string, sql: string) {
  const result = psqlFile(dbName, sql);
  if (result.status !== 0) throw new Error(`MIGRATION_APPLY_FAIL\n${result.stderr}`);
}

function assertions(dbName: string) {
  for (const a of ASSERTIONS) {
    // Existence and non-empty already enforced by checkInputs() before withContainer()
    const ar = psqlFile(dbName, readFileSync(a, "utf8"));
    if (ar.status !== 0) throw new Error(`ASSERTION_FAIL: ${a}\n${ar.stderr}`);
  }
}

function installOn(dbName: string, migrations: string[]) {
  createDatabase(dbName);
  for (const sql of migrations) apply(dbName, sql);
  assertions(dbName);
  console.log(`[harness] ${dbName} install+assertions OK`);
}

function query(dbName: string, sql: string): string {
  const r = docker(["exec", CONTAINER, "psql", "-XAt", "-U", USER, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-c", sql]);
  if (r.status !== 0) throw new Error(`SNAPSHOT_QUERY_FAILED: ${r.stderr}`);
  return r.stdout;
}

function dataSnapshot(dbName: string): string {
  const tables: string[] = JSON.parse(query(dbName, "SELECT json_agg(table_schema || '.' || table_name ORDER BY table_schema,table_name) FROM information_schema.tables WHERE table_schema IN ('core','ops')"));
  if (tables.length !== 26 || tables.some(name => !/^(core|ops)\.[a-z_]+$/.test(name))) throw new Error("UPGRADE_TABLE_SET_INVALID");
  const rows = tables.map(name => `SELECT '${name}' AS name, COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${name} t`).join(" UNION ALL ");
  return JSON.stringify(JSON.parse(query(dbName, `SELECT jsonb_object_agg(name,rows) FROM (${rows}) s`)));
}

function upgradeOn(dbName: string, migrations: string[], invalid: boolean) {
  createDatabase(dbName);
  apply(dbName, migrations[0]!);
  for (const fixture of UPGRADE_FIXTURES) apply(dbName, readFileSync(fixture, "utf8"));
  if (invalid) {
    apply(dbName, "UPDATE core.issue_resolutions SET preferred_claim_id='32111111-1111-4111-8111-111111111111' WHERE id='e4111111-1111-4111-8111-111111111111';");
  }
  const incompatible = query(dbName, "SELECT count(*) FROM core.issue_resolutions r WHERE r.preferred_claim_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.research_issue_claims c WHERE c.issue_id=r.issue_id AND c.claim_id=r.preferred_claim_id)");
  if (incompatible !== (invalid ? "1" : "0")) throw new Error("UPGRADE_FAULT_SETUP_FAILED");
  const before = dataSnapshot(dbName);
  writeFileSync(join(evidenceDir, `${dbName}-pre.json`), before, { mode: 0o600 });
  const result = psqlFile(dbName, migrations.slice(1).join("\n"));
  writeFileSync(join(evidenceDir, `${dbName}-migration.json`), JSON.stringify(result), { mode: 0o600 });
  const after = dataSnapshot(dbName);
  writeFileSync(join(evidenceDir, `${dbName}-post.json`), after, { mode: 0o600 });
  if (before !== after) throw new Error("UPGRADE_EXISTING_ROWS_CHANGED");
  if (invalid) {
    if (result.status === 0 || !result.stderr.includes("S32_M2E_LEGACY_PREFERRED_CLAIM_NOT_MEMBER")) throw new Error("INVALID_LEGACY_PREFLIGHT_NOT_REJECTED");
    const partial = query(dbName, "SELECT (SELECT count(*) FROM pg_constraint WHERE conrelid='core.issue_resolutions'::regclass AND conname='fk_ir_preferred_claim_same_issue') + (SELECT count(*) FROM pg_trigger WHERE tgrelid='core.issue_resolutions'::regclass AND NOT tgisinternal) + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='core' AND p.proname='fn_issue_resolutions_immutable')");
    if (partial !== "0") throw new Error("INVALID_LEGACY_PARTIAL_DDL");
    console.log("INVALID_LEGACY_PREFLIGHT_FAIL_CLOSED_PG16=PASS");
  } else {
    if (result.status !== 0) throw new Error(`VALID_UPGRADE_FAILED: ${result.stderr}`);
    assertions(dbName);
    console.log("VALID_001_TO_002_UPGRADE_PG16=PASS");
  }
}

async function main() {
  // Strict pre-flight: must check files BEFORE creating container
  const migrations = readS32MigrationChain(ROOT);
  checkInputs(MIGRATIONS[0]!, [...MIGRATIONS.slice(1), ...ASSERTIONS, ...UPGRADE_FIXTURES]);
  evidenceDir = mkdtempSync(join(tmpdir(), "s32-schema-evidence-"));
  console.log(`SCHEMA_EVIDENCE_DIR=${evidenceDir}`);
  await withContainer(async () => {
    const version = Number(query("postgres", "SHOW server_version_num"));
    if (version < 160000 || version >= 170000) throw new Error("PG16_REQUIRED");
    installOn("s32_test_a", migrations);
    installOn("s32_test_b", migrations);
    console.log("FRESH_INSTALL_PG16=PASS");
    upgradeOn("s32_upgrade_valid", migrations, false);
    upgradeOn("s32_upgrade_invalid", migrations, true);
  });
  // Real exit-handling logic: consult postCleanupDecision() and act accordingly.
  const decision = postCleanupDecision();
  if (typeof decision === "object") {
    console.error(`[harness] cleanup FAILED: ${decision.error}`);
    process.exit(2);
  }
  console.log("SCHEMA_OK");
}
// CLI entry guard: only run main() when this module is the program's entry
// point. When imported (e.g., by vitest or another module), do NOT start
// Docker, run SQL, or print SCHEMA_OK. Preserves exported functions and
// normal CLI behavior. Does not rely on NODE_ENV / test env detection.
function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}
if (isMainEntry()) {
  main().catch((e) => { console.error("SCHEMA_CHECK_FAIL", e instanceof Error ? e.message : String(e)); process.exit(1); });
}
