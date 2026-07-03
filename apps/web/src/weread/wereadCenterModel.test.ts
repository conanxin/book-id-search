import { describe, expect, it } from "vitest";
import {
  formatWereadCenterSummaryState,
  classifyWereadError,
  getInitialWereadCenterState,
  formatTrendWindow,
  getTrendCards,
  getTrendCoverageLabel,
  getActivityLevel,
  WEREAD_CENTER_PRIVACY_COPY,
} from "./wereadCenterModel";
import { hasForbiddenWereadText, type WereadSummary, type WereadTrends } from "../wereadPrivate";

const baseSummary: WereadSummary = {
  ok: true,
  dataAvailable: true,
  booksCount: 1586,
  notesCount: 6989,
  confirmedMatchesCount: 323,
  confirmedWithNotesCount: 37,
  confirmedWithHighlightsCount: 34,
  totalConfirmedNoteRecords: 281,
};

describe("wereadCenterModel", () => {
  it("formats summary numbers correctly", () => {
    const view = formatWereadCenterSummaryState(baseSummary);
    expect(view.booksCount).toBe(1586);
    expect(view.notesCount).toBe(6989);
    expect(view.confirmedMatchesCount).toBe(323);
    expect(view.confirmedWithNotesCount).toBe(37);
    expect(view.confirmedWithHighlightsCount).toBe(34);
    expect(view.totalConfirmedNoteRecords).toBe(281);
    expect(view.matchRatePercent).toBe(20.4);
    expect(view.notesPerConfirmedMatch).toBe(1);
    expect(view.hasNotes).toBe(true);
  });

  it("handles missing optional fields", () => {
    const partial: WereadSummary = {
      ok: true,
      dataAvailable: true,
      booksCount: 10,
      notesCount: 0,
      confirmedMatchesCount: 0,
    };
    const view = formatWereadCenterSummaryState(partial);
    expect(view.confirmedWithNotesCount).toBe(0);
    expect(view.confirmedWithHighlightsCount).toBe(0);
    expect(view.totalConfirmedNoteRecords).toBe(0);
    expect(view.matchRatePercent).toBe(0);
    expect(view.hasNotes).toBe(false);
  });

  it("handles null summary", () => {
    const view = formatWereadCenterSummaryState(null);
    expect(view.booksCount).toBe(0);
    expect(view.notesCount).toBe(0);
    expect(view.hasNotes).toBe(false);
  });

  it("classifies auth errors", () => {
    const err = new Error("Invalid token");
    const classified = classifyWereadError(err);
    expect(classified.type).toBe("auth");
    expect(classified.message).toBe("Token 无效或已过期");
  });

  it("classifies disabled errors", () => {
    const err = new Error("Private API not enabled");
    const classified = classifyWereadError(err);
    expect(classified.type).toBe("disabled");
    expect(classified.message).toBe("私有 API 未启用");
  });

  it("classifies network errors", () => {
    const err = new Error("fetch failed");
    const classified = classifyWereadError(err);
    expect(classified.type).toBe("network");
    expect(classified.message).toBe("fetch failed");
  });

  it("initial state is idle", () => {
    const state = getInitialWereadCenterState();
    expect(state.status).toBe("idle");
    expect(state.token).toBeNull();
    expect(state.summary).toBeNull();
    expect(state.error).toBeNull();
  });

  it("privacy copy does not contain forbidden words", () => {
    for (const text of WEREAD_CENTER_PRIVACY_COPY) {
      expect(hasForbiddenWereadText(text)).toBe(false);
    }
  });
});

