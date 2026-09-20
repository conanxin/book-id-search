import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let container = "";
function docker(args: string[], input?: string) {
  const result = spawnSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
    encoding: "utf8", timeout: 60_000, input,
  });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}
try {
  const name = `s32-m1d-test-${process.pid}-${Date.now()}`;
  const password = randomBytes(18).toString("hex");
  // Keep the unique name before docker run: a timed-out client may still create a container.
  container = name;
  docker(["run", "--detach", "--rm", "--name", name,
    "--label", `book-id-search.s32-m1d-run=${name}`, "--memory=512m",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=268435456", "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=s32test", "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_DB=s32_m1d_test", "postgres:16-alpine"]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "s32test", "-d", "s32_m1d_test"]); ready = true; break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  docker(["exec", "-i", container, "psql", "-X", "-U", "s32test", "-d", "s32_m1d_test", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    readFileSync(resolve(root, "db/migrations/001_s32_core_schema.sql"), "utf8"));
  const port = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Expected a loopback-only disposable database port");
  const result = spawnSync(resolve(root, "node_modules/.bin/vitest"), ["run", "--maxWorkers=1", "apps/api/src/s32/postgres/project-item-note-store.integration.test.ts"], {
    cwd: root, stdio: "inherit", timeout: 300_000,
    env: { ...process.env, S32_M1D_TEST_DATABASE_URL: `postgresql://s32test:${password}@127.0.0.1:${port}/s32_m1d_test` },
  });
  if (result.status !== 0) throw new Error(`Integration tests failed: ${result.status}`);
  console.log("S32_M1D_REAL_PG=PASS");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Integration runner failed");
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      const owner = docker(["inspect", "--format", '{{ index .Config.Labels "book-id-search.s32-m1d-run" }}', container]);
      if (owner !== container) throw new Error("Test container ownership mismatch");
      docker(["rm", "--force", container]);
      console.log("DISPOSABLE_TEST_CONTAINER_REMOVED=YES");
    }
    catch { console.error("DISPOSABLE_TEST_CONTAINER_REMOVED=NO"); process.exitCode = 1; }
  }
}
