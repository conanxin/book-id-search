/**
 * S27Q-1B — Long-term Reading Data Quality Audit Model (full).
 *
 * Pure front-end, no network, no AI, no persistence.
 *
 * Privacy contract:
 *   - Never reads private note content, note comments, marked text, private book ids,
 *     note identifiers, highlight identifiers, chapter titles, tokens, or raw requests.
 *   - Only consumes public aggregate fields from the reading archive.
 *   - Issues and debug snapshots never contain catalogId, title, author,
 *     publisher, or any private identifier.
 *   - No evaluative wording about reading ability, interest, psychology,
 *     growth, or quality.
 *
 * Field name mapping (archive → spec terms):
 *   ReadingArchiveYearLink:
 *     sharedTopBooks → commonBooks (archive has no unionBooks)
 *     overlapRatio stays as-is (0 when union size is 0)
 *   ReadingArchiveRecurringBook:
 *     years         → appearances
 *     yearsOnList   → appearanceCount
 *     bestRank / latestYear / latestRank stay as-is
 *
 * Determinism: all outputs are pure functions of the input. Issue IDs
 * are derived from structural fields (scope:code:year:fromYear:toYear:
 * itemIndex:rank), not random or position-based. Sorting is stable
 * across repeated calls with the same input.
 *
 * No yearLink or recurring audit work is deferred. The audit pipeline
 * is complete in this round. The Phase A report and commit are
 * deferred to S27Q-1C per spec.
 */

import type {
  ReadingArchiveRecurringBook,
  ReadingArchiveYear,
  ReadingArchiveYearLink,
  WereadReadingArchive,
} from "./wereadReadingArchiveModel";

// ---------- public types ----------

export type ReadingDataQualitySeverity = "error" | "warning" | "info";
export type ReadingDataQualityScope =
  | "archive"
  | "coverage"
  | "year"
  | "top_book"
  | "year_link"
  | "recurring_book";
export type ReadingDataQualityStatus = "pass" | "warn" | "fail";

/**
 * Issue codes:
 *   coverage:   empty_archive, partial_archive, target_year_unaccounted,
 *               loaded_failed_conflict, duplicate_loaded_year, invalid_year
 *   year:       non_finite_metric, negative_metric, dated_records_exceed_total,
 *               matched_records_exceed_total, matched_books_exceed_matched_records,
 *               active_months_out_of_range, streak_months_out_of_range,
 *               streak_exceeds_active_months, peak_month_year_mismatch
 *   top_book:   top_books_exceed_limit, top_book_missing_catalog,
 *               top_book_duplicate_catalog, top_book_missing_title,
 *               top_book_invalid_rank, top_book_duplicate_rank,
 *               top_book_records_exceed_year_total, top_book_order_mismatch
 *   year_link:  year_link_unknown_year, year_link_invalid_order,
 *               year_link_duplicate_pair, year_link_invalid_counts,
 *               year_link_ratio_out_of_range, year_link_ratio_mismatch,
 *               missing_year_link
 *   recurring:  recurring_duplicate_catalog, recurring_appearance_count_mismatch,
 *               recurring_unknown_year, recurring_duplicate_year,
 *               recurring_invalid_rank, recurring_latest_year_mismatch
 */
export type ReadingDataQualityIssueCode =
  | "empty_archive"
  | "partial_archive"
  | "target_year_unaccounted"
  | "loaded_failed_conflict"
  | "duplicate_loaded_year"
  | "invalid_year"
  | "non_finite_metric"
  | "negative_metric"
  | "dated_records_exceed_total"
  | "matched_records_exceed_total"
  | "matched_books_exceed_matched_records"
  | "active_months_out_of_range"
  | "streak_months_out_of_range"
  | "streak_exceeds_active_months"
  | "peak_month_year_mismatch"
  | "top_books_exceed_limit"
  | "top_book_missing_catalog"
  | "top_book_duplicate_catalog"
  | "top_book_missing_title"
  | "top_book_invalid_rank"
  | "top_book_duplicate_rank"
  | "top_book_records_exceed_year_total"
  | "top_book_order_mismatch"
  | "year_link_unknown_year"
  | "year_link_invalid_order"
  | "year_link_duplicate_pair"
  | "year_link_invalid_counts"
  | "year_link_ratio_out_of_range"
  | "year_link_ratio_mismatch"
  | "missing_year_link"
  | "recurring_duplicate_catalog"
  | "recurring_appearance_count_mismatch"
  | "recurring_unknown_year"
  | "recurring_duplicate_year"
  | "recurring_invalid_rank"
  | "recurring_latest_year_mismatch";

export interface ReadingDataQualityIssue {
  id: string;
  code: ReadingDataQualityIssueCode;
  severity: ReadingDataQualitySeverity;
  scope: ReadingDataQualityScope;
  year?: number;
  fromYear?: number;
  toYear?: number;
  itemIndex?: number | null;
  rank?: number | null;
  actual?: number | string | null;
  expected?: number | string | null;
}

