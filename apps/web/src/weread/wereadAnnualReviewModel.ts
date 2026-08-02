/**
 * S27J — Front-end pure helpers for the private WeRead annual review.
 *
 * Strict privacy contract (mirrors S27H / S27I):
 *   - These helpers NEVER read note text, note comment, wereadBookId,
 *     noteId, highlightId, chapterTitle, or any private id.
 *   - They consume ONLY the public catalog fields returned by the
 *     `/api/private/weread/annual-review` endpoint.
 *   - All dates are passed in as `now` so the functions remain pure
 *     and deterministic across runs / tests / snapshots.
 *   - No random numbers, no `Date.now()` inside the math, no React,
 *     no DOM, no network calls. The result is a fully serialisable
 *     object that the dashboard maps onto JSX.
 */

import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewMonth,
  WereadAnnualReviewQuarter,
  WereadAnnualReviewResponse,
} from "../wereadPrivate";

// ---------- types ----------

export type AnnualReviewMonthActivity = "none" | "light" | "steady" | "high";

export interface AnnualTimelineMonth {
  month: string;
  label: string; // e.g. "01"
  year: number;
  monthIndex: number; // 0-11
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
  bookCount: number;
  activity: AnnualReviewMonthActivity;
  /** Numeric 0..1, used as bar height ratio. */
  intensity: number;
  heightPct: number; // 0-100
}

export interface AnnualTypeDistribution {
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  total: number;
  /** Per-bucket ratio (0..1). */
  ratio: {
    highlights: number;
    thoughts: number;
    reviews: number;
    unknown: number;
  };
}

export interface AnnualQuarterView {
  quarter: WereadAnnualReviewQuarter["quarter"];
  label: string;
  total: number;
  activeMonths: number;
  matchedRecords: number;
  bookCount: number;
  /** Share of the year total (0..1). 0 when the year has no data. */
  shareOfYear: number;
  /** Per-month activity classification within the quarter. */
  monthActivity: AnnualReviewMonthActivity[];
}

export interface AnnualRhythmSummary {
  totalRecords: number;
  activeMonths: number;
  longestStreakMonths: number;
  averageRecordsPerActiveMonth: number;
  peakMonth: string | null;
  peakMonthRecords: number;
  matchedBooks: number;
  year: number;
}

export interface AnnualRecordCard {
  key: string;
  label: string;
  value: string;
}

export interface AnnualOverviewView {
  totalRecords: number;
  datedRecords: number;
  matchedRecords: number;
  matchedBooks: number;
  activeMonths: number;
  longestStreakMonths: number;
  firstNoteAt: string | null;
  lastNoteAt: string | null;
  peakMonth: string | null;
  peakMonthRecords: number;
  averageRecordsPerActiveMonth: number;
  cards: AnnualRecordCard[];
}

// ---------- formatters ----------

const MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"] as const;

const QUARTER_LABELS: Record<WereadAnnualReviewQuarter["quarter"], string> = {
  Q1: "Q1（1–3月）",
  Q2: "Q2（4–6月）",
  Q3: "Q3（7–9月）",
  Q4: "Q4（10–12月）",
};

const ACTIVITY_LABELS: Record<AnnualReviewMonthActivity, string> = {
  none: "无记录",
  light: "轻量",
  steady: "稳定",
  high: "高活跃",
};

/** Pretty-print a YYYY-MM month as "2025年3月". */
export function formatAnnualReviewMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const year = Number(m[1]);
  const idx = Number(m[2]) - 1;
  if (!Number.isFinite(year) || idx < 0 || idx > 11) return month;
  return `${year}年${MONTH_NAMES[idx]}`;
}

/** Pretty-print a year as "2025 年". */
export function formatAnnualReviewYear(year: number): string {
  if (!Number.isFinite(year)) return "";
  return `${year} 年`;
}

