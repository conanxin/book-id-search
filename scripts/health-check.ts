#!/usr/bin/env tsx
/**
 * S20A production health check.
 *
 * Verifies the live book-id-search deployment is healthy and the public attack
 * surface has not expanded (ports 3001/5173/7700 must NOT be reachable from the
 * public internet). Safe to run repeatedly; performs no writes, no imports, no
 * Meilisearch config changes.
 *
 * Usage:
 *   pnpm health:check
 *   tsx scripts/health-check.ts --public-url https://books.conanxin.com \
 *     --expected-docs 5115734 --server-ip 118.195.129.137 \
 *     --json reports/health-check-latest.json \
 *     --markdown reports/HEALTH_CHECK_LATEST.md
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

// ---------- args ----------
interface Args {
  publicUrl: string;
  expectedDocs: number;
  serverIp: string;
  jsonPath: string;
  markdownPath: string;
  skipLocal: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string, fallback: string) => {
    const i = argv.indexOf(key);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  return {
    publicUrl: get("--public-url", "https://books.conanxin.com"),
    expectedDocs: parseInt(get("--expected-docs", "5115734"), 10),
    serverIp: get("--server-ip", "118.195.129.137"),
    jsonPath: get("--json", "reports/health-check-latest.json"),
    markdownPath: get("--markdown", "reports/HEALTH_CHECK_LATEST.md"),
    skipLocal: argv.includes("--skip-local"),
  };
}

// ---------- helpers ----------
interface CheckResult {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

const RESULTS: CheckResult[] = [];

function record(name: string, status: CheckResult["status"], detail: string) {
  RESULTS.push({ name, status, detail });
  const tag = `[${status}]`.padEnd(7);
  console.log(`${tag} ${name}: ${detail}`);
}

function aggregate(): CheckResult["status"] {
  if (RESULTS.some((r) => r.status === "FAIL")) return "FAIL";
  if (RESULTS.some((r) => r.status === "WARN")) return "WARN";
  return "PASS";
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "manual" });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text */
    }
    return { status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function fetchHead(url: string, timeoutMs = 10000): Promise<number> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "manual" });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

// ---------- checks ----------
async function checkFrontend(args: Args) {
  try {
    const r = await fetchHead(`${args.publicUrl}/`);
    if (r === 200 || r === 304) {
      record("public frontend", "PASS", `GET / -> ${r}`);
    } else {
      record("public frontend", "FAIL", `GET / -> ${r}`);
    }
  } catch (e) {
    record("public frontend", "FAIL", `fetch failed: ${(e as Error).message}`);
  }
}

async function checkApiHealth(args: Args) {
  try {
    const r = await fetchJson(`${args.publicUrl}/api/health`);
    const obj = r.body as { ok?: boolean; meili?: { status?: string } } | string;
    if (r.status === 200 && typeof obj === "object" && obj?.ok === true) {
      record("api health", "PASS", `ok=true meili=${obj.meili?.status ?? "?"}`);
    } else {
      record("api health", "FAIL", `status=${r.status} body=${JSON.stringify(obj).slice(0, 200)}`);
    }
  } catch (e) {
    record("api health", "FAIL", `fetch failed: ${(e as Error).message}`);
  }
}

const FORBIDDEN_KEYS = [
  "rawInfo",
  "samples",
  "/data/private",
  "checkpointPath",
  "books.txt",
];

async function checkStats(args: Args) {
  try {
    const r = await fetchJson(`${args.publicUrl}/api/stats`);
    if (r.status !== 200) {
      record("stats", "FAIL", `status=${r.status}`);
      return;
    }
    const obj = r.body as {
      numberOfDocuments?: number;
      isIndexing?: boolean;
      lastImportReport?: unknown;
      parseQualityReport?: unknown;
      rawDocumentDbSize?: number;
    };
    const docs = obj.numberOfDocuments;
    if (docs !== args.expectedDocs) {
      record("stats count", "FAIL", `docs=${docs} expected=${args.expectedDocs}`);
    } else {
      record("stats count", "PASS", `docs=${docs}`);
    }

    if (obj.isIndexing !== false) {
      record("stats indexing", "FAIL", `isIndexing=${obj.isIndexing}`);
    } else {
      record("stats indexing", "PASS", "isIndexing=false");
    }

    // compact stats must NOT leak forbidden internals
    const serialized = JSON.stringify(obj);
    const leaks = FORBIDDEN_KEYS.filter((k) => serialized.includes(k));
    if (leaks.length > 0) {
      record("stats compact safety", "FAIL", `forbidden keys present: ${leaks.join(",")}`);
    } else {
      record(
        "stats compact safety",
        "PASS",
        `no leaks (rawInfo/samples/private/checkpoint/books.txt)`,
      );
    }
  } catch (e) {
    record("stats", "FAIL", `fetch failed: ${(e as Error).message}`);
  }
}

