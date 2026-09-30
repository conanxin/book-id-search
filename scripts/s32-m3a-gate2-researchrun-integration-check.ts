import { readS32MigrationChain } from "./s32-migration-chain.js";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let container = "";

function dockerRaw(args: string[], input?: string) {
  return spawnSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    input,
  });
}

function docker(args: string[], input?: string) {
  const result = dockerRaw(args, input);
  if (result.status !== 0) {
    throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout.trim();
}

function psql(db: string, sql: string) {
  return docker(
    ["exec", "-i", container, "psql", "-X", "-U", "s32test", "-d", db, "-v", "ON_ERROR_STOP=1", "-f", "-"],
    sql,
  );
}

try {
  const name = `s32-gate2-run-test-${process.pid}-${Date.now()}`;
  const password = randomBytes(18).toString("hex");
  container = name;

  docker([
    "run", "--detach", "--rm", "--name", name,
    "--label", `book-id-search.s32-gate2-run=${name}`,
    "--memory=512m",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=268435456",
    "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=s32test",
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_DB=s32_m3a_gate2_test",
    "postgres:16-alpine",
  ]);
  console.log(`GATE2_PG16_CONTAINER=${name}`);

  // Readiness: real TCP SQL probe (SELECT 1), never the flaky socket-only pg_isready window.
  // psql inside the container with -h 127.0.0.1 forces a TCP round-trip.
  const portRaw = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!portRaw) throw new Error("Expected a loopback-only disposable database port");
  const port = Number(portRaw);
  let ready = false;
  for (let i = 0; i < 90; i += 1) {
    const probe = dockerRaw([
      "exec", container, "psql", "-X", "-h", "127.0.0.1", "-U", "s32test", "-d", "s32_m3a_gate2_test",
      "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1",
    ], undefined);
    if (probe.status === 0) { ready = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not accept a real TCP SELECT 1");
  console.log("GATE2_PG16_TCP_SQL_READY=YES");

  const migrations = readS32MigrationChain(root);
  if (migrations.length !== 2) throw new Error("Expected frozen 001 -> 002 migration chain");
  psql("s32_m3a_gate2_test", migrations.join("\n"));
  console.log("GATE2_SCHEMA_001_002=PASS");
  const fixture = readFileSync(resolve(root, "scripts/fixtures/s32-m3a-gate2-researchrun.sql"), "utf8");
  psql("s32_m3a_gate2_test", fixture);
  console.log("GATE2_FIXTURE=PASS");

  const result = spawnSync(
    resolve(root, "node_modules/.bin/vitest"),
    ["run", "--maxWorkers=1", "apps/api/src/s32/postgres/research-run-store.integration.test.ts"],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 300_000,
      env: {
        ...process.env,
        S32_M3A_GATE2_TEST_DATABASE_URL: `postgresql://s32test:${password}@127.0.0.1:${port}/s32_m3a_gate2_test`,
      },
    },
  );
  if (result.status !== 0) throw new Error(`Integration tests failed: ${result.status}`);
  console.log("GATE2_REAL_PG_WHOLE_BACKEND=PASS");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Integration runner failed");
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      const owner = docker([
        "inspect", "--format", '{{ index .Config.Labels "book-id-search.s32-gate2-run" }}', container,
      ]);
      if (owner !== container) throw new Error("Test container ownership mismatch");
      docker(["rm", "--force", container]);
      console.log("DISPOSABLE_PG_REMOVED=YES");
    } catch {
      console.error("DISPOSABLE_PG_REMOVED=NO");
      process.exitCode = 1;
    }
  }
}