export interface ReadingDataQualityAuditSummary {
  status: ReadingDataQualityStatus;
  targetYearCount: number;
  loadedYearCount: number;
  failedYearCount: number;
  unaccountedYearCount: number;
  totalRecords: number;
  datedRecords: number;
  matchedRecords: number;
  matchedBooks: number;
  datedRecordRatio: number;
  matchedRecordRatio: number;
  publicTopBookMetadataRatio: number;
  yearLinkCoverageRatio: number;
  accountedRatio: number;
  issueCounts: { error: number; warning: number; info: number };
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export interface ReadingDataQualityCoverageSection {
  targetYears: number[];
  loadedYears: number[];
  failedYears: number[];
  unaccountedYears: number[];
  unexpectedLoadedYears: number[];
}

export interface ReadingDataQualityAuditMeta {
  source: "current_loaded_archive";
  persisted: false;
  requestedNetwork: false;
}

export interface WereadReadingDataQualityAudit {
  status: ReadingDataQualityStatus;
  issues: ReadingDataQualityIssue[];
  coverage: ReadingDataQualityCoverageSection;
  summary: ReadingDataQualityAuditSummary;
  meta: ReadingDataQualityAuditMeta;
  auditedAt: Date;
}

export interface ReadingDataQualityAuditInput {
  archive: WereadReadingArchive;
  targetYears: ReadonlyArray<number | null | undefined>;
  failedYears: ReadonlyArray<number | null | undefined>;
  topBooksLimit: 6 | 12 | 18;
  /**
   * Optional per-book metadata for Top N audit checks that need
   * fields not present in `ReadingArchiveYear` (title, rank, records).
   * When omitted, the corresponding checks are no-ops and
   * publicTopBookMetadataRatio treats all entries as metadata-valid.
   */
  topBookMetadata?: ReadonlyArray<TopBookAuditMetadata>;
}

// ---------- per-function simple input types (test-friendly) ----------

export interface AuditYearCoverageArgs {
  targetYears: ReadonlyArray<unknown>;
  loadedYears: ReadonlyArray<unknown>;
  failedYears: ReadonlyArray<unknown>;
}

export interface AuditYearMetricsArgs {
  years: ReadonlyArray<ReadingArchiveYear>;
}

export interface TopBookAuditBook {
  title?: string | null;
  rank?: number;
  records?: number;
}

export interface TopBookAuditMetadata {
  year: number;
  books: ReadonlyArray<TopBookAuditBook>;
}

export interface AuditTopBooksArgs {
  years: ReadonlyArray<ReadingArchiveYear>;
  topBooksLimit: 6 | 12 | 18;
  bookMetadata?: ReadonlyArray<TopBookAuditMetadata>;
}

export interface AuditYearLinksArgs {
  years: ReadonlyArray<ReadingArchiveYear>;
  yearLinks: ReadonlyArray<ReadingArchiveYearLink>;
}

export interface AuditRecurringBooksArgs {
  years: ReadonlyArray<ReadingArchiveYear>;
  recurringBooks: ReadonlyArray<ReadingArchiveRecurringBook>;
}

// ---------- constants ----------

const READING_DATA_QUALITY_CURRENT_YEAR = new Date().getFullYear();
const READING_DATA_QUALITY_MIN_YEAR = 1900;
const READING_DATA_QUALITY_MAX_YEAR = READING_DATA_QUALITY_CURRENT_YEAR + 1;

/**
 * Stable per-field index used in non_finite_metric / negative_metric
 * Issue itemIndex. Disambiguates multiple identical-code Issues fired
 * in the same year against different fields. Includes every numeric
 * metric field actually present in ReadingArchiveYear.
 */
const YEAR_METRIC_INDEX = {
  totalRecords: 0,
  datedRecords: 1,
  matchedRecords: 2,
  matchedBooks: 3,
  activeMonths: 4,
  longestStreakMonths: 5,
  peakMonthRecords: 6,
  averageRecordsPerActiveMonth: 7,
  topBookCount: 8,
} as const;

const SCOPE_ORDER: Record<ReadingDataQualityScope, number> = {
  archive: 0,
  coverage: 1,
  year: 2,
  top_book: 3,
  year_link: 4,
  recurring_book: 5,
};

const SEVERITY_ORDER: Record<ReadingDataQualitySeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const ID_PLACEHOLDER = "-";

type YearMetricKey = keyof typeof YEAR_METRIC_INDEX;

// ---------- helpers ----------

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isValidMonthString(value: string): {
  valid: boolean;
  year: number | null;
  month: number | null;
} {
  const match = /^([0-9]{4})-([0-9]{2})$/.exec(value);
  if (!match) return { valid: false, year: null, month: null };
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12) return { valid: false, year, month };
  return { valid: true, year, month };
}

function newIssue(
  draft: Omit<ReadingDataQualityIssue, "id">
): ReadingDataQualityIssue {
  return { ...draft, id: "" };
}

/**
 * Deterministic issue ID derived from structural fields.
 * Format: scope:code:year:fromYear:toYear:itemIndex:rank
 * Empty fields use "-" placeholder. No UUIDs, no positional counters.
 */
