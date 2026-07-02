#!/usr/bin/env tsx
// ------------------------------------------------------------------
// Search-quality regression runner (S24-C6).
// ------------------------------------------------------------------
// For each case in search-quality-cases.ts, call /api/search against
// the live site and check the expectations. Outputs a markdown
// report and a structured JSON summary. Exits 0 on PASS/WARN, 1
// on FAIL.
//
// Usage:
//   tsx scripts/search-quality-regression.ts [--public-url URL]
//
// No MiniMax calls — pure search API, no token cost.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SEARCH_QUALITY_CASES,
  type SearchQualityCase,
  type SearchQualityExpectations,
} from "./search-quality-cases.js";

interface ApiSearchResponse {
  query: string;
  queryInfo: {
    original: string;
    normalized: string;
    cleaned: string;
    detectedType: string;
    cleanupApplied: boolean;
    removedPhrases: string[];
    intentType: string;
    intentLabel: string;
  };
  page: number;
  limit: number;
  total: number;
  items: Array<{
    id: string;
    title: string;
    author?: string;
    publisher?: string;
    match?: { type: string; label: string };
    ranking?: { score: number; fieldHits: string[]; evidence: string[] };
  }>;
}

interface CaseResult {
  caseId: string;
  description: string;
  q: string;
  status: "PASS" | "WARN" | "FAIL";
  httpStatus?: number;
  error?: string;
  cleanup?: { cleaned: string; removedPhrases: string[]; intentType: string; detectedType: string };
  topTitles: string[];
  topIds: string[];
  notes: string[];
}

interface Report {
  startedAt: string;
  finishedAt: string;
  publicUrl: string;
  totals: { pass: number; warn: number; fail: number; total: number };
  cases: CaseResult[];
}

function parseArgs(argv: string[]): { publicUrl: string } {
  let publicUrl = process.env.PUBLIC_URL ?? "https://books.conanxin.com";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--public-url" && argv[i + 1]) {
      publicUrl = argv[i + 1];
      i += 1;
    }
  }
  return { publicUrl };
}

