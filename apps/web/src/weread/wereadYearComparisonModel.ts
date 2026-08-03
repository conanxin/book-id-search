/**
 * S27K — Pure helpers for the private WeRead "year-over-year reading
 * comparison" workspace.
 *
 * Strict privacy contract (mirrors S27H / S27I / S27J):
 *   - These helpers NEVER read note text, note comment, wereadBookId,
 *     noteId, highlightId, chapterTitle, AI summary body, or any
 *     private id.
 *   - They consume ONLY the public catalog fields returned by the
 *     `/api/private/weread/annual-review` endpoint (catalogId,
 *     title, author, publisher, publishYear, counts, dates).
 *   - All math runs in pure functions: no `Date.now()` inside the
 *     algorithm, no React, no DOM, no network calls. Results are
 *     fully serialisable objects that the dashboard maps onto JSX.
 *   - Persisted flag is hard-coded to `false` to make sure no caller
 *     ever writes the comparison result anywhere.
 *
 * What this module produces:
 *   - `WereadYearComparison` describes two calendar years side by
 *     side: metrics deltas, 12-month bars, Q1-Q4 totals, and the
 *     topBooks ranking change groups (continuing / entered / left).
 *   - `buildYearComparisonSummaries` emits rule-based descriptive
 *     text. It never guesses about psychological traits, reading
 *     quality, or interest shifts.
 */

import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewQuarter,
  WereadAnnualReviewResponse,
} from "../wereadPrivate";

// ---------- public types ----------

export type YearComparisonDirection =
  | "increase"
  | "decrease"
  | "same"
  | "from_zero"
  | "to_zero";

export type YearComparisonMetricKey =
  | "totalRecords"
  | "activeMonths"
  | "matchedRecords"
  | "matchedBooks"
  | "longestStreakMonths"
  | "averageRecordsPerActiveMonth";

export interface YearComparisonMetric {
  key: YearComparisonMetricKey;
  label: string;
  baseValue: number;
  targetValue: number;
  delta: number;
  /** null when the base is 0 and the target moved away from 0. */
  percentChange: number | null;
  direction: YearComparisonDirection;
}

export interface YearComparisonMonth {
  monthNumber: number; // 1..12
  label: string; // "1月" .. "12月"
  baseTotal: number;
  targetTotal: number;
  delta: number;
  baseBookCount: number;
  targetBookCount: number;
}

export type YearComparisonQuarterKey = "Q1" | "Q2" | "Q3" | "Q4";

export interface YearComparisonQuarter {
  quarter: YearComparisonQuarterKey;
  label: string; // "Q1（1–3月）"
  baseTotal: number;
  targetTotal: number;
  delta: number;
  baseActiveMonths: number;
  targetActiveMonths: number;
  baseBookCount: number;
  targetBookCount: number;
}

export type YearComparisonBookStatus = "continuing" | "entered" | "left";

export interface YearComparisonBookChange {
  catalogId: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  baseRank: number | null; // 1-based, null when not in base topBooks
  targetRank: number | null; // 1-based, null when not in target topBooks
  baseNoteCount: number;
  targetNoteCount: number;
  /** Positive when rank improves toward 1 (baseRank - targetRank). */
  rankChange: number | null;
  status: YearComparisonBookStatus;
}

export interface WereadYearComparison {
  baseYear: number;
  targetYear: number;
  topBooksRange: number; // 6 / 12 / 18 — single source of truth
  metrics: YearComparisonMetric[];
  months: YearComparisonMonth[];
  quarters: YearComparisonQuarter[];
  continuingBooks: YearComparisonBookChange[];
  enteredBooks: YearComparisonBookChange[];
  leftBooks: YearComparisonBookChange[];
  summaries: string[];
  meta: {
    baseHasData: boolean;
    targetHasData: boolean;
    baseTopBooksCount: number;
    targetTopBooksCount: number;
    persisted: false;
  };
}

// ---------- constants ----------

const MONTH_NAMES = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
] as const;

const QUARTER_LABELS: Record<YearComparisonQuarterKey, string> = {
  Q1: "Q1（1–3月）",
  Q2: "Q2（4–6月）",
  Q3: "Q3（7–9月）",
  Q4: "Q4（10–12月）",
};