function formatIssueId(
  issue: Omit<ReadingDataQualityIssue, "id">
): string {
  const parts: Array<string | number> = [
    issue.scope,
    issue.code,
    issue.year ?? ID_PLACEHOLDER,
    issue.fromYear ?? ID_PLACEHOLDER,
    issue.toYear ?? ID_PLACEHOLDER,
    issue.itemIndex ?? ID_PLACEHOLDER,
    issue.rank ?? ID_PLACEHOLDER,
  ];
  return parts.join(":");
}

function assignIssueIds(
  issues: ReadingDataQualityIssue[]
): ReadingDataQualityIssue[] {
  return issues.map((issue) => ({
    ...issue,
    id: formatIssueId(issue),
  }));
}

function sortIssues(
  issues: ReadingDataQualityIssue[]
): ReadingDataQualityIssue[] {
  return [...issues].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    const scope = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    if (scope !== 0) return scope;
    const aYear = a.year ?? a.fromYear ?? Number.NEGATIVE_INFINITY;
    const bYear = b.year ?? b.fromYear ?? Number.NEGATIVE_INFINITY;
    if (aYear !== bYear) return aYear - bYear;
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    const aIndex = a.itemIndex ?? Number.NEGATIVE_INFINITY;
    const bIndex = b.itemIndex ?? Number.NEGATIVE_INFINITY;
    if (aIndex !== bIndex) return aIndex - bIndex;
    const aRank = a.rank ?? Number.NEGATIVE_INFINITY;
    const bRank = b.rank ?? Number.NEGATIVE_INFINITY;
    return aRank - bRank;
  });
}

function buildIssueCounts(issues: ReadingDataQualityIssue[]): {
  error: number;
  warning: number;
  info: number;
} {
  return {
    error: issues.filter((i) => i.severity === "error").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
}

function deriveStatus(
  issues: ReadingDataQualityIssue[]
): ReadingDataQualityStatus {
  if (issues.some((i) => i.severity === "error")) return "fail";
  if (issues.some((i) => i.severity === "warning")) return "warn";
  return "pass";
}

/**
 * Safe total: only adds finite non-negative numbers; non-finite or
 * negative values contribute 0. Does NOT mutate inputs.
 */
function safeSumYears(
  years: ReadonlyArray<ReadingArchiveYear>,
  field: (y: ReadingArchiveYear) => number
): number {
  let sum = 0;
  for (const y of years) {
    const v = field(y);
    if (isFiniteNumber(v) && v >= 0) sum += v;
  }
  return sum;
}

// ---------- year normalization ----------

export function normalizeReadingDataQualityYears(
  years: ReadonlyArray<unknown>
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const y of years) {
    if (!isInteger(y)) continue;
    if (y < READING_DATA_QUALITY_MIN_YEAR) continue;
    if (y > READING_DATA_QUALITY_MAX_YEAR) continue;
    if (seen.has(y)) continue;
    seen.add(y);
    out.push(y);
  }
  out.sort((a, b) => a - b);
  return out;
}

// ---------- coverage audit ----------

export function auditReadingYearCoverage(
  args: AuditYearCoverageArgs
): ReadingDataQualityIssue[] {
  const issues: ReadingDataQualityIssue[] = [];
  const targetYears = normalizeReadingDataQualityYears(args.targetYears);
  const failedYears = normalizeReadingDataQualityYears(args.failedYears);
  const loadedYears = normalizeReadingDataQualityYears(args.loadedYears);

  const seenInvalid = new Set<string>();
  for (const list of [
    { scope: "target" as const, values: args.targetYears },
    { scope: "loaded" as const, values: args.loadedYears },
    { scope: "failed" as const, values: args.failedYears },
  ]) {
    for (const y of list.values) {
      if (y === null || y === undefined) continue;
      if (!isInteger(y)) {
        const key = `non-integer-${list.scope}-${String(y)}`;
        if (!seenInvalid.has(key)) {
          seenInvalid.add(key);
          issues.push(
            newIssue({
              code: "invalid_year",
              severity: "error",
              scope: "coverage",
              actual: isFiniteNumber(y) ? y : null,
            })
          );
        }
        continue;
      }
      if (
        y < READING_DATA_QUALITY_MIN_YEAR ||
        y > READING_DATA_QUALITY_MAX_YEAR
      ) {
        const key = `out-of-range-${list.scope}-${y}`;
        if (!seenInvalid.has(key)) {
          seenInvalid.add(key);
          issues.push(
            newIssue({
              code: "invalid_year",
              severity: "error",
              scope: "coverage",
              actual: y,
            })
          );
        }
      }
    }
  }

  const seenLoaded = new Set<number>();
  let loadedDupCount = 0;
  for (const y of args.loadedYears) {
    if (!isInteger(y)) continue;
    if (seenLoaded.has(y)) {
      loadedDupCount += 1;
    } else {
      seenLoaded.add(y);
    }
  }
  if (loadedDupCount > 0) {
    issues.push(
      newIssue({
        code: "duplicate_loaded_year",
        severity: "error",
        scope: "coverage",
        actual: loadedDupCount + 1,
        expected: 1,
      })
    );
  }

  for (const y of loadedYears) {
    if (failedYears.includes(y)) {
      issues.push(
        newIssue({
          code: "loaded_failed_conflict",
          severity: "error",
          scope: "coverage",
          year: y,
        })
      );
    }
  }

  for (let i = targetYears.length - 1; i >= 0; i--) {
    const y = targetYears[i];
    if (!loadedYears.includes(y) && !failedYears.includes(y)) {
      issues.push(
        newIssue({
          code: "target_year_unaccounted",
          severity: "warning",
          scope: "coverage",
          year: y,
        })
      );
    }
  }

  if (failedYears.length > 0 && loadedYears.length > 0) {
    issues.push(
      newIssue({
        code: "partial_archive",
        severity: "warning",
        scope: "archive",
      })
    );
  }

  if (loadedYears.length === 0 && targetYears.length === 0) {
    issues.push(
      newIssue({
        code: "empty_archive",
        severity: "info",
        scope: "archive",
      })
    );
  }

  return issues;
}

