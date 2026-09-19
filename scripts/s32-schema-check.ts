// S32-M0 schema-check harness (ESM-compatible, fail-closed)
// Usage: ./node_modules/.bin/tsx scripts/s32-schema-check.ts
// Exit codes:
//   0 = SCHEMA_OK (both DB A + DB B passed, no cleanup failure)
//   1 = SCHEMA_CHECK_FAIL (any thrown error)
//   2 = cleanup failure (docker rm unexpected error)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = process.env.S32_ROOT_OVERRIDE
  ? resolve(process.env.S32_ROOT_OVERRIDE)
  : resolve(__dirname, "..");
const MIG = resolve(ROOT, "db/migrations/001_s32_core_schema.sql");
const ASSERTIONS = [
  resolve(ROOT, "db/tests/001_s32_schema_assertions.sql"),
  resolve(ROOT, "db/tests/002_s32_negative_invariants.sql"),
];
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
      const r = docker(["exec", CONTAINER, "pg_isready", "-U", USER]);
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

async function installOn(dbName: string) {
  console.log(`[harness] ===== ${dbName} =====`);
  const dr = psqlFile("postgres", `DROP DATABASE IF EXISTS "${dbName}";`);
  if (dr.status !== 0) console.warn(`[harness] drop db warn: ${dr.stderr}`);
  const cr = psqlFile("postgres", `CREATE DATABASE "${dbName}";`);
  if (cr.status !== 0) throw new Error(`create db failed: ${cr.stderr}`);
  const mig = psqlFile(dbName, readFileSync(MIG, "utf8"));
  if (mig.status !== 0) throw new Error(`MIGRATION_APPLY_FAIL\n${mig.stderr}`);
  for (const a of ASSERTIONS) {
    // Existence and non-empty already enforced by checkInputs() before withContainer()
    const ar = psqlFile(dbName, readFileSync(a, "utf8"));
    if (ar.status !== 0) throw new Error(`ASSERTION_FAIL: ${a}\n${ar.stderr}`);
  }
  console.log(`[harness] ${dbName} install+assertions OK`);
}

async function main() {
  // Strict pre-flight: must check files BEFORE creating container
  checkInputs(MIG, ASSERTIONS);
  await withContainer(async () => {
    await installOn("s32_test_a");
    await installOn("s32_test_b");
  });
  // Real exit-handling logic: consult postCleanupDecision() and act accordingly.
  const decision = postCleanupDecision();
  if (typeof decision === "object") {
    console.error(`[harness] cleanup FAILED: ${decision.error}`);
    process.exit(2);
  }
  console.log("SCHEMA_OK");
}
main().catch((e) => { console.error("SCHEMA_CHECK_FAIL", e instanceof Error ? e.message : String(e)); process.exit(1); });