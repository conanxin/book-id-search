import { describe, expect, it } from "vitest";
import {
  formatWereadCenterSummaryState,
  classifyWereadError,
  getInitialWereadCenterState,
  WEREAD_CENTER_PRIVACY_COPY,
} from "./wereadCenterModel";
import { hasForbiddenWereadText, type WereadSummary } from "../wereadPrivate";

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