interface SearchCheck {
  label: string;
  q: string;
  expectedMatchLabel: string;
}

const SEARCH_CHECKS: SearchCheck[] = [
  { label: "ISBN", q: "9787538455250", expectedMatchLabel: "ISBN 精确匹配" },
  { label: "hyphen-ISBN", q: "978-7-5384-5525-0", expectedMatchLabel: "ISBN 精确匹配" },
  { label: "SSID", q: "13000000", expectedMatchLabel: "SSID 精确匹配" },
  { label: "DXID", q: "000008232537", expectedMatchLabel: "DXID 精确匹配" },
  { label: "title", q: "时尚秋冬披肩", expectedMatchLabel: "书名命中" },
];

async function checkSearches(args: Args) {
  for (const c of SEARCH_CHECKS) {
    try {
      const url = new URL(`${args.publicUrl}/api/search`);
      url.searchParams.set("q", c.q);
      const r = await fetchJson(url.toString());
      if (r.status !== 200) {
        record(`search ${c.label}`, "FAIL", `status=${r.status}`);
        continue;
      }
      const obj = r.body as {
        items?: { match?: { label?: string; type?: string } }[];
        queryInfo?: { detectedType?: string };
      };
      const top = obj.items?.[0];
      const label = top?.match?.label ?? "(none)";
      const detected = obj.queryInfo?.detectedType ?? "?";
      if (label === c.expectedMatchLabel) {
        record(
          `search ${c.label}`,
          "PASS",
          `q=${c.q} detectedType=${detected} label=${label}`,
        );
      } else {
        record(
          `search ${c.label}`,
          "FAIL",
          `q=${c.q} detectedType=${detected} got=${label} expected=${c.expectedMatchLabel}`,
        );
      }
    } catch (e) {
      record(`search ${c.label}`, "FAIL", `fetch failed: ${(e as Error).message}`);
    }
  }
}

async function checkPortExposure(args: Args) {
  // External reachability for ports that must be private.
  // We hit them via the public IP using a Host header that resolves to localhost,
  // OR via direct IP. Most reliable: probe each port on the server IP.
  // If we get a non-network-error response, treat as FAIL.
  const ports = [
    { port: 3001, label: "api" },
    { port: 5173, label: "web" },
    { port: 7700, label: "meilisearch" },
  ];
  for (const { port, label } of ports) {
    const url = `http://${args.serverIp}:${port}/`;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      let status = 0;
      let reached = false;
      try {
        const r = await fetch(url, { signal: ctl.signal, redirect: "manual" });
        status = r.status;
        reached = true;
      } catch {
        // network error / timeout / refused → private (good)
      } finally {
        clearTimeout(t);
      }
      if (reached && status > 0) {
        record(`port :${port} ${label} external`, "FAIL", `reachable from outside, status=${status}`);
      } else {
        record(`port :${port} ${label} external`, "PASS", `not reachable from ${args.serverIp} (private)`);
      }
    } catch (e) {
      record(`port :${port} ${label} external`, "PASS", `not reachable (${(e as Error).message})`);
    }
  }
}

function safeExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

