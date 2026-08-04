/**
 * S27L-2 — Unit tests for the browser-local Markdown export of the
 * long-term WeRead reading archive workspace.
 *
 * Pure-function coverage. The browser download helper is exercised
 * through dependency injection so jsdom is not required.
 *
 * ≥35 model assertions per the S27L-2 spec.
 */

import { describe, expect, it } from "vitest";
import type { DocumentLike } from "./wereadReadingArchiveMarkdown";
import {
  READING_ARCHIVE_MARKDOWN_DATA_INTEGRITY_NOTE,
  READING_ARCHIVE_MARKDOWN_FILENAME_MAX_LENGTH,
  READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX,
  READING_ARCHIVE_MARKDOWN_INTERPRETATION_NOTE,
  READING_ARCHIVE_MARKDOWN_MIME,
  READING_ARCHIVE_MARKDOWN_PRIVACY_NOTE,
  READING_ARCHIVE_MARKDOWN_SITE_BASE_URL,
  buildReadingArchiveMarkdown,
  buildReadingArchiveMarkdownFilename,
  escapeArchiveMarkdownInline,
  escapeArchiveMarkdownTableCell,
  formatArchiveAverage,
  formatArchiveMarkdownDate,
  formatArchiveOverlapPercent,
  formatArchiveYearRange,
  sanitizeArchiveMarkdownText,
  triggerReadingArchiveMarkdownDownload,
  validateReadingArchiveMarkdown,
} from "./wereadReadingArchiveMarkdown";
import { buildWereadReadingArchive } from "./wereadReadingArchiveModel";
import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewResponse,
} from "../wereadPrivate";

// ---------- fixtures ----------

const NOW = new Date("2026-08-04T10:32:00.000Z"); // Asia/Shanghai => 2026-08-04 18:32 local

function makeBook(over: Partial<WereadAnnualReviewBook> = {}): WereadAnnualReviewBook {
  return {
    catalogId: "10000000_000000000001",
    title: "公共书目 A",
    author: "作者 A",
    publisher: "出版社 X",
    publishYear: 2020,
    noteCount: 12,
    highlights: 8,
    thoughts: 3,
    reviews: 1,
    unknown: 0,
    activeMonths: 4,
    firstNoteAt: "2025-01-05T00:00:00.000Z",
    lastNoteAt: "2025-09-30T00:00:00.000Z",
    ...over,
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const year = overrides.selectedYear ?? 2025;
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    total: 0,
    highlights: 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: 0,
    bookCount: 0,
  }));
  return {
    ok: true,
    selectedYear: year,
    availableYears: [year, year - 1, year - 2, year - 3, year - 4],
    overview: {
      year,
      totalRecords: 100,
      datedRecords: 90,
      matchedRecords: 80,
      matchedBooks: 12,
      activeMonths: 12,
      longestStreakMonths: 6,
      firstNoteAt: `${year}-01-05T00:00:00.000Z`,
      lastNoteAt: `${year}-09-30T00:00:00.000Z`,
      peakMonth: `${year}-06`,
      peakMonthRecords: 25,
      averageRecordsPerActiveMonth: 8.3,
    },
    months,
    quarters: [
      { quarter: "Q1", total: 25, activeMonths: 3, matchedRecords: 22, bookCount: 5 },
      { quarter: "Q2", total: 30, activeMonths: 3, matchedRecords: 28, bookCount: 6 },
      { quarter: "Q3", total: 30, activeMonths: 3, matchedRecords: 27, bookCount: 6 },
      { quarter: "Q4", total: 15, activeMonths: 3, matchedRecords: 13, bookCount: 4 },
    ],
    topBooks: [makeBook()],
    meta: {
      topBooksRequested: 12,
      topBooksReturned: 1,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
    ...overrides,
  };
}