const QUARTER_MONTHS: Record<YearComparisonQuarterKey, number[]> = {
  Q1: [1, 2, 3],
  Q2: [4, 5, 6],
  Q3: [7, 8, 9],
  Q4: [10, 11, 12],
};

const METRIC_LABELS: Record<YearComparisonMetricKey, string> = {
  totalRecords: "阅读记录",
  activeMonths: "活跃月份",
  matchedRecords: "已匹配记录",
  matchedBooks: "年度书目",
  longestStreakMonths: "最长连续月份",
  averageRecordsPerActiveMonth: "活跃月份平均记录",
};

// ---------- core math ----------

/**
 * Compute the absolute delta between base and target. Pure integer.
 */
export function calculateComparisonDelta(
  baseValue: number,
  targetValue: number
): number {
  return targetValue - baseValue;
}

/**
 * Compute percent change between two numeric values.
 *   base > 0              → (target - base) / base × 100
 *   base = 0, target > 0  → null (caller treats as "from zero")
 *   base > 0, target = 0  → -100
 *   base = 0, target = 0  → 0
 * Never returns NaN or Infinity.
 */
export function calculatePercentChange(
  baseValue: number,
  targetValue: number
): number | null {
  const base = Number(baseValue);
  const target = Number(targetValue);
  if (!Number.isFinite(base) || !Number.isFinite(target)) return 0;
  if (base === 0 && target === 0) return 0;
  if (base === 0 && target !== 0) return null;
  const pct = ((target - base) / base) * 100;
  if (!Number.isFinite(pct)) return 0;
  return pct;
}

/**
 * Classify a delta against the zero-baseline rule. Same logic as
 * `calculatePercentChange`, but isolated so the UI can render the
 * direction without depending on the percentage math.
 */
export function getComparisonDirection(
  baseValue: number,
  targetValue: number
): YearComparisonDirection {
  const base = Number(baseValue) || 0;
  const target = Number(targetValue) || 0;
  if (base === 0 && target === 0) return "same";
  if (base === 0 && target > 0) return "from_zero";
  if (base > 0 && target === 0) return "to_zero";
  return target > base ? "increase" : target < base ? "decrease" : "same";
}

/**
 * Build the six comparison metrics.
 */
export function buildYearComparisonMetrics(args: {
  base: WereadAnnualReviewResponse;
  target: WereadAnnualReviewResponse;
}): YearComparisonMetric[] {
  const baseOverview = args.base.overview;
  const targetOverview = args.target.overview;
  const sources: Array<{
    key: YearComparisonMetricKey;
    baseValue: number;
    targetValue: number;
  }> = [
    { key: "totalRecords", baseValue: baseOverview.totalRecords, targetValue: targetOverview.totalRecords },
    { key: "activeMonths", baseValue: baseOverview.activeMonths, targetValue: targetOverview.activeMonths },
    { key: "matchedRecords", baseValue: baseOverview.matchedRecords, targetValue: targetOverview.matchedRecords },
    { key: "matchedBooks", baseValue: baseOverview.matchedBooks, targetValue: targetOverview.matchedBooks },
    { key: "longestStreakMonths", baseValue: baseOverview.longestStreakMonths, targetValue: targetOverview.longestStreakMonths },
    {
      key: "averageRecordsPerActiveMonth",
      baseValue: Math.round(baseOverview.averageRecordsPerActiveMonth * 100) / 100,
      targetValue: Math.round(targetOverview.averageRecordsPerActiveMonth * 100) / 100,
    },
  ];
  return sources.map((s) => ({
    key: s.key,
    label: METRIC_LABELS[s.key],
    baseValue: s.baseValue,
    targetValue: s.targetValue,
    delta: calculateComparisonDelta(s.baseValue, s.targetValue),
    percentChange: calculatePercentChange(s.baseValue, s.targetValue),
    direction: getComparisonDirection(s.baseValue, s.targetValue),
  }));
}

// ---------- monthly + quarterly ----------

/**
 * Build the 12-month comparison. Always returns exactly 12 entries.
 * Missing months in either year are treated as 0 — we never treat a
 * missing month as "no data". Sorted by `monthNumber` ascending.
 */
