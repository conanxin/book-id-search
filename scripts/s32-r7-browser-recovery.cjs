#!/usr/bin/env node
"use strict";
// Local, non-secret incident copies only. No SSH, API, recorder, or completion.
// A fresh read-only production audit and explicit user authorization are still
// required: local copies cannot establish the freshness of production state.
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const reject = (reason) => { throw new Error(reason); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function read600(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { reject("RECOVERY_EVIDENCE_MISSING"); }
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) reject("RECOVERY_EVIDENCE_UNSAFE");
  const raw = fs.readFileSync(file, "utf8");
  const values = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || !/^[A-Z0-9_]+$/.test(key) || Object.hasOwn(values, key)) reject("RECOVERY_EVIDENCE_INVALID");
    if (/(^|_)(TOKEN|PASSWORD|SECRET|DATABASE_URL)$/.test(key)) reject("RECOVERY_SECRET_FIELD");
    values[key] = line.slice(index + 1);
  }
  return { raw, values, stat };
}
function expect(values, required) {
  for (const [key, value] of Object.entries(required)) {
    if (values[key] !== value) reject(`RECOVERY_IDENTITY_MISMATCH:${key}`);
  }
}
function absent(file) {
  try { fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return;
    reject("RECOVERY_PATH_UNREADABLE");
  }
  reject("RECOVERY_ALREADY_RECORDED_OR_CONSUMED");
}
function git(args) {
  // Identity checks require no credential and must not run configured monitors.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  return execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    { cwd: ROOT, env, encoding: "utf8" }).trim();
}
function head() {
  return git(["rev-parse", "HEAD"]);
}
function checkState({ stateDir, fp, projectId, ctrl, toolSha }) {
  // Git's environment can redirect cwd-bound identity/status checks elsewhere.
  // Reject every Git override, including future variables, before invoking Git.
  if (Object.keys(process.env).some((key) => key.startsWith("GIT_") && process.env[key])) {
    reject("RECOVERY_GIT_ENVIRONMENT_REJECTED");
  }
  if (git(["for-each-ref", "--format=%(refname)", "refs/replace"])) {
    reject("RECOVERY_GIT_REPLACEMENTS_REJECTED");
  }
  if (!stateDir || !path.isAbsolute(stateDir)) reject("RECOVERY_STATE_DIRECTORY_REQUIRED");
  const dir = fs.lstatSync(stateDir);
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700) reject("RECOVERY_STATE_DIRECTORY_UNSAFE");
  if (!/^[a-f0-9]{64}$/.test(fp) || !/^[a-f0-9]{40}$/.test(ctrl)
      || !/^[a-f0-9]{40}$/.test(toolSha) || toolSha !== head()) reject("RECOVERY_TOOL_OR_INCIDENT_IDENTITY_INVALID");
  const incident = read600(path.join(stateDir, "R7.browser-incident.env"));
  expect(incident.values, {
    R7_STATE: "INCOMPLETE", S32_RELEASE_FINGERPRINT: fp, CONTROL_PLANE_SHA: ctrl, PROJECT_ID: projectId,
    R7_BEGIN_INVOCATIONS: "1", R7_API_INVOCATIONS: "1", R7_BROWSER_INVOCATIONS: "1",
    FAILED_BROWSER_REASON: "DEVTOOLS_ENDPOINT_TIMEOUT", SEMANTIC_WEB_ACCEPTANCE: "NOT_REACHED",
  });
  const src = incident.values.RELEASE_SOURCE_SHA;
  if (!/^[a-f0-9]{40}$/.test(src)) reject("RECOVERY_SOURCE_INVALID");
  const base = path.join(stateDir, `s32-rollout-${fp}-R7`);
  absent(`${base}.web.env`);
  absent(`${base}.result.env`);
  const claim = path.join(stateDir, "R7.browser-recovery.claim.env");
  absent(claim);
  const start = read600(`${base}.start.env`);
  const api = read600(`${base}.api.env`);
  expect(incident.values, { R7_START_SHA256: sha256(start.raw), R7_API_SHA256: sha256(api.raw) });
  expect(start.values, { STATUS: "STARTED", STAGE: "R7", S32_RELEASE_FINGERPRINT: fp,
    RELEASE_SOURCE_SHA: src, CONTROL_PLANE_SHA: ctrl });
  expect(api.values, { STATUS: "PASS", STAGE: "R7_API", R7_API_ACCEPTANCE: "PASS",
    IDEMPOTENCY_RECEIPT_DB_PROOF: "PASS", S32_RELEASE_FINGERPRINT: fp, RELEASE_SOURCE_SHA: src,
    PROJECT_ID: projectId, PROJECT_NAME: `[S32 Production Acceptance] ${fp.slice(0, 12)}`,
    LEGACY_SEARCH_REGRESSION: "PASS", ASSESSMENT_REPLAY: "PASS", S32_BACKEND_ACCEPTANCE: "PASS",
    MEILI_DOCUMENTS: "5115734", ACCEPTANCE_PROJECT_RETAINED: "YES" });
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(api.values.ASSESSMENT_ID || "")) reject("RECOVERY_ASSESSMENT_INVALID");
  return { incident, claim };
}
function prepareRecovery(options, { fixture = false } = {}) {
  const state = checkState(options);
  if (!fixture) {
    const authPath = path.join(options.stateDir, "R7.browser-recovery.authorization.env");
    if (!fs.existsSync(authPath)) reject("RECOVERY_AUTHORIZATION_REQUIRED");
    const auth = read600(authPath);
    const expected = { AUTHORIZED_ACTION: "S32_R7_BROWSER_STARTUP_RECOVERY", EXPLICIT_APPROVAL: "true",
      CONSUMABLE_ONCE: "true", RECOVERY_TOOL_SHA: options.toolSha,
      INCIDENT_SHA256: sha256(state.incident.raw), RECOVERY_BROWSER_INVOCATIONS: "1" };
    if (Object.keys(auth.values).length !== Object.keys(expected).length) reject("RECOVERY_AUTHORIZATION_INVALID");
    expect(auth.values, expected);
    if (git(["status", "--porcelain", "--untracked-files=normal"])) {
      reject("RECOVERY_TOOL_CHECKOUT_DIRTY");
    }
    // This is a separate LOCAL recovery claim, never a production R7 artifact.
    // It remains consumed after every later failure, including spawn errors.
    // Keep this state directory and never copy/reset/delete the claim to retry.
    fs.linkSync(authPath, state.claim);
    const claimed = read600(state.claim);
    if (claimed.stat.dev !== auth.stat.dev || claimed.stat.ino !== auth.stat.ino || claimed.raw !== auth.raw) {
      reject("RECOVERY_CLAIM_IDENTITY_MISMATCH");
    }
  }
  return ["R7_BROWSER_RECOVERY=STARTUP_RECOVERY", `RECOVERY_TOOL_SHA=${options.toolSha}`];
}
module.exports = { checkState, prepareRecovery };
if (require.main === module) {
  try {
    const [mode, stateDir, fp, projectId, ctrl, toolSha] = process.argv.slice(2);
    if (mode !== "--check" || process.argv.length !== 8) reject("INVALID_ARGUMENTS");
    checkState({ stateDir, fp, projectId, ctrl, toolSha });
    process.stdout.write("STATUS=PASS\nRECOVERY_STATE=READY_AUTHORIZATION_REQUIRED\nPRODUCTION_WRITE_EXECUTED=NO\n");
  } catch (error) {
    process.stdout.write(`STATUS=BLOCKED\nREASON=${error.code || error.message}\n`);
    process.exitCode = 1;
  }
}
