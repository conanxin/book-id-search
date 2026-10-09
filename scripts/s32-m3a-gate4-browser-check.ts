/**
 * Gate 4 Task 4 — isolated real PG16 and Chromium Dossier acceptance.
 *
 * Boots disposable PG16 + real API + real Vite Web, issues a synthetic owner
 * session cookie via the real issueWebSession (test-only secret), then runs the
 * Playwright browser suite against the live stack. Full teardown in finally. No production access.
 *
 * Usage: tsx scripts/s32-m3a-gate4-browser-check.ts
 * Requires: docker (loopback), free ports 3001/5173, and the pinned devDependency
 * @playwright/test 1.55.0 (pnpm install; lockfile-locked, dev-only, no runtime dep).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKER_HOST = "unix:///var/run/docker.sock";
const CONTAINER = `s32-m3a-gate4-browser-${process.pid}`;
const DB_NAME = "s32_m3a_gate3_browser";
const DB_USER = "s32browser";
const PASSWORD = randomBytes(18).toString("hex");
const SESSION_SECRET = randomBytes(48).toString("hex");
const OWNER_SUB = "gate4-browser-owner-sub";
const API_PORT = 3001;
const WEB_PORT = 5173;

let container: string | null = null; // set only after a successful docker run
let apiProc: ChildProcess | null = null;
let webProc: ChildProcess | null = null;

function docker(args: string[], input?: string): string {
  return execFileSync(
    "docker",
    ["--host", DOCKER_HOST, ...args],
    { encoding: "utf8", input, timeout: 120_000 },
  ).trim();
}

function log(line: string): void {
  process.stdout.write(`[gate4-browser] ${line}\n`);
}

async function waitFor(label: string, check: () => Promise<boolean>, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} not ready after ${attempts} attempts`);
}

async function main(): Promise<void> {
  // ---- 0. Port ownership: fail closed if ANY process is already listening on
  // our ports. A plain HTTP probe only sees successful roots; an unrelated
  // listener returning 404/401/500 would look "free". Probe the TCP layer
  // instead: a completed connect() means the port is owned — refuse without
  // touching that process.
  const net = await import("node:net");
  for (const port of [API_PORT, WEB_PORT]) {
    const owned = await new Promise<boolean>(resolveProbe => {
      const socket = new net.Socket();
      const done = (ownedPort: boolean) => { socket.destroy(); resolveProbe(ownedPort); };
      socket.setTimeout(1500);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
      socket.connect(port, "127.0.0.1");
    });
    if (owned) {
      throw new Error(`Port ${port} is already owned by an existing listener; refusing to start (fail closed, TCP probe).`);
    }
  }

  // ---- 1. Disposable loopback-only PG16.
  docker([
    "run", "--detach", "--rm",
    "--name", CONTAINER,
    "--label", `book-id-search.s32-m3a-gate4-browser=${CONTAINER}`,
    "--memory=512m",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=268435456",
    "-p", "127.0.0.1::5432",
    "-e", `POSTGRES_USER=${DB_USER}`,
    "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
    "-e", `POSTGRES_DB=${DB_NAME}`,
    "postgres:16-alpine",
  ]);
  container = CONTAINER;
  log(`PG16 container ${CONTAINER} started`);

  // Readiness = real TCP SQL SELECT 1 (pg_isready then real query).
  await waitFor("pg_isready", async () => {
    const r = spawnSync("docker", ["--host", DOCKER_HOST, "exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", DB_USER, "-d", DB_NAME], { encoding: "utf8", timeout: 8000 });
    return r.status === 0;
  });
  const one = docker(["exec", "-i", CONTAINER, "psql", "-X", "-h", "127.0.0.1", "-U", DB_USER, "-d", DB_NAME, "-Atc", "SELECT 1"]);
  if (one !== "1") throw new Error(`Real SQL readiness failed: ${JSON.stringify(one)}`);
  log("PG16 real TCP SELECT 1 = 1");

  const portOut = docker(["port", CONTAINER, "5432/tcp"]);
  const dbPort = portOut.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!dbPort) throw new Error(`Unexpected port mapping: ${portOut}`);
  const dbUrl = `postgresql://${DB_USER}:${PASSWORD}@127.0.0.1:${dbPort}/${DB_NAME}`;

  // ---- 2. Frozen migrations 001 then 002, then Gate2 + Gate3 fixtures.
  const { readS32MigrationChain } = await import("./s32-migration-chain.js");
  const migrationSqls = readS32MigrationChain(root);
  const migrationFiles = ["db/migrations/001_s32_core_schema.sql", "db/migrations/002_s32_m2e_issue_resolution.sql"];
  migrationSqls.forEach((sql, i) => {
    docker(["exec", "-i", CONTAINER, "psql", "-X", "-h", "127.0.0.1", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", "-f", "-"], sql);
    log(`migration applied: ${migrationFiles[i]}`);
  });
  for (const fixture of ["scripts/fixtures/s32-m3a-gate2-researchrun.sql", "scripts/fixtures/s32-m3a-gate3-browser.sql", "scripts/fixtures/s32-m3a-gate4-dossier.sql"]) {
    docker(["exec", "-i", CONTAINER, "psql", "-X", "-h", "127.0.0.1", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", "-f", "-"], readFileSync(resolve(root, fixture), "utf8"));
    log(`fixture applied: ${fixture}`);
  }

  // ---- 3. Real API (development wiring, loopback).
  apiProc = spawn("pnpm", ["--filter", "@book-id-search/api", "dev"], {
    cwd: root,
    env: {
      ...process.env,
      S32_FEATURES_ENABLED: "true",
      S32_DATABASE_URL: dbUrl,
      S32_PRIVATE_API_TOKEN: `gate3-${randomBytes(12).toString("hex")}`,
      GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "gate3-synthetic-client-id.apps.googleusercontent.com",
      BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: OWNER_SUB,
      BOOK_ID_SEARCH_SESSION_SECRET: SESSION_SECRET,
      BOOK_ID_SEARCH_PUBLIC_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
      NODE_ENV: "development",
      API_HOST: "127.0.0.1",
      API_PORT: String(API_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const apiLog = `/tmp/gate3-api-${process.pid}.log`;
  mkdirSync("/tmp", { recursive: true });
  apiProc.stdout?.on("data", d => appendFileSync(apiLog, d));
  apiProc.stderr?.on("data", d => appendFileSync(apiLog, d));
  log(`API spawning (log ${apiLog})`);

  // ---- 4. Real Vite web.
  webProc = spawn("pnpm", ["--filter", "@book-id-search/web", "dev"], {
    cwd: root,
    env: { ...process.env, VITE_S32_ENABLED: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const webLog = `/tmp/gate3-web-${process.pid}.log`;
  webProc.stdout?.on("data", d => appendFileSync(webLog, d));
  webProc.stderr?.on("data", d => appendFileSync(webLog, d));
  log(`Web spawning (log ${webLog})`);

  // Readiness probes against the real stack.
  await waitFor("API /api/auth/session", async () => {
    const r = spawnSync("curl", ["-fsS", `http://127.0.0.1:${API_PORT}/api/auth/session`, "-o", "/dev/null"], { encoding: "utf8", timeout: 4000 });
    return r.status !== null && r.status < 500;
  });
  await waitFor("Web 5173", async () => {
    const r = spawnSync("curl", ["-fsS", `http://127.0.0.1:${WEB_PORT}/research/projects`, "-o", "/dev/null"], { encoding: "utf8", timeout: 4000 });
    return r.status === 0;
  });
  log("API + Web ready");

  // ---- 5. Issue the synthetic owner session cookie with the real issueWebSession.
  const issueSession = resolve(root, "scripts/s32-m3a-gate3-browser-session.ts");
  const { token, csrf } = JSON.parse(execFileSync(resolve(root, "node_modules/.bin/tsx"), [issueSession, SESSION_SECRET, OWNER_SUB], { encoding: "utf8" }));
  log("Synthetic owner session issued (real issueWebSession, ephemeral secret)");

  // ---- 6. Run the real-browser Playwright suite.
  // A fixed, opt-in synthetic P1-A suite reuses the proven disposable PG16,
  // Owner cookie, real Web/API and teardown. Default Gate4 acceptance unchanged.
  const spec = resolve(root, process.env.S32_BROWSER_SUITE === "P1A"
    ? "scripts/s32-p1a-browser-acceptance.spec.ts"
    : "scripts/s32-m3a-gate4-browser-acceptance.spec.ts");
  const run = spawnSync(
    resolve(root, "node_modules/.bin/playwright"),
    ["test", spec, "--browser=chromium", "--workers=1", "--reporter=line"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 1_200_000,
      env: {
        ...process.env,
        GATE4_BROWSER_CONTAINER: CONTAINER,
        GATE4_BROWSER_DB_USER: DB_USER,
        GATE4_BROWSER_DB_NAME: DB_NAME,
        GATE4_BROWSER_SESSION_COOKIE: `book_id_search_session_dev=${token}`,
        GATE4_BROWSER_SESSION_CSRF: csrf,
        GATE4_BROWSER_API: `http://127.0.0.1:${API_PORT}`,
        GATE4_BROWSER_WEB: `http://127.0.0.1:${WEB_PORT}`,
        GATE4_BROWSER_WEB_PORT: String(WEB_PORT),
      },
    },
  );
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.status !== 0) throw new Error(`Playwright browser suite failed: exit ${run.status}`);
  log("Playwright browser suite PASS");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "gate3 browser orchestrator failed");
  process.exitCode = 1;
}).finally(async () => {
  // ---- Teardown: bounded, verified, fail-closed.
  let teardownOk = true;
  // 1. Stop our own detached process groups (API + Web) without touching
  //    unrelated services.
  const ownedPids: number[] = [];
  for (const proc of [apiProc, webProc]) {
    if (proc?.pid) {
      ownedPids.push(proc.pid);
      try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* already gone */ } }
    }
  }
  // 2. Bounded drain: wait until both process groups are gone (max 10s).
  const drained = await new Promise<boolean>(resolve => {
    const deadline = Date.now() + 10_000;
    const tick = () => {
      const alive = ownedPids.filter(pid => { try { process.kill(-pid, 0); return true; } catch { return false; } });
      if (alive.length === 0) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  });
  if (!drained) {
    // Escalate once to SIGKILL on our own groups only, then re-verify.
    for (const pid of ownedPids) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
    await new Promise(r => setTimeout(r, 500));
    const stillAlive = ownedPids.filter(pid => { try { process.kill(-pid, 0); return true; } catch { return false; } });
    if (stillAlive.length > 0) { teardownOk = false; log(`TEST_SERVERS_STOPPED=NO (pids ${stillAlive.join(",")})`); }
  }
  if (teardownOk) log("TEST_SERVERS_STOPPED=YES");
  // 3. Verify our API/Web ports are actually released (bounded).
  const net = await import("node:net");
  for (const port of [API_PORT, WEB_PORT]) {
    const stillOwned = await new Promise<boolean>(resolveProbe => {
      const socket = new net.Socket();
      const done = (ownedPort: boolean) => { socket.destroy(); resolveProbe(ownedPort); };
      socket.setTimeout(1500);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
      socket.connect(port, "127.0.0.1");
    });
    if (stillOwned) { teardownOk = false; log(`PORT_${port}_RELEASED=NO`); }
  }
  // 4. Remove the owned disposable PG container (label-verified), only if we
  //    actually started one.
  if (container) {
    try {
      const owner = docker(["inspect", "--format", `{{ index .Config.Labels "book-id-search.s32-m3a-gate4-browser" }}`, container]);
      if (owner !== container) throw new Error("ownership mismatch");
      docker(["rm", "--force", container]);
      log("DISPOSABLE_PG_REMOVED=YES");
    } catch {
      teardownOk = false;
      log("DISPOSABLE_PG_REMOVED=NO");
    }
  }
  if (!teardownOk) process.exitCode = 1;
});