function buildArchiveFixture(): {
  responses: WereadAnnualReviewResponse[];
} {
  const years = [2025, 2024, 2023, 2022, 2021];
  const responses: WereadAnnualReviewResponse[] = years.map((y) =>
    makeResponse({
      selectedYear: y,
      availableYears: [2025, 2024, 2023, 2022, 2021],
      overview: {
        year: y,
        totalRecords: 100 - (2025 - y) * 5,
        datedRecords: 90 - (2025 - y) * 5,
        matchedRecords: 80 - (2025 - y) * 5,
        matchedBooks: 8,
        activeMonths: 12,
        longestStreakMonths: 4,
        firstNoteAt: `${y}-01-05T00:00:00.000Z`,
        lastNoteAt: `${y}-09-30T00:00:00.000Z`,
        peakMonth: `${y}-06`,
        peakMonthRecords: 25,
        averageRecordsPerActiveMonth: 8,
      },
    }),
  );
  return { responses };
}

const FULL_INPUT = (() => {
  const { responses } = buildArchiveFixture();
  const archive = buildWereadReadingArchive({
    responses,
    requestedYears: 5,
    topBooksLimit: 12,
    recurringLimit: 10,
  });
  return {
    archive,
    rangeLabel: "最近5年" as const,
    topBooksLimit: 12 as const,
    failedYears: [] as number[],
    exportedAt: NOW,
  };
})();

const PARTIAL_INPUT = (() => {
  const { responses } = buildArchiveFixture();
  // simulate 2023 and 2022 failed
  const archive = buildWereadReadingArchive({
    responses: responses.filter((r) => r.selectedYear !== 2023 && r.selectedYear !== 2022),
    requestedYears: 5,
    topBooksLimit: 12,
    recurringLimit: 10,
  });
  return {
    archive,
    rangeLabel: "最近5年" as const,
    topBooksLimit: 12 as const,
    failedYears: [2023, 2022] as number[],
    exportedAt: NOW,
  };
})();

const EMPTY_INPUT = (() => {
  const archive = buildWereadReadingArchive({
    responses: [],
    requestedYears: 0,
    topBooksLimit: 12,
    recurringLimit: 10,
  });
  return {
    archive,
    rangeLabel: "全部" as const,
    topBooksLimit: 12 as const,
    failedYears: [] as number[],
    exportedAt: NOW,
  };
})();

// ---------- escaping helpers ----------

describe("escapeArchiveMarkdownInline", () => {
  it("1. escapes inline Markdown meta characters", () => {
    expect(escapeArchiveMarkdownInline("a*b_c[d]e<f>g#h`i~j")).toBe(
      "a\\*b\\_c\\[d\\]e\\<f\\>g\\#h\\`i\\~j",
    );
  });
  it("2. strips newlines, tabs, carriage returns, and NUL", () => {
    expect(escapeArchiveMarkdownInline("a\nb\tc\rd\u0000e")).toBe("a b c d e");
  });
  it("3. collapses repeated whitespace to single space", () => {
    expect(escapeArchiveMarkdownInline("a     b\n\n\t  c")).toBe("a b c");
  });
  it("4. neutralises heading injection in inline text", () => {
    const hostile = "# injected heading";
    expect(escapeArchiveMarkdownInline(hostile)).toBe("\\# injected heading");
  });
  it("5. handles null and undefined as empty string", () => {
    expect(escapeArchiveMarkdownInline(null)).toBe("");
    expect(escapeArchiveMarkdownInline(undefined)).toBe("");
  });
});

describe("escapeArchiveMarkdownTableCell", () => {
  it("6. replaces empty / nullish cells with em-dash placeholder", () => {
    expect(escapeArchiveMarkdownTableCell(null)).toBe("—");
    expect(escapeArchiveMarkdownTableCell("")).toBe("—");
    expect(escapeArchiveMarkdownTableCell(undefined)).toBe("—");
  });
  it("7. escapes pipe characters that would break tables", () => {
    expect(escapeArchiveMarkdownTableCell("a|b")).toBe("a\\|b");
  });
  it("8. strips newlines so cells stay single-line", () => {
    expect(escapeArchiveMarkdownTableCell("a\nb")).toBe("a b");
  });
});

