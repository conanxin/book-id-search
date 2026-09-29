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

function scalar(db: string, sql: string): string {
  return docker([
    "exec", container, "psql", "-X", "-A", "-t", "-U", "s32test", "-d", db,
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ]).trim();
}

try {
  const name = `s32-m2e-test-${process.pid}-${Date.now()}`;
  const password = randomBytes(18).toString("hex");
  container = name;

  docker([
    "run", "--detach", "--rm", "--name", name,
    "--label", `book-id-search.s32-m2e-run=${name}`,
    "--memory=512m",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=268435456",
    "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=s32test",
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_DB=s32_m2e_test",
    "postgres:16-alpine",
  ]);

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "s32test", "-d", "s32_m2e_test"]);
      ready = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");

  const migrations = readS32MigrationChain(root);
  if (migrations.length !== 2) throw new Error("Expected reviewed 001 -> 002 migration chain");
  const fixture = readFileSync(resolve(root, "scripts/fixtures/s32-m2e-browser.sql"), "utf8");

  // Fresh 001 -> 002 install used by the store integration suite.
  psql("s32_m2e_test", migrations.join("\n"));
  psql("s32_m2e_test", fixture);

  // Valid upgrade: representative pre-002 Project/Issue/Claim/Resolution survives.
  docker(["exec", container, "createdb", "-U", "s32test", "s32_m2e_upgrade_valid"]);
  psql("s32_m2e_upgrade_valid", migrations[0]);
  psql("s32_m2e_upgrade_valid", fixture);
  psql("s32_m2e_upgrade_valid", `
    INSERT INTO core.issue_resolutions
      (id,issue_id,resolution_type,preferred_claim_id,rationale)
    VALUES (
      '71111111-1111-4111-8111-111111111111',
      '21111111-1111-4111-8111-111111111111',
      'PREFERRED_CLAIM',
      '31111111-1111-4111-8111-111111111111',
      'valid legacy resolution'
    );
    UPDATE core.research_issues
      SET current_resolution_id='71111111-1111-4111-8111-111111111111'
      WHERE id='21111111-1111-4111-8111-111111111111';
  `);
  const beforeValid = scalar("s32_m2e_upgrade_valid", "SELECT count(*) FROM core.issue_resolutions");
  psql("s32_m2e_upgrade_valid", migrations[1]);
  const afterValid = scalar("s32_m2e_upgrade_valid", "SELECT count(*) FROM core.issue_resolutions");
  const validPointer = scalar(
    "s32_m2e_upgrade_valid",
    "SELECT current_resolution_id::text FROM core.research_issues WHERE id='21111111-1111-4111-8111-111111111111'",
  );
  if (beforeValid !== "1" || afterValid !== "1" || validPointer !== "71111111-1111-4111-8111-111111111111") {
    throw new Error("Valid 001 -> 002 upgrade did not preserve representative rows");
  }
  console.log("S32_M2E_VALID_UPGRADE=PASS");

  // Invalid upgrade: cross-Issue preferred Claim is legal in 001 but 002 must fail closed.
  docker(["exec", container, "createdb", "-U", "s32test", "s32_m2e_upgrade_invalid"]);
  psql("s32_m2e_upgrade_invalid", migrations[0]);
  psql("s32_m2e_upgrade_invalid", fixture);
  psql("s32_m2e_upgrade_invalid", `
    INSERT INTO core.issue_resolutions
      (id,issue_id,resolution_type,preferred_claim_id,rationale)
    VALUES (
      '72111111-1111-4111-8111-111111111111',
      '21111111-1111-4111-8111-111111111111',
      'PREFERRED_CLAIM',
      '32111111-1111-4111-8111-111111111111',
      'invalid legacy cross-issue preferred claim'
    );
  `);
  const invalid = dockerRaw(
    ["exec", "-i", container, "psql", "-X", "-U", "s32test", "-d", "s32_m2e_upgrade_invalid", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    migrations[1],
  );
  const invalidOutput = `${invalid.stdout}\n${invalid.stderr}`;
  if (invalid.status === 0 || !invalidOutput.includes("S32_M2E_LEGACY_PREFERRED_CLAIM_NOT_MEMBER")) {
    throw new Error("Invalid 001 -> 002 upgrade did not fail closed at the legacy preflight");
  }
  const invalidConstraint = scalar(
    "s32_m2e_upgrade_invalid",
    "SELECT count(*) FROM pg_constraint WHERE conname='fk_ir_preferred_claim_same_issue'",
  );
  const invalidTrigger = scalar(
    "s32_m2e_upgrade_invalid",
    "SELECT count(*) FROM pg_trigger WHERE tgname='trg_issue_resolutions_no_update' AND NOT tgisinternal",
  );
  if (invalidConstraint !== "0" || invalidTrigger !== "0") {
    throw new Error("Failed 002 migration left partial DDL behind");
  }
  console.log("S32_M2E_INVALID_UPGRADE_FAIL_CLOSED=PASS");

  const port = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Expected a loopback-only disposable database port");

  const result = spawnSync(
    resolve(root, "node_modules/.bin/vitest"),
    ["run", "--maxWorkers=1", "apps/api/src/s32/postgres/issue-resolution-store.integration.test.ts"],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 300_000,
      env: {
        ...process.env,
        S32_M2E_TEST_DATABASE_URL: `postgresql://s32test:${password}@127.0.0.1:${port}/s32_m2e_test`,
      },
    },
  );
  if (result.status !== 0) throw new Error(`Integration tests failed: ${result.status}`);
  console.log("S32_M2E_REAL_PG=PASS");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Integration runner failed");
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      const owner = docker([
        "inspect", "--format", '{{ index .Config.Labels "book-id-search.s32-m2e-run" }}', container,
      ]);
      if (owner !== container) throw new Error("Test container ownership mismatch");
      docker(["rm", "--force", container]);
      console.log("DISPOSABLE_TEST_CONTAINER_REMOVED=YES");
    } catch {
      console.error("DISPOSABLE_TEST_CONTAINER_REMOVED=NO");
      process.exitCode = 1;
    }
  }
}