// ---------- year metrics audit ----------

export function auditReadingDataQualityYears(
  args: AuditYearMetricsArgs
): ReadingDataQualityIssue[] {
  const issues: ReadingDataQualityIssue[] = [];

  for (const year of args.years) {
    const y = year.year;

    // Iterate YEAR_METRIC_INDEX for deterministic per-field itemIndex.
    for (const [key, itemIndex] of Object.entries(YEAR_METRIC_INDEX)) {
      const fieldKey = key as YearMetricKey;
      const value = year[fieldKey] as number;
      if (!isFiniteNumber(value)) {
        issues.push(
          newIssue({
            code: "non_finite_metric",
            severity: "error",
            scope: "year",
            year: y,
            itemIndex,
            actual: null,
          })
        );
      } else if (value < 0) {
        issues.push(
          newIssue({
            code: "negative_metric",
            severity: "error",
            scope: "year",
            year: y,
            itemIndex,
            actual: value,
            expected: 0,
          })
        );
      }
    }

    if (
      isFiniteNumber(year.datedRecords) &&
      isFiniteNumber(year.totalRecords) &&
      year.datedRecords > year.totalRecords
    ) {
      issues.push(
        newIssue({
          code: "dated_records_exceed_total",
          severity: "error",
          scope: "year",
          year: y,
          actual: year.datedRecords,
          expected: year.totalRecords,
        })
      );
    }

    if (
      isFiniteNumber(year.matchedRecords) &&
      isFiniteNumber(year.totalRecords) &&
      year.matchedRecords > year.totalRecords
    ) {
      issues.push(
        newIssue({
          code: "matched_records_exceed_total",
          severity: "error",
          scope: "year",
          year: y,
          actual: year.matchedRecords,
          expected: year.totalRecords,
        })
      );
    }

    if (
      isFiniteNumber(year.matchedBooks) &&
      isFiniteNumber(year.matchedRecords) &&
      year.matchedBooks > year.matchedRecords
    ) {
      issues.push(
        newIssue({
          code: "matched_books_exceed_matched_records",
          severity: "error",
          scope: "year",
          year: y,
          actual: year.matchedBooks,
          expected: year.matchedRecords,
        })
      );
    }

    if (
      isFiniteNumber(year.activeMonths) &&
      (year.activeMonths < 0 || year.activeMonths > 12)
    ) {
      issues.push(
        newIssue({
          code: "active_months_out_of_range",
          severity: "error",
          scope: "year",
          year: y,
          actual: year.activeMonths,
          expected: 12,
        })
      );
    }

    if (
      isFiniteNumber(year.longestStreakMonths) &&
      (year.longestStreakMonths < 0 || year.longestStreakMonths > 12)
    ) {
      issues.push(
        newIssue({
          code: "streak_months_out_of_range",
          severity: "error",
          scope: "year",
          year: y,
          actual: year.longestStreakMonths,
          expected: 12,
        })
      );
    }

    if (
      isFiniteNumber(year.longestStreakMonths) &&
      isFiniteNumber(year.activeMonths) &&
      year.longestStreakMonths > year.activeMonths
    ) {
      issues.push(
        newIssue({
          code: "streak_exceeds_active_months",
          severity: "error",
          scope: "year",
          year: y,
          actual: year.longestStreakMonths,
          expected: year.activeMonths,
        })
      );
    }

    if (year.peakMonth !== null && year.peakMonth !== undefined) {
      if (typeof year.peakMonth !== "string") {
        issues.push(
          newIssue({
            code: "peak_month_year_mismatch",
            severity: "error",
            scope: "year",
            year: y,
            actual: null,
            expected: y,
          })
        );
      } else {
        const parsed = isValidMonthString(year.peakMonth);
        if (!parsed.valid) {
          issues.push(
            newIssue({
              code: "peak_month_year_mismatch",
              severity: "error",
              scope: "year",
              year: y,
              actual: year.peakMonth,
              expected: y,
            })
          );
        } else if (parsed.year !== y) {
          issues.push(
            newIssue({
              code: "peak_month_year_mismatch",
              severity: "error",
              scope: "year",
              year: y,
              actual: parsed.year ?? null,
              expected: y,
            })
          );
        }
        if (year.activeMonths === 0) {
          issues.push(
            newIssue({
              code: "peak_month_year_mismatch",
              severity: "warning",
              scope: "year",
              year: y,
              actual: year.peakMonth,
              expected: null,
            })
          );
        }
      }
    }
  }

  return issues;
}

