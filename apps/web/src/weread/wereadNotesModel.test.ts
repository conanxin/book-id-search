import { describe, expect, it } from "vitest";
import {
  buildMarkdownExport,
  buildMarkdownExportFilename,
  formatDaysLabel,
  formatNoteDate,
  formatNoteTypeLabel,
  formatNotesSummary,
  formatSortLabel,
  getFilterLabel,
  notesQueryKey,
  truncateNotePreview,
} from "./wereadNotesModel";
import type { WereadNotesLibrarySummary, WereadPrivateNoteItem } from "../wereadPrivate";

const sampleItem: WereadPrivateNoteItem = {
  type: "highlight",
  text: "这是一段划线",
  comment: "我的想法",
  createdAt: "2026-07-04T00:00:00.000Z",
  updatedAt: null,
  matched: true,
  catalogId: "13000000_000000000001",
  source: "private_weread",
};

const baseQuery = {
  type: "all" as const,
  days: "all" as const,
  matchedOnly: false,
  limit: 50,
  offset: 0,
  sort: "newest" as const,
};

describe("wereadNotesModel", () => {
  it("formats note type labels", () => {
    expect(formatNoteTypeLabel("highlight")).toBe("划线");
    expect(formatNoteTypeLabel("thought")).toBe("想法");
    expect(formatNoteTypeLabel("review")).toBe("书评");
    expect(formatNoteTypeLabel("unknown")).toBe("未分类");
  });

  it("formats days / sort / type filter labels", () => {
    expect(formatDaysLabel("7")).toBe("近 7 天");
    expect(formatDaysLabel("30")).toBe("近 30 天");
    expect(formatDaysLabel("90")).toBe("近 90 天");
    expect(formatDaysLabel("all")).toBe("全部时间");
    expect(formatSortLabel("newest")).toBe("最新优先");
    expect(formatSortLabel("oldest")).toBe("最早优先");
    expect(getFilterLabel("all")).toBe("全部");
    expect(getFilterLabel("highlight")).toBe("划线");
    expect(getFilterLabel("thought")).toBe("想法");
    expect(getFilterLabel("review")).toBe("书评");
  });

  it("formats note date with fallback", () => {
    expect(formatNoteDate("2026-07-04T12:34:56.000Z")).toBe("2026-07-04");
    expect(formatNoteDate(null)).toBe("—");
    expect(formatNoteDate(undefined)).toBe("—");
    expect(formatNoteDate("not-a-date")).toBe("—");
  });

  it("formats notes summary with safe defaults", () => {
    const s: WereadNotesLibrarySummary = {
      totalAfterFilter: 10,
      highlights: 6,
      thoughts: 3,
      reviews: 1,
      unknown: 0,
      matchedCount: 4,
      unmatchedCount: 6,
    };
    const v = formatNotesSummary(s);
    expect(v.total).toBe(10);
    expect(v.highlights).toBe(6);
    expect(v.matched).toBe(4);

    const empty = formatNotesSummary(null);
    expect(empty.total).toBe(0);
    expect(empty.highlights).toBe(0);
  });

  it("markdown includes text and comment and excludes forbidden IDs", () => {
    const md = buildMarkdownExport([sampleItem], {
      query: baseQuery,
      generatedAt: new Date("2026-07-04T08:00:00.000Z"),
    });
    expect(md).toContain("这是一段划线");
    expect(md).toContain("我的想法");
    expect(md).toContain("已匹配书目 (13000000_000000000001)");
    // no forbidden keys in the export
    expect(md).not.toMatch(/wereadBookId/);
    expect(md).not.toMatch(/noteId/);
    expect(md).not.toMatch(/highlightId/);
    expect(md).not.toMatch(/chapterTitle/);
  });

  it("markdown filename uses YYYYMMDD", () => {
    const fn = buildMarkdownExportFilename(baseQuery, new Date("2026-07-04T00:00:00.000Z"));
    expect(fn).toBe("weread-notes-export-20260704.md");
  });

  it("truncate preview cuts long strings with ellipsis", () => {
    expect(truncateNotePreview("short")).toBe("short");
    const long = "x".repeat(500);
    const out = truncateNotePreview(long, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
  });

  it("scrubs forbidden identifiers from markdown export", () => {
    const dirty: WereadPrivateNoteItem = {
      ...sampleItem,
      text: "leak wereadBookId=abc123 in text",
    };
    const md = buildMarkdownExport([dirty], { query: baseQuery });
    expect(md).toContain("[redacted]");
    expect(md).not.toMatch(/wereadBookId=abc123/);
  });

  it("notesQueryKey is stable for same query and distinct for different", () => {
    const k1 = notesQueryKey(baseQuery);
    const k2 = notesQueryKey({ ...baseQuery, type: "highlight" });
    expect(k1).not.toBe(k2);
    expect(notesQueryKey(baseQuery)).toBe(k1);
  });
});