import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNotesTrend,
  clearWereadOverlayCache,
  getWereadStatusByCatalogId,
  getWereadStatusesByCatalogIds,
  getWereadSummary,
  loadWereadOverlay,
  setWereadOverlayCacheTtl,
} from "./private-overlay.js";

describe("private-overlay", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-overlay-"));
    setWereadOverlayCacheTtl(0);
    clearWereadOverlayCache();
  });

  afterEach(() => {
    clearWereadOverlayCache();
    setWereadOverlayCacheTtl(60_000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(name: string, content: unknown) {
    const fullPath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(content, null, 2));
  }

  it("summary count matches fixtures", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: "wb1", readingStatus: "finished", progress: 100 },
      { wereadBookId: "wb2", readingStatus: "reading", progress: 30 },
    ]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: "wb1", type: "note" },
      { wereadBookId: "wb1", type: "highlight" },
      { wereadBookId: "wb2", type: "note" },
      { wereadBookId: "wb2", type: "review" },
      { wereadBookId: "wb2", type: "thought" },
    ]);
    writeFixture("derived/latest/weread-matches.confirmed.json", [
      {
        wereadBookId: "wb1",
        catalogId: "13000000_000000000001",
        ssid: "13000000",
        dxid: "000000000001",
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
      {
        wereadBookId: "wb2",
        catalogId: "13000000_000000000002",
        ssid: "13000000",
        dxid: "000000000002",
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
    ]);
    const data = loadWereadOverlay(tmpDir);
    const summary = getWereadSummary(data);
    expect(summary.dataAvailable).toBe(true);
    expect(summary.booksCount).toBe(2);
    expect(summary.notesCount).toBe(5);
    expect(summary.confirmedMatchesCount).toBe(2);
    expect(summary.confirmedWithNotesCount).toBe(2);
    expect(summary.confirmedWithHighlightsCount).toBe(1);
    expect(summary.totalConfirmedNoteRecords).toBe(5);
  });

  it("status for matched catalogId returns redacted status", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: "wb1", readingStatus: "finished", progress: 100, lastReadAt: "2026-01-01T00:00:00Z" },
    ]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: "wb1", type: "note", note: "private note text" },
      { wereadBookId: "wb1", type: "highlight", comment: "private comment" },
    ]);
    writeFixture("derived/latest/weread-matches.confirmed.json", [
      {
        wereadBookId: "wb1",
        catalogId: "13000000_000000000001",
        ssid: "13000000",
        dxid: "000000000001",
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
    ]);
    const data = loadWereadOverlay(tmpDir);
    const status = getWereadStatusByCatalogId(data, "13000000_000000000001");
    expect(status.matched).toBe(true);
    expect(status.catalogId).toBe("13000000_000000000001");
    expect(status.weread?.readingStatus).toBe("finished");
    expect(status.weread?.progress).toBe(100);
    expect(status.weread?.noteCount).toBe(1);
    expect(status.weread?.highlightCount).toBe(1);
    expect(status.weread?.notesSummary).toEqual({
      total: 2,
      highlights: 1,
      thoughts: 0,
      reviews: 0,
      unknown: 1,
      hasNotes: true,
    });
    expect(status.weread?.matchedRecordsCount).toBe(1);
    // must not leak private fields
    const json = JSON.stringify(status);
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("private note text");
    expect(json).not.toContain("private comment");
    expect(json).not.toContain("noteId");
    expect(json).not.toContain("highlightId");
    expect(json).not.toContain("chapterTitle");
    expect(json).not.toContain("title");
    expect(json).not.toContain("author");
  });

  it("batch status deduplicates and redacts", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: "wb1", readingStatus: "finished", progress: 100, lastReadAt: "2026-01-01T00:00:00Z" },
    ]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: "wb1", type: "note", note: "private note text", chapterTitle: "Ch1" },
      { wereadBookId: "wb1", type: "highlight", comment: "private comment" },
    ]);
    writeFixture("derived/latest/weread-matches.confirmed.json", [
      {
        wereadBookId: "wb1",
        catalogId: "13000000_000000000001",
        ssid: "13000000",
        dxid: "000000000001",
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
    ]);
    const data = loadWereadOverlay(tmpDir);
    const results = getWereadStatusesByCatalogIds(data, [
      "13000000_000000000001",
      "13000000_000000000001",
      "00000000_000000000000",
    ]);
    expect(Object.keys(results)).toEqual([
      "13000000_000000000001",
      "00000000_000000000000",
    ]);
    expect(results["13000000_000000000001"].matched).toBe(true);
    expect(results["00000000_000000000000"].matched).toBe(false);
    expect(results["13000000_000000000001"].weread?.notesSummary).toEqual({
      total: 2,
      highlights: 1,
      thoughts: 0,
      reviews: 0,
      unknown: 1,
      hasNotes: true,
    });
    const json = JSON.stringify(results);
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("private note text");
    expect(json).not.toContain("private comment");
    expect(json).not.toContain("chapterTitle");
    expect(json).not.toContain("noteId");
    expect(json).not.toContain("highlightId");
    expect(json).not.toContain("title");
    expect(json).not.toContain("author");
  });

  it("status for unmatched catalogId returns matched=false", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", []);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", []);
    writeFixture("derived/latest/weread-matches.confirmed.json", []);
    const data = loadWereadOverlay(tmpDir);
    const status = getWereadStatusByCatalogId(data, "13000000_000000000000");
    expect(status.matched).toBe(false);
    expect(status.catalogId).toBe("13000000_000000000000");
    expect(status.weread).toBeUndefined();
  });

  it("missing files returns dataAvailable=false", () => {
    const data = loadWereadOverlay(tmpDir);
    expect(data.dataAvailable).toBe(false);
    expect(data.books.size).toBe(0);
  });

  it("cache returns same object within ttl", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [{ wereadBookId: "wb1" }]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", []);
    writeFixture("derived/latest/weread-matches.confirmed.json", []);
    setWereadOverlayCacheTtl(60_000);
    const d1 = loadWereadOverlay(tmpDir);
    const d2 = loadWereadOverlay(tmpDir);
    expect(d1).toBe(d2);
  });
});

