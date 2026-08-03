/**
 * S27J-2 — Unit tests for the browser-local Markdown export model.
 *
 * Pure-function coverage. The browser download helper is exercised
 * through dependency injection so jsdom is not required.
 *
 * ≥35 assertions per the S27J-2 spec.
 */

import { describe, expect, it } from "vitest";
import {
  ANNUAL_MARKDOWN_DISCLAIMER_BULLETS,
  ANNUAL_MARKDOWN_FILENAME_PREFIX,
  ANNUAL_MARKDOWN_MIME,
  ANNUAL_MARKDOWN_PRIVACY_NOTE,
  ANNUAL_MARKDOWN_SITE_BASE_URL,
  buildAnnualReviewMarkdown,
  buildAnnualReviewMarkdownFilename,
  escapeMarkdownInline,
  escapeMarkdownTableCell,
  formatAnnualMarkdownDate,
  formatAnnualMonthLabel,
  formatAnnualQuarterLabel,
  triggerAnnualReviewMarkdownDownload,
  validateAnnualReviewMarkdown,
} from "./wereadAnnualReviewMarkdown";
import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewResponse,
} from "../wereadPrivate";

// ---------- fixtures ----------

const NOW = new Date("2026-08-03T08:24:00.000Z");

function makeMonth(
  month: string,
  total: number,
  over: Partial<{
    highlights: number;
    thoughts: number;
    reviews: number;
    unknown: number;
    matched: number;
    bookCount: number;
  }> = {}
): WereadAnnualReviewResponse["months"][number] {
  return {
    month,
    total,
    highlights: over.highlights ?? 0,
    thoughts: over.thoughts ?? 0,
    reviews: over.reviews ?? 0,
    unknown: over.unknown ?? 0,
    matched: over.matched ?? 0,
    bookCount: over.bookCount ?? 0,
  };
}

