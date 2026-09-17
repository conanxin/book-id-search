import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(__dirname, "..");
const MIG = resolve(ROOT, "db/migrations/001_s32_core_schema.sql");
const ASSERTIONS = [resolve(ROOT, "db/tests/001_s32_schema_assertions.sql"), resolve(ROOT, "db/tests/002_s32_negative_invariants.sql")];
const IMAGE = "postgres:16-alpine";
const USER = "s32test"; const PASS = "s32testpw";
let CONTAINER = `s32-m0-${Date.now()}`;
function run(cmd: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? -1 };
}
function docker(args: string[]) { return run(["sudo", "docker", ...args]); }
async function withContainer<T>(fn: () => Promise<T>): Promise<T> {
  const cleanup = async () => { docker(["rm", "-f", CONTAINER]).catch(() => {}); };
  process.on("SIGINT", cleanup); process.on("SIGTERM", cleanup);
  try {
    const img = docker(["image", "inspect", IMAGE]);
    if (img.status !== 0) { console.log(`[harness] pulling ${IMAGE}`); const p = docker(["pull", IMAGE]); if (p.status !== 0) throw new Error(`pull failed: ${p.stderr}`); }
    const up = docker(["run","-d","--rm","--name",CONTAINER,"-e",`POSTGRES_USER=${USER}`,"-e",`POSTGRES_PASSWORD=${PASS}`,"-e","POSTGRES_DB=postgres","--tmpfs","/var/lib/postgresql/data:rw,size=1073741824",IMAGE]);
    if (up.status !== 0) throw new Error(`docker run failed: ${up.stderr}`);
    CONTAINER = up.stdout.trim();
    for (let i = 0; i < 90; i++) { const r = docker(["exec", CONTAINER, "pg_isready", "-U", USER]); if (r.status === 0) break; await new Promise(r => setTimeout(r, 1000)); }
    return await fn();
  } finally { await cleanup(); }
}
function psqlFile(dbName: string, sql: string) {
  const tmp = `/tmp/s32-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`;
  writeFileSync(tmp, sql);
  docker(["cp", tmp, `${CONTAINER}:/tmp/q.sql`]);
  const r = docker(["exec","-i",CONTAINER,"psql","-U",USER,"-X","-v","ON_ERROR_STOP=0","-d",dbName,"-f","/tmp/q.sql"]);
  docker(["exec", CONTAINER, "rm", "-f", "/tmp/q.sql"]);
  require("node:fs").unlinkSync(tmp);
  return r;
}
async function installOn(dbName: string) {
  if (!existsSync(MIG)) throw new Error(`MIGRATION_FILE_MISSING: ${MIG}`);
  console.log(`[harness] ===== ${dbName} =====`);
  const dr = psqlFile("postgres", `DROP DATABASE IF EXISTS "${dbName}";`);
  if (dr.status !== 0) console.warn(`drop db warn: ${dr.stderr}`);
  const cr = psqlFile("postgres", `CREATE DATABASE "${dbName}";`);
  if (cr.status !== 0) throw new Error(`create db failed: ${cr.stderr}`);
  const mig = psqlFile(dbName, readFileSync(MIG, "utf8"));
  if (mig.status !== 0) { console.error("[harness] MIGRATION_APPLY_FAIL"); console.error(mig.stderr); process.exit(2); }
  for (const a of ASSERTIONS) {
    if (!existsSync(a)) { console.warn(`ASSERTION_FILE_MISSING: ${a} (skipped)`); continue; }
    const ar = psqlFile(dbName, readFileSync(a, "utf8"));
    if (ar.status !== 0) { console.error(`ASSERTION_FAIL: ${a}`); console.error(ar.stderr); process.exit(2); }
  }
  console.log(`[harness] ${dbName} install+assertions OK`);
}
async function main() {
  await withContainer(async () => { await installOn("s32_test_a"); await installOn("s32_test_b"); });
  console.log("SCHEMA_OK");
}
main().catch((e) => { console.error("SCHEMA_CHECK_FAIL", e instanceof Error ? e.message : String(e)); process.exit(1); });