describe("formatArchiveYearRange", () => {
  it("9. returns em-dash style when both ends are null", () => {
    expect(formatArchiveYearRange({ firstYear: null, latestYear: null })).toBe(
      "暂无年份",
    );
  });
  it("10. collapses same year to single label", () => {
    expect(formatArchiveYearRange({ firstYear: 2025, latestYear: 2025 })).toBe(
      "2025 年",
    );
  });
  it("11. produces span when both ends differ", () => {
    expect(formatArchiveYearRange({ firstYear: 2021, latestYear: 2025 })).toBe(
      "2021—2025 年",
    );
  });
});

describe("formatArchiveOverlapPercent", () => {
  it("12. returns integer percent when whole", () => {
    expect(formatArchiveOverlapPercent(0.5)).toBe("50%");
  });
  it("13. clamps and rounds to 1 decimal place", () => {
    expect(formatArchiveOverlapPercent(0.123)).toBe("12.3%");
  });
  it("14. clamps out-of-range ratios and reports 0% on NaN", () => {
    expect(formatArchiveOverlapPercent(1.5)).toBe("100%");
    expect(formatArchiveOverlapPercent(-0.3)).toBe("0%");
    expect(formatArchiveOverlapPercent(NaN)).toBe("0%");
  });
});

describe("formatArchiveAverage", () => {
  it("15. keeps integers whole", () => {
    expect(formatArchiveAverage(8)).toBe("8");
  });
  it("16. rounds to 1 decimal place when fractional", () => {
    expect(formatArchiveAverage(8.34)).toBe("8.3");
  });
  it("17. handles NaN as em-dash", () => {
    expect(formatArchiveAverage(NaN)).toBe("—");
  });
});

describe("formatArchiveMarkdownDate / sanitizeArchiveMarkdownText", () => {
  it("18. formats valid date with leading zeros", () => {
    expect(formatArchiveMarkdownDate(new Date("2026-01-02T03:04:00"))).toBe(
      "2026-01-02 03:04",
    );
  });
  it("19. returns em-dash for invalid dates", () => {
    expect(formatArchiveMarkdownDate(new Date("invalid"))).toBe("—");
  });
  it("20. sanitizeArchiveMarkdownText delegates to inline escape", () => {
    expect(sanitizeArchiveMarkdownText("a#b")).toBe("a\\#b");
  });
});

// ---------- filename ----------

describe("buildReadingArchiveMarkdownFilename", () => {
  it("21. produces ASCII span filename for normal range", () => {
    const name = buildReadingArchiveMarkdownFilename({
      firstYear: 2021,
      latestYear: 2025,
      now: NOW,
    });
    expect(name).toBe(`${READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX}-2021-to-2025-20260804.md`);
    expect(name.length).toBeLessThanOrEqual(READING_ARCHIVE_MARKDOWN_FILENAME_MAX_LENGTH);
  });
  it("22. produces empty-archive fallback when both years are null", () => {
    const name = buildReadingArchiveMarkdownFilename({
      firstYear: null,
      latestYear: null,
      now: NOW,
    });
    expect(name).toBe(`${READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX}-empty-20260804.md`);
  });
  it("23. swaps years if first > latest (descending input)", () => {
    const name = buildReadingArchiveMarkdownFilename({
      firstYear: 2025,
      latestYear: 2021,
      now: NOW,
    });
    expect(name).toBe(`${READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX}-2021-to-2025-20260804.md`);
  });
  it("24. rejects invalid years and uses empty fallback", () => {
    const name = buildReadingArchiveMarkdownFilename({
      firstYear: 18,
      latestYear: null,
      now: NOW,
    });
    expect(name).toBe(`${READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX}-empty-20260804.md`);
  });
  it("25. keeps filename as pure ASCII (no non-ASCII bytes)", () => {
    const name = buildReadingArchiveMarkdownFilename({
      firstYear: 2021,
      latestYear: 2025,
      now: NOW,
    });
    expect(/^[\x20-\x7e]+$/.test(name)).toBe(true);
  });
});