export function buildYearComparisonMonths(args: {
  base: WereadAnnualReviewResponse;
  target: WereadAnnualReviewResponse;
}): YearComparisonMonth[] {
  const baseByMonth = indexMonthsByMonthNumber(args.base);
  const targetByMonth = indexMonthsByMonthNumber(args.target);
  const out: YearComparisonMonth[] = [];
  for (let i = 1; i <= 12; i += 1) {
    const baseMonth = baseByMonth.get(i) ?? zeroMonth(i);
    const targetMonth = targetByMonth.get(i) ?? zeroMonth(i);
    out.push({
      monthNumber: i,
      label: MONTH_NAMES[i - 1],
      baseTotal: baseMonth.total,
      targetTotal: targetMonth.total,
      delta: baseMonth.total - targetMonth.total, // base - target (positive when target grew)
      baseBookCount: baseMonth.bookCount,
      targetBookCount: targetMonth.bookCount,
    });
  }
  // sanity: reverse so delta is target - base to match the metric helper.
  return out.map((m) => ({
    ...m,
    delta: calculateComparisonDelta(m.baseTotal, m.targetTotal),
  }));
}

function indexMonthsByMonthNumber(
  response: WereadAnnualReviewResponse
): Map<number, { total: number; bookCount: number }> {
  const map = new Map<number, { total: number; bookCount: number }>();
  for (const m of response.months) {
    const match = /^(\d{4})-(\d{2})$/.exec(m.month);
    if (!match) continue;
    const monthNumber = Number(match[2]);
    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) continue;
    map.set(monthNumber, { total: m.total, bookCount: m.bookCount });
  }
  return map;
}

function zeroMonth(monthNumber: number): { total: number; bookCount: number } {
  return { total: 0, bookCount: 0 };
}

/**
 * Build the four-quarter comparison. Quarters are emitted in Q1→Q4
 * order. Per-quarter totals come from the server-provided
 * `quarters` array. Per-quarter `bookCount` is recomputed from the
 * month `bookCount` so we never depend on a server-only metric.
 */
export function buildYearComparisonQuarters(args: {
  base: WereadAnnualReviewResponse;
  target: WereadAnnualReviewResponse;
}): YearComparisonQuarter[] {
  const baseQuarters = indexQuartersByKey(args.base.quarters);
  const targetQuarters = indexQuartersByKey(args.target.quarters);
  const baseMonths = indexMonthsByMonthNumber(args.base);
  const targetMonths = indexMonthsByMonthNumber(args.target);
  const out: YearComparisonQuarter[] = [];
  for (const q of ["Q1", "Q2", "Q3", "Q4"] as const) {
    const baseQ = baseQuarters.get(q) ?? zeroQuarter(q);
    const targetQ = targetQuarters.get(q) ?? zeroQuarter(q);
    const baseBookCount = sumBookCount(baseMonths, QUARTER_MONTHS[q]);
    const targetBookCount = sumBookCount(targetMonths, QUARTER_MONTHS[q]);
    out.push({
      quarter: q,
      label: QUARTER_LABELS[q],
      baseTotal: baseQ.total,
      targetTotal: targetQ.total,
      delta: calculateComparisonDelta(baseQ.total, targetQ.total),
      baseActiveMonths: baseQ.activeMonths,
      targetActiveMonths: targetQ.activeMonths,
      baseBookCount,
      targetBookCount,
    });
  }
  return out;
}

function indexQuartersByKey(
  quarters: ReadonlyArray<WereadAnnualReviewQuarter>
): Map<YearComparisonQuarterKey, WereadAnnualReviewQuarter> {
  const map = new Map<YearComparisonQuarterKey, WereadAnnualReviewQuarter>();
  for (const q of quarters) {
    map.set(q.quarter, q);
  }
  return map;
}

function zeroQuarter(q: YearComparisonQuarterKey): WereadAnnualReviewQuarter {
  return { quarter: q, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 };
}

function sumBookCount(
  monthIndex: Map<number, { total: number; bookCount: number }>,
  monthNumbers: number[]
): number {
  let total = 0;
  for (const n of monthNumbers) {
    const m = monthIndex.get(n);
    if (m) total += m.bookCount;
  }
  return total;
}