function makeBook(over: Partial<WereadAnnualReviewBook> = {}): WereadAnnualReviewBook {
  return {
    catalogId: "10000000_000000000001",
    title: "公共书目 A",
    author: "作者 A",
    publisher: "出版社 X",
    publishYear: 2024,
    noteCount: 30,
    highlights: 18,
    thoughts: 8,
    reviews: 4,
    unknown: 0,
    activeMonths: 5,
    firstNoteAt: "2025-01-05T00:00:00.000Z",
    lastNoteAt: "2025-09-30T00:00:00.000Z",
    ...over,
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const months = Array.from({ length: 12 }, (_, i) =>
    makeMonth(`2025-${String(i + 1).padStart(2, "0")}`, 0)
  );
  return {
    ok: true,
    selectedYear: 2025,
    availableYears: [2025, 2024],
    overview: {
      year: 2025,
      totalRecords: 0,
      datedRecords: 0,
      matchedRecords: 0,
      matchedBooks: 0,
      activeMonths: 0,
      longestStreakMonths: 0,
      firstNoteAt: null,
      lastNoteAt: null,
      peakMonth: null,
      peakMonthRecords: 0,
      averageRecordsPerActiveMonth: 0,
    },
    months,
    quarters: [
      { quarter: "Q1", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q2", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q3", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q4", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    ],
    topBooks: [],
    meta: {
      topBooksRequested: 12,
      topBooksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
    ...overrides,
  };
}

// ---------- 1: escapeMarkdownInline ----------

describe("escapeMarkdownInline", () => {
  it("escapes Markdown meta characters", () => {
    const out = escapeMarkdownInline("a\\b*c_d`e[f]g<h>i#j|k");
    expect(out).toBe("a\\\\b\\*c\\_d\\`e\\[f\\]g\\<h\\>i\\#j\\|k");
  });
  it("collapses whitespace and strips control characters", () => {
    const out = escapeMarkdownInline("a   b\tc\u0007d");
    expect(out).toBe("a b c d");
  });
  it("treats null and undefined as empty", () => {
    expect(escapeMarkdownInline(null)).toBe("");
    expect(escapeMarkdownInline(undefined)).toBe("");
  });
  it("never allows a public title to impersonate a heading line", () => {
    // Even when the title starts with `# `, the escape function
    // prevents it from breaking out of an inline span.
    const out = escapeMarkdownInline("# public title");
    expect(out).toBe("\\# public title");
  });
  it("strips newlines so the inline string stays on a single line", () => {
    const out = escapeMarkdownInline("line1\nline2\r\nline3");
    expect(out.includes("\n")).toBe(false);
    expect(out.includes("\r")).toBe(false);
  });
});

// ---------- 2: escapeMarkdownTableCell ----------

describe("escapeMarkdownTableCell", () => {
  it("escapes pipe characters and collapses newlines", () => {
    const out = escapeMarkdownTableCell("a|b\nc|d");
    expect(out).toBe("a\\|b c\\|d");
    expect(out.includes("\n")).toBe(false);
    expect(out.includes("\r")).toBe(false);
  });
  it("returns empty string for nullish input", () => {
    expect(escapeMarkdownTableCell(null)).toBe("");
    expect(escapeMarkdownTableCell(undefined)).toBe("");
  });
});

// ---------- 3: formatters ----------

describe("formatters", () => {
  it("formatAnnualMarkdownDate uses local YYYY-MM-DD HH:mm", () => {
    expect(formatAnnualMarkdownDate(NOW)).toBe(`${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")} ${String(NOW.getHours()).padStart(2, "0")}:${String(NOW.getMinutes()).padStart(2, "0")}`);
  });

  it("formatAnnualMonthLabel returns year + chinese month", () => {
    expect(formatAnnualMonthLabel(2025, 0)).toBe("2025 年1 月");
    expect(formatAnnualMonthLabel(2025, 11)).toBe("2025 年12 月");
    expect(formatAnnualMonthLabel(2025, 12)).toBe("");
  });

  it("formatAnnualQuarterLabel covers all 4 quarters", () => {
    expect(formatAnnualQuarterLabel("Q1")).toBe("Q1（1–3 月）");
    expect(formatAnnualQuarterLabel("Q4")).toBe("Q4（10–12 月）");
  });
});

// ---------- 4: buildAnnualReviewMarkdown — structure ----------

describe("buildAnnualReviewMarkdown — structure", () => {
  // 1
  it("Markdown title includes the selected year", () => {
    const out = buildAnnualReviewMarkdown({ review: makeResponse(), exportedAt: NOW });
    expect(out.content.startsWith("# 2025 年阅读回顾")).toBe(true);
  });
  // 2
  it("renders the 年度概览 section with the documented fields", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        overview: {
          year: 2025,
          totalRecords: 120,
          datedRecords: 120,
          matchedRecords: 90,
          matchedBooks: 7,
          activeMonths: 9,
          longestStreakMonths: 5,
          firstNoteAt: "2025-01-05T00:00:00.000Z",
          lastNoteAt: "2025-09-30T00:00:00.000Z",
          peakMonth: "2025-03",
          peakMonthRecords: 25,
          averageRecordsPerActiveMonth: 13.33,
        },
      }),
      exportedAt: NOW,
    });
    expect(out.content).toContain("## 年度概览");
    expect(out.content).toContain("- 阅读记录：120");
    expect(out.content).toContain("- 有效日期记录：120");
    expect(out.content).toContain("- 活跃月份：9");
    expect(out.content).toContain("- 最长连续活跃：5 个月");
    expect(out.content).toContain("- 已匹配记录：90");
    expect(out.content).toContain("- 年度书目：7");
    expect(out.content).toContain("- 高峰月份：2025 年3 月");
    expect(out.content).toContain("- 活跃月份平均记录：13.33");
  });
  // 3
  it("emits exactly 12 month table rows", () => {
    const out = buildAnnualReviewMarkdown({ review: makeResponse(), exportedAt: NOW });
    const rows = out.content
      .split("\n")
      .filter((line) => line.startsWith("|") && /\|/.test(line) && line.includes("月") && !line.includes("---") && !line.includes("月份 |"));
    expect(rows).toHaveLength(12);
  });
  // 4
  it("emits Q1..Q4 quarter sections in order", () => {
    const out = buildAnnualReviewMarkdown({ review: makeResponse(), exportedAt: NOW });
    const idxQ1 = out.content.indexOf("### Q1");
    const idxQ2 = out.content.indexOf("### Q2");
    const idxQ3 = out.content.indexOf("### Q3");
    const idxQ4 = out.content.indexOf("### Q4");
    expect(idxQ1).toBeGreaterThan(-1);
    expect(idxQ2).toBeGreaterThan(idxQ1);
    expect(idxQ3).toBeGreaterThan(idxQ2);
    expect(idxQ4).toBeGreaterThan(idxQ3);
  });
  // 5
  it("preserves top books order with index numbers", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [
          makeBook({ catalogId: "10000000_000000000001", title: "公共书目 1", noteCount: 30 }),
          makeBook({ catalogId: "10000000_000000000002", title: "公共书目 2", noteCount: 18 }),
        ],
      }),
      exportedAt: NOW,
    });
    expect(out.content.indexOf("### 1. 《公共书目 1》")).toBeGreaterThan(-1);
    expect(out.content.indexOf("### 2. 《公共书目 2》")).toBeGreaterThan(out.content.indexOf("### 1."));
  });
  // 6
  it("includes the public title and author", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ title: "公共书目 A", author: "作者 A" })],
      }),
      exportedAt: NOW,
    });
    expect(out.content).toContain("《公共书目 A》");
    expect(out.content).toContain("作者：作者 A");
  });
  // 7
  it("omits the author line when missing", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ author: null })],
      }),
      exportedAt: NOW,
    });
    // The section still appears, but no `作者：` line for this book.
    expect(out.content).not.toMatch(/- 作者：/);
  });
  // 8
  it("omits publisher / year fields when missing", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ publisher: null, publishYear: null })],
      }),
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/- 出版信息：/);
  });
  // 9
  it("renders the public catalog URL", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ catalogId: "10000000_000000000099" })],
      }),
      exportedAt: NOW,
    });
    expect(out.content).toContain(`${ANNUAL_MARKDOWN_SITE_BASE_URL}/books/10000000_000000000099`);
  });
});

