/**
 * S27I — Front-end pure helpers for the private WeRead review calendar.
 *
 * Strict privacy contract (mirrors S27H / S27H-2 boundary):
 *   - These helpers NEVER read note text, note comment, wereadBookId,
 *     noteId, highlightId, chapterTitle, summary overview / keyPoints /
 *     reviewQuestions, the AI theme summary body, evidenceCount, the
 *     `q` search term, or any private catalog id.
 *   - They consume ONLY the public catalog fields returned by the
 *     `/api/private/weread/reading-map` endpoint (catalogId, title,
 *     author, noteCount, activeMonths, lastNoteAt, firstNoteAt) plus
 *     the already-sanitised session-theme overlay (themes[].label +
 *     catalogIds + notesUsed).
 *   - All dates are passed in as `now` so the functions remain pure
 *     and deterministic across runs / tests / snapshots.
 *   - No random numbers, no `Date.now()` inside the math, no React,
 *     no DOM, no network calls. The result is a fully serialisable
 *     calendar object that the dashboard just maps onto JSX.
 */

import type {
  WereadReadingMapBook,
  WereadReadingMapResponse,
} from "../wereadPrivate";
import type { WereadSessionThemeOverlay } from "./wereadSessionThemeModel";

// ---------- types ----------

export type ReadingReviewPriority = "high" | "medium" | "low";

export type ReadingReviewReasonCode =
  | "session_book"
  | "long_inactive"
  | "high_note_count"
  | "multi_month_activity"
  | "recent_activity";

export interface ReadingReviewBookTask {
  id: string;
  kind: "book";
  catalogId: string;
  title: string;
  author?: string | null;
  suggestedDate: string;
  priority: ReadingReviewPriority;
  priorityScore: number;
  noteCount: number;
  activeMonths: number;
  lastNoteAt: string;
  sessionRelevant: boolean;
  reasonCodes: ReadingReviewReasonCode[];
}

export interface ReadingReviewThemeTask {
  id: string;
  kind: "theme";
  label: string;
  suggestedDate: string;
  source: "theme" | "direction";
}

export type ReadingReviewTask = ReadingReviewBookTask | ReadingReviewThemeTask;

export interface ReadingReviewDay {
  date: string;
  tasks: ReadingReviewTask[];
}

export interface ReadingReviewUnscheduledBook {
  catalogId: string;
  title: string;
  reason: "missing_last_note_date";
}

export interface ReadingReviewCalendarMeta {
  booksConsidered: number;
  bookTasks: number;
  themeTasks: number;
  sessionBooksUsed: number;
  persisted: false;
}

export interface ReadingReviewCalendar {
  startDate: string;
  endDate: string;
  horizonDays: number;
  tasks: ReadingReviewTask[];
  days: ReadingReviewDay[];
  unscheduledBooks: ReadingReviewUnscheduledBook[];
  meta: ReadingReviewCalendarMeta;
}

// ---------- constants ----------

export const REVIEW_HORIZON_OPTIONS = [14, 28, 42] as const;
export type ReviewHorizonDays = (typeof REVIEW_HORIZON_OPTIONS)[number];

export const REVIEW_RECOMMEND_OPTIONS = [6, 12, 18] as const;
export type ReviewRecommendCount = (typeof REVIEW_RECOMMEND_OPTIONS)[number];

export const REVIEW_DEFAULT_HORIZON: ReviewHorizonDays = 28;
export const REVIEW_DEFAULT_RECOMMEND: ReviewRecommendCount = 12;

const REVIEW_PRIORITY_BOUNDARIES = {
  high: 70,
  medium: 45,
} as const;

const REVIEW_SCORE_BOUNDS = {
  time: { long: 45, mid: 36, near: 28, recent: 18, active: 8 },
  note: { max: 40, weight: 30 },
  months: { max: 12, weight: 15 },
  sessionBoost: 20,
  ceiling: 100,
  floor: 0,
} as const;

// ---------- date helpers ----------

/**
 * Parse an ISO-like timestamp into a UTC midnight Date. Returns
 * `null` for malformed input so callers can drop bad data instead of
 * fabricating a fake lastNoteAt.
 */