// ---------- topBooks ranking changes ----------

/**
 * Compare two `topBooks` arrays and classify each book into one of
 * three groups:
 *   - `continuing` — present in both years' topBooks
 *   - `entered`    — present only in the target year's topBooks
 *   - `left`       — present only in the base year's topBooks
 *
 * Public metadata (title / author / publisher / publishYear) comes
 * from the **target** response first, then falls back to the base
 * response. We never read the raw WeRead title / author from the
 * private snapshot.
 */
export function buildYearComparisonBookChanges(args: {
  base: WereadAnnualReviewResponse;
  target: WereadAnnualReviewResponse;
}): {
  continuing: YearComparisonBookChange[];
  entered: YearComparisonBookChange[];
  left: YearComparisonBookChange[];
} {
  const baseIndex = indexBooksByCatalogId(args.base.topBooks);
  const targetIndex = indexBooksByCatalogId(args.target.topBooks);
  const seen = new Set<string>();
  const continuing: YearComparisonBookChange[] = [];
  for (const [catalogId, baseBook] of baseIndex) {
    const targetBook = targetIndex.get(catalogId);
    if (!targetBook) continue;
    const baseRank = rankOf(args.base.topBooks, catalogId);
    const targetRank = rankOf(args.target.topBooks, catalogId);
    const merged = mergeBookMeta(baseBook, targetBook);
    continuing.push({
      catalogId,
      title: merged.title,
      author: merged.author ?? null,
      publisher: merged.publisher ?? null,
      publishYear: merged.publishYear ?? null,
      baseRank,
      targetRank,
      baseNoteCount: baseBook.noteCount,
      targetNoteCount: targetBook.noteCount,
      rankChange: baseRank !== null && targetRank !== null ? baseRank - targetRank : null,
      status: "continuing",
    });
    seen.add(catalogId);
  }
  const entered: YearComparisonBookChange[] = [];
  for (const [catalogId, targetBook] of targetIndex) {
    if (seen.has(catalogId)) continue;
    const targetRank = rankOf(args.target.topBooks, catalogId);
    const merged = mergeBookMeta(targetBook, targetBook);
    entered.push({
      catalogId,
      title: merged.title,
      author: merged.author ?? null,
      publisher: merged.publisher ?? null,
      publishYear: merged.publishYear ?? null,
      baseRank: null,
      targetRank,
      baseNoteCount: 0,
      targetNoteCount: targetBook.noteCount,
      rankChange: null,
      status: "entered",
    });
  }
  const left: YearComparisonBookChange[] = [];
  for (const [catalogId, baseBook] of baseIndex) {
    if (seen.has(catalogId)) continue;
    const baseRank = rankOf(args.base.topBooks, catalogId);
    const merged = mergeBookMeta(baseBook, baseBook);
    left.push({
      catalogId,
      title: merged.title,
      author: merged.author ?? null,
      publisher: merged.publisher ?? null,
      publishYear: merged.publishYear ?? null,
      baseRank,
      targetRank: null,
      baseNoteCount: baseBook.noteCount,
      targetNoteCount: 0,
      rankChange: null,
      status: "left",
    });
  }
  // Stable sort: continuing by target rank; entered/left by rank.
  continuing.sort((a, b) => (a.targetRank ?? 0) - (b.targetRank ?? 0));
  entered.sort((a, b) => (a.targetRank ?? 0) - (b.targetRank ?? 0));
  left.sort((a, b) => (a.baseRank ?? 0) - (b.baseRank ?? 0));
  return { continuing, entered, left };
}

function indexBooksByCatalogId(
  books: ReadonlyArray<WereadAnnualReviewBook>
): Map<string, WereadAnnualReviewBook> {
  const map = new Map<string, WereadAnnualReviewBook>();
  for (const book of books) {
    if (!book.catalogId) continue;
    if (map.has(book.catalogId)) continue; // keep first occurrence
    map.set(book.catalogId, book);
  }
  return map;
}

