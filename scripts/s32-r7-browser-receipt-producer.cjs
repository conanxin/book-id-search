#!/usr/bin/env node
/**
 * S32 R7 browser receipt producer.
 *
 * fixture mode validates the producer/receipt mechanics against a synthetic
 * local page. browser mode validates the real frozen production Web surface:
 * token -> sessionStorage -> project list -> exact retained acceptance project
 * -> project detail -> mobile overflow.
 *
 * The browser token is process-memory/sessionStorage only. It is never written
 * to the receipt.
 */

"use strict";

const fs = require("fs");
const { createHash } = require("crypto");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const MODE = process.argv[2] || "";
const OUT = process.argv[3] || "";
const FP = process.argv[4] || "";
const PROJECT_ID = process.argv[5] || "";
const RUNNER_SOURCE_SHA = process.argv[6] || process.env.S32_R7_RUNNER_SOURCE_SHA || "";
const RUNNER_ID = "s32-r7-browser-receipt-producer";
const RUNNER_VERSION = "1";
const TOKEN_KEY = "book-id-search:s32-private-token:v1";
const PROJECT_NAME = `[S32 Production Acceptance] ${FP.slice(0, 12)}`;
const BROWSER_TOKEN = (process.env.S32_R7_BROWSER_TOKEN || "").trim();

function fail(reason) {
  process.stdout.write(`R7_BROWSER_RECEIPT=FAIL\nREASON=${reason}\n`);
  process.exit(1);
}

class RuntimeFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function runtimeFail(reason) {
  throw new RuntimeFailure(reason);
}

if (!["fixture", "browser"].includes(MODE)) fail("INVALID_MODE");
if (!/^[0-9a-f]{64}$/.test(FP)) fail("INVALID_FINGERPRINT");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(PROJECT_ID)) fail("INVALID_PROJECT_ID");
if (!/^[0-9a-f]{40}$/.test(RUNNER_SOURCE_SHA)) fail("INVALID_RUNNER_SOURCE_SHA");
if (!OUT) fail("MISSING_OUTPUT_PATH");

try {
  if (fs.existsSync(OUT)) fail("RECEIPT_PATH_EXISTS");
} catch {
  fail("RECEIPT_PATH_UNREADABLE");
}

function findChromium() {
  const override = (process.env.S32_R7_CHROMIUM || "").trim();
  if (override) {
    try {
      fs.accessSync(override, fs.constants.X_OK);
      return override;
    } catch {
      return null;
    }
  }

  const home = process.env.HOME || "/root";
  const cacheRoot = path.join(home, ".cache/ms-playwright");
  const candidates = [];
  try {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^chromium/.test(entry.name)) continue;
      const base = path.join(cacheRoot, entry.name);
      candidates.push(
        path.join(base, "chrome-linux64/chrome"),
        path.join(base, "chrome-linux/chrome"),
        path.join(base, "chrome-headless-shell-linux64/chrome-headless-shell"),
        path.join(base, "chrome-linux64/headless_shell"),
      );
    }
  } catch {
    // no Playwright cache
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }

  const which = spawnSync(
    "sh",
    ["-lc", "command -v chromium || command -v chromium-browser || command -v google-chrome || command -v chrome"],
    { encoding: "utf8" },
  );
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim().split("\n")[0];
  }
  return null;
}

const FIXTURE_PORT = Number(process.env.S32_R7_FIXTURE_PORT || 4789);
const TARGET_URL = MODE === "fixture"
  ? `http://127.0.0.1:${FIXTURE_PORT}/`
  : (process.env.S32_R7_BROWSER_URL || "");

let BROWSER_TARGET = null;
if (MODE === "browser") {
  if (!BROWSER_TOKEN) fail("MISSING_BROWSER_TOKEN");
  try {
    BROWSER_TARGET = new URL(TARGET_URL);
  } catch {
    fail("MISSING_BROWSER_URL");
  }
  const normalizedPath = BROWSER_TARGET.pathname.replace(/\/+$/, "");
  if (normalizedPath !== "/research/projects") fail("BROWSER_URL_NOT_PROJECT_LIST");
  const loopback = BROWSER_TARGET.hostname === "127.0.0.1" || BROWSER_TARGET.hostname === "localhost";
  if (!loopback) {
    if (BROWSER_TARGET.protocol !== "https:" || BROWSER_TARGET.origin !== "https://books.conanxin.com") {
      fail("BROWSER_URL_UNTRUSTED_ORIGIN");
    }
  }
}