// ---------- top books audit ----------

export function auditReadingDataQualityTopBooks(
  args: AuditTopBooksArgs
): ReadingDataQualityIssue[] {
  const issues: ReadingDataQualityIssue[] = [];

  const metadataByYear = new Map<number, ReadonlyArray<TopBookAuditBook>>();
  if (args.bookMetadata) {
    for (const m of args.bookMetadata) {
      metadataByYear.set(m.year, m.books ?? []);
    }
  }

  for (const year of args.years) {
    const ids = Array.isArray(year.topBookCatalogIds)
      ? year.topBookCatalogIds
      : [];
    const count = ids.length;

    if (count > args.topBooksLimit) {
      issues.push(
        newIssue({
          code: "top_books_exceed_limit",
          severity: "warning",
          scope: "top_book",
          year: year.year,
          actual: count,
          expected: args.topBooksLimit,
        })
      );
    }

    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (typeof id !== "string" || id.trim().length === 0) {
        issues.push(
          newIssue({
            code: "top_book_missing_catalog",
            severity: "error",
            scope: "top_book",
            year: year.year,
            itemIndex: i,
          })
        );
        continue;
      }
      if (seen.has(id)) {
        issues.push(
          newIssue({
            code: "top_book_duplicate_catalog",
            severity: "error",
            scope: "top_book",
            year: year.year,
            itemIndex: i,
          })
        );
      } else {
        seen.add(id);
      }
    }

    const meta = metadataByYear.get(year.year);
    if (meta) {
      for (let i = 0; i < meta.length; i++) {
        const book = meta[i];
        const t = book?.title;
        if (
          t === null ||
          t === undefined ||
          (typeof t === "string" && t.trim().length === 0)
        ) {
          issues.push(
            newIssue({
              code: "top_book_missing_title",
              severity: "error",
              scope: "top_book",
              year: year.year,
              itemIndex: i,
              actual: null,
              expected: "non-empty",
            })
          );
        }
      }

      const seenRanks = new Set<number>();
      for (let i = 0; i < meta.length; i++) {
        const r = meta[i]?.rank;
        if (r === undefined) continue;
        if (typeof r !== "number" || !Number.isInteger(r) || r <= 0) {
          issues.push(
            newIssue({
              code: "top_book_invalid_rank",
              severity: "error",
              scope: "top_book",
              year: year.year,
              itemIndex: i,
              rank: typeof r === "number" ? r : null,
              actual: typeof r === "number" ? r : null,
              expected: "positive_integer",
            })
          );
          continue;
        }
        if (seenRanks.has(r)) {
          issues.push(
            newIssue({
              code: "top_book_duplicate_rank",
              severity: "error",
              scope: "top_book",
              year: year.year,
              itemIndex: i,
              rank: r,
              actual: r,
              expected: "unique",
            })
          );
        } else {
          seenRanks.add(r);
        }
      }

      for (let i = 0; i < meta.length; i++) {
        const book = meta[i];
        const rec = book?.records;
        if (rec === undefined) continue;
        if (typeof rec !== "number" || !Number.isFinite(rec)) {
          issues.push(
            newIssue({
              code: "top_book_records_exceed_year_total",
              severity: "error",
              scope: "top_book",
              year: year.year,
              itemIndex: i,
              rank: typeof book?.rank === "number" ? book.rank : null,
              actual: null,
              expected: year.totalRecords,
            })
          );
          continue;
        }
        if (rec < 0 || rec > year.totalRecords) {
          issues.push(
            newIssue({
              code: "top_book_records_exceed_year_total",
              severity: "error",
              scope: "top_book",
              year: year.year,
              itemIndex: i,
              rank: typeof book?.rank === "number" ? book.rank : null,
              actual: rec,
              expected: year.totalRecords,
            })
          );
        }
      }

      for (let i = 0; i < meta.length; i++) {
        const r = meta[i]?.rank;
        if (r === undefined) continue;
        if (typeof r !== "number" || !Number.isInteger(r)) continue;
        if (r !== i + 1) {
          issues.push(
            newIssue({
              code: "top_book_order_mismatch",
              severity: "error",
              scope: "top_book",
              year: year.year,
              itemIndex: i,
              rank: r,
              actual: r,
              expected: i + 1,
            })
          );
        }
      }
    }
  }

  return issues;
}

// ---------- year link audit ----------