function rankOf(
  books: ReadonlyArray<WereadAnnualReviewBook>,
  catalogId: string
): number | null {
  const idx = books.findIndex((b) => b.catalogId === catalogId);
  return idx === -1 ? null : idx + 1;
}

interface BookMeta {
  title: string;
  author: string | null | undefined;
  publisher: string | null | undefined;
  publishYear: string | number | null | undefined;
}

function mergeBookMeta(base: WereadAnnualReviewBook, target: WereadAnnualReviewBook): BookMeta {
  return {
    title: pickString(target.title, base.title),
    author: target.author ?? base.author ?? null,
    publisher: target.publisher ?? base.publisher ?? null,
    publishYear: target.publishYear ?? base.publishYear ?? null,
  };
}

function pickString(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return "";
}

// ---------- summaries ----------

/**
 * Build the descriptive summary list. Every line is a deterministic
 * rule — no psychological inference, no quality judgement, no
 * "interest shift" language.
 */
export function buildYearComparisonSummaries(args: {
  comparison: WereadYearComparison;
}): string[] {
  const out: string[] = [];
  const metricByKey = new Map(args.comparison.metrics.map((m) => [m.key, m]));
  const totalRecords = metricByKey.get("totalRecords");
  const activeMonths = metricByKey.get("activeMonths");
  const matchedRecords = metricByKey.get("matchedRecords");
  const matchedBooks = metricByKey.get("matchedBooks");

  if (totalRecords) {
    if (totalRecords.direction === "increase") {
      out.push(
        `目标年度阅读记录比基准年度增加 ${formatCount(totalRecords.delta)} 条。`
      );
    } else if (totalRecords.direction === "decrease") {
      out.push(
        `目标年度阅读记录比基准年度减少 ${formatCount(Math.abs(totalRecords.delta))} 条。`
      );
    } else if (totalRecords.direction === "from_zero") {
      out.push(
        `目标年度从基准年度的 0 条阅读记录增加至 ${formatCount(totalRecords.targetValue)} 条。`
      );
    } else if (totalRecords.direction === "to_zero") {
      out.push(
        `目标年度阅读记录由基准年度的 ${formatCount(totalRecords.baseValue)} 条降为 0 条。`
      );
    } else {
      out.push("两年阅读记录数量持平。");
    }
  }

  if (activeMonths) {
    if (activeMonths.direction === "same") {
      out.push("两年活跃月份数量持平。");
    } else {
      out.push(
        `目标年度活跃月份为 ${formatCount(activeMonths.targetValue)} 个，基准年度为 ${formatCount(activeMonths.baseValue)} 个。`
      );
    }
  }

  if (matchedRecords && matchedRecords.direction !== "same") {
    out.push(
      `目标年度已匹配记录为 ${formatCount(matchedRecords.targetValue)} 条，基准年度为 ${formatCount(matchedRecords.baseValue)} 条。`
    );
  }

  if (matchedBooks && matchedBooks.direction !== "same") {
    out.push(
      `目标年度已匹配书目为 ${formatCount(matchedBooks.targetValue)} 本，基准年度为 ${formatCount(matchedBooks.baseValue)} 本。`
    );
  }

  // Peak month shift.
  const basePeak = peakMonthLabel(args.comparison);
  const targetPeak = targetPeakMonthLabel(args.comparison);
  if (basePeak && targetPeak) {
    if (basePeak === targetPeak) {
      out.push(`两年记录高峰月份均为 ${targetPeak}。`);
    } else {
      out.push(`记录高峰月份从 ${basePeak} 变为 ${targetPeak}。`);
    }
  } else if (targetPeak) {
    out.push(`目标年度记录高峰出现在 ${targetPeak}。`);
  }

  // Continuing books count.
  if (args.comparison.continuingBooks.length > 0) {
    out.push(
      `有 ${formatCount(args.comparison.continuingBooks.length)} 本书连续进入两年的高互动书目榜。`
    );
  }

  // Entered / left counts — neutral language only.
  if (args.comparison.enteredBooks.length > 0) {
    out.push(
      `有 ${formatCount(args.comparison.enteredBooks.length)} 本书进入目标年度高互动书目榜。`
    );
  }
  if (args.comparison.leftBooks.length > 0) {
    out.push(
      `有 ${formatCount(args.comparison.leftBooks.length)} 本书未进入目标年度高互动书目榜。`
    );
  }

  return out;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  return rounded.toLocaleString("zh-CN");
}