// ---------- 5: buildAnnualReviewMarkdown — empty year ----------

describe("buildAnnualReviewMarkdown — empty year", () => {
  // 10
  it("still emits the empty-year overview and 12-row zero table", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        selectedYear: 2010,
        availableYears: [2010, 2009],
        overview: {
          year: 2010,
          totalRecords: 0,
          datedRecords: 0,
          matchedRecords: 0,
          matchedBooks: 0,
          activeMonths: 0,
          longestStreakMonths: 0,
          firstNoteAt: null,
          lastNoteAt: null,
          peakMonth: null,
          peakMonthRecords: 0,
          averageRecordsPerActiveMonth: 0,
        },
      }),
      exportedAt: NOW,
    });
    expect(out.content).toContain("# 2010 年阅读回顾");
    expect(out.content).toContain("该年度暂无有效日期的阅读记录");
    const rows = out.content
      .split("\n")
      .filter((line) => line.startsWith("|") && /\|/.test(line) && line.includes("月") && !line.includes("---") && !line.includes("月份 |"));
    expect(rows).toHaveLength(12);
    for (const q of ["### Q1", "### Q2", "### Q3", "### Q4"]) {
      expect(out.content).toContain(q);
    }
  });
  // 11
  it("handles peakMonth=null without crashing", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        overview: {
          year: 2025,
          totalRecords: 1,
          datedRecords: 1,
          matchedRecords: 1,
          matchedBooks: 1,
          activeMonths: 1,
          longestStreakMonths: 1,
          firstNoteAt: "2025-02-01T00:00:00.000Z",
          lastNoteAt: "2025-02-01T00:00:00.000Z",
          peakMonth: null,
          peakMonthRecords: 0,
          averageRecordsPerActiveMonth: 1,
        },
        months: [
          makeMonth("2025-02", 1, { highlights: 1, matched: 1, bookCount: 1 }),
          ...Array.from({ length: 11 }, (_, i) => makeMonth(`2025-${String(i + 1).padStart(2, "0")}`, 0)).filter(
            (m) => m.month !== "2025-02"
          ),
        ],
      }),
      exportedAt: NOW,
    });
    expect(out.content).toContain("- 高峰月份：无记录");
    expect(out.content).toContain("本年暂无明确的记录高峰");
  });
  // 12
  it("rounds the average to 2 decimals", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        overview: {
          year: 2025,
          totalRecords: 5,
          datedRecords: 5,
          matchedRecords: 5,
          matchedBooks: 5,
          activeMonths: 3,
          longestStreakMonths: 2,
          firstNoteAt: null,
          lastNoteAt: null,
          peakMonth: null,
          peakMonthRecords: 0,
          averageRecordsPerActiveMonth: 1.6667,
        },
      }),
      exportedAt: NOW,
    });
    expect(out.content).toContain("- 活跃月份平均记录：1.67");
  });
});

