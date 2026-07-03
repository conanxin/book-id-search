#!/usr/bin/env tsx
/**
 * S26I: Audit confirmed WeRead matches.
 *
 * Inputs:
 *   --confirmed private-data/weread/derived/latest/weread-matches.confirmed.json
 *   --review    private-data/weread/derived/latest/weread-match-review.json
 *   --out       private-data/weread/derived/latest/weread-confirmed-audit.json
 *   --summary   private-data/weread/derived/latest/weread-confirmed-audit-summary.json
 *
 * Privacy:
 *   - private audit file may contain wereadBookId/catalogId because it is not committed.
 *   - stdout only prints counts and high-level status.
 */
import fs from "node:fs";
import process from "node:process";

// ---------- types ----------
type MatchMethod = "isbn" | "title_author" | "title_similarity" | "manual";
type MatchConfidence = "high" | "medium" | "low";
type DecisionSource = "auto_seed" | "manual" | "auto_high_confidence";

type ConfirmedMatch = {
  wereadBookId: string;
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
  decisionSource: DecisionSource;
  confirmedAt?: string;
  confirmedBy?: string;
};

type MatchCandidate = {
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  title: string;
  author: string;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
  reason: string;
};

type ReviewStatus = "pending" | "accepted" | "rejected" | "needs_manual_search";

type ReviewItem = {
  reviewId: string;
  wereadBookId: string;
  wereadTitle: string;
  wereadAuthor: string;
  status: ReviewStatus;
  decisionSource: DecisionSource;
  selectedCatalogId: string | null;
  selectedCandidateIndex: number | null;
  confidence: MatchConfidence | "none";
  reason: string;
  candidates: MatchCandidate[];
  notes: string;
};

type AuditRow = ConfirmedMatch & {
  invalid: boolean;
  invalidReasons: string[];
};

type DuplicateGroup = {
  key: string;
  count: number;
  entries: { wereadBookId: string; catalogId: string; ssid: string; dxid: string; matchMethod: MatchMethod }[];
};

type AuditSummary = {
  status: "PASS" | "WARN" | "BLOCKED";
  confirmedEntries: number;
  uniqueWereadBookIds: number;
  uniqueCatalogIds: number;
  duplicateCatalogIdGroups: number;
  duplicateCatalogIdEntries: number;
  duplicateWereadBookIdGroups: number;
  duplicateWereadBookIdEntries: number;
  invalidRows: number;
  warnings: number;
  matchMethodDistribution: Record<string, number>;
  matchConfidenceDistribution: Record<string, number>;
  decisionSourceDistribution: Record<string, number>;
  reviewConsistencyWarnings: number;
  reviewConsistencyErrors: number;
  generatedAt: string;
};

type AuditOutput = {
  summary: AuditSummary;
  duplicateCatalogIdGroups: DuplicateGroup[];
  duplicateWereadBookIdGroups: DuplicateGroup[];
  invalidRows: AuditRow[];
  warnings: string[];
};

// ---------- args ----------
interface Args {
  confirmedPath: string;
  reviewPath: string;
  outPath: string;
  summaryPath: string;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return null;
    return argv[i + 1] as string;
  };
  return {
    confirmedPath: get("--confirmed") ?? "private-data/weread/derived/latest/weread-matches.confirmed.json",
    reviewPath: get("--review") ?? "private-data/weread/derived/latest/weread-match-review.json",
    outPath: get("--out") ?? "private-data/weread/derived/latest/weread-confirmed-audit.json",
    summaryPath: get("--summary") ?? "private-data/weread/derived/latest/weread-confirmed-audit-summary.json",
  };
}

// ---------- validation ----------
const VALID_METHODS: MatchMethod[] = ["isbn", "title_author", "title_similarity", "manual"];
const VALID_CONFIDENCES: MatchConfidence[] = ["high", "medium", "low"];
const VALID_SOURCES: DecisionSource[] = ["auto_seed", "manual", "auto_high_confidence"];
const SSID_DXID_RE = /^[0-9_]+$/;
const CATALOG_ID_RE = /^[0-9]+_[0-9]+$/;