/** Pretty-print an ISO date as "2025-03-08". */
export function formatAnnualReviewDate(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Format an overview number; returns "—" for null/undefined. */
export function formatAnnualReviewOverview(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return String(Math.floor(value));
}

/** Truncate a long book title; returns the input if it's already short. */
export function truncateAnnualBookTitle(title: string, maxLength = 28): string {
  if (typeof title !== "string") return "";
  if (title.length <= maxLength) return title;
  return `${title.slice(0, Math.max(0, maxLength - 1))}…`;
}

// ---------- timeline model ----------

/**
 * Classify a single month relative to the year-wide average.
 *
 *   average = 0       → all months are "none"
 *   total == 0        → "none"
 *   total >= avg*1.5  → "high"
 *   total <= avg*0.5  → "light"
 *   otherwise         → "steady"
 */
export function classifyAnnualMonthActivity(args: {
  total: number;
  averagePerActiveMonth: number;
}): AnnualReviewMonthActivity {
  if (args.total === 0) return "none";
  if (args.averagePerActiveMonth === 0) return "none";
  if (args.total >= args.averagePerActiveMonth * 1.5) return "high";
  if (args.total <= args.averagePerActiveMonth * 0.5) return "light";
  return "steady";
}

/**
 * Build the 12-month timeline model from the API's `months` array.
 * Always returns exactly 12 entries, one per YYYY-MM in the year.
 */
export function buildAnnualTimelineModel(args: {
  months: ReadonlyArray<WereadAnnualReviewMonth>;
  year: number;
  averagePerActiveMonth: number;
}): AnnualTimelineMonth[] {
  const byKey = new Map<string, WereadAnnualReviewMonth>();
  for (const m of args.months) {
    byKey.set(m.month, m);
  }
  const out: AnnualTimelineMonth[] = [];
  for (let i = 0; i < 12; i += 1) {
    const key = `${args.year}-${String(i + 1).padStart(2, "0")}`;
    const raw = byKey.get(key) ?? {
      month: key,
      total: 0,
      highlights: 0,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      matched: 0,
      bookCount: 0,
    };
    const activity = classifyAnnualMonthActivity({
      total: raw.total,
      averagePerActiveMonth: args.averagePerActiveMonth,
    });
    out.push({
      month: key,
      label: String(i + 1).padStart(2, "0"),
      year: args.year,
      monthIndex: i,
      total: raw.total,
      highlights: raw.highlights,
      thoughts: raw.thoughts,
      reviews: raw.reviews,
      unknown: raw.unknown,
      matched: raw.matched,
      bookCount: raw.bookCount,
      activity,
      intensity: 0,
      heightPct: 0,
    });
  }
  const maxTotal = out.reduce((acc, m) => Math.max(acc, m.total), 0);
  for (const m of out) {
    m.intensity = maxTotal > 0 ? m.total / maxTotal : 0;
    m.heightPct = Math.round(m.intensity * 100);
  }
  return out;
}

// ---------- type distribution ----------

export function buildAnnualTypeDistribution(args: {
  months: ReadonlyArray<WereadAnnualReviewMonth>;
}): AnnualTypeDistribution {
  let highlights = 0;
  let thoughts = 0;
  let reviews = 0;
  let unknown = 0;
  for (const m of args.months) {
    highlights += m.highlights;
    thoughts += m.thoughts;
    reviews += m.reviews;
    unknown += m.unknown;
  }
  const total = highlights + thoughts + reviews + unknown;
  const safe = (v: number) => (total > 0 ? v / total : 0);
  return {
    highlights,
    thoughts,
    reviews,
    unknown,
    total,
    ratio: {
      highlights: safe(highlights),
      thoughts: safe(thoughts),
      reviews: safe(reviews),
      unknown: safe(unknown),
    },
  };
}

// ---------- quarter model ----------

export function buildQuarterReviewModel(args: {
  quarters: ReadonlyArray<WereadAnnualReviewQuarter>;
  months: ReadonlyArray<WereadAnnualReviewMonth>;
  averagePerActiveMonth: number;
}): AnnualQuarterView[] {
  const yearTotal = args.quarters.reduce((acc, q) => acc + q.total, 0);
  return args.quarters.map((q) => {
    const qIndex: Record<WereadAnnualReviewQuarter["quarter"], number> = {
      Q1: 0,
      Q2: 1,
      Q3: 2,
      Q4: 3,
    };
    const idx = qIndex[q.quarter];
    const monthActivity: AnnualReviewMonthActivity[] = [];
    for (let i = 0; i < 3; i += 1) {
      const monthIdx = idx * 3 + i;
      const month = args.months[monthIdx];
      if (!month) {
        monthActivity.push("none");
        continue;
      }
      monthActivity.push(
        classifyAnnualMonthActivity({
          total: month.total,
          averagePerActiveMonth: args.averagePerActiveMonth,
        })
      );
    }
    return {
      quarter: q.quarter,
      label: QUARTER_LABELS[q.quarter],
      total: q.total,
      activeMonths: q.activeMonths,
      matchedRecords: q.matchedRecords,
      bookCount: q.bookCount,
      shareOfYear: yearTotal > 0 ? q.total / yearTotal : 0,
      monthActivity,
    };
  });
}

// ---------- rhythm summary ----------

export function buildAnnualRhythmSummary(args: {
  response: WereadAnnualReviewResponse;
}): AnnualRhythmSummary {
  return {
    totalRecords: args.response.overview.totalRecords,
    activeMonths: args.response.overview.activeMonths,
    longestStreakMonths: args.response.overview.longestStreakMonths,
    averageRecordsPerActiveMonth: args.response.overview.averageRecordsPerActiveMonth,
    peakMonth: args.response.overview.peakMonth,
    peakMonthRecords: args.response.overview.peakMonthRecords,
    matchedBooks: args.response.overview.matchedBooks,
    year: args.response.selectedYear,
  };
}

// ---------- overview view + record cards ----------

/**
 * Build the descriptive overview used by the dashboard's top cards.
 * Returns six primary counters plus the descriptive record cards
 * (read-only statistical sentences — no psychological inference).
 */
export function buildAnnualOverviewView(args: {
  response: WereadAnnualReviewResponse;
  topBookCount: number;
}): AnnualOverviewView {
  const o = args.response.overview;
  const peakBook = args.response.topBooks[0];
  const peakBookCount = peakBook ? peakBook.noteCount : 0;
  const cards: AnnualRecordCard[] = [
    {
      key: "total",
      label: "全年阅读记录",
      value: `全年留下 ${formatAnnualReviewOverview(o.totalRecords)} 条阅读记录。`,
    },
    {
      key: "active",
      label: "活跃月份",
      value: `在 ${formatAnnualReviewOverview(o.activeMonths)} 个自然月有阅读活动。`,
    },
    {
      key: "streak",
      label: "最长连续月份",
      value: `最长连续活跃 ${formatAnnualReviewOverview(o.longestStreakMonths)} 个月。`,
    },
    {
      key: "peak",
      label: "记录高峰月份",
      value:
        o.peakMonth
          ? `记录高峰出现在 ${formatAnnualReviewMonth(o.peakMonth)}。`
          : "本年暂无可用记录。",
    },
    {
      key: "matched",
      label: "年度匹配书目",
      value: `年度共涉及 ${formatAnnualReviewOverview(o.matchedBooks)} 本已匹配书目。`,
    },
    {
      key: "topBook",
      label: "最高互动书目",
      value:
        peakBook
          ? `最高互动书目 ${truncateAnnualBookTitle(peakBook.title, 24)} 留下 ${peakBookCount} 条阅读记录。`
          : "本年暂无最高互动书目。",
    },
  ];
  return {
    totalRecords: o.totalRecords,
    datedRecords: o.datedRecords,
    matchedRecords: o.matchedRecords,
    matchedBooks: o.matchedBooks,
    activeMonths: o.activeMonths,
    longestStreakMonths: o.longestStreakMonths,
    firstNoteAt: o.firstNoteAt,
    lastNoteAt: o.lastNoteAt,
    peakMonth: o.peakMonth,
    peakMonthRecords: o.peakMonthRecords,
    averageRecordsPerActiveMonth: o.averageRecordsPerActiveMonth,
    cards,
  };
}

export function buildAnnualRecordCards(args: {
  response: WereadAnnualReviewResponse;
}): AnnualRecordCard[] {
  return buildAnnualOverviewView({
    response: args.response,
    topBookCount: args.response.topBooks.length,
  }).cards;
}

// ---------- helpers ----------

/** True when the response carries no annual data at all. */
export function hasAnnualReviewData(response: WereadAnnualReviewResponse | null | undefined): boolean {
  if (!response) return false;
  return response.overview.totalRecords > 0 || response.topBooks.length > 0;
}

// ---------- exports for reuse ----------

export const ANNUAL_ACTIVITY_LABELS = ACTIVITY_LABELS;
export const ANNUAL_QUARTER_LABELS = QUARTER_LABELS;
export const ANNUAL_MONTH_NAMES = MONTH_NAMES;