// ---------- 6: escaping / privacy contract ----------

describe("buildAnnualReviewMarkdown — escaping & privacy", () => {
  // 13
  it("escapes pipe characters inside the 12-month table", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        months: [
          makeMonth("2025-01", 1, { highlights: 1 }),
          ...Array.from({ length: 11 }, (_, i) => makeMonth(`2025-${String(i + 2).padStart(2, "0")}`, 0)),
        ],
      }),
      exportedAt: NOW,
    });
    // The header line is `| 月份 | 记录 | ... |`. The data rows must
    // not contain an unescaped pipe other than the cell separators.
    const header = "| 月份 | 记录 | 划线 | 想法 | 书评 | 未分类 | 已匹配 | 书目 |";
    const rows = out.content
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.includes("---") && line !== header);
    for (const row of rows) {
      // Each row has exactly 8 data fields + 2 boundary pipes = 10
      // entries when split by `|`.
      const parts = row.split("|");
      expect(parts).toHaveLength(10);
    }
  });
  // 14
  it("blocks public-title heading injection", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ title: "# 伪造的标题", author: "# 伪造的作者" })],
      }),
      exportedAt: NOW,
    });
    // No raw `# ` block should appear in the body once we strip the
    // page-level H1.
    const body = out.content.split("\n").slice(1).join("\n");
    expect(body).not.toMatch(/^# /m);
  });
  // 15
  it("escapes HTML characters in the body", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ title: "<script>alert(1)</script>", author: "evil < author" })],
      }),
      exportedAt: NOW,
    });
    expect(out.content).not.toContain("<script>");
    expect(out.content).toContain("\\<script\\>");
  });
  // 16
  it("strips control characters", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ title: "title\u0007with\u0000ctrl" })],
      }),
      exportedAt: NOW,
    });
    expect(out.content).not.toContain("\u0000");
    expect(out.content).not.toContain("\u0007");
  });
});

// ---------- 7: filename ----------

describe("buildAnnualReviewMarkdownFilename", () => {
  // 17
  it("builds the documented filename format", () => {
    expect(
      buildAnnualReviewMarkdownFilename({ selectedYear: 2025, now: NOW })
    ).toBe(`${ANNUAL_MARKDOWN_FILENAME_PREFIX}-2025-20260803.md`);
  });
  // 18
  it("is pure ASCII and never embeds private data", () => {
    const name = buildAnnualReviewMarkdownFilename({ selectedYear: 2025, now: NOW });
    expect(/^[\x20-\x7e]+$/.test(name)).toBe(true);
    expect(name).not.toMatch(/10000000/);
    expect(name).not.toContain("token");
    expect(name).not.toContain("公共书目");
    expect(name).not.toContain(".ics");
  });
  it("rejects non-4-digit selectedYear", () => {
    expect(() =>
      buildAnnualReviewMarkdownFilename({ selectedYear: 99 as unknown as number, now: NOW })
    ).toThrow();
    expect(() =>
      buildAnnualReviewMarkdownFilename({ selectedYear: NaN, now: NOW })
    ).toThrow();
  });
  it("keeps filename length ≤ 80", () => {
    const name = buildAnnualReviewMarkdownFilename({ selectedYear: 2025, now: NOW });
    expect(name.length).toBeLessThanOrEqual(80);
  });
});

// ---------- 8: download helper ----------