function validateRow(row: ConfirmedMatch): string[] {
  const reasons: string[] = [];
  if (!row.wereadBookId || typeof row.wereadBookId !== "string") reasons.push("missing wereadBookId");
  if (!row.catalogId || typeof row.catalogId !== "string") reasons.push("missing catalogId");
  else if (!CATALOG_ID_RE.test(row.catalogId)) reasons.push("invalid catalogId format");
  if (!row.ssid || typeof row.ssid !== "string" || !SSID_DXID_RE.test(row.ssid)) reasons.push("invalid ssid");
  if (!row.dxid || typeof row.dxid !== "string" || !SSID_DXID_RE.test(row.dxid)) reasons.push("invalid dxid");
  if (!VALID_METHODS.includes(row.matchMethod as MatchMethod)) reasons.push(`invalid matchMethod: ${row.matchMethod}`);
  if (!VALID_CONFIDENCES.includes(row.matchConfidence as MatchConfidence)) reasons.push(`invalid matchConfidence: ${row.matchConfidence}`);
  if (!VALID_SOURCES.includes(row.decisionSource as DecisionSource)) reasons.push(`invalid decisionSource: ${row.decisionSource}`);
  if (row.confirmedAt !== undefined && typeof row.confirmedAt !== "string") reasons.push("invalid confirmedAt");
  return reasons;
}