// ---------- build markdown ----------

describe("buildReadingArchiveMarkdown", () => {
  it("26. emits title and meta block", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(result.content).toContain("# 长期阅读档案");
    expect(result.content).toContain("- 当前范围：最近5年");
    expect(result.content).toContain("- 高互动书目口径：各年度 Top 12");
    expect(result.content).toContain(`- 成功加载年份：5 个`);
    expect(result.content).toContain(`- 暂时失败年份：0 个`);
    expect(result.content).toContain("- 导出时间：2026-08-04 18:32");
  });

  it("27. emits privacy and interpretation notices", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(result.content).toContain(READING_ARCHIVE_MARKDOWN_PRIVACY_NOTE);
    expect(result.content).toContain(READING_ARCHIVE_MARKDOWN_INTERPRETATION_NOTE);
  });

  it("28. emits data-integrity note when no failures", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(result.content).toContain(READING_ARCHIVE_MARKDOWN_DATA_INTEGRITY_NOTE);
    expect(result.content).not.toContain("完整性提示：");
  });

  it("29. emits completeness prompt when failedYears > 0", () => {
    const result = buildReadingArchiveMarkdown(PARTIAL_INPUT);
    expect(result.content).toContain("完整性提示：本次有 2 个年份暂时加载失败");
    expect(result.content).toContain("- 暂时失败年份：2022、2023");
  });

  it("30. year trend table is sorted oldest → newest", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    const trendIdx = result.content.indexOf("## 跨年度趋势");
    const slice = result.content.slice(trendIdx, trendIdx + 800);
    const yearNumbers = [...slice.matchAll(/\|\s*(\d{4})\s*\|/g)].map((m) =>
      Number(m[1]),
    );
    expect(yearNumbers).toEqual([2021, 2022, 2023, 2024, 2025]);
  });

  it("31. year directory is sorted newest → oldest", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    const dirIdx = result.content.indexOf("## 年度档案目录");
    const slice = result.content.slice(dirIdx, dirIdx + 1200);
    const headings = [...slice.matchAll(/### (\d{4}) 年/g)].map((m) =>
      Number(m[1]),
    );
    expect(headings).toEqual([2025, 2024, 2023, 2022, 2021]);
  });

  it("32. includes overview, recurring books, and overlap sections", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(result.content).toContain("## 档案总览");
    expect(result.content).toContain("## 跨年度趋势");
    expect(result.content).toContain("## 年度档案目录");
    expect(result.content).toContain("## 多年进入 Top 12 高互动榜的书目");
    expect(result.content).toContain("## 相邻年度榜单重合");
    expect(result.content).toContain("## 数据完整性");
    expect(result.content).toContain("## 说明");
  });

  it("33. omits fake 'unique cross-year book count' statistic", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(result.content).not.toContain("跨年唯一书目数");
    expect(result.content).not.toMatch(/\u552f\u4e00\u4e66\u76ee\u6570/);
  });

  it("34. neighbouring-year overlap table uses deterministic percent", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(result.content).toContain("| 2024 → 2025 |");
    expect(result.content).toMatch(/\| 2024 → 2025 \| \d+ \| \d+(?:\.\d)?% \|/);
  });

  it("35. empty archive still emits meta, integrity, and explanations", () => {
    const result = buildReadingArchiveMarkdown(EMPTY_INPUT);
    expect(result.content).toContain("# 长期阅读档案");
    expect(result.content).toContain("当前暂无成功加载的年度阅读档案");
    expect(result.content).toContain("当前暂无跨年度趋势数据");
    expect(result.content).toContain("当前成功加载的年度不足以生成相邻年份榜单重合");
    expect(result.content).toContain("- 所有目标年份均已成功加载");
  });

  it("36. partial archive renders integrity note and lists failed years", () => {
    const result = buildReadingArchiveMarkdown(PARTIAL_INPUT);
    expect(result.content).toContain("- 暂时失败年份数量：2");
    expect(result.content).toContain("- 暂时失败年份：2022、2023");
    expect(result.content).not.toContain("所有目标年份均已成功加载");
  });

  it("37. invalid topBooksLimit rejected", () => {
    expect(() =>
      buildReadingArchiveMarkdown({ ...FULL_INPUT, topBooksLimit: 7 as unknown as 12 }),
    ).toThrow(/topBooksLimit/);
  });

  it("38. invalid failedYears rejected (non-integer)", () => {
    expect(() =>
      buildReadingArchiveMarkdown({ ...FULL_INPUT, failedYears: [2024.5] }),
    ).toThrow(/failedYears/);
  });

  it("39. invalid failedYears rejected (out of range)", () => {
    expect(() =>
      buildReadingArchiveMarkdown({ ...FULL_INPUT, failedYears: [18] }),
    ).toThrow(/failedYears/);
  });

  it("40. returned filename, mime, and byteLength are populated", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(result.mimeType).toBe(READING_ARCHIVE_MARKDOWN_MIME);
    expect(result.mimeType).toBe("text/markdown;charset=utf-8");
    expect(result.filename).toMatch(
      new RegExp(`^${READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX}-\\d{4}-to-\\d{4}-\\d{8}\\.md$`),
    );
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.yearCount).toBe(5);
    expect(result.failedYearCount).toBe(0);
    expect(result.topBooksLimit).toBe(12);
    expect(result.rangeLabel).toBe("最近5年");
  });
});

