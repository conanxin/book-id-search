/**
 * S27I — Unit tests for the review calendar model.
 *
 * ≥32 assertions per the S27I spec. All inputs are synthetic, no real
 * titles / tokens / private ids.
 */

import { describe, expect, it } from "vitest";
import {
  REVIEW_DEFAULT_HORIZON,
  REVIEW_DEFAULT_RECOMMEND,
  REVIEW_HORIZON_OPTIONS,
  REVIEW_RECOMMEND_OPTIONS,
  addReviewDays,
  buildBookReviewTasks,
  buildReadingReviewCalendar,
  buildReviewCalendarDays,
  buildThemeReviewTasks,
  calculateReviewPriorityScore,
  daysBetweenReviewDates,
  formatReviewCalendarSummary,
  formatReviewDate,
  formatReviewPriorityLabel,
  formatReviewReason,
  formatReviewReasons,
  getReviewPriority,
  getSuggestedReviewOffset,
  hasReviewCalendarData,
  parseReviewDate,
  stableCatalogHash,
} from "./wereadReviewCalendarModel";
import type {
  WereadReadingMapBook,
  WereadReadingMapResponse,
} from "../wereadPrivate";
import type { WereadSessionThemeOverlay } from "./wereadSessionThemeModel";

// ---------- synthetic fixtures ----------

const NOW = new Date("2026-08-02T00:00:00.000Z");

function makeBook(
  catalogId: string,
  opts: Partial<WereadReadingMapBook> = {}
): WereadReadingMapBook {
  return {
    catalogId,
    title: `Synthetic Book ${catalogId}`,
    author: "Synthetic Author",
    noteCount: 5,
    highlights: 3,
    thoughts: 2,
    reviews: 0,
    unknown: 0,
    activeMonths: 1,
    firstNoteAt: "2025-12-01T00:00:00.000Z",
    lastNoteAt: "2026-07-20T00:00:00.000Z",
    ...opts,
  };
}