// ---------- distribution ----------
function distribution<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) {
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

// ---------- grouping ----------
function buildDuplicateGroups<T extends { wereadBookId: string; catalogId: string; ssid: string; dxid: string; matchMethod: MatchMethod }>(
  items: T[],
  keyFn: (x: T) => string
): DuplicateGroup[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, arr] of map.entries()) {
    if (arr.length > 1) {
      groups.push({
        key,
        count: arr.length,
        entries: arr.map((e) => ({
          wereadBookId: e.wereadBookId,
          catalogId: e.catalogId,
          ssid: e.ssid,
          dxid: e.dxid,
          matchMethod: e.matchMethod,
        })),
      });
    }
  }
  return groups;
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const confirmed: ConfirmedMatch[] = JSON.parse(fs.readFileSync(args.confirmedPath, "utf8"));
  const reviewItems: ReviewItem[] = fs.existsSync(args.reviewPath)
    ? JSON.parse(fs.readFileSync(args.reviewPath, "utf8"))
    : [];

  const reviewByWereadId = new Map<string, ReviewItem>();
  for (const r of reviewItems) {
    if (r?.wereadBookId) reviewByWereadId.set(r.wereadBookId, r);
  }

  // validation
  const auditRows: AuditRow[] = confirmed.map((row) => {
    const invalidReasons = validateRow(row);
    return { ...row, invalid: invalidReasons.length > 0, invalidReasons };
  });
  const invalidRows = auditRows.filter((r) => r.invalid);

  // duplicates
  const catalogIdGroups = buildDuplicateGroups(confirmed, (r) => r.catalogId);
  const wereadBookIdGroups = buildDuplicateGroups(confirmed, (r) => r.wereadBookId);

  // review consistency
  const consistencyWarnings: string[] = [];
  const consistencyErrors: string[] = [];
  for (const row of confirmed) {
    const review = reviewByWereadId.get(row.wereadBookId);
    if (!review) {
      consistencyWarnings.push(`wereadBookId ${row.wereadBookId} not found in review queue`);
      continue;
    }
    if (review.status !== "accepted") {
      consistencyErrors.push(`wereadBookId ${row.wereadBookId} review status is ${review.status}`);
    }
    if (review.selectedCatalogId && review.selectedCatalogId !== row.catalogId) {
      consistencyErrors.push(`wereadBookId ${row.wereadBookId} selectedCatalogId mismatch`);
    }
  }

  const summary: AuditSummary = {
    status: "PASS",
    confirmedEntries: confirmed.length,
    uniqueWereadBookIds: new Set(confirmed.map((r) => r.wereadBookId)).size,
    uniqueCatalogIds: new Set(confirmed.map((r) => r.catalogId)).size,
    duplicateCatalogIdGroups: catalogIdGroups.length,
    duplicateCatalogIdEntries: catalogIdGroups.reduce((acc, g) => acc + g.count, 0),
    duplicateWereadBookIdGroups: wereadBookIdGroups.length,
    duplicateWereadBookIdEntries: wereadBookIdGroups.reduce((acc, g) => acc + g.count, 0),
    invalidRows: invalidRows.length,
    warnings: consistencyWarnings.length + consistencyErrors.length + catalogIdGroups.length,
    matchMethodDistribution: distribution(confirmed.map((r) => r.matchMethod)),
    matchConfidenceDistribution: distribution(confirmed.map((r) => r.matchConfidence)),
    decisionSourceDistribution: distribution(confirmed.map((r) => r.decisionSource)),
    reviewConsistencyWarnings: consistencyWarnings.length,
    reviewConsistencyErrors: consistencyErrors.length,
    generatedAt: new Date().toISOString(),
  };

  if (invalidRows.length > 0 || wereadBookIdGroups.length > 0 || consistencyErrors.length > 0) {
    summary.status = "BLOCKED";
  } else if (consistencyWarnings.length > 0 || catalogIdGroups.length > 0) {
    summary.status = "WARN";
  } else {
    summary.status = "PASS";
  }

  const output: AuditOutput = {
    summary,
    duplicateCatalogIdGroups: catalogIdGroups,
    duplicateWereadBookIdGroups: wereadBookIdGroups,
    invalidRows,
    warnings: [...consistencyWarnings, ...consistencyErrors],
  };

  fs.writeFileSync(args.outPath, JSON.stringify(output, null, 2));
  fs.writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2));

  // stdout only counts
  console.log(`[weread:confirmed:audit] STATUS=${summary.status}`);
  console.log(`[weread:confirmed:audit] confirmedEntries=${summary.confirmedEntries}`);
  console.log(`[weread:confirmed:audit] uniqueWereadBookIds=${summary.uniqueWereadBookIds}`);
  console.log(`[weread:confirmed:audit] uniqueCatalogIds=${summary.uniqueCatalogIds}`);
  console.log(`[weread:confirmed:audit] duplicateCatalogIdGroups=${summary.duplicateCatalogIdGroups}`);
  console.log(`[weread:confirmed:audit] duplicateCatalogIdEntries=${summary.duplicateCatalogIdEntries}`);
  console.log(`[weread:confirmed:audit] duplicateWereadBookIdGroups=${summary.duplicateWereadBookIdGroups}`);
  console.log(`[weread:confirmed:audit] duplicateWereadBookIdEntries=${summary.duplicateWereadBookIdEntries}`);
  console.log(`[weread:confirmed:audit] invalidRows=${summary.invalidRows}`);
  console.log(`[weread:confirmed:audit] reviewConsistencyWarnings=${summary.reviewConsistencyWarnings}`);
  console.log(`[weread:confirmed:audit] reviewConsistencyErrors=${summary.reviewConsistencyErrors}`);
  console.log(`[weread:confirmed:audit] warnings=${summary.warnings}`);
  console.log(`[weread:confirmed:audit] matchMethodDistribution=${JSON.stringify(summary.matchMethodDistribution)}`);
  console.log(`[weread:confirmed:audit] matchConfidenceDistribution=${JSON.stringify(summary.matchConfidenceDistribution)}`);
  console.log(`[weread:confirmed:audit] decisionSourceDistribution=${JSON.stringify(summary.decisionSourceDistribution)}`);

  if (summary.status === "BLOCKED") process.exit(1);
  if (summary.status === "WARN") process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((err) => {
    console.error(`[weread:confirmed:audit] ERROR: ${err.message}`);
    process.exit(1);
  });
}