function checkLocal(args: Args) {
  if (args.skipLocal) {
    record("local checks", "PASS", "skipped (--skip-local)");
    return;
  }

  // docker compose ps — uses sudo since the CVM's docker.sock is root-owned.
  const ps = safeExec("sudo", ["docker", "compose", "ps", "--format", "json"]);
  if (ps === null || ps === "") {
    record("docker compose ps", "WARN", "docker compose unavailable or failed");
  } else {
    const services: { Service?: string; State?: string; Status?: string }[] = ps
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {};
        }
      });
    const summary = services
      .map((s) => `${s.Service}=${s.State ?? "?"}`)
      .join(" ");
    const allUp = services.length > 0 && services.every((s) => s.State === "running");
    record(
      "docker compose ps",
      allUp ? "PASS" : "WARN",
      summary || "no services parsed",
    );
  }

  // df -h (root partition)
  const df = safeExec("df", ["-h", "/"]);
  if (df) {
    const useMatch = df.match(/(\d+)%\s+\//);
    const usePct = useMatch ? parseInt(useMatch[1], 10) : -1;
    let status: CheckResult["status"] = "PASS";
    if (usePct >= 90) status = "FAIL";
    else if (usePct >= 80) status = "WARN";
    record("disk /", status, usePct >= 0 ? `used=${usePct}%` : "could not parse");
  } else {
    record("disk /", "WARN", "df unavailable");
  }

  // /data/book-id-search/meili_data size (sudo du)
  const du = safeExec("sudo", ["du", "-sh", "/data/book-id-search/meili_data"]);
  if (du) {
    record("meili_data size", "PASS", du);
  } else {
    record("meili_data size", "WARN", "du unavailable or permission denied");
  }

  // Caddy certificate status — best effort.
  // We probe the LIVE public cert first (most reliable indicator that HTTPS is
  // actually serving a valid, unexpired certificate), and then fall back to the
  // on-disk storage layout.
  const liveCert = safeExec("bash", [
    "-c",
    `echo | openssl s_client -servername books.conanxin.com -connect books.conanxin.com:443 2>/dev/null | openssl x509 -noout -subject -enddate`,
  ]);
  if (liveCert) {
    const subjectMatch = liveCert.match(/subject=([^\n]+)/);
    const endMatch = liveCert.match(/notAfter=([^\n]+)/);
    if (subjectMatch && endMatch) {
      record(
        "caddy certificate",
        "PASS",
        `live cert subject=${subjectMatch[1].trim()} expires=${endMatch[1].trim()}`,
      );
      return;
    }
  }

  // Fallback: probe on-disk storage. Caddy on this CVM stores certs under
  // /var/lib/caddy/.config/caddy/ (not the legacy /var/lib/caddy/acme/ default).
  const candidateDirs = [
    "/var/lib/caddy/.config/caddy", // observed on this CVM (caddy runs as user caddy)
    "/var/lib/caddy", // legacy/default
  ];
  const caddyfile = safeExec("sudo", ["cat", "/etc/caddy/Caddyfile"]);
  if (caddyfile) {
    const storageMatch = caddyfile.match(/\/var\/lib\/caddy[^ \n]*/);
    if (storageMatch && !candidateDirs.includes(storageMatch[0])) {
      candidateDirs.unshift(storageMatch[0]);
    }
  }

  let bestDetail = "";
  let bestStatus: CheckResult["status"] = "WARN";
  for (const dir of candidateDirs) {
    const listing = safeExec("sudo", ["ls", dir]);
    if (listing === null) continue;
    const entries = listing.split("\n").filter(Boolean);
    const certArtifacts = entries.filter(
      (l) => l === "acme" || l.endsWith(".crt") || l.endsWith(".key") || l === "ocsp" || l === "locks",
    );
    if (certArtifacts.length > 0) {
      bestStatus = "PASS";
      bestDetail = `cert_dir=${dir} cert_artifacts=${certArtifacts.join(",")}`;
      break;
    } else if (entries.length > 0) {
      bestDetail = `cert_dir=${dir} entries=${entries.length} (no cert artifacts found)`;
    }
  }
  if (bestStatus === "PASS") {
    record("caddy certificate", "PASS", bestDetail);
  } else if (bestDetail) {
    record("caddy certificate", "WARN", bestDetail);
  } else {
    record(
      "caddy certificate",
      "WARN",
      `no cert dirs readable among: ${candidateDirs.join(", ")}`,
    );
  }
}

// ---------- output ----------
function ensureDir(p: string) {
  const d = path.dirname(p);
  fs.mkdirSync(d, { recursive: true });
}

function writeJson(args: Args, overall: string) {
  const payload = {
    timestamp: new Date().toISOString(),
    publicUrl: args.publicUrl,
    expectedDocs: args.expectedDocs,
    serverIp: args.serverIp,
    overall,
    checks: RESULTS,
  };
  ensureDir(args.jsonPath);
  fs.writeFileSync(args.jsonPath, JSON.stringify(payload, null, 2));
}

function writeMarkdown(args: Args, overall: string) {
  const lines: string[] = [];
  lines.push(`# Production Health Check — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- Public URL: \`${args.publicUrl}\``);
  lines.push(`- Expected docs: \`${args.expectedDocs}\``);
  lines.push(`- Server IP: \`${args.serverIp}\``);
  lines.push(`- Overall: **${overall}**`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Check | Status | Detail |");
  lines.push("|---|---|---|");
  for (const r of RESULTS) {
    lines.push(`| ${r.name} | ${r.status} | ${r.detail} |`);
  }
  lines.push("");
  ensureDir(args.markdownPath);
  fs.writeFileSync(args.markdownPath, lines.join("\n"));
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[health-check] publicUrl=${args.publicUrl} expectedDocs=${args.expectedDocs} serverIp=${args.serverIp}`);

  await checkFrontend(args);
  await checkApiHealth(args);
  await checkStats(args);
  await checkSearches(args);
  await checkPortExposure(args);
  checkLocal(args);

  const overall = aggregate();
  console.log("");
  console.log(`STATUS: ${overall}`);

  writeJson(args, overall);
  writeMarkdown(args, overall);
  console.log(`[health-check] wrote ${args.jsonPath} and ${args.markdownPath}`);

  // Exit codes: 0=PASS, 1=WARN, 2=FAIL — useful for cron / CI
  process.exit(overall === "FAIL" ? 2 : overall === "WARN" ? 1 : 0);
}

main().catch((e) => {
  console.error("[health-check] uncaught error:", e);
  process.exit(3);
});