describe("buildNotesTrend", () => {
  const now = Date.now();
  const day = 86400;
  const ts = (offsetDays: number) => Math.floor(now / 1000) - offsetDays * day;

  function makeNote(
    wereadBookId: string,
    type: "note" | "highlight" | "thought" | "review",
    createdAt: number | string | null,
    extras: Record<string, unknown> = {}
  ) {
    return { wereadBookId, type, createdAt, ...extras };
  }

  it("aggregates by 7/30/90 day windows and classifies types", () => {
    const notes = [
      makeNote("wb1", "highlight", ts(2)),
      makeNote("wb1", "highlight", ts(5)),
      makeNote("wb2", "thought", ts(20)),
      makeNote("wb3", "review", ts(50)),
      makeNote("wb4", "note", ts(120)),
    ];
    const trends = buildNotesTrend(notes as any, []);
    expect(trends.windows.days7.total).toBe(2);
    expect(trends.windows.days7.highlights).toBe(2);
    expect(trends.windows.days30.total).toBe(3);
    expect(trends.windows.days30.thoughts).toBe(1);
    expect(trends.windows.days90.total).toBe(4);
    expect(trends.windows.days90.reviews).toBe(1);
    expect(trends.windows.allTime.total).toBe(5);
  });

  it("counts activeBooks and activeDays", () => {
    const notes = [
      makeNote("wb1", "highlight", ts(1)),
      makeNote("wb1", "thought", ts(1)),
      makeNote("wb2", "highlight", ts(3)),
      makeNote("wb3", "review", ts(10)),
    ];
    const trends = buildNotesTrend(notes as any, []);
    expect(trends.windows.days30.activeBooks).toBe(3);
    expect(trends.windows.days30.activeDays).toBeGreaterThanOrEqual(2);
  });

  it("counts notesWithoutDate for missing/invalid dates", () => {
    const notes = [
      makeNote("wb1", "highlight", ts(1)),
      makeNote("wb2", "highlight", null),
      makeNote("wb3", "highlight", undefined),
      makeNote("wb4", "highlight", "not-a-date"),
    ];
    const trends = buildNotesTrend(notes as any, []);
    expect(trends.coverage.notesWithDate).toBe(1);
    expect(trends.coverage.notesWithoutDate).toBe(3);
    expect(trends.coverage.dateCoverageRatio).toBe(0.25);
  });

  it("uses updatedAt as fallback when createdAt is missing", () => {
    const notes = [
      { wereadBookId: "wb1", type: "highlight", updatedAt: ts(2) },
    ];
    const trends = buildNotesTrend(notes as any, []);
    expect(trends.coverage.notesWithDate).toBe(1);
    expect(trends.windows.days7.total).toBe(1);
  });

  it("filters confirmedOnly stats by confirmed book ids", () => {
    const notes = [
      makeNote("wb1", "highlight", ts(1)),
      makeNote("wb2", "highlight", ts(1)),
      makeNote("wb3", "highlight", ts(1)),
    ];
    const confirmed = [
      { wereadBookId: "wb1", catalogId: "13000000_000000000001", ssid: "x", dxid: "y", matchMethod: "isbn" as const, matchConfidence: "high" as const, decisionSource: "auto_seed" as const },
      { wereadBookId: "wb2", catalogId: "13000000_000000000002", ssid: "x", dxid: "y", matchMethod: "isbn" as const, matchConfidence: "high" as const, decisionSource: "auto_seed" as const },
    ];
    const trends = buildNotesTrend(notes as any, confirmed as any);
    expect(trends.confirmedOnly.total).toBe(2);
    expect(trends.confirmedOnly.activeBooks).toBe(2);
    expect(trends.confirmedOnly.highlights).toBe(2);
  });

  it("returns daily series for 7/30/90 windows only", () => {
    const notes = [
      makeNote("wb1", "highlight", ts(1)),
      makeNote("wb2", "highlight", ts(3)),
    ];
    const trends = buildNotesTrend(notes as any, []);
    expect(trends.windows.days7.daily).toBeDefined();
    expect(trends.windows.days30.daily).toBeDefined();
    expect(trends.windows.days90.daily).toBeDefined();
    expect((trends.windows.allTime as any).daily).toBeUndefined();
  });

  it("response is fully redacted", () => {
    const notes = [
      { wereadBookId: "wb1", type: "highlight", createdAt: ts(1), note: "secret note", comment: "secret comment", chapterTitle: "Ch secret", noteId: "abc123", highlightId: "def456" },
    ];
    const trends = buildNotesTrend(notes as any, []);
    const json = JSON.stringify(trends);
    expect(json).not.toContain("secret note");
    expect(json).not.toContain("secret comment");
    expect(json).not.toContain("Ch secret");
    expect(json).not.toContain("abc123");
    expect(json).not.toContain("def456");
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("noteId");
    expect(json).not.toContain("highlightId");
    expect(json).not.toContain("chapterTitle");
  });

  it("handles empty notes", () => {
    const trends = buildNotesTrend([], []);
    expect(trends.windows.days7.total).toBe(0);
    expect(trends.windows.allTime.total).toBe(0);
    expect(trends.coverage.notesWithDate).toBe(0);
    expect(trends.coverage.notesWithoutDate).toBe(0);
    expect(trends.coverage.dateCoverageRatio).toBe(0);
  });
});