// ---------- validation / safety ----------

describe("validateReadingArchiveMarkdown", () => {
  it("41. flags note.text presence", () => {
    const out = validateReadingArchiveMarkdown(
      "blah note.text in body blah",
    );
    expect(out).toContain("note.text");
  });

  it("42. flags q= search term", () => {
    const out = validateReadingArchiveMarkdown("q=hello&year=2024");
    expect(out).toContain("q-search");
  });

  it("43. flags Bearer token leak", () => {
    const out = validateReadingArchiveMarkdown(
      "Authorization: Bearer abcdefghijklmnop",
    );
    expect(out).toContain("token");
    expect(out).toContain("Authorization header");
  });

  it("44. flags private API URLs", () => {
    const out = validateReadingArchiveMarkdown(
      "fetched from /api/private/weread/ai-summary?year=2024",
    );
    expect(out).toContain("private API URL");
  });

  it("45. flags AI summary body", () => {
    const out = validateReadingArchiveMarkdown("summary.body and summary.keyPoints leak");
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((label) => label.toLowerCase().includes("ai summary"))).toBe(true);
  });

  it("46. flags session themes", () => {
    const out = validateReadingArchiveMarkdown("session_theme and themes.appended");
    expect(out.some((label) => label.includes("session themes"))).toBe(true);
  });

  it("47. flags wereadBookId / noteId / highlightId", () => {
    const out = validateReadingArchiveMarkdown("wereadBookId noteId highlightId leak");
    expect(out).toContain("wereadBookId");
    expect(out).toContain("noteId");
    expect(out).toContain("highlightId");
  });

  it("48. flags chapterTitle / markedText", () => {
    const out = validateReadingArchiveMarkdown("chapterTitle and markedText visible");
    expect(out).toContain("chapterTitle");
    expect(out).toContain("markedText");
  });

  it("49. flags note.comment", () => {
    const out = validateReadingArchiveMarkdown("note.comment present");
    expect(out).toContain("note.comment");
  });

  it("50. accepts safe Markdown with no violations", () => {
    const result = buildReadingArchiveMarkdown(FULL_INPUT);
    expect(validateReadingArchiveMarkdown(result.content)).toEqual([]);
  });

  it("51. constant for site base URL is stable", () => {
    expect(READING_ARCHIVE_MARKDOWN_SITE_BASE_URL).toBe(
      "https://books.conanxin.com",
    );
  });
});