export function auditReadingDataQualityYearLinks(
  args: AuditYearLinksArgs
): { issues: ReadingDataQualityIssue[]; validExpectedPairCount: number; expectedPairCount: number } {
  const issues: ReadingDataQualityIssue[] = [];
  const loadedYears = normalizeReadingDataQualityYears(
    args.years.map((y) => y.year)
  );
  const loadedSet = new Set(loadedYears);

  // Expected adjacent pairs from sorted loaded years.
  const sortedLoaded = [...loadedSet].sort((a, b) => a - b);
  const expectedPairs = new Set<string>();
  for (let i = 0; i < sortedLoaded.length - 1; i++) {
    expectedPairs.add(`${sortedLoaded[i]}->${sortedLoaded[i + 1]}`);
  }

  const seenPairs = new Set<string>();
  let validExpectedPairCount = 0;

  for (let i = 0; i < args.yearLinks.length; i++) {
    const link = args.yearLinks[i];
    const fromYear = link.sourceYear;
    const toYear = link.targetYear;

    if (!loadedSet.has(fromYear)) {
      issues.push(
        newIssue({
          code: "year_link_unknown_year",
          severity: "error",
          scope: "year_link",
          itemIndex: i,
          fromYear,
          actual: null,
          expected: "loaded_year",
        })
      );
    }
    if (!loadedSet.has(toYear)) {
      issues.push(
        newIssue({
          code: "year_link_unknown_year",
          severity: "error",
          scope: "year_link",
          itemIndex: i,
          toYear,
          actual: null,
          expected: "loaded_year",
        })
      );
    }
    if (fromYear >= toYear) {
      issues.push(
        newIssue({
          code: "year_link_invalid_order",
          severity: "error",
          scope: "year_link",
          itemIndex: i,
          fromYear,
          toYear,
          actual: null,
          expected: "source<target",
        })
      );
    }

    // commonBooks = sharedTopBooks (archive has no unionBooks field)
    const commonBooks = link.sharedTopBooks;
    if (
      !isFiniteNumber(commonBooks) ||
      commonBooks < 0 ||
      !Number.isInteger(commonBooks)
    ) {
      issues.push(
        newIssue({
          code: "year_link_invalid_counts",
          severity: "error",
          scope: "year_link",
          itemIndex: i,
          fromYear,
          toYear,
          actual: isFiniteNumber(commonBooks) ? commonBooks : null,
          expected: "finite_non_negative_integer",
        })
      );
    }

    const ratio = link.overlapRatio;
    if (!isFiniteNumber(ratio) || ratio < 0 || ratio > 1) {
      issues.push(
        newIssue({
          code: "year_link_ratio_out_of_range",
          severity: "error",
          scope: "year_link",
          itemIndex: i,
          fromYear,
          toYear,
          actual: isFiniteNumber(ratio) ? ratio : null,
          expected: "0..1",
        })
      );
    }

    // unionBooks=0 → ratio must be 0. Without unionBooks field we
    // approximate: sharedTopBooks=0 implies ratio=0.
    if (isFiniteNumber(commonBooks) && isFiniteNumber(ratio)) {
      if (commonBooks === 0 && ratio !== 0) {
        issues.push(
          newIssue({
            code: "year_link_ratio_mismatch",
            severity: "error",
            scope: "year_link",
            itemIndex: i,
            fromYear,
            toYear,
            actual: ratio,
            expected: 0,
          })
        );
      }
      if (commonBooks > 0 && ratio === 0) {
        issues.push(
          newIssue({
            code: "year_link_ratio_mismatch",
            severity: "error",
            scope: "year_link",
            itemIndex: i,
            fromYear,
            toYear,
            actual: ratio,
            expected: "shared>0 implies ratio>0",
          })
        );
      }
    }

    const pairKey = `${fromYear}->${toYear}`;
    if (seenPairs.has(pairKey)) {
      issues.push(
        newIssue({
          code: "year_link_duplicate_pair",
          severity: "error",
          scope: "year_link",
          itemIndex: i,
          fromYear,
          toYear,
          actual: 2,
          expected: 1,
        })
      );
    } else {
      seenPairs.add(pairKey);
      const validPair =
        loadedSet.has(fromYear) &&
        loadedSet.has(toYear) &&
        fromYear < toYear &&
        isFiniteNumber(commonBooks) &&
        commonBooks >= 0 &&
        Number.isInteger(commonBooks) &&
        isFiniteNumber(ratio) &&
        ratio >= 0 &&
        ratio <= 1;
      if (validPair && expectedPairs.has(pairKey)) {
        validExpectedPairCount += 1;
      }
    }
  }

  // Missing expected pairs
  for (const pairKey of expectedPairs) {
    if (!seenPairs.has(pairKey)) {
      const [fromStr, toStr] = pairKey.split("->");
      const fromYear = parseInt(fromStr, 10);
      const toYear = parseInt(toStr, 10);
      issues.push(
        newIssue({
          code: "missing_year_link",
          severity: "warning",
          scope: "year_link",
          fromYear,
          toYear,
        })
      );
    }
  }

  return {
    issues,
    validExpectedPairCount,
    expectedPairCount: expectedPairs.size,
  };
}

// ---------- recurring books audit ----------