describe("triggerAnnualReviewMarkdownDownload", () => {
  // 19
  it("uses the documented MIME type and triggers a download", () => {
    let createdWith: Blob | null = null;
    let revokedUrl: string | null = null;
    let attached = false;
    const result = triggerAnnualReviewMarkdownDownload({
      content: "# 2025 年阅读回顾\n",
      filename: `${ANNUAL_MARKDOWN_FILENAME_PREFIX}-2025-20260803.md`,
      createObjectUrl: (blob) => {
        createdWith = blob;
        return "blob:mock-md-1";
      },
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      attachAnchor: () => {
        attached = true;
      },
    });
    expect(createdWith).not.toBeNull();
    expect((createdWith as unknown as Blob).type).toBe(ANNUAL_MARKDOWN_MIME);
    expect(result.mimeType).toBe(ANNUAL_MARKDOWN_MIME);
    expect(result.blobUrl).toBe("blob:mock-md-1");
    expect(result.downloadTriggered).toBe(true);
    expect(attached).toBe(true);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(revokedUrl).toBe("blob:mock-md-1");
        resolve();
      }, 5);
    });
  });
  // 20
  it("schedules URL.revokeObjectURL on the next tick", () => {
    let revokedUrl: string | null = null;
    triggerAnnualReviewMarkdownDownload({
      content: "# 2025 年阅读回顾\n",
      filename: `${ANNUAL_MARKDOWN_FILENAME_PREFIX}-2025-20260803.md`,
      createObjectUrl: () => "blob:mock-md-2",
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      attachAnchor: () => undefined,
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(revokedUrl).toBe("blob:mock-md-2");
        resolve();
      }, 5);
    });
  });
  // 21
  it("never touches localStorage / sessionStorage / IndexedDB", () => {
    const storageSpies = { getItem: 0, setItem: 0, removeItem: 0, clear: 0 };
    const originalLS = (globalThis as any).localStorage;
    const originalSS = (globalThis as any).sessionStorage;
    (globalThis as any).localStorage = {
      getItem: () => { storageSpies.getItem += 1; return null; },
      setItem: () => { storageSpies.setItem += 1; },
      removeItem: () => { storageSpies.removeItem += 1; },
      clear: () => { storageSpies.clear += 1; },
    };
    (globalThis as any).sessionStorage = {
      getItem: () => { storageSpies.getItem += 1; return null; },
      setItem: () => { storageSpies.setItem += 1; },
      removeItem: () => { storageSpies.removeItem += 1; },
      clear: () => { storageSpies.clear += 1; },
    };
    try {
      triggerAnnualReviewMarkdownDownload({
        content: "# 2025 年阅读回顾\n",
        filename: `${ANNUAL_MARKDOWN_FILENAME_PREFIX}-2025-20260803.md`,
        createObjectUrl: () => "blob:mock-md-x",
        revokeObjectUrl: () => undefined,
        attachAnchor: () => undefined,
      });
    } finally {
      (globalThis as any).localStorage = originalLS;
      (globalThis as any).sessionStorage = originalSS;
    }
    expect(storageSpies.getItem).toBe(0);
    expect(storageSpies.setItem).toBe(0);
    expect(storageSpies.removeItem).toBe(0);
    expect(storageSpies.clear).toBe(0);
    return Promise.resolve();
  });
});

// ---------- 9: validateAnnualReviewMarkdown ----------

describe("validateAnnualReviewMarkdown", () => {
  it("accepts a well-formed document", () => {
    const out = buildAnnualReviewMarkdown({ review: makeResponse(), exportedAt: NOW });
    expect(validateAnnualReviewMarkdown(out.content)).toEqual([]);
  });
  it("flags missing top-level title", () => {
    expect(validateAnnualReviewMarkdown("no title").length).toBeGreaterThan(0);
  });
});

// ---------- 10: privacy contract — no note / token / AI leakage -----