// ---------- download trigger ----------

describe("triggerReadingArchiveMarkdownDownload", () => {
  it("52. creates Blob with text/markdown;charset=utf-8 MIME", () => {
    const captured: Array<{ size: number; type: string }> = [];
    const result = triggerReadingArchiveMarkdownDownload({
      content: "# long term archive\n",
      filename: "test.md",
      createObjectUrl: (b) => {
        captured.push({ size: b.size, type: b.type });
        return "blob:test://url";
      },
      revokeObjectUrl: () => {},
      resolveDocument: () => null,
    });
    expect(captured[0].type).toBe("text/markdown;charset=utf-8");
    expect(captured[0].size).toBeGreaterThan(0);
    expect(result.mimeType).toBe("text/markdown;charset=utf-8");
    expect(result.blobUrl).toBe("blob:test://url");
    expect(result.downloadTriggered).toBe(true);
  });

  it("53. calls revokeObjectURL on next tick", async () => {
    let revoked: string | null = null;
    const captured: { value: ReadingArchiveAnchorCapture | null } = { value: null };
    const result = triggerReadingArchiveMarkdownDownload({
      content: "x",
      filename: "x.md",
      createObjectUrl: () => "blob:test://url-2",
      revokeObjectUrl: (url) => {
        revoked = url;
      },
      attachAnchor: (descriptor) => {
        captured.value = { ...(descriptor as ReadingArchiveAnchorCapture) };
      },
    });
    const attached = captured.value;
    expect(attached).not.toBeNull();
    expect(attached!.href).toBe("blob:test://url-2");
    expect(attached!.download).toBe("x.md");
    expect(attached!.testId).toBe("weread-reading-archive-markdown-anchor");
    expect(attached!.rel).toBe("noopener");
    await new Promise((r) => setTimeout(r, 5));
    expect(revoked).toBe("blob:test://url-2");
    expect(result.blobUrl).toBe("blob:test://url-2");
  });

  it("54. default attach path with jsdom-like doc triggers anchor click + remove", () => {
    let clicked = false;
    let removed = false;
    let appended = false;
    let hrefSet = "";
    let downloadSet = "";
    let testIdSet = "";
    const fakeDoc: DocumentLike = {
      createElement: () => {
        return {
          setAttribute(name: string, value: string) {
            if (name === "href") hrefSet = value;
            if (name === "download") downloadSet = value;
            if (name === "data-testid") testIdSet = value;
          },
          click() {
            clicked = true;
          },
        };
      },
      body: {
        appendChild() {
          appended = true;
        },
        removeChild() {
          removed = true;
        },
      },
    };
    triggerReadingArchiveMarkdownDownload({
      content: "y",
      filename: "y.md",
      createObjectUrl: () => "blob:test://url-3",
      revokeObjectUrl: () => {},
      resolveDocument: () => fakeDoc,
    });
    expect(clicked).toBe(true);
    expect(appended).toBe(true);
    expect(removed).toBe(true);
    expect(hrefSet).toBe("blob:test://url-3");
    expect(downloadSet).toBe("y.md");
    expect(testIdSet).toBe("weread-reading-archive-markdown-anchor");
  });

  it("55. throws when content or filename is empty", () => {
    expect(() =>
      triggerReadingArchiveMarkdownDownload({
        content: "",
        filename: "x.md",
        createObjectUrl: () => "blob:test://x",
        revokeObjectUrl: () => {},
      }),
    ).toThrow(/content is empty/);
    expect(() =>
      triggerReadingArchiveMarkdownDownload({
        content: "x",
        filename: "",
        createObjectUrl: () => "blob:test://x",
        revokeObjectUrl: () => {},
      }),
    ).toThrow(/filename is empty/);
  });
});

// helper for descriptor capture in download test
type ReadingArchiveAnchorCapture = {
  href: string;
  download: string;
  rel: string;
  testId: string;
};