export function auditReadingDataQualityRecurringBooks(
  args: AuditRecurringBooksArgs
): ReadingDataQualityIssue[] {
  const issues: ReadingDataQualityIssue[] = [];
  const loadedYears = normalizeReadingDataQualityYears(
    args.years.map((y) => y.year)
  );
  const loadedSet = new Set(loadedYears);
  const seenCatalogs = new Set<string>();

  for (let i = 0; i < args.recurringBooks.length; i++) {
    const book = args.recurringBooks[i];

    if (seenCatalogs.has(book.catalogId)) {
      issues.push(
        newIssue({
          code: "recurring_duplicate_catalog",
          severity: "error",
          scope: "recurring_book",
          itemIndex: i,
        })
      );
    } else {
      seenCatalogs.add(book.catalogId);
    }

    // appearanceCount (= yearsOnList) must match appearances.length (= years.length)
    if (book.years.length !== book.yearsOnList) {
      issues.push(
        newIssue({
          code: "recurring_appearance_count_mismatch",
          severity: "error",
          scope: "recurring_book",
          itemIndex: i,
          actual: book.years.length,
          expected: book.yearsOnList,
        })
      );
    }

    const seenYears = new Set<number>();
    for (const y of book.years) {
      if (seenYears.has(y)) {
        issues.push(
          newIssue({
            code: "recurring_duplicate_year",
            severity: "error",
            scope: "recurring_book",
            itemIndex: i,
            year: y,
          })
        );
      } else {
        seenYears.add(y);
      }
      if (!loadedSet.has(y)) {
        issues.push(
          newIssue({
            code: "recurring_unknown_year",
            severity: "warning",
            scope: "recurring_book",
            itemIndex: i,
            year: y,
          })
        );
      }
    }

    if (!isPositiveInteger(book.bestRank)) {
      issues.push(
        newIssue({
          code: "recurring_invalid_rank",
          severity: "error",
          scope: "recurring_book",
          itemIndex: i,
          rank: typeof book.bestRank === "number" ? book.bestRank : null,
          actual: book.bestRank,
          expected: "positive_integer",
        })
      );
    }
    if (!isPositiveInteger(book.latestRank)) {
      issues.push(
        newIssue({
          code: "recurring_invalid_rank",
          severity: "error",
          scope: "recurring_book",
          itemIndex: i,
          rank: typeof book.latestRank === "number" ? book.latestRank : null,
          actual: book.latestRank,
          expected: "positive_integer",
        })
      );
    }

    // latestYear must be present in years
    if (book.years.length > 0 && !book.years.includes(book.latestYear)) {
      issues.push(
        newIssue({
          code: "recurring_latest_year_mismatch",
          severity: "error",
          scope: "recurring_book",
          itemIndex: i,
          year: book.latestYear,
          actual: book.latestYear,
          expected: Math.max(...book.years),
        })
      );
    }
    // latestYear must be finite non-negative integer
    if (!isInteger(book.latestYear) || book.latestYear < 0) {
      issues.push(
        newIssue({
          code: "recurring_latest_year_mismatch",
          severity: "error",
          scope: "recurring_book",
          itemIndex: i,
          actual: book.latestYear,
          expected: "non_negative_integer",
        })
      );
    }
  }

  return issues;
}

// ---------- summary builder ----------

function buildReadingDataQualitySummary(
  input: ReadingDataQualityAuditInput,
  issues: ReadingDataQualityIssue[],
  coverage: ReadingDataQualityCoverageSection,
  validExpectedPairCount: number,
  expectedPairCount: number
): ReadingDataQualityAuditSummary {
  const totalRecords = safeSumYears(input.archive.years, (y) => y.totalRecords);
  const datedRecords = safeSumYears(input.archive.years, (y) => y.datedRecords);
  const matchedRecords = safeSumYears(input.archive.years, (y) => y.matchedRecords);
  const matchedBooks = safeSumYears(input.archive.years, (y) => y.matchedBooks);

  // publicTopBookMetadataRatio: catalogId + title validity (B6)
  let totalTopBookElements = 0;
  let validTopBookElements = 0;
  if (input.topBookMetadata && input.topBookMetadata.length > 0) {
    const metaByYear = new Map<number, ReadonlyArray<TopBookAuditBook>>();
    for (const m of input.topBookMetadata) {
      metaByYear.set(m.year, m.books ?? []);
    }
    for (const year of input.archive.years) {
      const meta = metaByYear.get(year.year);
      const ids = year.topBookCatalogIds ?? [];
      for (let i = 0; i < ids.length; i++) {
        totalTopBookElements += 1;
        const id = ids[i];
        const title = meta?.[i]?.title;
        const validId = typeof id === "string" && id.trim().length > 0;
        const validTitle =
          typeof title === "string" && title.trim().length > 0;
        if (validId && validTitle) validTopBookElements += 1;
      }
    }
  } else {
    for (const year of input.archive.years) {
      for (const id of year.topBookCatalogIds ?? []) {
        totalTopBookElements += 1;
        if (typeof id === "string" && id.trim().length > 0) {
          validTopBookElements += 1;
        }
      }
    }
  }
  const publicTopBookMetadataRatio =
    totalTopBookElements === 0
      ? 1
      : round4(validTopBookElements / totalTopBookElements);

  const datedRecordRatio =
    totalRecords === 0 ? 1 : round4(datedRecords / totalRecords);
  const matchedRecordRatio =
    totalRecords === 0 ? 1 : round4(matchedRecords / totalRecords);

  const accountedYearCount =
    coverage.loadedYears.length + coverage.failedYears.length;
  const accountedRatio =
    coverage.targetYears.length === 0
      ? 1
      : round4(
          Math.min(
            1,
            Math.max(0, accountedYearCount / coverage.targetYears.length)
          )
        );

  const yearLinkCoverageRatio =
    expectedPairCount === 0
      ? 1
      : round4(
          Math.min(
            1,
            Math.max(0, validExpectedPairCount / expectedPairCount)
          )
        );

  const counts = buildIssueCounts(issues);

  return {
    status: deriveStatus(issues),
    targetYearCount: coverage.targetYears.length,
    loadedYearCount: coverage.loadedYears.length,
    failedYearCount: coverage.failedYears.length,
    unaccountedYearCount: coverage.unaccountedYears.length,
    totalRecords,
    datedRecords,
    matchedRecords,
    matchedBooks,
    datedRecordRatio,
    matchedRecordRatio,
    publicTopBookMetadataRatio,
    yearLinkCoverageRatio,
    accountedRatio,
    issueCounts: counts,
    errorCount: counts.error,
    warningCount: counts.warning,
    infoCount: counts.info,
  };
}