const CHROMIUM = findChromium();
if (!CHROMIUM) fail("CHROMIUM_UNAVAILABLE");

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
      res.writeHead(404);
      res.end();
    });
    server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
    const rejectPending = (reason) => {
      for (const { reject } of this.pending.values()) reject(new Error(reason));
      this.pending.clear();
    };
    ws.addEventListener("close", () => rejectPending("CDP_SOCKET_CLOSED"));
    ws.addEventListener("error", () => rejectPending("CDP_SOCKET_ERROR"));
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

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function produce() {
  if (MODE === "fixture") fixtureServer = await startFixtureServer();

  const port = 10000 + (process.pid % 50000);
  const chromeProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "s32-r7-chrome-profile-"));
  const chromeEnv = {
    ...process.env,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  delete chromeEnv.S32_R7_BROWSER_TOKEN;
  let chrome = null;
  let spawnError = null;

  function chromePgid() {
    return chrome && Number.isInteger(chrome.pid) ? chrome.pid : null;
  }

  function signalChromeGroup() {
    const pgid = chromePgid();
    if (pgid === null) return;
    try {
      process.kill(-pgid, "SIGKILL");
      return;
    } catch (error) {
      if (error && error.code === "ESRCH") return;
      throw error;
    }
  }

  function chromeGroupHasLiveMembers() {
    const pgid = chromePgid();
    if (pgid === null) return false;

    let entries;
    try {
      entries = fs.readdirSync("/proc", { withFileTypes: true });
    } catch (error) {
      throw new Error(`PROC_SCAN_FAILED:${error && error.code ? error.code : "UNKNOWN"}`);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
      const statPath = `/proc/${entry.name}/stat`;
      let raw;
      try {
        raw = fs.readFileSync(statPath, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw new Error(`PROC_STAT_FAILED:${error && error.code ? error.code : "UNKNOWN"}`);
      }

      const closeParen = raw.lastIndexOf(")");
      if (closeParen < 0) throw new Error("PROC_STAT_PARSE_FAILED");
      const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
      if (fields.length < 3) throw new Error("PROC_STAT_PARSE_FAILED");
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === pgid && state !== "Z" && state !== "X") return true;
    }
    return false;
  }

  async function terminateChromeGroup() {
    signalChromeGroup();
    for (let i = 0; i < 100; i += 1) {
      if (!chromeGroupHasLiveMembers()) return;
      await sleep(50);
      signalChromeGroup();
    }
    throw new Error("CHROMIUM_PROCESS_GROUP_TIMEOUT");
  }

  let watchdogTriggered = false;
  let terminationSignal = null;
  let resolveTerminationSignal;
  const terminationSignalPromise = new Promise((resolve) => {
    resolveTerminationSignal = resolve;
  });
  let deferredFailure = null;
  let cleanupFailure = null;
  let pendingReceiptPath = null;

  const requestTermination = (signal) => {
    if (terminationSignal) return;
    terminationSignal = signal;
    resolveTerminationSignal(signal);
    try {
      signalChromeGroup();
    } catch {
      // Final teardown performs the authoritative fail-closed check.
    }
  };
  const onSigint = () => requestTermination("SIGINT");
  const onSigterm = () => requestTermination("SIGTERM");
  // Repeated signals must not restore Node's immediate-exit default while
  // process/profile or pending-receipt cleanup is still in progress.
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const abortOnTermination = async (promise) => Promise.race([
    promise,
    terminationSignalPromise.then((signal) => {
      throw new RuntimeFailure(`TERMINATED_BY_${signal}`);
    }),
  ]);

  const checkTermination = () => {
    if (terminationSignal) runtimeFail(`TERMINATED_BY_${terminationSignal}`);
  };
  const watchdog = setTimeout(() => {
    watchdogTriggered = true;
    try {
      signalChromeGroup();
    } catch {
      // Final teardown performs the authoritative fail-closed check.
    }
  }, 90000);
  watchdog.unref?.();

  const localFetch = (url) => fetch(url, {
    dispatcher: undefined,
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);

  try {
    try {
      chrome = spawn(CHROMIUM, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${chromeProfileDir}`,
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        "about:blank",
      ], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
        env: chromeEnv,
      });
      chrome.on("error", (error) => {
        spawnError = error;
      });
    } catch (error) {
      spawnError = error;
    }

    let target = null;
    for (let i = 0; i < 60; i += 1) {
      checkTermination();
      if (spawnError) {
        runtimeFail(`CHROMIUM_SPAWN_FAILED:${spawnError.code || "UNKNOWN"}`);
      }
      try {
        const response = await abortOnTermination(localFetch(`http://127.0.0.1:${port}/json/list`));
        if (!response) throw new Error("unreachable");
        const list = await response.json();
        const page = list.find((entry) => entry.type === "page");
        if (page) {
          target = page;
          break;
        }
      } catch {
        // retry
      }
      await abortOnTermination(sleep(250));
    }
    checkTermination();
    if (spawnError) {
      runtimeFail(`CHROMIUM_SPAWN_FAILED:${spawnError.code || "UNKNOWN"}`);
    }
    if (!target) runtimeFail("DEVTOOLS_ENDPOINT_TIMEOUT");

    const cdp = await abortOnTermination(withTimeout(
      Cdp.connect(target.webSocketDebuggerUrl),
      10000,
      "CDP_CONNECT_TIMEOUT",
    ));

    try {
      await abortOnTermination(cdp.send("Page.enable"));
      await abortOnTermination(cdp.send("Runtime.enable"));

      async function evaluate(expression) {
        const result = await abortOnTermination(cdp.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }));
        if (result.exceptionDetails) {
          throw new Error(`EVAL_FAILED:${result.exceptionDetails.text}`);
        }
        return result.result.value;
      }

      async function navigate(url) {
        const before = cdp.events.filter((event) => event.method === "Page.loadEventFired").length;
        await abortOnTermination(cdp.send("Page.navigate", { url }));
        for (let i = 0; i < 120; i += 1) {
          checkTermination();
          const count = cdp.events.filter((event) => event.method === "Page.loadEventFired").length;
          if (count > before) {
            const ready = await evaluate("document.readyState");
            if (ready === "complete" || ready === "interactive") return;
          }
          await abortOnTermination(sleep(250));
        }
        throw new Error("PAGE_LOAD_TIMEOUT");
      }

      async function reload() {
        const before = cdp.events.filter((event) => event.method === "Page.loadEventFired").length;
        await abortOnTermination(cdp.send("Page.reload", { ignoreCache: true }));
        for (let i = 0; i < 120; i += 1) {
          checkTermination();
          const count = cdp.events.filter((event) => event.method === "Page.loadEventFired").length;
          if (count > before) {
            const ready = await evaluate("document.readyState");
            if (ready === "complete" || ready === "interactive") return;
          }
          await abortOnTermination(sleep(250));
        }
        throw new Error("PAGE_RELOAD_TIMEOUT");
      }

      async function waitForState(expression, label) {
        let last = null;
        for (let i = 0; i < 100; i += 1) {
          checkTermination();
          last = await evaluate(expression);
          if (last && last.ready === true) return last;
          await abortOnTermination(sleep(250));
        }
        throw new Error(`${label}:${JSON.stringify(last)}`);
      }

      await abortOnTermination(cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      }));
      await navigate(TARGET_URL);

      let observedProjectId = null;

      if (MODE === "fixture") {
        const runnerSource = await evaluate(
          "document.documentElement.getAttribute('data-runner-source')",
        );
        if (runnerSource !== RUNNER_ID) runtimeFail("WRONG_RUNNER_SOURCE");

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
        if (!desktop.ok) runtimeFail(desktop.reason || "DESKTOP_CHECK_FAILED");
        if (desktop.projectId !== PROJECT_ID) runtimeFail("PROJECT_ID_MISMATCH");
        if (desktop.webResult !== "PASS") runtimeFail("WEB_ACCEPTANCE_NOT_PASS");
        observedProjectId = desktop.projectId;
      } else {
        const target = BROWSER_TARGET;
        if (!target) runtimeFail("MISSING_BROWSER_URL");

        await evaluate(
          `sessionStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(BROWSER_TOKEN)}); true`,
        );
        await reload();

        const projectPath = `/research/projects/${encodeURIComponent(PROJECT_ID)}`;
        const listExpression = `(() => {
          const heading = Array.from(document.querySelectorAll("h1"))
            .find((node) => node.textContent.trim() === "\u6211\u7684\u7814\u7a76\u9879\u76ee");
          const expectedName = ${JSON.stringify(PROJECT_NAME)};
          const expectedPath = ${JSON.stringify(projectPath)};
          const link = Array.from(document.querySelectorAll("a[href]")).find((node) => {
            try {
              return new URL(node.href, location.href).pathname === expectedPath
                && node.textContent.includes(expectedName);
            } catch {
              return false;
            }
          });
          return {
            ready: Boolean(heading && link),
            heading: heading ? heading.textContent.trim() : null,
            projectFound: Boolean(link),
          };
        })()`;
        await waitForState(listExpression, "PROJECT_LIST_TIMEOUT");

        const detailUrl = new URL(projectPath, target.origin).href;
        await navigate(detailUrl);
        const detailExpression = `(() => {
          const expectedName = ${JSON.stringify(PROJECT_NAME)};
          const h1 = Array.from(document.querySelectorAll("h1"))
            .find((node) => node.textContent.trim() === expectedName);
          const detail = document.querySelector(".research-detail, .research-panel");
          return {
            ready: Boolean(h1 && detail),
            h1: h1 ? h1.textContent.trim() : null,
            detail: Boolean(detail),
          };
        })()`;
        await waitForState(detailExpression, "PROJECT_DETAIL_TIMEOUT");
        observedProjectId = PROJECT_ID;
      }

      await abortOnTermination(cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      }));
      await abortOnTermination(sleep(250));
      const overflow = await evaluate(
        "({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })",
      );
      if (overflow.scrollWidth > overflow.clientWidth) runtimeFail("MOBILE_390_OVERFLOW");

      const baseLines = [
        "STATUS=PASS",
        "STAGE=R7_WEB",
        `S32_RELEASE_FINGERPRINT=${FP}`,
        `PROJECT_ID=${observedProjectId}`,
        "S32_WEB_ACCEPTANCE=PASS",
        "MOBILE_390x844=PASS",
        "NO_HORIZONTAL_OVERFLOW=PASS",
        `RUNNER_VERSION=${RUNNER_VERSION}`,
        `RUNNER_SOURCE_SHA=${RUNNER_SOURCE_SHA}`,
        `RUNNER_ID=${RUNNER_ID}`,
        `RUNNER_MODE=${MODE}`,
      ];

      const secretPattern = /(^|_)(TOKEN|PASSWORD|SECRET|DATABASE_URL)=/;
      if (baseLines.some((line) => secretPattern.test(line))) {
        runtimeFail("SECRET_FIELD_PRESENT");
      }

      const baseBody = baseLines.join("\n") + "\n";
      const receiptHash = createHash("sha256").update(baseBody, "utf8").digest("hex");
      const receipt = baseBody + `RECEIPT_SHA256=${receiptHash}\n`;
      if (MODE === "browser" && receipt.includes(BROWSER_TOKEN)) {
        runtimeFail("SECRET_VALUE_PRESENT");
      }

      const dir = path.dirname(OUT);
      pendingReceiptPath = path.join(dir, `.r7-web-receipt.${process.pid}.tmp`);
      fs.writeFileSync(pendingReceiptPath, receipt, { mode: 0o600, flag: "wx" });
      fs.chmodSync(pendingReceiptPath, 0o600);
    } finally {
      cdp.close();
    }
  } catch (error) {
    if (error instanceof RuntimeFailure) {
      deferredFailure = error.reason;
    } else {
      deferredFailure = `BROWSER_RUN_FAILED:${String(error && error.message).slice(0, 160)}`;
    }
  } finally {
    clearTimeout(watchdog);
    try {
      await terminateChromeGroup();
    } catch {
      cleanupFailure = "CHROMIUM_PROCESS_GROUP_TIMEOUT";
    }
    try {
      fs.rmSync(chromeProfileDir, { recursive: true, force: true });
      if (fs.existsSync(chromeProfileDir)) {
        cleanupFailure = cleanupFailure || "CHROME_PROFILE_CLEANUP_FAILED";
      }
    } catch {
      cleanupFailure = cleanupFailure || "CHROME_PROFILE_CLEANUP_FAILED";
    }
    if (fixtureServer) fixtureServer.close();
  }

  // A signal received during synchronous profile deletion is queued by Node.
  // Cross a poll phase before deciding whether canonical evidence may commit;
  // a single immediate can run in the current check phase before signal I/O.
  // Keep both handlers installed until that queued work has been dispatched.
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  if (terminationSignal) deferredFailure = `TERMINATED_BY_${terminationSignal}`;
  if (watchdogTriggered) deferredFailure = "WATCHDOG_TIMEOUT";
  if (cleanupFailure) deferredFailure = cleanupFailure;

  if (deferredFailure) {
    try {
      if (pendingReceiptPath) fs.rmSync(pendingReceiptPath, { force: true });
    } catch {
      // Temporary receipt cleanup is best-effort after a terminal failure.
    }
    fail(deferredFailure);
  }

  if (!pendingReceiptPath || !fs.existsSync(pendingReceiptPath)) {
    fail("RECEIPT_TEMP_MISSING");
  }
  try {
    fs.linkSync(pendingReceiptPath, OUT);
  } catch {
    try {
      fs.rmSync(pendingReceiptPath, { force: true });
    } catch {
      // Publication already failed; preserve the primary error.
    }
    fail("RECEIPT_PUBLISH_FAILED");
  }
  try {
    fs.unlinkSync(pendingReceiptPath);
  } catch {
    // Canonical receipt publication is already atomic and complete.
    // The hidden non-secret temp link may be cleaned manually if needed.
  }

  process.stdout.write(`R7_BROWSER_RECEIPT=PASS\nRUNNER_MODE=${MODE}\nRECEIPT=${OUT}\n`);
  // Failure paths exit only after pending cleanup, with handlers still active.
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}

produce();