async function callSearch(publicUrl: string, q: string, limit: number): Promise<{ status: number; body: ApiSearchResponse | null; error?: string }> {
  try {
    const url = `${publicUrl}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "book-id-search-quality-regression/1.0" },
    });
    if (!res.ok) {
      return { status: res.status, body: null, error: `HTTP ${res.status}: ${await res.text().catch(() => "")}` };
    }
    const body = (await res.json()) as ApiSearchResponse;
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, error: (e as Error).message };
  }
}

function evalCase(c: SearchQualityCase, r: { status: number; body: ApiSearchResponse | null; error?: string }): CaseResult {
  const result: CaseResult = {
    caseId: c.id,
    description: c.description,
    q: c.q,
    status: "PASS",
    httpStatus: r.status,
    topTitles: [],
    topIds: [],
    notes: [],
  };

  if (r.status === 0 || !r.body) {
    result.status = "FAIL";
    result.error = r.error ?? "unknown";
    result.notes.push(`Network error: ${result.error}`);
    return result;
  }

  if (r.status >= 500 && c.expectations.noFiveHundred) {
    result.status = "FAIL";
    result.notes.push(`HTTP ${r.status} on a query that should not 500`);
  } else if (r.status >= 400) {
    result.status = "FAIL";
    result.notes.push(`HTTP ${r.status}`);
  }

  const body = r.body;
  const qi = body.queryInfo;
  result.cleanup = {
    cleaned: qi.cleaned,
    removedPhrases: qi.removedPhrases,
    intentType: qi.intentType,
    detectedType: qi.detectedType,
  };
  result.topTitles = body.items.map((it) => it.title);
  result.topIds = body.items.map((it) => it.id);

  const e = c.expectations;

  if (e.cleaned !== undefined && qi.cleaned !== e.cleaned) {
    result.status = bump(result.status, "FAIL");
    result.notes.push(`cleaned expected "${e.cleaned}" got "${qi.cleaned}"`);
  }
  if (e.detectedType !== undefined && qi.detectedType !== e.detectedType) {
    result.status = bump(result.status, "FAIL");
    result.notes.push(`detectedType expected "${e.detectedType}" got "${qi.detectedType}"`);
  }
  if (e.intentType !== undefined && qi.intentType !== e.intentType) {
    // Intent miss is WARN, not FAIL — different search queries can
    // legitimately have similar intents. We only FAIL on identifier
    // mis-detection, which is handled above.
    result.status = bump(result.status, "WARN");
    result.notes.push(`intentType expected "${e.intentType}" got "${qi.intentType}"`);
  }
  if (e.removedPhrasesIncludes) {
    for (const phrase of e.removedPhrasesIncludes) {
      if (!qi.removedPhrases.includes(phrase)) {
        result.status = bump(result.status, "WARN");
        result.notes.push(`removedPhrases missing "${phrase}"`);
      }
    }
  }
  if (e.topId !== undefined) {
    if (!result.topIds.includes(e.topId)) {
      result.status = bump(result.status, "FAIL");
      result.notes.push(`topIds missing expected id "${e.topId}"`);
    }
  }
  if (e.topResultsShouldNotInclude) {
    for (const t of e.topResultsShouldNotInclude) {
      if (result.topTitles.includes(t)) {
        result.status = bump(result.status, "FAIL");
        result.notes.push(`topTitles includes forbidden "${t}"`);
      }
    }
  }
  if (e.topResultsShouldContainAnyTerms) {
    const titlesStr = result.topTitles.join(" ");
    const hit = e.topResultsShouldContainAnyTerms.some((t) => titlesStr.includes(t));
    if (!hit) {
      result.status = bump(result.status, "WARN");
      result.notes.push(`no top title contains any of: ${e.topResultsShouldContainAnyTerms.join(", ")}`);
    }
  }
  if (e.topResultsShouldContain) {
    const titlesStr = result.topTitles.join(" ");
    for (const t of e.topResultsShouldContain) {
      if (!titlesStr.includes(t)) {
        result.status = bump(result.status, "WARN");
        result.notes.push(`no top title contains required term "${t}"`);
      }
    }
  }

  return result;
}

function bump(s: CaseResult["status"], next: "WARN" | "FAIL"): CaseResult["status"] {
  if (next === "FAIL") return "FAIL";
  if (next === "WARN" && s === "PASS") return "WARN";
  return s;
}

function overallStatus(cases: CaseResult[]): "PASS" | "WARN" | "FAIL" {
  if (cases.some((c) => c.status === "FAIL")) return "FAIL";
  if (cases.some((c) => c.status === "WARN")) return "WARN";
  return "PASS";
}

function buildMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Search-quality regression — ${report.startedAt}`);
  lines.push("");
  lines.push(`Site: ${report.publicUrl}`);
  lines.push("");
  lines.push(`Totals: ${report.totals.pass} PASS / ${report.totals.warn} WARN / ${report.totals.fail} FAIL / ${report.totals.total} total`);
  lines.push("");
  lines.push(`Overall: **${overallStatus(report.cases)}**`);
  lines.push("");
  for (const c of report.cases) {
    lines.push(`## ${c.caseId} — ${c.status}`);
    lines.push("");
    lines.push(`> ${c.description}`);
    lines.push("");
    lines.push(`- q: \`${c.q}\``);
    if (c.cleanup) {
      lines.push(`- cleaned: \`${c.cleanup.cleaned}\``);
      lines.push(`- removed: [${c.cleanup.removedPhrases.join(", ")}]`);
      lines.push(`- intentType: ${c.cleanup.intentType}`);
      lines.push(`- detectedType: ${c.cleanup.detectedType}`);
    }
    if (c.topTitles.length) {
      lines.push(`- top titles: ${c.topTitles.slice(0, 5).map((t) => `\`${t}\``).join(", ")}`);
    }
    if (c.topIds.length) {
      lines.push(`- top ids: ${c.topIds.slice(0, 5).map((t) => `\`${t}\``).join(", ")}`);
    }
    if (c.notes.length) {
      lines.push("- notes:");
      for (const n of c.notes) lines.push(`  - ${n}`);
    }
    if (c.error) {
      lines.push(`- error: \`${c.error}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { publicUrl } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  console.log(`[search-quality] Running ${SEARCH_QUALITY_CASES.length} cases against ${publicUrl}`);
  const cases: CaseResult[] = [];
  for (const c of SEARCH_QUALITY_CASES) {
    const limit = c.limit ?? 10;
    const r = await callSearch(publicUrl, c.q, limit);
    const result = evalCase(c, r);
    cases.push(result);
    const tag = result.status === "PASS" ? "✓" : result.status === "WARN" ? "?" : "✗";
    console.log(`  ${tag} ${result.caseId} (q="${c.q}")`);
    if (result.notes.length) {
      for (const n of result.notes) console.log(`     · ${n}`);
    }
  }
  const finishedAt = new Date().toISOString();
  const totals = {
    pass: cases.filter((c) => c.status === "PASS").length,
    warn: cases.filter((c) => c.status === "WARN").length,
    fail: cases.filter((c) => c.status === "FAIL").length,
    total: cases.length,
  };
  const report: Report = { startedAt, finishedAt, publicUrl, totals, cases };
  const md = buildMarkdown(report);

  // Persist to logs/search-quality/ so future weekly runs can diff.
  const logDir = path.join(process.cwd(), "logs", "search-quality");
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  const mdPath = path.join(logDir, `search-quality-${ts}.md`);
  const jsonPath = path.join(logDir, `search-quality-${ts}.json`);
  writeFileSync(mdPath, md);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log("");
  console.log(`Totals: ${totals.pass} PASS / ${totals.warn} WARN / ${totals.fail} FAIL`);
  console.log(`Markdown: ${mdPath}`);
  console.log(`JSON: ${jsonPath}`);

  const overall = overallStatus(cases);
  if (overall === "FAIL") process.exit(1);
}

main().catch((e) => {
  console.error("[search-quality] unhandled error:", e);
  process.exit(2);
});