// ---------- main entry ----------

export function buildWereadReadingDataQualityAudit(
  input: ReadingDataQualityAuditInput
): WereadReadingDataQualityAudit {
  const loadedYears = normalizeReadingDataQualityYears(
    input.archive.years.map((y) => y.year)
  );
  const targetYears = normalizeReadingDataQualityYears(input.targetYears);
  const failedYears = normalizeReadingDataQualityYears(input.failedYears);
  const loadedSet = new Set(loadedYears);
  const failedSet = new Set(failedYears);
  const unaccountedYears = targetYears.filter(
    (y) => !loadedSet.has(y) && !failedSet.has(y)
  );
  const unexpectedLoadedYears = loadedYears.filter(
    (y) => !targetYears.includes(y)
  );

  const coverage: ReadingDataQualityCoverageSection = {
    targetYears,
    loadedYears,
    failedYears,
    unaccountedYears,
    unexpectedLoadedYears,
  };

  const coverageIssues = auditReadingYearCoverage({
    targetYears: input.targetYears,
    loadedYears: input.archive.years.map((y) => y.year),
    failedYears: input.failedYears,
  });
  const yearIssues = auditReadingDataQualityYears({
    years: input.archive.years,
  });
  const topBookIssues = auditReadingDataQualityTopBooks({
    years: input.archive.years,
    topBooksLimit: input.topBooksLimit,
    bookMetadata: input.topBookMetadata,
  });
  const yearLinkAudit = auditReadingDataQualityYearLinks({
    years: input.archive.years,
    yearLinks: input.archive.yearLinks,
  });
  const recurringIssues = auditReadingDataQualityRecurringBooks({
    years: input.archive.years,
    recurringBooks: input.archive.recurringBooks,
  });

  const allIssues = [
    ...coverageIssues,
    ...yearIssues,
    ...topBookIssues,
    ...yearLinkAudit.issues,
    ...recurringIssues,
  ];
  const sorted = sortIssues(allIssues);
  const issuesWithIds = assignIssueIds(sorted);
  const summary = buildReadingDataQualitySummary(
    input,
    issuesWithIds,
    coverage,
    yearLinkAudit.validExpectedPairCount,
    yearLinkAudit.expectedPairCount
  );

  return {
    status: deriveStatus(issuesWithIds),
    issues: issuesWithIds,
    coverage,
    summary,
    meta: {
      source: "current_loaded_archive",
      persisted: false,
      requestedNetwork: false,
    },
    auditedAt: new Date(),
  };
}

/** Alias matching the test-helper naming convention. */
export const auditReadingDataQuality = buildWereadReadingDataQualityAudit;

// ---------- debug snapshot ----------

/**
 * Safe debug snapshot. Only structural fields included. Excludes:
 * itemIndex, rank, actual, expected, totalRecords, catalogId, title,
 * author, raw archive, cache/request keys, token/private fields.
 */
export function buildReadingDataQualityDebugSnapshot(
  audit: WereadReadingDataQualityAudit
): object {
  return {
    status: audit.status,
    issueCounts: audit.summary.issueCounts,
    issues: audit.issues.map((issue) => ({
      id: issue.id,
      code: issue.code,
      severity: issue.severity,
      scope: issue.scope,
      year: issue.year,
      fromYear: issue.fromYear,
      toYear: issue.toYear,
    })),
    coverage: {
      targetYears: audit.coverage.targetYears,
      loadedYears: audit.coverage.loadedYears,
      failedYears: audit.coverage.failedYears,
      unaccountedYears: audit.coverage.unaccountedYears,
      unexpectedLoadedYears: audit.coverage.unexpectedLoadedYears,
    },
    ratios: {
      accountedRatio: audit.summary.accountedRatio,
      datedRecordRatio: audit.summary.datedRecordRatio,
      matchedRecordRatio: audit.summary.matchedRecordRatio,
      publicTopBookMetadataRatio: audit.summary.publicTopBookMetadataRatio,
      yearLinkCoverageRatio: audit.summary.yearLinkCoverageRatio,
    },
    persisted: audit.meta.persisted,
    requestedNetwork: audit.meta.requestedNetwork,
  };
}