function peakMonthLabel(comparison: WereadYearComparison): string | null {
  // We only have the structured month deltas; the base peak lives in
  // the unprocessed response. We use the month delta to derive the
  // peak month for the base year — the largest baseTotal in months.
  let best = -Infinity;
  let bestMonth: YearComparisonMonth | null = null;
  for (const m of comparison.months) {
    if (m.baseTotal > best) {
      best = m.baseTotal;
      bestMonth = m;
    }
  }
  return bestMonth && best > 0 ? bestMonth.label : null;
}

function targetPeakMonthLabel(comparison: WereadYearComparison): string | null {
  let best = -Infinity;
  let bestMonth: YearComparisonMonth | null = null;
  for (const m of comparison.months) {
    if (m.targetTotal > best) {
      best = m.targetTotal;
      bestMonth = m;
    }
  }
  return bestMonth && best > 0 ? bestMonth.label : null;
}

// ---------- main entry point ----------

export interface BuildYearComparisonArgs {
  base: WereadAnnualReviewResponse;
  target: WereadAnnualReviewResponse;
  topBooksRange: number;
}

export function buildWereadYearComparison(
  args: BuildYearComparisonArgs
): WereadYearComparison {
  const base = args.base;
  const target = args.target;
  const metrics = buildYearComparisonMetrics({ base, target });
  const months = buildYearComparisonMonths({ base, target });
  const quarters = buildYearComparisonQuarters({ base, target });
  const bookChanges = buildYearComparisonBookChanges({ base, target });
  const comparison: WereadYearComparison = {
    baseYear: base.selectedYear,
    targetYear: target.selectedYear,
    topBooksRange: args.topBooksRange,
    metrics,
    months,
    quarters,
    continuingBooks: bookChanges.continuing,
    enteredBooks: bookChanges.entered,
    leftBooks: bookChanges.left,
    summaries: [],
    meta: {
      baseHasData: base.overview.totalRecords > 0 || base.topBooks.length > 0,
      targetHasData: target.overview.totalRecords > 0 || target.topBooks.length > 0,
      baseTopBooksCount: base.topBooks.length,
      targetTopBooksCount: target.topBooks.length,
      persisted: false,
    },
  };
  comparison.summaries = buildYearComparisonSummaries({ comparison });
  return comparison;
}

// ---------- formatters ----------

/**
 * Pretty-print a delta. Positive numbers get a `+`, negative keep the
 * minus sign. Zero is rendered as `0`. NaN / Infinity fall back to `0`.
 */
export function formatComparisonDelta(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  if (rounded > 0) return `+${rounded.toLocaleString("zh-CN")}`;
  return `−${Math.abs(rounded).toLocaleString("zh-CN")}`;
}

/**
 * Pretty-print a percentage. Returns "—" when the base is 0 and the
 * target moved (caller should show the "由 0 增至 N" string instead).
 * Always rounds to at most one decimal.
 */
export function formatComparisonPercent(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "0%";
  const abs = Math.abs(value);
  const rounded = Math.round(abs * 10) / 10;
  const body = Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
  return value > 0 ? `+${body}%` : `−${body}%`;
}

/**
 * True when the comparison has at least one comparison axis that
 * carries data (overview metrics or any topBook).
 */
export function hasYearComparisonData(
  comparison: WereadYearComparison | null | undefined
): boolean {
  if (!comparison) return false;
  if (comparison.meta.baseHasData) return true;
  if (comparison.meta.targetHasData) return true;
  if (comparison.continuingBooks.length > 0) return true;
  if (comparison.enteredBooks.length > 0) return true;
  if (comparison.leftBooks.length > 0) return true;
  return false;
}

// ---------- helpers exported for tests ----------

export const YEAR_COMPARISON_MONTH_NAMES = MONTH_NAMES;
export const YEAR_COMPARISON_QUARTER_LABELS = QUARTER_LABELS;
export const YEAR_COMPARISON_METRIC_LABELS = METRIC_LABELS;