describe("formatTrendWindow", () => {
  const baseTrends: WereadTrends = {
    generatedAt: "2026-07-01T00:00:00Z",
    windows: {
      days7: {
        total: 5,
        activeDays: 4,
        activeBooks: 2,
        highlights: 5,
        thoughts: 0,
        reviews: 0,
        unknown: 0,
        daily: [
          { date: "2026-06-25", total: 2, highlights: 2, thoughts: 0, reviews: 0, unknown: 0 },
          { date: "2026-06-26", total: 3, highlights: 3, thoughts: 0, reviews: 0, unknown: 0 },
        ],
      },
      days30: {
        total: 30,
        activeDays: 15,
        activeBooks: 5,
        highlights: 25,
        thoughts: 3,
        reviews: 1,
        unknown: 1,
        daily: [
          { date: "2026-06-01", total: 10, highlights: 8, thoughts: 1, reviews: 1, unknown: 0 },
          { date: "2026-06-15", total: 20, highlights: 17, thoughts: 2, reviews: 0, unknown: 1 },
        ],
      },
      days90: {
        total: 100,
        activeDays: 60,
        activeBooks: 20,
        highlights: 80,
        thoughts: 10,
        reviews: 5,
        unknown: 5,
      },
      allTime: {
        total: 500,
        activeDays: 200,
        activeBooks: 50,
        highlights: 400,
        thoughts: 50,
        reviews: 20,
        unknown: 30,
      },
    },
    confirmedOnly: {
      total: 50,
      activeBooks: 10,
      highlights: 40,
      thoughts: 5,
      reviews: 3,
      unknown: 2,
    },
    coverage: {
      notesWithDate: 480,
      notesWithoutDate: 20,
      dateCoverageRatio: 0.96,
    },
  };

  it("formats 7/30/90 day totals", () => {
    const view = formatTrendWindow(baseTrends);
    expect(view.days7Total).toBe(5);
    expect(view.days30Total).toBe(30);
    expect(view.days90Total).toBe(100);
    expect(view.allTimeTotal).toBe(500);
  });

  it("formats activeDays and activeBooks for 30 days", () => {
    const view = formatTrendWindow(baseTrends);
    expect(view.activeDays30).toBe(15);
    expect(view.activeBooks30).toBe(5);
  });

  it("formats coverage ratio", () => {
    const view = formatTrendWindow(baseTrends);
    expect(view.coverageRatio).toBe(0.96);
    expect(view.notesWithDate).toBe(480);
    expect(view.notesWithoutDate).toBe(20);
    expect(getTrendCoverageLabel(view)).toBe("96%");
  });

  it("maps daily30 series", () => {
    const view = formatTrendWindow(baseTrends);
    expect(view.daily30).toHaveLength(2);
    expect(view.daily30[0]).toEqual({ date: "2026-06-01", total: 10 });
    expect(view.daily30[1]).toEqual({ date: "2026-06-15", total: 20 });
  });

  it("falls back to zero on null trends", () => {
    const view = formatTrendWindow(null);
    expect(view.days7Total).toBe(0);
    expect(view.allTimeTotal).toBe(0);
    expect(view.daily30).toEqual([]);
  });

  it("getTrendCards returns labeled cards", () => {
    const cards = getTrendCards(formatTrendWindow(baseTrends));
    expect(cards.length).toBeGreaterThanOrEqual(5);
    expect(cards.map((c) => c.label)).toContain("最近 7 天新增");
    expect(cards.map((c) => c.label)).toContain("最近 30 天新增");
    expect(cards.find((c) => c.label === "最近 7 天新增")?.value).toBe("5");
  });

  it("getActivityLevel returns correct level", () => {
    const quiet = formatTrendWindow(baseTrends);
    quiet.days7Total = 1;
    expect(getActivityLevel(quiet)).toBe("quiet");
    const normal = formatTrendWindow(baseTrends);
    normal.days7Total = 5;
    expect(getActivityLevel(normal)).toBe("normal");
    const active = formatTrendWindow(baseTrends);
    active.days7Total = 20;
    expect(getActivityLevel(active)).toBe("active");
    const intense = formatTrendWindow(baseTrends);
    intense.days7Total = 60;
    expect(getActivityLevel(intense)).toBe("intense");
  });
});