export function parseReviewDate(input: string | null | undefined): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

/**
 * Whole-day UTC distance. Floors to the nearest integer day so two
 * calls with the same inputs return the same number regardless of the
 * current wall-clock second.
 */
export function daysBetweenReviewDates(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / 86_400_000);
}

function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Add `days` whole days to a UTC date and return a new Date. */
export function addReviewDays(d: Date, days: number): Date {
  const next = new Date(d.getTime() + days * 86_400_000);
  return next;
}

// ---------- hash helper ----------

/**
 * Deterministic 32-bit hash for a public catalogId. Used to spread
 * suggested review dates so the same-day-stacking is impossible.
 *
 * Implementation is a tiny variant of the FNV-1a 32-bit hash, which
 * is stable across browsers / Node / V8 versions. The output is
 * always a non-negative integer.
 */
export function stableCatalogHash(catalogId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < catalogId.length; i += 1) {
    h ^= catalogId.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// ---------- priority math ----------

/**
 * Clamp `score` into the [0, 100] window and round to the nearest
 * integer. NaN / Infinity collapse to 0.
 */
function clampReviewScore(score: number): number {
  if (!Number.isFinite(score)) return REVIEW_SCORE_BOUNDS.floor;
  const rounded = Math.round(score);
  if (rounded < REVIEW_SCORE_BOUNDS.floor) return REVIEW_SCORE_BOUNDS.floor;
  if (rounded > REVIEW_SCORE_BOUNDS.ceiling) return REVIEW_SCORE_BOUNDS.ceiling;
  return rounded;
}

function timeScoreFromDays(daysSinceLast: number): number {
  const safeDays = Math.max(0, Math.floor(daysSinceLast));
  if (safeDays >= 365) return REVIEW_SCORE_BOUNDS.time.long;
  if (safeDays >= 180) return REVIEW_SCORE_BOUNDS.time.mid;
  if (safeDays >= 90) return REVIEW_SCORE_BOUNDS.time.near;
  if (safeDays >= 30) return REVIEW_SCORE_BOUNDS.time.recent;
  return REVIEW_SCORE_BOUNDS.time.active;
}

function noteScoreFromCount(noteCount: number): number {
  const safe = Math.max(0, Math.floor(noteCount));
  const capped = Math.min(safe, REVIEW_SCORE_BOUNDS.note.max);
  return (capped / REVIEW_SCORE_BOUNDS.note.max) * REVIEW_SCORE_BOUNDS.note.weight;
}

function activeMonthsScoreFromCount(activeMonths: number): number {
  const safe = Math.max(0, Math.floor(activeMonths));
  const capped = Math.min(safe, REVIEW_SCORE_BOUNDS.months.max);
  return (capped / REVIEW_SCORE_BOUNDS.months.max) * REVIEW_SCORE_BOUNDS.months.weight;
}

/**
 * Total priority score. `now` is required so the helper is pure.
 */
export function calculateReviewPriorityScore(args: {
  book: WereadReadingMapBook;
  now: Date;
  sessionCatalogIds: ReadonlySet<string>;
}): number {
  const lastNote = parseReviewDate(args.book.lastNoteAt);
  if (!lastNote) return REVIEW_SCORE_BOUNDS.floor;
  const todayUtc = new Date(
    Date.UTC(
      args.now.getUTCFullYear(),
      args.now.getUTCMonth(),
      args.now.getUTCDate()
    )
  );
  const daysSince = daysBetweenReviewDates(lastNote, todayUtc);
  let score = 0;
  score += timeScoreFromDays(daysSince);
  score += noteScoreFromCount(args.book.noteCount);
  score += activeMonthsScoreFromCount(args.book.activeMonths);
  if (args.sessionCatalogIds.has(args.book.catalogId)) {
    score += REVIEW_SCORE_BOUNDS.sessionBoost;
  }
  return clampReviewScore(score);
}

export function getReviewPriority(score: number): ReadingReviewPriority {
  if (!Number.isFinite(score)) return "low";
  const rounded = Math.round(score);
  if (rounded >= REVIEW_PRIORITY_BOUNDARIES.high) return "high";
  if (rounded >= REVIEW_PRIORITY_BOUNDARIES.medium) return "medium";
  return "low";
}

/**
 * Offset, in whole days from `now`, for a given priority + catalogId
 * hash. Stable for the same catalogId, so a fixed catalog always
 * lands on the same bucket.
 *
 *   - high:   hash % 3  → 0~2 days
 *   - medium: 3 + hash % 5  → 3~7 days
 *   - low:    8 + hash % 13 → 8~20 days
 */
export function getSuggestedReviewOffset(args: {
  priority: ReadingReviewPriority;
  catalogId: string;
}): number {
  const h = stableCatalogHash(args.catalogId);
  switch (args.priority) {
    case "high":
      return h % 3;
    case "medium":
      return 3 + (h % 5);
    case "low":
    default:
      return 8 + (h % 13);
  }
}

// ---------- reason codes ----------

function buildReasonCodes(args: {
  priorityScore: number;
  daysSinceLast: number;
  noteCount: number;
  activeMonths: number;
  sessionRelevant: boolean;
}): ReadingReviewReasonCode[] {
  const codes: ReadingReviewReasonCode[] = [];
  if (args.sessionRelevant) codes.push("session_book");
  if (args.daysSinceLast >= 90) codes.push("long_inactive");
  if (args.noteCount >= 20) codes.push("high_note_count");
  if (args.activeMonths >= 4) codes.push("multi_month_activity");
  if (args.daysSinceLast >= 0 && args.daysSinceLast < 30) codes.push("recent_activity");
  // Guarantee at least one code so the UI never shows an empty reason list.
  if (codes.length === 0) codes.push("recent_activity");
  return codes;
}

// ---------- builders ----------

/**
 * Build the book-side review tasks. Books without a usable
 * `lastNoteAt` are NOT included — they go to `unscheduledBooks` so the
 * UI can show the gap honestly instead of fabricating a fake date.
 */
export function buildBookReviewTasks(args: {
  books: ReadonlyArray<WereadReadingMapBook>;
  now: Date;
  sessionCatalogIds: ReadonlySet<string>;
}): { tasks: ReadingReviewBookTask[]; unscheduled: ReadingReviewUnscheduledBook[] } {
  const tasks: ReadingReviewBookTask[] = [];
  const unscheduled: ReadingReviewUnscheduledBook[] = [];
  for (const book of args.books) {
    if (!book || typeof book.catalogId !== "string") continue;
    const lastNote = parseReviewDate(book.lastNoteAt);
    if (!lastNote) {
      unscheduled.push({
        catalogId: book.catalogId,
        title: typeof book.title === "string" ? book.title : "(未命名书目)",
        reason: "missing_last_note_date",
      });
      continue;
    }
    const todayUtc = new Date(
      Date.UTC(
        args.now.getUTCFullYear(),
        args.now.getUTCMonth(),
        args.now.getUTCDate()
      )
    );
    const daysSince = daysBetweenReviewDates(lastNote, todayUtc);
    const sessionRelevant = args.sessionCatalogIds.has(book.catalogId);
    const score = calculateReviewPriorityScore({
      book,
      now: args.now,
      sessionCatalogIds: args.sessionCatalogIds,
    });
    const priority = getReviewPriority(score);
    const offset = getSuggestedReviewOffset({ priority, catalogId: book.catalogId });
    const suggested = addReviewDays(todayUtc, offset);
    const reasons = buildReasonCodes({
      priorityScore: score,
      daysSinceLast: daysSince,
      noteCount: book.noteCount,
      activeMonths: book.activeMonths,
      sessionRelevant,
    });
    tasks.push({
      id: `book:${book.catalogId}`,
      kind: "book",
      catalogId: book.catalogId,
      title: typeof book.title === "string" ? book.title : "(未命名书目)",
      author: typeof book.author === "string" ? book.author : null,
      suggestedDate: toIsoDate(suggested),
      priority,
      priorityScore: score,
      noteCount: Math.max(0, Math.floor(book.noteCount)),
      activeMonths: Math.max(0, Math.floor(book.activeMonths)),
      lastNoteAt: typeof book.lastNoteAt === "string" ? book.lastNoteAt : "",
      sessionRelevant,
      reasonCodes: reasons,
    });
  }
  return { tasks, unscheduled };
}

/**
 * Build the theme-side review tasks. Themes are session-only: no
 * theme task is bound to a specific catalogId, and no theme label is
 * ever written back to the server.
 *
 * Spread rule: `offset = index % 7` so 7 themes would cover days
 * 0..6, with subsequent themes wrapping into the same window.
 * We cap at 6 themes per the spec — but the rule still keeps the
 * math safe if a future caller passes more.
 */
export function buildThemeReviewTasks(args: {
  overlay: WereadSessionThemeOverlay;
  now: Date;
}): ReadingReviewThemeTask[] {
  if (!args.overlay || !args.overlay.enabled) return [];
  const themes = Array.isArray(args.overlay.themes) ? args.overlay.themes : [];
  if (themes.length === 0) return [];
  const todayUtc = new Date(
    Date.UTC(
      args.now.getUTCFullYear(),
      args.now.getUTCMonth(),
      args.now.getUTCDate()
    )
  );
  const out: ReadingReviewThemeTask[] = [];
  const seenLabels = new Set<string>();
  let emitted = 0;
  for (let i = 0; i < themes.length; i += 1) {
    if (out.length >= 6) break;
    const theme = themes[i];
    if (!theme || typeof theme.label !== "string" || theme.label.length === 0) continue;
    const rawLabel = theme.label.length > 60 ? theme.label.slice(0, 60) : theme.label;
    if (seenLabels.has(rawLabel)) continue;
    seenLabels.add(rawLabel);
    const offset = emitted % 7;
    const suggested = addReviewDays(todayUtc, offset);
    out.push({
      id: `theme:${emitted}:${theme.source}:${rawLabel}`,
      kind: "theme",
      label: rawLabel,
      suggestedDate: toIsoDate(suggested),
      source: theme.source === "direction" ? "direction" : "theme",
    });
    emitted += 1;
  }
  return out;
}

/**
 * Bucket a flat task list into per-day buckets that cover every day
 * in [startDate, startDate + horizonDays). Tasks whose suggestedDate
 * falls outside the window are dropped — callers re-compute the
 * calendar when horizon changes.
 */
export function buildReviewCalendarDays(args: {
  startDate: Date;
  horizonDays: number;
  tasks: ReadonlyArray<ReadingReviewTask>;
}): ReadingReviewDay[] {
  const days: ReviewDayBuilder[] = [];
  const total = Math.max(0, Math.floor(args.horizonDays));
  for (let i = 0; i < total; i += 1) {
    days.push({ date: toIsoDate(addReviewDays(args.startDate, i)), tasks: [] });
  }
  const index = new Map<string, number>();
  for (let i = 0; i < days.length; i += 1) index.set(days[i].date, i);
  for (const task of args.tasks) {
    const idx = index.get(task.suggestedDate);
    if (idx === undefined) continue;
    days[idx].tasks.push(task);
  }
  return days;
}

interface ReviewDayBuilder {
  date: string;
  tasks: ReadingReviewTask[];
}

function sortBookTasks(a: ReadingReviewBookTask, b: ReadingReviewBookTask): number {
  if (a.suggestedDate < b.suggestedDate) return -1;
  if (a.suggestedDate > b.suggestedDate) return 1;
  const order = { high: 0, medium: 1, low: 2 } as const;
  const pa = order[a.priority];
  const pb = order[b.priority];
  if (pa !== pb) return pa - pb;
  if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
  if (a.catalogId < b.catalogId) return -1;
  if (a.catalogId > b.catalogId) return 1;
  return 0;
}

function sortTasks(
  tasks: ReadonlyArray<ReadingReviewTask>
): ReadingReviewTask[] {
  const books = tasks.filter((t): t is ReadingReviewBookTask => t.kind === "book");
  const themes = tasks.filter((t): t is ReadingReviewThemeTask => t.kind === "theme");
  books.sort(sortBookTasks);
  themes.sort((a, b) => {
    if (a.suggestedDate < b.suggestedDate) return -1;
    if (a.suggestedDate > b.suggestedDate) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return [...themes, ...books];
}

/**
 * High-level builder used by the dashboard. Returns a fully
 * serialisable calendar. `recommendCount` caps the BOOK tasks only;
 * theme tasks are always passed through unchanged.
 */
export function buildReadingReviewCalendar(args: {
  response: WereadReadingMapResponse | null | undefined;
  overlay: WereadSessionThemeOverlay;
  now: Date;
  horizonDays: number;
  recommendCount: number;
}): ReadingReviewCalendar {
  const horizon = Math.max(1, Math.floor(args.horizonDays));
  const recommend = Math.max(0, Math.floor(args.recommendCount));
  const todayUtc = new Date(
    Date.UTC(
      args.now.getUTCFullYear(),
      args.now.getUTCMonth(),
      args.now.getUTCDate()
    )
  );
  const endUtc = addReviewDays(todayUtc, horizon - 1);

  const overlay: WereadSessionThemeOverlay = args.overlay ?? {
    enabled: false,
    themes: [],
    catalogIds: [],
    notesUsed: 0,
  };
  const sessionCatalogIds = new Set<string>(
    Array.isArray(overlay.catalogIds) ? overlay.catalogIds : []
  );
  const books: ReadonlyArray<WereadReadingMapBook> = Array.isArray(args.response?.books)
    ? args.response!.books
    : [];

  const { tasks: allBookTasks, unscheduled } = buildBookReviewTasks({
    books,
    now: args.now,
    sessionCatalogIds,
  });
  const bookTasks = [...allBookTasks].sort(sortBookTasks).slice(0, recommend);
  const themeTasks = buildThemeReviewTasks({
    overlay,
    now: args.now,
  });
  const tasks = sortTasks([...bookTasks, ...themeTasks]);
  const days = buildReviewCalendarDays({
    startDate: todayUtc,
    horizonDays: horizon,
    tasks,
  });
  const sessionBooksUsed = bookTasks.filter((t) => t.sessionRelevant).length;

  return {
    startDate: toIsoDate(todayUtc),
    endDate: toIsoDate(endUtc),
    horizonDays: horizon,
    tasks,
    days,
    unscheduledBooks: unscheduled,
    meta: {
      booksConsidered: books.length,
      bookTasks: bookTasks.length,
      themeTasks: themeTasks.length,
      sessionBooksUsed,
      persisted: false,
    },
  };
}

// ---------- formatters ----------

const REASON_LABELS_ZH: Record<ReadingReviewReasonCode, string> = {
  session_book: "当前会话涉及这本书",
  long_inactive: "距离上次阅读时间较长",
  high_note_count: "这本书留下了较多阅读记录",
  multi_month_activity: "在多个自然月持续阅读",
  recent_activity: "近期仍有阅读活动",
};

export function formatReviewReason(code: ReadingReviewReasonCode): string {
  return REASON_LABELS_ZH[code];
}

export function formatReviewReasons(
  codes: ReadonlyArray<ReadingReviewReasonCode>
): string[] {
  return codes.map(formatReviewReason);
}

export function formatReviewDate(input: string | null | undefined): string {
  if (typeof input !== "string") return "—";
  // Already YYYY-MM-DD — pass through.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const d = parseReviewDate(input);
  if (!d) return "—";
  return toIsoDate(d);
}

export function formatReviewPriorityLabel(priority: ReadingReviewPriority): string {
  switch (priority) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
    default:
      return "低";
  }
}

export function formatReviewCalendarSummary(calendar: ReadingReviewCalendar): string {
  const high = calendar.tasks.filter(
    (t): t is ReadingReviewBookTask => t.kind === "book" && t.priority === "high"
  ).length;
  return `共 ${calendar.meta.bookTasks} 项书目建议 · ${calendar.meta.themeTasks} 项会话主题 · ${high} 项高优先级`;
}

export function hasReviewCalendarData(
  calendar: ReadingReviewCalendar | null | undefined
): boolean {
  if (!calendar) return false;
  return calendar.tasks.length > 0 || calendar.unscheduledBooks.length > 0;
}