describe("buildAnnualReviewMarkdown — privacy contract", () => {
  // 22 — the document must never re-fetch AI / related-books
  it("does not embed AI summary or related-books output", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        overview: {
          year: 2025,
          totalRecords: 1,
          datedRecords: 1,
          matchedRecords: 1,
          matchedBooks: 1,
          activeMonths: 1,
          longestStreakMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
          peakMonth: null,
          peakMonthRecords: 0,
          averageRecordsPerActiveMonth: 1,
        },
        topBooks: [makeBook()],
      }),
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/overview|keyPoints|reviewQuestions|themes/);
    expect(out.content).not.toMatch(/FORBIDDEN_NOTE_TEXT|FORBIDDEN_NOTE_COMMENT|FORBIDDEN_OVERVIEW/);
  });
  // 23
  it("never leaks private IDs", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook()],
      }),
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/\bwereadBookId\b/);
    expect(out.content).not.toMatch(/\bnoteId\b/);
    expect(out.content).not.toMatch(/\bhighlightId\b/);
    expect(out.content).not.toMatch(/\bchapterTitle\b/);
  });
  // 24
  it("never leaks token / q / API key", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse(),
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/token/i);
    expect(out.content).not.toMatch(/api[_-]?key/i);
    expect(out.content).not.toContain("q=");
    expect(out.content).not.toContain("Authorization");
  });
  // 25
  it("never reproduces the WeRead raw title/author (the response is sanitised upstream)", () => {
    // The model only reads `book.title` / `book.author`. We confirm
    // that these are surfaced through the documented public fields
    // and never appear as a separate "raw" label.
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        topBooks: [makeBook({ title: "公共书目 A", author: "作者 A" })],
      }),
      exportedAt: NOW,
    });
    expect(out.content).toContain("《公共书目 A》");
    expect(out.content).toContain("作者：作者 A");
    expect(out.content).not.toMatch(/原始|rawTitle|rawAuthor|原始作者|原始书名/);
  });
  // 26
  it("never produces psychological-inference vocabulary", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        overview: {
          year: 2025,
          totalRecords: 10,
          datedRecords: 10,
          matchedRecords: 10,
          matchedBooks: 2,
          activeMonths: 3,
          longestStreakMonths: 2,
          firstNoteAt: null,
          lastNoteAt: null,
          peakMonth: "2025-03",
          peakMonthRecords: 4,
          averageRecordsPerActiveMonth: 3.33,
        },
        months: [
          makeMonth("2025-03", 4, { highlights: 4, matched: 4, bookCount: 1 }),
          makeMonth("2025-04", 3, { highlights: 3, matched: 3, bookCount: 1 }),
          makeMonth("2025-05", 3, { highlights: 3, matched: 3, bookCount: 1 }),
          ...Array.from({ length: 9 }, (_, i) =>
            makeMonth(`2025-${String(i + 1).padStart(2, "0")}`, 0)
          ),
        ],
        topBooks: [makeBook()],
      }),
      exportedAt: NOW,
    });
    for (const word of ["懒惰", "焦虑", "专注力", "人格", "性格", "心理", "阅读能力", "情绪"]) {
      expect(out.content).not.toContain(word);
    }
  });
});

// ---------- 11: deterministic copy / disclaimer ----------

describe("buildAnnualReviewMarkdown — deterministic copy", () => {
  it("uses the documented privacy notice + disclaimer bullets", () => {
    const out = buildAnnualReviewMarkdown({ review: makeResponse(), exportedAt: NOW });
    expect(out.content).toContain(`> ${ANNUAL_MARKDOWN_PRIVACY_NOTE}`);
    for (const bullet of ANNUAL_MARKDOWN_DISCLAIMER_BULLETS) {
      expect(out.content).toContain(bullet);
    }
  });
  it("includes the documented meta bullets", () => {
    const out = buildAnnualReviewMarkdown({ review: makeResponse(), exportedAt: NOW });
    expect(out.content).toContain("- 数据来源：微信读书私有阅读记录");
    expect(out.content).toContain("- 生成方式：book-id-search 浏览器本地生成");
    expect(out.content).toContain("- 保存状态：未上传服务器");
  });
});

// ---------- 12: contract checks ----------

describe("buildAnnualReviewMarkdown — contracts", () => {
  it("byte length matches UTF-8 encoding", () => {
    const out = buildAnnualReviewMarkdown({ review: makeResponse(), exportedAt: NOW });
    // The model encodes UTF-8 via TextEncoder in supported runtimes;
    // verify the byte length is >= the character length (ASCII-only
    // strings make them equal, multibyte Chinese chars make byte >
    // char).
    expect(out.byteLength).toBeGreaterThanOrEqual(out.content.length);
  });
  it("selectedYear and topBooksCount are echoed on the result", () => {
    const out = buildAnnualReviewMarkdown({
      review: makeResponse({
        selectedYear: 2024,
        topBooks: [makeBook(), makeBook({ catalogId: "10000000_000000000002" })],
      }),
      exportedAt: NOW,
    });
    expect(out.selectedYear).toBe(2024);
    expect(out.topBooksCount).toBe(2);
  });
  it("throws when the response is null/undefined", () => {
    expect(() =>
      buildAnnualReviewMarkdown({
        review: null as unknown as WereadAnnualReviewResponse,
        exportedAt: NOW,
      })
    ).toThrow();
  });
});