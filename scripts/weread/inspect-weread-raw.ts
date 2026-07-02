#!/usr/bin/env tsx
/**
 * S26B: WeRead raw export shape inspector.
 *
 * Walks every JSON file in --dir and produces a structural inventory without
 * exposing any real string values. Use this to audit a fresh export from the
 * WeRead Skill before normalizing it into a snapshot.
 *
 * Safety contract:
 *   - String values are NEVER printed to stdout, even length-reduced forms.
 *   - Only type tags ("string"|"number"|"boolean"|"null"|"array"|"object"),
 *     character-length integers, and key names reach stdout.
 *   - Sensitive keys (token/cookie/session/wr_vid/wr_skey/wr_rt/Bearer/sk-)
 *     are flagged as WARN; their values are never written anywhere.
 *   - Output JSON and Markdown go to gitignored paths under
 *     private-data/weread/audit/.
 *
 * Usage:
 *   pnpm weread:inspect
 *   tsx scripts/weread/inspect-weread-raw.ts --dir private-data/weread/raw/latest \
 *     --out-json private-data/weread/audit/raw-inventory.latest.json \
 *     --out-md private-data/weread/audit/raw-inventory.latest.md
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- types ----------
type JsonType = "string" | "number" | "boolean" | "null" | "array" | "object";

type FieldSummary = {
  key: string;
  occurrences: number;
  coveragePct: number;
  typeBreakdown: Record<string, number>;
  // For string fields only: distribution of (length bucket) counts. No values.
  stringLengthHistogram?: Record<string, number>;
  sensitive: boolean;
};

type FileInventory = {
  file: string;
  topLevelType: JsonType;
  recordCount: number;
  topLevelKeys: string[];
  fieldSummary: FieldSummary[];
  sensitiveKeyHits: string[];
  warnings: string[];
};

type InventoryReport = {
  generatedAt: string;
  dir: string;
  totalFiles: number;
  totalRecords: number;
  files: FileInventory[];
  warnings: string[];
  // Aggregate counts (no values).
  sensitiveWarningsTotal: number;
};

// ---------- sensitive key detection ----------
export const SENSITIVE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "token", re: /token/i },
  { name: "cookie", re: /\bcookie\b/i },
  { name: "session", re: /session/i },
  { name: "wr_vid", re: /\bwr_vid\b/i },
  { name: "wr_skey", re: /\bwr_skey\b/i },
  { name: "wr_rt", re: /\bwr_rt\b/i },
  { name: "bearer", re: /\bbearer\b/i },
  { name: "sk_live", re: /\bsk[-_]live/i },
  { name: "authorization", re: /^authorization$/i },
];

export function isSensitiveKey(key: string): { sensitive: boolean; matched: string | null } {
  for (const { name, re } of SENSITIVE_PATTERNS) {
    if (re.test(key)) return { sensitive: true, matched: name };
  }
  return { sensitive: false, matched: null };
}

// ---------- structural walkers ----------
export function detectJsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "null";
}

function bucketLength(len: number): string {
  if (len === 0) return "0";
  if (len <= 4) return "1-4";
  if (len <= 16) return "5-16";
  if (len <= 64) return "17-64";
  if (len <= 256) return "65-256";
  return "257+";
}

export function summarizeRecords(
  records: unknown[],
): { fieldSummary: FieldSummary[]; topLevelKeys: string[] } {
  const allKeys = new Set<string>();
  const occurrences = new Map<string, number>();
  const typeBreakdown = new Map<string, Map<string, number>>();
  const lengthHist = new Map<string, Map<string, number>>();
  const sensitiveFlags = new Map<string, boolean>();

  for (const rec of records) {
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue;
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
      allKeys.add(k);
      occurrences.set(k, (occurrences.get(k) ?? 0) + 1);
      const t = detectJsonType(v);
      if (!typeBreakdown.has(k)) typeBreakdown.set(k, new Map());
      const tb = typeBreakdown.get(k)!;
      tb.set(t, (tb.get(t) ?? 0) + 1);
      if (t === "string") {
        if (!lengthHist.has(k)) lengthHist.set(k, new Map());
        const lh = lengthHist.get(k)!;
        const bucket = bucketLength((v as string).length);
        lh.set(bucket, (lh.get(bucket) ?? 0) + 1);
      }
      if (!sensitiveFlags.has(k)) {
        sensitiveFlags.set(k, isSensitiveKey(k).sensitive);
      }
    }
  }

  const total = records.length || 1;
  const fieldSummary: FieldSummary[] = [];
  for (const key of allKeys) {
    const occ = occurrences.get(key) ?? 0;
    const tb = typeBreakdown.get(key) ?? new Map<string, number>();
    const typeBreakdownObj: Record<string, number> = {};
    for (const [k, v] of tb.entries()) typeBreakdownObj[k] = v;

    const fs: FieldSummary = {
      key,
      occurrences: occ,
      coveragePct: Math.round((occ / total) * 10000) / 100,
      typeBreakdown: typeBreakdownObj,
      sensitive: sensitiveFlags.get(key) ?? false,
    };

    if (lengthHist.has(key)) {
      const lh = lengthHist.get(key)!;
      const histObj: Record<string, number> = {};
      for (const [k, v] of lh.entries()) histObj[k] = v;
      fs.stringLengthHistogram = histObj;
    }

    fieldSummary.push(fs);
  }

  // Stable sort: by key name for diff-friendly output.
  fieldSummary.sort((a, b) => a.key.localeCompare(b.key));

  return { fieldSummary, topLevelKeys: Array.from(allKeys).sort() };
}

// ---------- file IO ----------
function readJsonFile(fullPath: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function inventoryFile(filePath: string): FileInventory {
  const fileName = path.basename(filePath);
  const base: FileInventory = {
    file: fileName,
    topLevelType: "null",
    recordCount: 0,
    topLevelKeys: [],
    fieldSummary: [],
    sensitiveKeyHits: [],
    warnings: [],
  };

  const result = readJsonFile(filePath);
  if (!result.ok) {
    base.warnings.push(`unreadable: ${result.error}`);
    return base;
  }
  const data = result.data;
  base.topLevelType = detectJsonType(data);

  // Accept arrays and single objects (record count = 1 for the latter).
  let records: unknown[];
  if (Array.isArray(data)) {
    records = data;
    base.recordCount = data.length;
  } else if (data !== null && typeof data === "object") {
    records = [data];
    base.recordCount = 1;
  } else {
    base.warnings.push(`top-level value of type ${base.topLevelType} is not a record container`);
    return base;
  }

  const { fieldSummary, topLevelKeys } = summarizeRecords(records);
  base.fieldSummary = fieldSummary;
  base.topLevelKeys = topLevelKeys;

  // Flag sensitive keys (only key names are reported).
  for (const f of fieldSummary) {
    if (f.sensitive) base.sensitiveKeyHits.push(f.key);
  }
  if (base.sensitiveKeyHits.length > 0) {
    base.warnings.push(
      `sensitive keys detected (names only): ${base.sensitiveKeyHits.join(", ")} — re-export without these fields if possible`,
    );
  }

  return base;
}

// ---------- arg parsing ----------
interface Args {
  dir: string;
  outJson: string | null;
  outMd: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | null => {
    const i = argv.indexOf(key);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  return {
    dir: get("--dir") ?? "private-data/weread/raw/latest",
    outJson: get("--out-json"),
    outMd: get("--out-md"),
  };
}

// ---------- markdown formatter ----------
function renderMarkdown(report: InventoryReport): string {
  const lines: string[] = [];
  lines.push("# WeRead raw inventory (S26B inspect)");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- dir: \`${report.dir}\``);
  lines.push(`- totalFiles: ${report.totalFiles}`);
  lines.push(`- totalRecords: ${report.totalRecords}`);
  lines.push(`- sensitiveWarningsTotal: ${report.sensitiveWarningsTotal}`);
  if (report.warnings.length > 0) {
    lines.push("- warnings:");
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  lines.push("");
  for (const f of report.files) {
    lines.push(`## ${f.file}`);
    lines.push("");
    lines.push(`- topLevelType: ${f.topLevelType}`);
    lines.push(`- recordCount: ${f.recordCount}`);
    lines.push(`- topLevelKeys: ${f.topLevelKeys.length ? f.topLevelKeys.map((k) => `\`${k}\``).join(", ") : "(none)"}`);
    if (f.sensitiveKeyHits.length > 0) {
      lines.push(`- sensitiveKeys: ${f.sensitiveKeyHits.map((k) => `\`${k}\``).join(", ")}`);
    }
    if (f.warnings.length > 0) {
      lines.push("- warnings:");
      for (const w of f.warnings) lines.push(`  - ${w}`);
    }
    if (f.fieldSummary.length > 0) {
      lines.push("");
      lines.push("| key | coverage% | types | string-length buckets |");
      lines.push("| --- | ---: | --- | --- |");
      for (const fs of f.fieldSummary) {
        const types = Object.entries(fs.typeBreakdown)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        const buckets = fs.stringLengthHistogram
          ? Object.entries(fs.stringLengthHistogram)
              .map(([k, v]) => `${k}:${v}`)
              .join(" ")
          : "—";
        lines.push(`| \`${fs.key}\` | ${fs.coveragePct} | ${types} | ${buckets} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- main ----------
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);

  if (!fs.existsSync(dir)) {
    console.error(`[weread:inspect] directory not found: ${dir}`);
    console.error(`[weread:inspect] STATUS=BLOCKED_FOR_RAW_EXPORT`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => path.join(dir, e.name))
    .sort();

  const inventories = files.map(inventoryFile);
  const totalRecords = inventories.reduce((s, f) => s + f.recordCount, 0);
  const sensitiveTotal = inventories.reduce(
    (s, f) => s + f.sensitiveKeyHits.length,
    0,
  );
  const warnings: string[] = [];
  if (files.length === 0) {
    warnings.push(
      `no JSON files in ${dir}; place WeRead raw exports here and re-run`,
    );
  }

  const report: InventoryReport = {
    generatedAt: new Date().toISOString(),
    dir: args.dir,
    totalFiles: files.length,
    totalRecords,
    files: inventories,
    warnings,
    sensitiveWarningsTotal: sensitiveTotal,
  };

  // ---------- stdout: counts only, no values ----------
  console.log(`[weread:inspect] dir=${args.dir}`);
  console.log(`[weread:inspect] totalFiles=${report.totalFiles}`);
  console.log(`[weread:inspect] totalRecords=${report.totalRecords}`);
  console.log(`[weread:inspect] sensitiveWarningsTotal=${report.sensitiveWarningsTotal}`);
  for (const f of report.files) {
    console.log(
      `  - ${f.file}: type=${f.topLevelType} count=${f.recordCount} keys=${f.topLevelKeys.length} sensitiveKeys=${f.sensitiveKeyHits.length}`,
    );
    for (const w of f.warnings) console.log(`    ! ${w}`);
  }
  for (const w of warnings) console.log(`  ! ${w}`);

  let status: "PASS" | "WARN" | "FAIL" | "BLOCKED_FOR_RAW_EXPORT" = "PASS";
  if (files.length === 0) status = "BLOCKED_FOR_RAW_EXPORT";
  else if (sensitiveTotal > 0) status = "WARN";
  console.log(`[weread:inspect] STATUS=${status}`);

  // ---------- file outputs ----------
  if (args.outJson) {
    const outDir = path.dirname(args.outJson);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.outJson, JSON.stringify(report, null, 2) + "\n");
    console.log(`[weread:inspect] wrote ${args.outJson}`);
  }
  if (args.outMd) {
    const outDir = path.dirname(args.outMd);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.outMd, renderMarkdown(report) + "\n");
    console.log(`[weread:inspect] wrote ${args.outMd}`);
  }

  if (status === "BLOCKED_FOR_RAW_EXPORT") process.exit(1);
}

// Only auto-invoke main() when this file is the actual CLI entry point.
// When imported from tests, `process.argv[1]` will not match this file.
import { fileURLToPath } from "node:url";
const isCliEntry =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCliEntry) {
  main();
}