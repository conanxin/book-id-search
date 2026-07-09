import { describe, expect, it } from "vitest";
import {
  buildMarkdownExport,
  buildMarkdownExportFilename,
  formatDaysLabel,
  formatNoteDate,
  formatNoteTypeLabel,
  formatNotesSearchInfo,
  formatNotesSummary,
  formatSortLabel,
  getFilterLabel,
  getNoteDisplayParts,
  getNoteSearchTerms,
  hasNoteSearchQuery,
  highlightNoteTextParts,
  normalizeNoteSearchQuery,
  notesQueryKey,
  truncateNotePreview,
  WEREAD_NOTE_SEARCH_MAX_LENGTH,
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

describe("getNoteDisplayParts", () => {
  it("returns trimmed body and comment for a normal note", () => {
    const p = getNoteDisplayParts({
      ...sampleItem,
      text: "  正文  ",
      comment: "  我的想法  ",
    });
    expect(p.bodyText).toBe("正文");
    expect(p.commentText).toBe("我的想法");
    expect(p.isEmpty).toBe(false);
  });

  it("treats whitespace-only text as empty and surfaces the comment as fallback", () => {
    const p = getNoteDisplayParts({
      ...sampleItem,
      text: "   \n  ",
      comment: "只有想法",
    });
    expect(p.bodyText).toBe("");
    expect(p.commentText).toBe("只有想法");
    expect(p.isEmpty).toBe(false);
  });

  it("reports isEmpty=true when both text and comment are blank", () => {
    const p = getNoteDisplayParts({
      ...sampleItem,
      text: "",
      comment: null,
    });
    expect(p.isEmpty).toBe(true);
    expect(p.bodyText).toBe("");
    expect(p.commentText).toBeNull();
  });

  it("handles non-string text safely (defensive)", () => {
    const p = getNoteDisplayParts({
      ...sampleItem,
      text: undefined as unknown as string,
      comment: "fallback",
    });
    expect(p.bodyText).toBe("");
    expect(p.commentText).toBe("fallback");
    expect(p.isEmpty).toBe(false);
  });
});

// ---------- S27D: full-text search helpers ----------

describe("wereadNotesModel S27D search", () => {
  it("normalizeNoteSearchQuery trims, collapses, caps, and handles non-strings", () => {
    expect(normalizeNoteSearchQuery("   ")).toBe("");
    expect(normalizeNoteSearchQuery("")).toBe("");
    expect(normalizeNoteSearchQuery(null)).toBe("");
    expect(normalizeNoteSearchQuery(undefined)).toBe("");
    expect(normalizeNoteSearchQuery(123 as unknown)).toBe("");
    expect(normalizeNoteSearchQuery("  hello  ")).toBe("hello");
    expect(normalizeNoteSearchQuery("a   b\tc\n d")).toBe("a b c d");
    const long = "x".repeat(150);
    const out = normalizeNoteSearchQuery(long);
    expect(out.length).toBe(WEREAD_NOTE_SEARCH_MAX_LENGTH);
    expect(out).toBe("x".repeat(WEREAD_NOTE_SEARCH_MAX_LENGTH));
  });

  it("getNoteSearchTerms splits on whitespace and lowercases", () => {
    expect(getNoteSearchTerms("")).toEqual([]);
    expect(getNoteSearchTerms("   ")).toEqual([]);
    expect(getNoteSearchTerms(null)).toEqual([]);
    expect(getNoteSearchTerms("佛塔 禅修")).toEqual(["佛塔", "禅修"]);
    expect(getNoteSearchTerms("Hello World")).toEqual(["hello", "world"]);
    expect(getNoteSearchTerms("  a   b  c  ")).toEqual(["a", "b", "c"]);
  });

  it("hasNoteSearchQuery reports only non-empty queries", () => {
    expect(hasNoteSearchQuery("")).toBe(false);
    expect(hasNoteSearchQuery("   ")).toBe(false);
    expect(hasNoteSearchQuery(null)).toBe(false);
    expect(hasNoteSearchQuery(undefined)).toBe(false);
    expect(hasNoteSearchQuery("x")).toBe(true);
    expect(hasNoteSearchQuery("  hello  ")).toBe(true);
  });

  it("highlightNoteTextParts marks Chinese substring matches", () => {
    const parts = highlightNoteTextParts("这是一段关于建筑学的划线", "建筑");
    const joined = parts.map((pp) => (pp.matched ? `*${pp.text}*` : pp.text)).join("");
    expect(joined).toBe("这是一段关于*建筑*学的划线");
    expect(parts.some((pp) => pp.matched && pp.text === "建筑")).toBe(true);
    expect(parts.some((pp) => !pp.matched && pp.text === "这是一段关于")).toBe(true);
  });

  it("highlightNoteTextParts supports multiple terms and merges overlaps", () => {
    const parts = highlightNoteTextParts("建筑 ARCHITECTURE 建筑", "建筑 architecture");
    const matched = parts.filter((pp) => pp.matched).map((pp) => pp.text);
    expect(matched).toEqual(["建筑", "ARCHITECTURE", "建筑"]);
  });

  it("highlightNoteTextParts returns single unmatched part for empty q", () => {
    const parts = highlightNoteTextParts("任何文字", "");
    expect(parts).toEqual([{ text: "任何文字", matched: false }]);
    expect(highlightNoteTextParts("任何文字", "   ")).toEqual([{ text: "任何文字", matched: false }]);
    expect(highlightNoteTextParts("任何文字", null)).toEqual([{ text: "任何文字", matched: false }]);
  });

  it("highlightNoteTextParts returns no matched parts when terms don't appear", () => {
    const parts = highlightNoteTextParts("abcdef", "xyz");
    expect(parts).toEqual([{ text: "abcdef", matched: false }]);
  });

  it("highlightNoteTextParts never produces HTML strings (no dangerouslySetInnerHTML)", () => {
    const parts = highlightNoteTextParts("<script>alert(1)</script>", "script");
    expect(parts.some((pp) => pp.matched && pp.text.toLowerCase() === "script")).toBe(true);
    for (const pp of parts) {
      expect(typeof pp.text).toBe("string");
    }
  });

  it("formatNotesSearchInfo returns counts only, no raw query or terms", () => {
    const v = formatNotesSearchInfo({ enabled: true, queryLength: 5, termsCount: 2, matchedCount: 7 });
    expect(v).toEqual({ enabled: true, queryLength: 5, termsCount: 2, matchedCount: 7 });
    expect(formatNotesSearchInfo(null)).toEqual({ enabled: false, queryLength: 0, termsCount: 0, matchedCount: 0 });
    expect(formatNotesSearchInfo(undefined)).toEqual({ enabled: false, queryLength: 0, termsCount: 0, matchedCount: 0 });
    expect(formatNotesSearchInfo({ enabled: false, queryLength: 100, termsCount: 5, matchedCount: 0 }).enabled).toBe(false);
  });
});