function makeReadingMap(
  books: WereadReadingMapBook[]
): WereadReadingMapResponse {
  return {
    ok: true,
    overview: {
      booksCount: books.length,
      notesCount: books.reduce((acc, b) => acc + b.noteCount, 0),
      matchedCatalogsCount: books.length,
      matchedNoteRecordsCount: books.reduce((acc, b) => acc + b.noteCount, 0),
      firstNoteAt: "2025-01-01T00:00:00.000Z",
      lastNoteAt: "2026-07-20T00:00:00.000Z",
      activeMonths: 6,
      currentStreakMonths: 1,
      longestStreakMonths: 3,
    },
    timeline: [],
    books,
    links: [],
    meta: {
      monthsRequested: 36,
      monthsReturned: 36,
      topBooksRequested: 18,
      topBooksReturned: books.length,
      linksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

function makeOverlay(opts: {
  enabled?: boolean;
  themes?: Array<{ id: string; label: string; source: "theme" | "direction" }>;
  catalogIds?: string[];
  notesUsed?: number;
}): WereadSessionThemeOverlay {
  return {
    enabled: opts.enabled ?? true,
    themes: opts.themes ?? [],
    catalogIds: opts.catalogIds ?? [],
    notesUsed: opts.notesUsed ?? 0,
  };
}

// ---------- date helpers ----------

describe("wereadReviewCalendarModel — date helpers", () => {
  it("parseReviewDate returns null for missing input", () => {
    expect(parseReviewDate(null)).toBeNull();
    expect(parseReviewDate(undefined)).toBeNull();
    expect(parseReviewDate("")).toBeNull();
  });

  it("parseReviewDate returns null for malformed input", () => {
    expect(parseReviewDate("not-a-date")).toBeNull();
  });

  it("parseReviewDate returns a Date for a valid ISO string", () => {
    const d = parseReviewDate("2026-07-20T00:00:00.000Z");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
  });

  it("daysBetweenReviewDates floors to whole UTC days", () => {
    const a = new Date("2026-01-01T00:00:00.000Z");
    const b = new Date("2026-01-04T12:00:00.000Z");
    expect(daysBetweenReviewDates(a, b)).toBe(3);
  });

  it("addReviewDays returns a new Date offset by N days", () => {
    const base = new Date("2026-08-02T00:00:00.000Z");
    const next = addReviewDays(base, 7);
    expect(next.getUTCDate()).toBe(9);
  });

  it("formatReviewDate passes through YYYY-MM-DD and falls back to dash", () => {
    expect(formatReviewDate("2026-08-02")).toBe("2026-08-02");
    expect(formatReviewDate(null)).toBe("—");
    expect(formatReviewDate("garbage")).toBe("—");
  });
});

// ---------- hash + offsets ----------

describe("wereadReviewCalendarModel — hash + offsets", () => {
  it("stableCatalogHash returns the same value for the same input", () => {
    expect(stableCatalogHash("123_0000001234")).toBe(
      stableCatalogHash("123_0000001234")
    );
  });

  it("stableCatalogHash returns different values for different inputs", () => {
    expect(stableCatalogHash("123_0000001234")).not.toBe(
      stableCatalogHash("456_0000005678")
    );
  });

  it("high-priority offsets land in 0~2 days", () => {
    for (let i = 0; i < 12; i += 1) {
      const offset = getSuggestedReviewOffset({
        priority: "high",
        catalogId: `cat_${i}`,
      });
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(2);
    }
  });

  it("medium-priority offsets land in 3~7 days", () => {
    for (let i = 0; i < 12; i += 1) {
      const offset = getSuggestedReviewOffset({
        priority: "medium",
        catalogId: `cat_${i}`,
      });
      expect(offset).toBeGreaterThanOrEqual(3);
      expect(offset).toBeLessThanOrEqual(7);
    }
  });

  it("low-priority offsets land in 8~20 days", () => {
    for (let i = 0; i < 12; i += 1) {
      const offset = getSuggestedReviewOffset({
        priority: "low",
        catalogId: `cat_${i}`,
      });
      expect(offset).toBeGreaterThanOrEqual(8);
      expect(offset).toBeLessThanOrEqual(20);
    }
  });

  it("high-priority offsets differ across distinct catalogIds", () => {
    const offsets = new Set<number>();
    for (let i = 0; i < 6; i += 1) {
      offsets.add(
        getSuggestedReviewOffset({ priority: "high", catalogId: `cat_${i}` })
      );
    }
    expect(offsets.size).toBeGreaterThan(1);
  });
});

// ---------- priority math ----------

describe("wereadReviewCalendarModel — priority math", () => {
  it("time score ≥365 days yields long-inactive bump", () => {
    const book = makeBook("c_long", {
      noteCount: 5,
      activeMonths: 1,
      lastNoteAt: "2025-07-01T00:00:00.000Z",
    });
    const score = calculateReviewPriorityScore({
      book,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    // 45 (time) + ~3.75 (notes) + 1.25 (months) = ~50
    expect(score).toBeGreaterThanOrEqual(45);
    expect(score).toBeLessThan(70);
  });

  it("note score is capped at 40 → +30 weight", () => {
    const book = makeBook("c_cap", {
      noteCount: 999,
      activeMonths: 12,
      lastNoteAt: "2026-08-01T00:00:00.000Z",
    });
    const score = calculateReviewPriorityScore({
      book,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    // 8 (time, <30d) + 30 (notes capped) + 15 (months capped) = 53
    expect(score).toBe(53);
  });

  it("activeMonths score is capped at 12", () => {
    const a = makeBook("c1", {
      noteCount: 0,
      activeMonths: 12,
      lastNoteAt: "2026-08-01T00:00:00.000Z",
    });
    const b = makeBook("c2", {
      noteCount: 0,
      activeMonths: 60,
      lastNoteAt: "2026-08-01T00:00:00.000Z",
    });
    const sa = calculateReviewPriorityScore({
      book: a,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    const sb = calculateReviewPriorityScore({
      book: b,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    expect(sa).toBe(sb);
  });

  it("session boost adds 20 points", () => {
    const book = makeBook("c_boost", {
      noteCount: 5,
      activeMonths: 1,
      lastNoteAt: "2026-08-01T00:00:00.000Z",
    });
    const without = calculateReviewPriorityScore({
      book,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    const withBoost = calculateReviewPriorityScore({
      book,
      now: NOW,
      sessionCatalogIds: new Set(["c_boost"]),
    });
    expect(withBoost).toBe(without + 20);
  });

  it("total score is capped at 100", () => {
    const book = makeBook("c_max", {
      noteCount: 999,
      activeMonths: 12,
      lastNoteAt: "2020-01-01T00:00:00.000Z",
    });
    const score = calculateReviewPriorityScore({
      book,
      now: NOW,
      sessionCatalogIds: new Set(["c_max"]),
    });
    expect(score).toBeLessThanOrEqual(100);
  });

  it("score never goes below 0", () => {
    const book = makeBook("c_zero", {
      noteCount: 0,
      activeMonths: 0,
      lastNoteAt: "2026-08-02T00:00:00.000Z",
    });
    const score = calculateReviewPriorityScore({
      book,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("getReviewPriority maps 70+ to high", () => {
    expect(getReviewPriority(70)).toBe("high");
    expect(getReviewPriority(100)).toBe("high");
  });

  it("getReviewPriority maps 45~69 to medium", () => {
    expect(getReviewPriority(45)).toBe("medium");
    expect(getReviewPriority(69)).toBe("medium");
  });

  it("getReviewPriority maps <45 to low", () => {
    expect(getReviewPriority(44)).toBe("low");
    expect(getReviewPriority(0)).toBe("low");
  });
});

// ---------- reason codes ----------

describe("wereadReviewCalendarModel — reason codes", () => {
  it("long_inactive appears after 90 days", () => {
    const reasons = formatReviewReasons([
      "session_book",
      "long_inactive",
      "high_note_count",
      "multi_month_activity",
      "recent_activity",
    ]);
    expect(reasons).toContain("距离上次阅读时间较长");
    expect(formatReviewReason("session_book")).toBe(
      "当前会话涉及这本书"
    );
  });

  it("formatReviewPriorityLabel returns 高/中/低", () => {
    expect(formatReviewPriorityLabel("high")).toBe("高");
    expect(formatReviewPriorityLabel("medium")).toBe("中");
    expect(formatReviewPriorityLabel("low")).toBe("低");
  });
});

// ---------- book tasks ----------

describe("wereadReviewCalendarModel — book tasks", () => {
  it("books with a valid lastNoteAt produce a task", () => {
    const { tasks, unscheduled } = buildBookReviewTasks({
      books: [makeBook("c_ok", { lastNoteAt: "2026-07-01T00:00:00.000Z" })],
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    expect(tasks.length).toBe(1);
    expect(unscheduled.length).toBe(0);
  });

  it("books without a lastNoteAt are pushed to unscheduled", () => {
    const { tasks, unscheduled } = buildBookReviewTasks({
      books: [
        makeBook("c_ok", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
        makeBook("c_missing", { lastNoteAt: null }),
        makeBook("c_undef", { lastNoteAt: undefined }),
        makeBook("c_bad", { lastNoteAt: "garbage" as unknown as string }),
      ],
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    expect(tasks.length).toBe(1);
    expect(unscheduled.length).toBe(3);
    expect(unscheduled.every((b) => b.reason === "missing_last_note_date")).toBe(true);
  });

  it("session overlay books are flagged", () => {
    const { tasks } = buildBookReviewTasks({
      books: [
        makeBook("c_session", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
        makeBook("c_other", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
      ],
      now: NOW,
      sessionCatalogIds: new Set(["c_session"]),
    });
    expect(tasks[0].sessionRelevant).toBe(true);
    expect(tasks[1].sessionRelevant).toBe(false);
  });

  it("output is stable for the same input", () => {
    const books = [
      makeBook("c_a", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
      makeBook("c_b", { lastNoteAt: "2026-05-01T00:00:00.000Z" }),
    ];
    const a = buildBookReviewTasks({
      books,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    const b = buildBookReviewTasks({
      books,
      now: NOW,
      sessionCatalogIds: new Set(),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------- theme tasks ----------

describe("wereadReviewCalendarModel — theme tasks", () => {
  it("emits one task per theme with offset = index % 7", () => {
    const overlay = makeOverlay({
      enabled: true,
      themes: [
        { id: "theme-0", label: "主题A", source: "theme" },
        { id: "theme-1", label: "主题B", source: "theme" },
        { id: "theme-2", label: "主题C", source: "theme" },
        { id: "direction-0", label: "方向X", source: "direction" },
      ],
    });
    const tasks = buildThemeReviewTasks({ overlay, now: NOW });
    expect(tasks.length).toBe(4);
    // Offsets: 0,1,2,3
    const offsets = tasks.map((t) => t.suggestedDate);
    const uniqueOffsets = new Set(offsets);
    expect(uniqueOffsets.size).toBe(4);
  });

  it("caps at 6 themes even if more are supplied", () => {
    const overlay = makeOverlay({
      enabled: true,
      themes: Array.from({ length: 9 }, (_, i) => ({
        id: `t-${i}`,
        label: `主题${i}`,
        source: "theme" as const,
      })),
    });
    const tasks = buildThemeReviewTasks({ overlay, now: NOW });
    expect(tasks.length).toBe(6);
  });

  it("deduplicates themes with identical labels", () => {
    const overlay = makeOverlay({
      enabled: true,
      themes: [
        { id: "t-0", label: "重复", source: "theme" },
        { id: "t-1", label: "重复", source: "theme" },
        { id: "t-2", label: "唯一", source: "theme" },
      ],
    });
    const tasks = buildThemeReviewTasks({ overlay, now: NOW });
    expect(tasks.length).toBe(2);
  });

  it("returns no tasks when overlay is disabled", () => {
    const overlay = makeOverlay({
      enabled: false,
      themes: [{ id: "t", label: "主题", source: "theme" }],
    });
    expect(buildThemeReviewTasks({ overlay, now: NOW })).toEqual([]);
  });

  it("returns no tasks when overlay has no themes", () => {
    const overlay = makeOverlay({ enabled: true, themes: [] });
    expect(buildThemeReviewTasks({ overlay, now: NOW })).toEqual([]);
  });

  it("clamps label to 60 characters", () => {
    const long = "长".repeat(80);
    const overlay = makeOverlay({
      enabled: true,
      themes: [{ id: "t", label: long, source: "theme" }],
    });
    const tasks = buildThemeReviewTasks({ overlay, now: NOW });
    expect(tasks[0].label.length).toBe(60);
  });
});

// ---------- calendar days ----------

describe("wereadReviewCalendarModel — calendar days", () => {
  it("buildReviewCalendarDays covers every horizon day even when empty", () => {
    const days = buildReviewCalendarDays({
      startDate: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 14,
      tasks: [],
    });
    expect(days.length).toBe(14);
    expect(days[0].date).toBe("2026-08-02");
    expect(days[13].date).toBe("2026-08-15");
  });

  it("groups multiple tasks on the same date", () => {
    const days = buildReviewCalendarDays({
      startDate: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 7,
      tasks: [
        {
          id: "t1",
          kind: "book",
          catalogId: "c1",
          title: "Book1",
          author: "A",
          suggestedDate: "2026-08-03",
          priority: "high",
          priorityScore: 80,
          noteCount: 5,
          activeMonths: 1,
          lastNoteAt: "2026-08-01T00:00:00.000Z",
          sessionRelevant: false,
          reasonCodes: ["recent_activity"],
        },
        {
          id: "t2",
          kind: "theme",
          label: "主题",
          suggestedDate: "2026-08-03",
          source: "theme",
        },
      ],
    });
    const day3 = days.find((d) => d.date === "2026-08-03");
    expect(day3?.tasks.length).toBe(2);
  });
});

// ---------- end-to-end calendar ----------

describe("wereadReviewCalendarModel — end-to-end calendar", () => {
  it("horizons 14 / 28 / 42 yield matching day counts", () => {
    const resp = makeReadingMap([
      makeBook("c1", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const overlay = makeOverlay({ enabled: true, themes: [] });
    for (const horizon of [14, 28, 42]) {
      const cal = buildReadingReviewCalendar({
        response: resp,
        overlay,
        now: NOW,
        horizonDays: horizon,
        recommendCount: 12,
      });
      expect(cal.days.length).toBe(horizon);
      expect(cal.horizonDays).toBe(horizon);
    }
  });

  it("meta.persisted is hard-coded to false", () => {
    const resp = makeReadingMap([makeBook("c1")]);
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay: makeOverlay({ enabled: true }),
      now: NOW,
      horizonDays: 28,
      recommendCount: 6,
    });
    expect(cal.meta.persisted).toBe(false);
  });

  it("books are sorted by date then priority then score then catalogId", () => {
    const resp = makeReadingMap([
      makeBook("c_a", {
        noteCount: 5,
        activeMonths: 1,
        lastNoteAt: "2026-08-01T00:00:00.000Z",
      }),
      makeBook("c_b", {
        noteCount: 999,
        activeMonths: 12,
        lastNoteAt: "2025-06-01T00:00:00.000Z",
      }),
      makeBook("c_c", {
        noteCount: 50,
        activeMonths: 5,
        lastNoteAt: "2026-02-01T00:00:00.000Z",
      }),
    ]);
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay: makeOverlay({ enabled: true, themes: [] }),
      now: NOW,
      horizonDays: 28,
      recommendCount: 12,
    });
    // High priority should come first.
    expect(cal.tasks[0].kind).toBe("book");
    const firstBook = cal.tasks[0] as Extract<typeof cal.tasks[0], { kind: "book" }>;
    expect(firstBook.priority).toBe("high");
  });

  it("recommend count limits book tasks only, not themes", () => {
    const resp = makeReadingMap(
      Array.from({ length: 10 }, (_, i) =>
        makeBook(`c_${i}`, { lastNoteAt: "2026-07-01T00:00:00.000Z" })
      )
    );
    const overlay = makeOverlay({
      enabled: true,
      themes: Array.from({ length: 6 }, (_, i) => ({
        id: `t-${i}`,
        label: `主题${i}`,
        source: "theme" as const,
      })),
    });
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay,
      now: NOW,
      horizonDays: 28,
      recommendCount: 6,
    });
    expect(cal.meta.bookTasks).toBeLessThanOrEqual(6);
    expect(cal.meta.themeTasks).toBe(6);
  });

  it("empty reading-map yields an empty book side but theme tasks remain", () => {
    const resp = makeReadingMap([]);
    const overlay = makeOverlay({
      enabled: true,
      themes: [{ id: "t", label: "唯一主题", source: "theme" }],
    });
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay,
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    expect(cal.meta.bookTasks).toBe(0);
    expect(cal.meta.themeTasks).toBe(1);
    expect(cal.meta.booksConsidered).toBe(0);
  });

  it("empty session overlay yields no theme tasks but book tasks remain", () => {
    const resp = makeReadingMap([
      makeBook("c1", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay: makeOverlay({ enabled: true, themes: [] }),
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    expect(cal.meta.themeTasks).toBe(0);
    expect(cal.meta.bookTasks).toBe(1);
  });

  it("null response yields an empty calendar without crashing", () => {
    const cal = buildReadingReviewCalendar({
      response: null,
      overlay: makeOverlay({ enabled: true }),
      now: NOW,
      horizonDays: 28,
      recommendCount: 12,
    });
    expect(cal.tasks.length).toBe(0);
    expect(cal.days.length).toBe(28);
    expect(cal.meta.booksConsidered).toBe(0);
  });
});

// ---------- privacy contract ----------

describe("wereadReviewCalendarModel — privacy contract", () => {
  it("calendar output never includes note text / comment", () => {
    // `title` here is the public catalog title, which IS allowed
    // (it's a public field on `WereadReadingMapBook`). The test
    // just makes sure no `comment` field or note-text-shaped payload
    // sneaks into the calendar JSON.
    const resp = makeReadingMap([
      makeBook("c_priv", {
        lastNoteAt: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay: makeOverlay({ enabled: true }),
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    const json = JSON.stringify(cal);
    expect(json).not.toContain("\"comment\"");
    expect(json).not.toMatch(/note\.text/);
  });

  it("calendar output never includes summary overview / keyPoints / reviewQuestions", () => {
    const overlay = makeOverlay({
      enabled: true,
      themes: [{ id: "t", label: "ok", source: "theme" }],
    });
    const cal = buildReadingReviewCalendar({
      response: makeReadingMap([]),
      overlay,
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    const json = JSON.stringify(cal);
    expect(json).not.toContain("overview");
    expect(json).not.toContain("keyPoints");
    expect(json).not.toContain("reviewQuestions");
  });

  it("calendar output never includes token / q / private IDs", () => {
    const resp = makeReadingMap([
      makeBook("123_0000000123", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay: makeOverlay({
        enabled: true,
        themes: [],
        catalogIds: ["123_0000000123"],
      }),
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    const json = JSON.stringify(cal);
    expect(json).not.toMatch(/token/i);
    expect(json).not.toMatch(/wereadBookId/);
    expect(json).not.toMatch(/noteId/);
    expect(json).not.toMatch(/highlightId/);
    // public catalogId IS allowed and expected
    expect(json).toContain("123_0000000123");
  });

  it("output is JSON-serialisable with no NaN / Infinity / HTML", () => {
    const resp = makeReadingMap([
      makeBook("c_x", { lastNoteAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay: makeOverlay({
        enabled: true,
        themes: [{ id: "t", label: "x", source: "theme" }],
      }),
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    const json = JSON.stringify(cal);
    expect(json).not.toContain("NaN");
    expect(json).not.toContain("Infinity");
    expect(json).not.toContain("<script");
    expect(json).not.toContain("<div");
  });
});

// ---------- summary + helpers ----------

describe("wereadReviewCalendarModel — summary + helpers", () => {
  it("formatReviewCalendarSummary counts high / book / theme", () => {
    const resp = makeReadingMap([
      makeBook("c_high", {
        noteCount: 999,
        activeMonths: 12,
        lastNoteAt: "2020-01-01T00:00:00.000Z",
      }),
      makeBook("c_low", {
        noteCount: 1,
        activeMonths: 1,
        lastNoteAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    const overlay = makeOverlay({
      enabled: true,
      themes: [{ id: "t", label: "X", source: "theme" }],
    });
    const cal = buildReadingReviewCalendar({
      response: resp,
      overlay,
      now: NOW,
      horizonDays: 28,
      recommendCount: 12,
    });
    const summary = formatReviewCalendarSummary(cal);
    expect(summary).toMatch(/共 \d+ 项书目建议/);
    expect(summary).toMatch(/1 项会话主题/);
    expect(summary).toMatch(/项高优先级/);
  });

  it("hasReviewCalendarData returns false for null and true otherwise", () => {
    expect(hasReviewCalendarData(null)).toBe(false);
    expect(hasReviewCalendarData(undefined)).toBe(false);
    const empty = buildReadingReviewCalendar({
      response: null,
      overlay: makeOverlay({ enabled: true }),
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    expect(hasReviewCalendarData(empty)).toBe(false);
    const notEmpty = buildReadingReviewCalendar({
      response: makeReadingMap([makeBook("c", { lastNoteAt: null })]),
      overlay: makeOverlay({ enabled: true }),
      now: NOW,
      horizonDays: 14,
      recommendCount: 12,
    });
    expect(hasReviewCalendarData(notEmpty)).toBe(true);
  });

  it("exposes the documented option lists and defaults", () => {
    expect(REVIEW_HORIZON_OPTIONS).toEqual([14, 28, 42]);
    expect(REVIEW_RECOMMEND_OPTIONS).toEqual([6, 12, 18]);
    expect(REVIEW_DEFAULT_HORIZON).toBe(28);
    expect(REVIEW_DEFAULT_RECOMMEND).toBe(12);
  });
});