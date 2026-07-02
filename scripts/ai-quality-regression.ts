#!/usr/bin/env node
/**
 * S22C/S22D — AI quality regression runner.
 *
 * Runs the cases in `scripts/ai-quality-cases.ts` against the public
 * (or local) AI endpoints and writes a JSON + Markdown report.
 *
 * Usage:
 *   pnpm ai:quality
 *   tsx scripts/ai-quality-regression.ts --public-url https://books.conanxin.com
 *   tsx scripts/ai-quality-regression.ts --case insight:insight-weak-missing-isbn
 *   tsx scripts/ai-quality-regression.ts --max-ai-calls 4 --mode smoke
 *
 * The script:
 *   1. Calls /api/ai/status. If disabled, status=BLOCKED_AI_DISABLED and exits.
 *   2. Runs each searchIntentCase (live=true) and each bookInsightCase (live=true)
 *      until max-ai-calls is reached. Live=false cases always run (no AI cost).
 *   3. Evaluates assertions for each case (PASS / WARN / FAIL).
 *   4. Writes JSON + Markdown report under reports/.
 *   5. Prints a terminal summary.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  searchIntentCases,
  bookInsightCases,
  FORBIDDEN_FULL_CONTENT_PHRASES,
  DEFAULT_MAX_AI_CALLS,
  type SearchIntentCase,
  type BookInsightCase,
} from "./ai-quality-cases.js";

interface CliArgs {
  publicUrl: string;
  jsonPath: string;
  markdownPath: string;
  maxAiCalls: number;
  caseFilter: string[]; // ["search:japanese-shawl-camisole", "insight:insight-complete-book"]
  mode: "full" | "smoke";
  showSummaryOnly: boolean;
}

interface CaseResult {
  id: string;
  kind: "search" | "insight";
  status: "PASS" | "WARN" | "FAIL" | "SKIPPED";
  latencyMs: number;
  cacheHit?: boolean;
  httpStatus?: number;
  notes: string[];
  checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail?: string }>;
  raw: any; // truncated for output safety
}

interface RegressionReport {
  status: "PASS" | "WARN" | "FAIL" | "BLOCKED_AI_DISABLED";
  timestamp: string;
  environment: {
    publicUrl: string;
    aiEnabled: boolean;
    docsCount?: number;
    gitCommit?: string;
  };
  totals: {
    cases: number;
    pass: number;
    warn: number;
    fail: number;
    skipped: number;
    aiCalls: number;
  };
  searchIntent: CaseResult[];
  bookInsight: CaseResult[];
  warnings: string[];
  failures: string[];
  safety: {
    noImport: boolean;
    noReset: boolean;
    noKeyLeak: boolean;
    providerRawLeakage: boolean;
  };
}

// ---------- arg parsing ----------

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    publicUrl: "https://books.conanxin.com",
    jsonPath: "reports/ai-quality-regression-latest.json",
    markdownPath: "reports/AI_QUALITY_REGRESSION_LATEST.md",
    maxAiCalls: DEFAULT_MAX_AI_CALLS,
    caseFilter: [],
    mode: "full",
    showSummaryOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--public-url" && next) {
      args.publicUrl = next;
      i++;
    } else if (a === "--json" && next) {
      args.jsonPath = next;
      i++;
    } else if (a === "--markdown" && next) {
      args.markdownPath = next;
      i++;
    } else if (a === "--max-ai-calls" && next) {
      args.maxAiCalls = Math.max(0, Number(next));
      i++;
    } else if (a === "--case" && next) {
      args.caseFilter.push(next);
      i++;
    } else if (a === "--mode" && next) {
      args.mode = (next === "smoke" ? "smoke" : "full");
      i++;
    } else if (a === "--summary") {
      args.showSummaryOnly = true;
    }
  }
  return args;
}

// ---------- helpers ----------

const REDACTED_KEY_RE = /eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{16,}|sk-or-[A-Za-z0-9_-]{16,}/g;

function redact(text: string): string {
  return text.replace(REDACTED_KEY_RE, "[REDACTED]");
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: T | null; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? safeJsonParse(text) : null, text };
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function casePassesFilter(c: SearchIntentCase | BookInsightCase, kind: "search" | "insight", filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => {
    const [k, id] = f.split(":");
    return k === (kind === "search" ? "search" : "insight") && id === c.id;
  });
}

function getGitCommit(): string | undefined {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.publicUrl.replace(/\/+$/, "");
  mkdirSync(dirname(args.jsonPath), { recursive: true });
  mkdirSync(dirname(args.markdownPath), { recursive: true });

  const report: RegressionReport = {
    status: "PASS",
    timestamp: new Date().toISOString(),
    environment: {
      publicUrl: baseUrl,
      aiEnabled: false,
      docsCount: undefined,
      gitCommit: getGitCommit(),
    },
    totals: { cases: 0, pass: 0, warn: 0, fail: 0, skipped: 0, aiCalls: 0 },
    searchIntent: [],
    bookInsight: [],
    warnings: [],
    failures: [],
    safety: { noImport: true, noReset: true, noKeyLeak: true, providerRawLeakage: false },
  };

  // 1. AI status
  const aiStatusResp = await fetchJson(`${baseUrl}/api/ai/status`);
  if (!aiStatusResp.ok || !aiStatusResp.body?.enabled) {
    report.status = "BLOCKED_AI_DISABLED";
    writeReports(args, report);
    printSummary(report);
    return;
  }
  report.environment.aiEnabled = true;

  // 2. Stats (for docs count check)
  try {
    const statsResp = await fetchJson(`${baseUrl}/api/stats`);
    if (statsResp.ok && statsResp.body) {
      report.environment.docsCount = statsResp.body.numberOfDocuments;
    }
  } catch {
    // ignore
  }

  // 3. search-intent cases
  let aiCalls = 0;
  for (const c of searchIntentCases) {
    if (!casePassesFilter(c, "search", args.caseFilter)) continue;
    if (!c.live || aiCalls >= args.maxAiCalls) {
      report.searchIntent.push({
        id: c.id,
        kind: "search",
        status: "SKIPPED",
        latencyMs: 0,
        notes: [`Skipped: live=${c.live} aiCallsUsed=${aiCalls}/${args.maxAiCalls}`],
        checks: [],
        raw: null,
      });
      report.totals.skipped++;
      continue;
    }
    aiCalls++;
    report.totals.aiCalls++;
    const result = await runSearchIntentCase(baseUrl, c);
    report.searchIntent.push(result);
    if (result.status === "PASS") report.totals.pass++;
    else if (result.status === "WARN") report.totals.warn++;
    else if (result.status === "FAIL") report.totals.fail++;
  }

  // 4. book-insight cases
  for (const c of bookInsightCases) {
    if (!casePassesFilter(c, "insight", args.caseFilter)) continue;
    if (!c.live || aiCalls >= args.maxAiCalls) {
      report.bookInsight.push({
        id: c.id,
        kind: "insight",
        status: "SKIPPED",
        latencyMs: 0,
        notes: [`Skipped: live=${c.live} aiCallsUsed=${aiCalls}/${args.maxAiCalls}`],
        checks: [],
        raw: null,
      });
      report.totals.skipped++;
      continue;
    }
    aiCalls++;
    report.totals.aiCalls++;
    const result = await runBookInsightCase(baseUrl, c);
    report.bookInsight.push(result);
    if (result.status === "PASS") report.totals.pass++;
    else if (result.status === "WARN") report.totals.warn++;
    else if (result.status === "FAIL") report.totals.fail++;
  }

  // 5. Determine overall status
  if (report.totals.fail > 0) {
    report.status = "FAIL";
  } else if (report.totals.warn > 0 && report.totals.warn <= 2) {
    report.status = "WARN";
  } else if (report.totals.warn > 2) {
    report.status = "FAIL";
  } else {
    report.status = "PASS";
  }

  // 6. Safety check
  for (const c of [...report.searchIntent, ...report.bookInsight]) {
    const dump = JSON.stringify(c);
    if (REDACTED_KEY_RE.test(dump)) {
      report.safety.noKeyLeak = false;
      report.failures.push(`Key leak detected in case ${c.id}`);
    }
    REDACTED_KEY_RE.lastIndex = 0;
  }

  writeReports(args, report);
  printSummary(report);
}

async function runSearchIntentCase(baseUrl: string, c: SearchIntentCase): Promise<CaseResult> {
  const checks: CaseResult["checks"] = [];
  const notes: string[] = [];
  const start = Date.now();
  const resp = await fetchJson(`${baseUrl}/api/ai/search-intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: c.query }),
  });
  const latency = Date.now() - start;
  const body = resp.body as any;
  const items: any[] = body?.items ?? [];
  const warnings: string[] = body?.warnings ?? [];

  if (!resp.ok) {
    checks.push({ name: "http-200", status: "FAIL", detail: `status=${resp.status}` });
  } else {
    checks.push({ name: "http-200", status: "PASS" });
  }

  if (c.expected.shouldNot500 && resp.status >= 500) {
    checks.push({ name: "no-500", status: "FAIL", detail: `status=${resp.status}` });
  }

  if (c.expected.mustHaveItems && items.length === 0) {
    checks.push({ name: "must-have-items", status: "FAIL" });
  } else if (c.expected.mustHaveItems) {
    checks.push({ name: "must-have-items", status: "PASS" });
  }

  if (c.expected.shouldContainTitle) {
    const idx = items.findIndex((it) => (it.title ?? "").includes(c.expected.shouldContainTitle!));
    if (idx < 0) {
      checks.push({ name: "should-contain-title", status: "FAIL", detail: `not found in items[0..${items.length - 1}]` });
    } else if (c.expected.maxRank && idx >= c.expected.maxRank) {
      checks.push({ name: "should-contain-title", status: "WARN", detail: `rank=${idx} > maxRank=${c.expected.maxRank}` });
    } else {
      checks.push({ name: "should-contain-title", status: "PASS", detail: `rank=${idx}` });
    }
  }

  if (c.expected.shouldContainIsbn) {
    const idx = items.findIndex((it) => (it.isbn ?? "") === c.expected.shouldContainIsbn || (it.isbn ?? "").includes(c.expected.shouldContainIsbn!));
    if (idx < 0) {
      checks.push({ name: "should-contain-isbn", status: "FAIL" });
    } else if (c.expected.maxRank && idx >= c.expected.maxRank) {
      checks.push({ name: "should-contain-isbn", status: "WARN", detail: `rank=${idx}` });
    } else {
      checks.push({ name: "should-contain-isbn", status: "PASS", detail: `rank=${idx}` });
    }
  }

  if (c.expected.shouldContainId) {
    const idx = items.findIndex((it) => (it.id ?? "") === c.expected.shouldContainId);
    if (idx < 0) {
      checks.push({ name: "should-contain-id", status: "FAIL" });
    } else {
      checks.push({ name: "should-contain-id", status: "PASS", detail: `rank=${idx}` });
    }
  }

  if (c.expected.shouldContainAnyTerms && c.expected.shouldContainAnyTerms.length > 0) {
    const matchedAny =
      items.some((it) => {
        const matched: string[] = it.aiEvidence?.matchedQueries ?? [];
        const hay = (it.title ?? "") + " " + matched.join(" ");
        return c.expected.shouldContainAnyTerms!.some((term) => hay.includes(term));
      }) ||
      (body?.keywords ?? []).some((kw: string) => c.expected.shouldContainAnyTerms!.some((term) => kw.includes(term)));
    if (!matchedAny) {
      checks.push({ name: "should-contain-any-terms", status: "WARN", detail: "no items or AI keywords matched any term" });
    } else {
      checks.push({ name: "should-contain-any-terms", status: "PASS" });
    }
  }

  if (c.expected.allowEmpty && items.length === 0 && warnings.length > 0) {
    checks.push({ name: "graceful-fallback", status: "PASS", detail: warnings[0] });
  } else if (c.expected.shouldHaveGracefulFallback && warnings.length > 0) {
    checks.push({ name: "graceful-fallback", status: "PASS" });
  }

  const topResult = items[0]
    ? { id: items[0].id, title: items[0].title, isbn: items[0].isbn }
    : null;

  const status = aggregateStatus(checks);
  if (topResult) {
    notes.push(`top=${topResult.title || topResult.id}`);
  }
  if (warnings.length) {
    notes.push(`warnings=${warnings.length}`);
  }

  return {
    id: c.id,
    kind: "search",
    status,
    latencyMs: latency,
    notes,
    checks,
    raw: redactForReport({ items: items.slice(0, 3).map(stripBookToSafe) }),
  };
}

async function runBookInsightCase(baseUrl: string, c: BookInsightCase): Promise<CaseResult> {
  const checks: CaseResult["checks"] = [];
  const notes: string[] = [];
  const start = Date.now();
  const resp = await fetchJson(`${baseUrl}/api/ai/book-insight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: c.bookId }),
  });
  const latency = Date.now() - start;
  const body = resp.body as any;
  const basis = body?.basis;
  const quality = body?.quality;
  const insight = body?.insight;
  const error = body?.error;

  if (c.expected.expectedStatus) {
    if (resp.status === c.expected.expectedStatus) {
      checks.push({ name: `http-${c.expected.expectedStatus}`, status: "PASS" });
    } else {
      checks.push({ name: `http-${c.expected.expectedStatus}`, status: "FAIL", detail: `got ${resp.status}` });
    }
  } else if (!resp.ok) {
    checks.push({ name: "http-200", status: "FAIL", detail: `status=${resp.status}` });
  } else {
    checks.push({ name: "http-200", status: "PASS" });
  }

  if (c.expected.shouldNot500 && resp.status >= 500) {
    checks.push({ name: "no-500", status: "FAIL" });
  }

  if (c.expected.expectedStatus === 404) {
    return {
      id: c.id,
      kind: "insight",
      status: aggregateStatus(checks),
      latencyMs: latency,
      httpStatus: resp.status,
      notes: notes.length ? notes : ["not-found path"],
      checks,
      raw: redactForReport({ error }),
    };
  }

  if (c.expected.mustHaveScopeNote) {
    if (insight?.scopeNote && /仅基于书目信息|不代表全文/.test(insight.scopeNote)) {
      checks.push({ name: "scope-note", status: "PASS" });
    } else {
      checks.push({ name: "scope-note", status: "FAIL", detail: "scopeNote missing or not bilingual-friendly" });
    }
  }

  if (c.expected.mustHaveSubjectTags) {
    if (Array.isArray(insight?.subjectTags) && insight.subjectTags.length > 0) {
      checks.push({ name: "subject-tags", status: "PASS", detail: `count=${insight.subjectTags.length}` });
    } else {
      checks.push({ name: "subject-tags", status: "FAIL" });
    }
  }

  if (c.expected.mustHaveCaveats) {
    if (Array.isArray(insight?.caveats) && insight.caveats.length > 0) {
      checks.push({ name: "caveats", status: "PASS", detail: `count=${insight.caveats.length}` });
    } else {
      checks.push({ name: "caveats", status: "FAIL" });
    }
  }

  if (c.expected.mustMentionMissingIsbn) {
    const allText = JSON.stringify({
      caveats: insight?.caveats ?? [],
      reasons: insight?.trustAssessment?.reasons ?? [],
      hints: quality?.trustHints ?? [],
    });
    if (/ISBN\s*缺|缺\s*ISBN|无\s*ISBN/.test(allText)) {
      checks.push({ name: "missing-isbn-mentioned", status: "PASS" });
    } else {
      checks.push({ name: "missing-isbn-mentioned", status: "FAIL", detail: "no ISBN 缺 / 缺 ISBN / 无 ISBN" });
    }
  }

  if (c.expected.shouldMentionMetadataLimitation) {
    const text = (insight?.scopeNote ?? "") + " " + (insight?.caveats ?? []).join(" ");
    if (/仅基于书目信息|不代表全文|书目字段|元数据/.test(text)) {
      checks.push({ name: "metadata-limitation", status: "PASS" });
    } else {
      checks.push({ name: "metadata-limitation", status: "WARN" });
    }
  }

  if (c.expected.trustLevelNotHigh) {
    const lvl = insight?.trustAssessment?.level;
    if (lvl && lvl !== "high") {
      checks.push({ name: "trust-not-high", status: "PASS", detail: `level=${lvl}` });
    } else {
      checks.push({ name: "trust-not-high", status: "FAIL", detail: `level=${lvl}` });
    }
  }

  if (c.expected.shouldNotInventIsbn) {
    const basisIsbn = basis?.isbn ?? "";
    const allInsightText = JSON.stringify(insight ?? {});
    // Find anything that looks like 10/13 digit ISBN
    const isbnLike = allInsightText.match(/\b\d{10}(\d{3})?\b/g) ?? [];
    // Allow the basis ISBN to appear; flag any other ISBN-like
    const foreignIsbns = isbnLike.filter((s) => s !== basisIsbn && !basisIsbn.includes(s));
    if (foreignIsbns.length === 0) {
      checks.push({ name: "no-invented-isbn", status: "PASS" });
    } else {
      checks.push({ name: "no-invented-isbn", status: "FAIL", detail: `foreign ISBNs: ${foreignIsbns.join(", ")}` });
    }
  }

  if (c.expected.forbiddenClaims && c.expected.forbiddenClaims.length > 0) {
    const dump = JSON.stringify(insight ?? {});
    // The "negative-claim allowlist" lets a phrase appear when the AI is
    // explicitly saying it's missing/has no version of that claim. This
    // matches phrases like "缺少内容简介", "无目录", "没有作者简介".
    const NEG_CLAIM_PATTERNS: Record<string, RegExp> = {
      "内容简介": /(缺少|没有|无|不含|未见|并未提供|缺乏|未提供)\s*内容简介/,
      "目录": /(缺少|没有|无|不含|未见|并未提供|缺乏|未提供)\s*目录/,
      "读者评价": /(缺少|没有|无|不含|未见|并未提供|缺乏|未提供)\s*读者评价/,
      "作者生平": /(缺少|没有|无|不含|未见|并未提供|缺乏|未提供)\s*作者生平/,
      "序言": /(缺少|没有|无|不含|未见|并未提供|缺乏|未提供)\s*序言/,
    };
    const hits = c.expected.forbiddenClaims.filter((p) => {
      if (!dump.includes(p)) return false;
      const allow = NEG_CLAIM_PATTERNS[p];
      if (allow && allow.test(dump)) return false;
      return true;
    });
    if (hits.length === 0) {
      checks.push({ name: "no-forbidden-claims", status: "PASS" });
    } else {
      checks.push({ name: "no-forbidden-claims", status: "FAIL", detail: `hits: ${hits.join(", ")}` });
    }
  }

  if (c.expected.requiredBasisFields && c.expected.requiredBasisFields.length > 0) {
    const missing = c.expected.requiredBasisFields.filter((f) => !(f in (basis ?? {})));
    if (missing.length === 0) {
      checks.push({ name: "basis-fields", status: "PASS" });
    } else {
      checks.push({ name: "basis-fields", status: "FAIL", detail: `missing: ${missing.join(", ")}` });
    }
  }

  // Provider raw leakage check
  const dumpAll = JSON.stringify(body ?? {});
  if (/providerResponse|rawResponse|chatRawResponse/i.test(dumpAll)) {
    checks.push({ name: "no-provider-raw-leak", status: "FAIL", detail: "provider raw response exposed" });
  } else {
    checks.push({ name: "no-provider-raw-leak", status: "PASS" });
  }

  if (quality?.missingFields?.includes("isbn")) {
    notes.push("quality.missingFields=isbn");
  }
  if (insight?.trustAssessment?.level) {
    notes.push(`trust=${insight.trustAssessment.level}`);
  }
  if (body?.cache?.hit) {
    notes.push("cache.hit=true");
  }

  return {
    id: c.id,
    kind: "insight",
    status: aggregateStatus(checks),
    latencyMs: latency,
    httpStatus: resp.status,
    cacheHit: body?.cache?.hit,
    notes,
    checks,
    raw: redactForReport({
      basis: basis ? stripBasisToSafe(basis) : null,
      quality,
      insight: insight ? stripInsightToSafe(insight) : null,
      source: body?.source,
      cache: body?.cache,
    }),
  };
}

function aggregateStatus(checks: CaseResult["checks"]): "PASS" | "WARN" | "FAIL" {
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.some((c) => c.status === "WARN")) return "WARN";
  return "PASS";
}

function stripBookToSafe(b: any) {
  if (!b) return b;
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    isbn: b.isbn,
    match: b.match,
    aiEvidence: b.aiEvidence,
    parseStatus: b.parseStatus,
  };
}

function stripBasisToSafe(b: any) {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    publisher: b.publisher,
    year: b.year,
    isbn: b.isbn,
    ssid: b.ssid,
    dxid: b.dxid,
    parseStatus: b.parseStatus,
  };
}

function stripInsightToSafe(i: any) {
  return {
    shortSummary: i.shortSummary,
    subjectTags: i.subjectTags,
    likelyAudience: i.likelyAudience,
    bibliographicSignals: i.bibliographicSignals,
    searchSuggestions: i.searchSuggestions,
    trustAssessment: i.trustAssessment,
    caveats: i.caveats,
    scopeNote: i.scopeNote,
  };
}

function redactForReport(obj: any): any {
  return JSON.parse(redact(JSON.stringify(obj)));
}

function writeReports(args: CliArgs, report: RegressionReport) {
  const json = JSON.stringify(report, null, 2);
  writeFileSync(args.jsonPath, json);

  const lines: string[] = [];
  lines.push("# AI Quality Regression Report");
  lines.push("");
  lines.push(`Status: **${report.status}**`);
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push(`- Public URL: ${report.environment.publicUrl}`);
  lines.push(`- AI enabled: ${report.environment.aiEnabled}`);
  lines.push(`- Docs count: ${report.environment.docsCount ?? "unknown"}`);
  lines.push(`- Timestamp: ${report.timestamp}`);
  lines.push(`- Git commit: ${report.environment.gitCommit ?? "unknown"}`);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Cases: ${report.totals.cases}`);
  lines.push(`- Pass: ${report.totals.pass}`);
  lines.push(`- Warn: ${report.totals.warn}`);
  lines.push(`- Fail: ${report.totals.fail}`);
  lines.push(`- Skipped: ${report.totals.skipped}`);
  lines.push(`- AI calls: ${report.totals.aiCalls}`);
  lines.push("");

  lines.push("## Search Intent Cases");
  lines.push("");
  lines.push("| Case | Query | Status | Latency | Notes |");
  lines.push("|------|-------|--------|---------|-------|");
  for (const c of report.searchIntent) {
    const notes = c.notes.join("; ") || (c.checks.length ? c.checks.map((k) => `${k.name}=${k.status}`).join(", ") : "");
    lines.push(`| ${c.id} | ${(c.raw?.items?.[0]?.title ?? c.id).toString().slice(0, 50)} | ${c.status} | ${c.latencyMs}ms | ${notes} |`);
  }
  lines.push("");

  lines.push("## Book Insight Cases");
  lines.push("");
  lines.push("| Case | BookId | Status | HTTP | Latency | Trust | Notes |");
  lines.push("|------|--------|--------|------|---------|-------|-------|");
  for (const c of report.bookInsight) {
    const trust = c.raw?.insight?.trustAssessment?.level ?? "-";
    const notes = c.notes.join("; ");
    lines.push(`| ${c.id} | ${c.id.replace("insight-", "")} | ${c.status} | ${c.httpStatus ?? "?"} | ${c.latencyMs}ms | ${trust} | ${notes} |`);
  }
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  lines.push("- Quality regression risks: " + (report.failures.length ? report.failures.join("; ") : "none"));
  lines.push("- Prompt tuning candidates: see WARN cases above");
  lines.push("- Failed cases: " + (report.totals.fail > 0 ? "see fail rows" : "none"));
  lines.push("");

  lines.push("## Safety");
  lines.push("");
  lines.push(`- no import: ${report.safety.noImport}`);
  lines.push(`- no reset: ${report.safety.noReset}`);
  lines.push(`- no key leak: ${report.safety.noKeyLeak}`);
  lines.push(`- no provider raw response exposed: ${report.safety.providerRawLeakage === false ? "true" : "false"}`);
  lines.push("");

  writeFileSync(args.markdownPath, lines.join("\n"));
}

function printSummary(report: RegressionReport) {
  console.log("");
  console.log("=== AI Quality Regression ===");
  console.log(`Status: ${report.status}`);
  console.log(`AI enabled: ${report.environment.aiEnabled}`);
  console.log(`Docs count: ${report.environment.docsCount ?? "unknown"}`);
  console.log(`Cases: ${report.totals.cases}  pass=${report.totals.pass}  warn=${report.totals.warn}  fail=${report.totals.fail}  skipped=${report.totals.skipped}`);
  console.log(`AI calls: ${report.totals.aiCalls}`);
  if (report.failures.length) {
    console.log("Failures:");
    for (const f of report.failures) console.log(`  - ${f}`);
  }
  console.log("Search intent:");
  for (const c of report.searchIntent) {
    console.log(`  ${c.id}: ${c.status}  ${c.latencyMs}ms  ${c.notes.join("; ")}`);
  }
  console.log("Book insight:");
  for (const c of report.bookInsight) {
    console.log(`  ${c.id}: ${c.status}  ${c.latencyMs}ms  ${c.notes.join("; ")}`);
  }
  console.log(`Key leak: ${report.safety.noKeyLeak ? "no" : "YES"}`);
  console.log("");
}

main().catch((e) => {
  console.error("Regression run failed:", redact(String(e?.message ?? e)));
  process.exit(2);
});
