import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "postgres:16-alpine";
let containerId = "";
let cleanupError: string | null = null;

function run(
  command: string,
  args: string[],
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.input !== undefined
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"],
    ...options,
  });
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function docker(args: string[], options: Partial<SpawnSyncOptionsWithStringEncoding> = {}) {
  return run("sudo", ["-n", "docker", ...args], options);
}

function requireOk(label: string, result: ReturnType<typeof run>) {
  if (result.status !== 0) {
    throw new Error(`${label}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result;
}

function cleanup() {
  if (!containerId) return;
  const result = docker(["rm", "-f", containerId]);
  if (result.status === 0 || /No such container|not found/i.test(result.stderr)) {
    console.log("TEST_CONTAINER_REMOVED=YES");
    containerId = "";
    return;
  }
  cleanupError = result.stderr || `docker rm exited ${result.status}`;
  console.error("TEST_CONTAINER_REMOVED=NO", cleanupError);
}

async function main() {
  const image = docker(["image", "inspect", IMAGE]);
  if (image.status !== 0) {
    throw new Error("PG16_IMAGE_MISSING: postgres:16-alpine must already be present");
  }

  const name = `s32-m1a-${process.pid}-${Date.now()}`;
  const up = requireOk("docker run", docker([
    "run", "-d", "--rm",
    "--name", name,
    "--memory=1g",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=536870912",
    "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=s32test",
    "-e", "POSTGRES_PASSWORD=s32testpw",
    "-e", "POSTGRES_DB=postgres",
    IMAGE,
  ]));
  containerId = up.stdout;

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const check = docker([
      "exec", containerId,
      "pg_isready", "-h", "127.0.0.1", "-U", "s32test", "-d", "postgres",
    ]);
    if (check.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!ready) throw new Error("PG_READY=NO");
  console.log("PG_READY=YES");

  const migration = readFileSync(resolve(ROOT, "db/migrations/001_s32_core_schema.sql"), "utf8");
  const applied = docker(
    [
      "exec", "-i", containerId,
      "psql", "-X", "-U", "s32test", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-f", "-",
    ],
    { input: migration },
  );
  requireOk("migration", applied);

  const schemaReady = requireOk(
    "schema readiness",
    docker([
      "exec", containerId,
      "psql", "-X", "-U", "s32test", "-d", "postgres",
      "-Atc", "SELECT to_regclass('core.external_identities')::text",
    ]),
  );
  if (schemaReady.stdout !== "core.external_identities") {
    throw new Error(`M1A_SCHEMA_READY=NO: ${schemaReady.stdout || "missing"}`);
  }
  console.log("M1A_SCHEMA_READY=YES");

  const portResult = requireOk(
    "docker port",
    docker(["port", containerId, "5432/tcp"]),
  );
  const match = portResult.stdout.match(/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`PG_PORT_UNRESOLVED: ${portResult.stdout}`);
  const port = match[1];
  const databaseUrl = `postgresql://s32test:s32testpw@127.0.0.1:${port}/postgres`;

  const vitest = resolve(ROOT, "node_modules/.bin/vitest");
  const tests = spawnSync(
    vitest,
    ["run", "apps/api/src/s32/postgres/catalog-promotion-store.integration.test.ts"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, S32_TEST_DATABASE_URL: databaseUrl },
    },
  );
  if (tests.stdout) process.stdout.write(tests.stdout);
  if (tests.stderr) process.stderr.write(tests.stderr);
  if ((tests.status ?? -1) !== 0) {
    throw new Error(`M1A_INTEGRATION_TEST_FAILED: exit ${tests.status ?? -1}`);
  }

  console.log("M1A_INTEGRATION_OK");
}

main()
  .catch((error) => {
    console.error("M1A_INTEGRATION_FAIL", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    if (cleanupError) process.exitCode = 2;
  });
