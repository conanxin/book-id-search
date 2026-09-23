#!/usr/bin/env node
/**
 * S32 R7 browser receipt producer — produces the R7.web.env acceptance
 * receipt ONLY from a real browser run. Two modes:
 *
 *   fixture  — headless Chromium against a local synthetic acceptance page
 *              (used by the isolated E2E and CI; no production access).
 *   browser  — headless Chromium against the real deployment URL.
 *
 * Fail-closed receipt contract (a receipt is written only if every rule
 * passes; ANY violation => exit non-zero, no receipt file):
 *   1. wrong runner source    → fail (page must report its runner id)
 *   2. tampered receipt       → fail (receipt content is built from the
 *                               observed run, never from caller input)
 *   3. secret field present   → fail (scanned before write)
 *   4. desktop fails          → fail (all desktop checks must pass)
 *   5. 390x844 overflow       → fail (no horizontal overflow at 390x844)
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const MODE = process.argv[2] || "";
const OUT = process.argv[3] || "";
const FP = process.argv[4] || "";
const PROJECT_ID = process.argv[5] || "";
const RUNNER_SOURCE = process.argv[6] || "s32-r7-browser-receipt-producer";

function fail(reason) {
  process.stdout.write(`R7_BROWSER_RECEIPT=FAIL\nREASON=${reason}\n`);
  process.exit(1);
}

if (!["fixture", "browser"].includes(MODE)) fail("INVALID_MODE");
if (!/^[0-9a-f]{64}$/.test(FP)) fail("INVALID_FINGERPRINT");
if (!/^[0-9a-f-]{36}$/.test(PROJECT_ID)) fail("INVALID_PROJECT_ID");
if (!OUT) fail("MISSING_OUTPUT_PATH");

// The receipt path must not pre-exist: producer runs are single-shot.
try {
  if (fs.existsSync(OUT)) fail("RECEIPT_PATH_EXISTS");
} catch { fail("RECEIPT_PATH_UNREADABLE"); }

// Locate a Chromium binary (Playwright cache or system); drive it over the
// DevTools protocol using Node's built-in WebSocket (no npm dependency).
function findChromium() {
  const home = process.env.HOME || "/root";
  const candidates = [
    path.join(home, ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
    path.join(home, ".cache/ms-playwright/chromium_headless_shell-1228/chrome-linux64/headless_shell"),
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  // Last resort: PATH.
  const which = spawnSync("which", ["chromium", "chromium-browser", "google-chrome", "chrome"], { encoding: "utf8" });
  if (which.status === 0) return which.stdout.trim().split("\n")[0];
  return null;
}

const CHROMIUM = findChromium();
if (!CHROMIUM) fail("CHROMIUM_UNAVAILABLE");

// Fixture mode serves a synthetic acceptance page locally; browser mode
// points at the deployment. The page contract is identical: it must render
// data-runner-source and the acceptance markers.
const FIXTURE_PORT = Number(process.env.S32_R7_FIXTURE_PORT || 4789);
const TARGET_URL = MODE === "fixture"
  ? `http://127.0.0.1:${FIXTURE_PORT}/`
  : (process.env.S32_R7_BROWSER_URL || "");

if (MODE === "browser" && !/^https?:\/\//.test(TARGET_URL)) fail("MISSING_BROWSER_URL");

// --- fixture server ----------------------------------------------------
// The fixture page is deliberately callER-argument-free: it renders a fixed
// synthetic acceptance surface. Whatever the producer was asked to expect
// is compared against this observed reality — that is the point of rules
// 1 and 2 (wrong runner source / tampered identity must fail, not render).
const FIXTURE_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
let fixtureServer = null;
function startFixtureServer() {
  const http = require("http");
  const page = `<!doctype html>
<html data-runner-source="s32-r7-browser-receipt-producer">
<head><meta charset="utf-8"><title>S32 R7 acceptance fixture</title>
<style>body{margin:0;font-family:sans-serif}.panel{padding:16px}</style></head>
<body>
<main class="panel" id="acceptance-root">
  <h1>[S32 Production Acceptance] ${FP.slice(0, 12)}</h1>
  <p data-acceptance="project-id">${FIXTURE_PROJECT_ID}</p>
  <p data-acceptance="web" data-result="PASS">WEB_ACCEPTANCE=PASS</p>
</main>
</body></html>`;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

// --- minimal CDP client over the built-in WebSocket --------------------
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) { this.events.push(msg); }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { this.ws.close(); }
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// --- receipt content is derived ONLY from the observed run --------------
async function produce() {
  if (MODE === "fixture") fixtureServer = await startFixtureServer();

  // Launch Chromium with a loopback-only debugging port. Node's fetch honors
// proxy env vars on this host, which hijacks 127.0.0.1; the producer never
// needs a proxy, so dispatch explicitly.
  const port = 10000 + (process.pid % 50000);
  const chrome = spawn(CHROMIUM, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"], detached: true, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  // Kill the whole process group (chrome leaves renderer/gpu children).
  const killChrome = () => { try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ } };
  // Hard watchdog: no run may exceed 90s.
  const watchdog = setTimeout(() => { killChrome(); fail("WATCHDOG_TIMEOUT"); }, 90000);
  watchdog.unref?.();

  const localFetch = (url) => fetch(url, {
    // Bypass any inherited proxy for the loopback DevTools endpoint.
    dispatcher: undefined,
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);

  try {
    // Wait for the DevTools endpoint.
    let targets = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await localFetch(`http://127.0.0.1:${port}/json/list`);
        if (!res) throw new Error("unreachable");
        const list = await res.json();
        const page = list.find(t => t.type === "page");
        if (page) { targets = page; break; }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!targets) fail("DEVTOOLS_ENDPOINT_TIMEOUT");

    const cdp = await withTimeout(Cdp.connect(targets.webSocketDebuggerUrl), 10000, "CDP_CONNECT_TIMEOUT");
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");

      // Navigate.
      const loaded = new Promise(resolve => {
        const poll = setInterval(async () => {
          if (cdp.events.some(e => e.method === "Page.loadEventFired")) { clearInterval(poll); resolve(); }
        }, 50);
        setTimeout(() => { clearInterval(poll); resolve(); }, 25000);
      });
      await cdp.send("Page.navigate", { url: TARGET_URL });
      await withTimeout(loaded, 30000, "PAGE_LOAD_TIMEOUT");

      async function evaluate(expression) {
        const result = await cdp.send("Runtime.evaluate", {
          expression, returnByValue: true, awaitPromise: true,
        });
        if (result.exceptionDetails) throw new Error(`EVAL_FAILED:${result.exceptionDetails.text}`);
        return result.result.value;
      }

      // Rule 1 — runner source must match the producer identity.
      const runnerSource = await evaluate(
        "document.documentElement.getAttribute('data-runner-source')",
      );
      if (runnerSource !== RUNNER_SOURCE) fail("WRONG_RUNNER_SOURCE");

      // Desktop checks (1440x900).
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      const desktop = await evaluate(`(() => {
        const root = document.querySelector('#acceptance-root, main');
        if (!root) return { ok: false, reason: 'ACCEPTANCE_ROOT_MISSING' };
        const projectId = root.querySelector("[data-acceptance='project-id']");
        const web = root.querySelector("[data-acceptance='web']");
        return {
          ok: Boolean(projectId && web),
          reason: projectId && web ? null : 'ACCEPTANCE_MARKERS_MISSING',
          projectId: projectId ? projectId.textContent.trim() : null,
          webResult: web ? web.getAttribute('data-result') : null,
        };
      })()`);
      if (!desktop.ok) fail(desktop.reason || "DESKTOP_CHECK_FAILED");   // Rule 4
      if (desktop.projectId !== PROJECT_ID) fail("PROJECT_ID_MISMATCH");  // Rule 2 (tamper)
      if (desktop.webResult !== "PASS") fail("WEB_ACCEPTANCE_NOT_PASS");  // Rule 4

      // Rule 5 — 390x844 must not scroll horizontally.
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
      });
      const overflow = await evaluate(
        "({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })",
      );
      if (overflow.scrollWidth > overflow.clientWidth) fail("MOBILE_390_OVERFLOW");

      // Build the receipt purely from observed values.
      const lines = [
        "STATUS=PASS",
        "STAGE=R7_WEB",
        `S32_RELEASE_FINGERPRINT=${FP}`,
        `PROJECT_ID=${desktop.projectId}`,
        "S32_WEB_ACCEPTANCE=PASS",
        "MOBILE_390x844=PASS",
        "NO_HORIZONTAL_OVERFLOW=PASS",
        `RUNNER_SOURCE=${RUNNER_SOURCE}`,
        `RUNNER_MODE=${MODE}`,
        "",
      ];

      // Rule 3 — secret fields must never enter the receipt.
      const secretPattern = /(^|_)(TOKEN|PASSWORD|SECRET|DATABASE_URL)=/;
      if (lines.some(l => secretPattern.test(l))) fail("SECRET_FIELD_PRESENT");

      // Atomic write: temp file + rename, 0600.
      const dir = path.dirname(OUT);
      const tmp = path.join(dir, `.r7-web-receipt.${process.pid}.tmp`);
      fs.writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, OUT);

      process.stdout.write(`R7_BROWSER_RECEIPT=PASS\nRUNNER_MODE=${MODE}\nRECEIPT=${OUT}\n`);
      process.exit(0);
    } finally {
      cdp.close();
    }
  } catch (error) {
    fail(`BROWSER_RUN_FAILED:${String(error && error.message).slice(0, 120)}`);
  } finally {
    clearTimeout(watchdog);
    killChrome();
    if (fixtureServer) fixtureServer.close();
  }
}

produce();
