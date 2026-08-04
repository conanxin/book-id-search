/**
 * S27O-3 — Unit tests for the dual-period Markdown export model.
 *
 * All tests use synthetic `DualPeriodComparisonResult` objects; no
 * network calls, no real user data, no browser download side-effects.
 */

import { describe, it, expect } from "vitest";
import type {
  DualPeriodComparisonResult,
  ReadingPeriod,
} from "./wereadDualPeriodComparison";
import {
  escapeDualMarkdownInline,
  escapeDualMarkdownTableCell,
  sanitizeDualMarkdownText,
  formatDualMarkdownDate,
  formatDualPeriodRange,
  formatDualDirection,
  formatDualInteger,
  formatDualAverage,
  formatDualAbsoluteDelta,
  formatDualAverageDelta,
  formatDualPercentage,
  formatDualRank,
  formatDualPercent,
  buildDualPeriodMarkdown,
  buildDualPeriodMarkdownFilename,
  validateDualPeriodMarkdown,
  triggerDualPeriodMarkdownDownload,
  DUAL_PERIOD_MARKDOWN_MIME,
  DUAL_PERIOD_MARKDOWN_FILENAME_PREFIX,
  DUAL_PERIOD_MARKDOWN_FILENAME_MAX_LENGTH,
  DUAL_PERIOD_MARKDOWN_EMPTY_NOTE,
  DUAL_PERIOD_MARKDOWN_SINGLE_YEAR_NOTE,
  DUAL_PERIOD_MARKDOWN_NO_RECURRING_NOTE,
  DUAL_PERIOD_MARKDOWN_NO_OVERLAP_NOTE,
  DUAL_PERIOD_MARKDOWN_METHOD_NOTES,
  type DualPeriodRangeLabel,
} from "./wereadDualPeriodMarkdown";

// ---------- fixtures ----------

function makePeriod(
  startYear: number,
  endYear: number,
): ReadingPeriod {
  return { startYear, endYear };
}

function makeRecurring(
  catalogId: string,
  title: string,
  overrides: Partial<{
    author: string | null;
    publisher: string | null;
    publishYear: string | number | null;
    yearsOnList: number;
    years: number[];
    totalNoteCountWithinLists: number;
    bestRank: number;
    latestYear: number;
    latestRank: number;
  }> = {},
): import("./wereadReadingArchiveModel").ReadingArchiveRecurringBook {
  return {
    catalogId,
    title,
    author: overrides.author === undefined ? "公共作者" : overrides.author,
    publisher: overrides.publisher === undefined ? "公共出版社" : overrides.publisher,
    publishYear: overrides.publishYear === undefined ? 2020 : overrides.publishYear,
    yearsOnList: overrides.yearsOnList ?? 2,
    years: overrides.years ?? [2021, 2022],
    totalNoteCountWithinLists: overrides.totalNoteCountWithinLists ?? 0,
    bestRank: overrides.bestRank ?? 1,
    latestYear: overrides.latestYear ?? 2022,
    latestRank: overrides.latestRank ?? 1,
  };
}

function makeResult(
  overrides: Partial<{
    periodA: { startYear: number; endYear: number; metrics: DualPeriodComparisonResult["periodA"]["metrics"] };
    periodB: { startYear: number; endYear: number; metrics: DualPeriodComparisonResult["periodB"]["metrics"] };
    delta: DualPeriodComparisonResult["delta"];
    recurring: DualPeriodComparisonResult["recurringBooks"];
    overlap: DualPeriodComparisonResult["overlap"];
  }> = {},
): DualPeriodComparisonResult {
  const periodAMetrics = overrides.periodA?.metrics ?? {
    years: [2020, 2021],
    totalRecords: 300,
    totalActiveMonths: 12,
    matchedRecords: 200,
    matchedBooks: 6,
    averageRecordsPerYear: 150,
    averageRecordsPerActiveMonth: 25,
    longestActiveStreak: 2,
    peakYear: 2021,
    peakYearRecords: 200,
  };
  const periodBMetrics = overrides.periodB?.metrics ?? {
    years: [2023, 2024],
    totalRecords: 500,
    totalActiveMonths: 18,
    matchedRecords: 350,
    matchedBooks: 9,
    averageRecordsPerYear: 250,
    averageRecordsPerActiveMonth: 27.8,
    longestActiveStreak: 2,
    peakYear: 2024,
    peakYearRecords: 300,
  };
  return {
    periodA: {
      range: overrides.periodA
        ? makePeriod(overrides.periodA.startYear, overrides.periodA.endYear)
        : makePeriod(2020, 2021),
      metrics: periodAMetrics,
    },
    periodB: {
      range: overrides.periodB
        ? makePeriod(overrides.periodB.startYear, overrides.periodB.endYear)
        : makePeriod(2023, 2024),
      metrics: periodBMetrics,
    },
    delta:
      overrides.delta ?? {
        totalRecords: {
          absolute: 200,
          percentage: 66.7,
          direction: "increase",
        },
        activeMonths: {
          absolute: 6,
          percentage: 50,
          direction: "increase",
        },
        matchedRecords: {
          absolute: 150,
          percentage: 75,
          direction: "increase",
        },
        matchedBooks: {
          absolute: 3,
          percentage: 50,
          direction: "increase",
        },
        averageRecords: {
          absolute: 100,
          percentage: 66.7,
          direction: "increase",
        },
      },
    recurringBooks:
      overrides.recurring ?? {
        continued: [makeRecurring("c-1", "公共书目 一")],
        entered: [makeRecurring("c-2", "公共书目 二")],
        left: [makeRecurring("c-3", "公共书目 三")],
      },
    overlap:
      overrides.overlap ?? {
        average: 0.4,
        comparablePairs: 2,
      },
    meta: {
      source: "current_loaded_archive",
      persisted: false,
    },
  };
}

// ---------- escaping ----------

describe("escapeDualMarkdownInline", () => {
  it("escapes Markdown meta characters", () => {
    const out = escapeDualMarkdownInline("# heading | *bold*");
    expect(out).toBe("\\# heading \\| \\*bold\\*");
  });
  it("strips control characters", () => {
    const out = escapeDualMarkdownInline("a\x00b\x01c");
    expect(out).toBe("a b c");
  });
  it("collapses whitespace", () => {
    const out = escapeDualMarkdownInline("a    \n\n  b");
    expect(out).toBe("a b");
  });
  it("returns empty for null/undefined", () => {
    expect(escapeDualMarkdownInline(null)).toBe("");
    expect(escapeDualMarkdownInline(undefined)).toBe("");
  });
});

describe("escapeDualMarkdownTableCell", () => {
  it("escapes pipe characters in cells", () => {
    expect(escapeDualMarkdownTableCell("a|b")).toBe("a\\|b");
  });
  it("escapes pipes alongside other meta chars", () => {
    expect(escapeDualMarkdownTableCell("#a|b")).toBe("\\#a\\|b");
  });
});

describe("sanitizeDualMarkdownText", () => {
  it("collapses whitespace and strips control", () => {
    const out = sanitizeDualMarkdownText("  a\nb\x00c  ");
    expect(out).toBe("a b c");
  });
  it("returns empty for non-strings", () => {
    expect(sanitizeDualMarkdownText(42)).toBe("");
    expect(sanitizeDualMarkdownText({})).toBe("");
  });
});

// ---------- formatters ----------

describe("formatters", () => {
  it("formatDualMarkdownDate renders YYYY-MM-DD HH:mm", () => {
    expect(formatDualMarkdownDate(new Date(2025, 0, 5, 13, 7))).toBe(
      "2025-01-05 13:07",
    );
  });
  it("formatDualPeriodRange renders single-year and range", () => {
    expect(formatDualPeriodRange(makePeriod(2020, 2020))).toBe("2020 年");
    expect(formatDualPeriodRange(makePeriod(2020, 2025))).toBe("2020–2025 年");
  });
  it("formatDualDirection uses allow-listed labels", () => {
    expect(formatDualDirection("increase")).toBe("增加");
    expect(formatDualDirection("decrease")).toBe("减少");
    expect(formatDualDirection("same")).toBe("持平");
    expect(formatDualDirection("from_zero")).toBe("由零起");
    expect(formatDualDirection("to_zero")).toBe("归零");
  });
  it("formatDualInteger handles finite / NaN / Infinity", () => {
    expect(formatDualInteger(1234)).toBe("1,234");
    expect(formatDualInteger(0)).toBe("0");
    expect(formatDualInteger(NaN)).toBe("—");
    expect(formatDualInteger(Infinity)).toBe("—");
  });
  it("formatDualAverage rounds to 1 decimal", () => {
    expect(formatDualAverage(10)).toBe("10");
    expect(formatDualAverage(10.45)).toBe("10.5");
    expect(formatDualAverage(NaN)).toBe("—");
  });
  it("formatDualAbsoluteDelta uses + / - / 0", () => {
    expect(
      formatDualAbsoluteDelta({ absolute: 120, percentage: 50, direction: "increase" }),
    ).toBe("+120");
    expect(
      formatDualAbsoluteDelta({ absolute: -50, percentage: -25, direction: "decrease" }),
    ).toBe("-50");
    expect(
      formatDualAbsoluteDelta({ absolute: 0, percentage: 0, direction: "same" }),
    ).toBe("0");
  });
  it("formatDualAverageDelta preserves 1 decimal", () => {
    expect(
      formatDualAverageDelta({ absolute: 0.4, percentage: 0.4, direction: "increase" }),
    ).toBe("+0.4");
  });
  it("formatDualPercentage labels from_zero / to_zero / same", () => {
    expect(
      formatDualPercentage({ absolute: 5, percentage: null, direction: "from_zero" }),
    ).toBe("由 0 起");
    expect(
      formatDualPercentage({ absolute: -5, percentage: -100, direction: "to_zero" }),
    ).toBe("降至 0");
    expect(
      formatDualPercentage({ absolute: 0, percentage: 0, direction: "same" }),
    ).toBe("0%");
  });
  it("formatDualRank formats positive integers only", () => {
    expect(formatDualRank(1)).toBe("第 1 名");
    expect(formatDualRank(0)).toBe("—");
    expect(formatDualRank(NaN)).toBe("—");
  });
  it("formatDualPercent clamps 0..1 and rounds to 1 decimal", () => {
    expect(formatDualPercent(0.456)).toBe("45.6%");
    expect(formatDualPercent(-0.1)).toBe("0%");
    expect(formatDualPercent(1.5)).toBe("100%");
    expect(formatDualPercent(NaN)).toBe("0%");
  });
});

// ---------- markdown structure ----------

describe("buildDualPeriodMarkdown", () => {
  it("includes the fixed title", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5, 13, 7),
    });
    expect(out.content).toContain("# 双时间段阅读比较");
  });

  it("includes both period ranges", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近10年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("时间段 A：");
    expect(out.content).toContain("时间段 B：");
    expect(out.content).toContain("2020–2021");
    expect(out.content).toContain("2023–2024");
  });

  it("includes the export timestamp", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 11, 31, 23, 59),
    });
    expect(out.content).toContain("2025-12-31 23:59");
  });

  it("includes the privacy and interpretation notes", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("隐私说明");
    expect(out.content).toContain("解释边界");
    expect(out.content).toContain("浏览器本地生成");
  });

  it("includes the metrics comparison table", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("## 核心指标比较");
    expect(out.content).toContain("阅读记录");
    expect(out.content).toContain("活跃月份");
    expect(out.content).toContain("已匹配记录");
    expect(out.content).toContain("年度书目");
    expect(out.content).toContain("年均记录");
  });

  it("renders delta cells with direction-aware values", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult({
        delta: {
          totalRecords: { absolute: 50, percentage: 50, direction: "increase" },
          activeMonths: { absolute: -4, percentage: -25, direction: "decrease" },
          matchedRecords: { absolute: 0, percentage: 0, direction: "same" },
          matchedBooks: { absolute: 50, percentage: null, direction: "from_zero" },
          averageRecords: { absolute: -50, percentage: -100, direction: "to_zero" },
        },
      }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("+50");
    expect(out.content).toContain("-4");
    expect(out.content).toContain("由 0 起");
    expect(out.content).toContain("降至 0");
  });

  it("renders the three recurring sections", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("### 两个时间段共同出现");
    expect(out.content).toContain("### B 新出现");
    expect(out.content).toContain("### A 出现但 B 未出现");
  });

  it("renders the overlap table", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("## Overlap");
    expect(out.content).toContain("| 时间段 | 榜单重合比例 | 可比较年份对 |");
  });

  it("renders empty overlap note when comparablePairs = 0", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult({ overlap: { average: 0, comparablePairs: 0 } }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain(DUAL_PERIOD_MARKDOWN_NO_OVERLAP_NOTE);
  });

  it("renders empty recurring note when continued is empty", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult({
        recurring: { continued: [], entered: [], left: [] },
      }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain(DUAL_PERIOD_MARKDOWN_NO_RECURRING_NOTE);
    expect(out.content).toContain("时间段 B 没有新上榜的书目");
    expect(out.content).toContain("时间段 A 没有仅在 A 出现的上榜书目");
  });

  it("renders the empty-period notice when both periods have zero years", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult({
        periodA: {
          startYear: 2020,
          endYear: 2020,
          metrics: emptyMetrics(),
        },
        periodB: {
          startYear: 2021,
          endYear: 2021,
          metrics: emptyMetrics(),
        },
      }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain(DUAL_PERIOD_MARKDOWN_EMPTY_NOTE);
  });

  it("renders single-year period normally", () => {
    const singleMetrics = {
      years: [2020],
      totalRecords: 50,
      totalActiveMonths: 4,
      matchedRecords: 30,
      matchedBooks: 2,
      averageRecordsPerYear: 50,
      averageRecordsPerActiveMonth: 12.5,
      longestActiveStreak: 1,
      peakYear: 2020,
      peakYearRecords: 50,
    };
    const out = buildDualPeriodMarkdown({
      result: makeResult({
        periodA: { startYear: 2020, endYear: 2020, metrics: singleMetrics },
        periodB: {
          startYear: 2021,
          endYear: 2023,
          metrics: {
            years: [2021, 2022, 2023],
            totalRecords: 200,
            totalActiveMonths: 12,
            matchedRecords: 100,
            matchedBooks: 6,
            averageRecordsPerYear: 66.7,
            averageRecordsPerActiveMonth: 16.7,
            longestActiveStreak: 3,
            peakYear: 2022,
            peakYearRecords: 100,
          },
        },
      }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("2020 年");
  });

  it("escapes pipe characters in headings", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult({
        recurring: {
          continued: [],
          entered: [
            makeRecurring("c-x", "Book | with pipe"),
          ],
          left: [],
        },
      }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("Book \\| with pipe");
  });

  it("strips control characters from book titles", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult({
        recurring: {
          continued: [],
          entered: [
            makeRecurring("c-y", "Bad\u0000\u0007Title"),
          ],
          left: [],
        },
      }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).not.toContain("\u0000");
    expect(out.content).not.toContain("\u0007");
    expect(out.content).toContain("Bad Title");
  });

  it("uses the export timestamp in the filename", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 7, 5, 13, 7),
    });
    expect(out.filename).toMatch(/20250805/);
    expect(out.filename).toMatch(/^weread-dual-comparison-/);
  });

  it("uses empty suffix when both periods have no data", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult({
        periodA: { startYear: 2020, endYear: 2020, metrics: emptyMetrics() },
        periodB: { startYear: 2025, endYear: 2025, metrics: emptyMetrics() },
      }),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 7, 5),
    });
    expect(out.filename).toContain("-empty-");
  });

  it("caps filename at MAX_LENGTH", () => {
    const longResult = makeResult();
    const out = buildDualPeriodMarkdown({
      result: longResult,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 7, 5),
    });
    expect(out.filename.length).toBeLessThanOrEqual(
      DUAL_PERIOD_MARKDOWN_FILENAME_MAX_LENGTH,
    );
  });

  it("emits the documented MIME type", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.mimeType).toBe(DUAL_PERIOD_MARKDOWN_MIME);
  });

  it("byteLength matches TextEncoder", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const bytes = new TextEncoder().encode(out.content);
    expect(out.byteLength).toBe(bytes.length);
  });

  it("includes method section", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.content).toContain("## 方法说明");
    expect(out.content).toContain(DUAL_PERIOD_MARKDOWN_METHOD_NOTES[0]);
  });

  it("returns the expected counts in build result", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    expect(out.periodAYearCount).toBe(2);
    expect(out.periodBYearCount).toBe(2);
    expect(out.comparablePairs).toBe(2);
    expect(out.continuedCount).toBe(1);
    expect(out.enteredCount).toBe(1);
    expect(out.leftCount).toBe(1);
  });
});

describe("buildDualPeriodMarkdownFilename", () => {
  it("uses ASCII period labels and date", () => {
    const name = buildDualPeriodMarkdownFilename({
      periodA: makePeriod(2020, 2021),
      periodB: makePeriod(2023, 2024),
      now: new Date(2025, 7, 5),
      hasUsableData: true,
    });
    expect(name).toBe(`${DUAL_PERIOD_MARKDOWN_FILENAME_PREFIX}-2020-2021-vs-2023-2024-20250805.md`);
  });
  it("emits -empty- when hasUsableData is false", () => {
    const name = buildDualPeriodMarkdownFilename({
      periodA: makePeriod(0, 0),
      periodB: makePeriod(0, 0),
      now: new Date(2025, 7, 5),
      hasUsableData: false,
    });
    expect(name).toContain(`${DUAL_PERIOD_MARKDOWN_FILENAME_PREFIX}-empty-`);
  });
});

// ---------- validation ----------

describe("validateDualPeriodMarkdown", () => {
  it("accepts a valid build", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const r = validateDualPeriodMarkdown(out);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it("rejects forbidden tokens", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const tampered = { ...out, content: out.content + "\n\nnote.text: leaked" };
    const r = validateDualPeriodMarkdown(tampered);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("note.text"))).toBe(true);
  });
  it("rejects inference vocabulary", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const tampered = { ...out, content: out.content + "\n\n兴趣转变已发生" };
    const r = validateDualPeriodMarkdown(tampered);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("兴趣转变"))).toBe(true);
  });
  it("rejects wrong mime type", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const r = validateDualPeriodMarkdown({ ...out, mimeType: "text/html" });
    expect(r.valid).toBe(false);
  });
  it("rejects filenames that don't end with .md", () => {
    const out = buildDualPeriodMarkdown({
      result: makeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const r = validateDualPeriodMarkdown({ ...out, filename: "x.txt" });
    expect(r.valid).toBe(false);
  });
});

// ---------- trigger ----------

describe("triggerDualPeriodMarkdownDownload", () => {
  it("creates a blob with the right MIME and triggers download", async () => {
    let blobCreated: Blob | null = null;
    let createObjectUrlCalledWith: Blob | null = null;
    let revokedUrl: string | null = null;
    let attached: { href: string; download: string; rel: string; testId: string } | null = null;

    const result = triggerDualPeriodMarkdownDownload({
      content: "# hello",
      filename: "test.md",
      createObjectUrl: (b) => {
        createObjectUrlCalledWith = b;
        return "blob:abc";
      },
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      attachAnchor: (anchor) => {
        attached = anchor;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.filename).toBe("test.md");
    expect(result.mimeType).toBe(DUAL_PERIOD_MARKDOWN_MIME);
    expect(result.blobUrl).toBe("blob:abc");
    expect(result.downloadTriggered).toBe(true);
    expect(createObjectUrlCalledWith).not.toBeNull();
    expect(attached).toEqual({
      href: "blob:abc",
      download: "test.md",
      rel: "noopener noreferrer",
      testId: "weread-dual-period-export-anchor",
    });
    expect(revokedUrl).toBe("blob:abc");
  });

  it("falls back to document when no attachAnchor is provided", () => {
    const calls: string[] = [];
    const fakeDoc = {
      createElement: (tag: string) => {
        calls.push(`create:${tag}`);
        return {
          setAttribute: (name: string, value: string) => {
            calls.push(`set:${name}=${value}`);
          },
          click: () => {
            calls.push("click");
          },
        };
      },
      body: {
        appendChild: () => calls.push("append"),
        removeChild: () => calls.push("remove"),
      },
    };
    const result = triggerDualPeriodMarkdownDownload({
      content: "abc",
      filename: "x.md",
      createObjectUrl: () => "blob:x",
      revokeObjectUrl: () => {},
      resolveDocument: () => fakeDoc,
    });
    expect(result.downloadTriggered).toBe(true);
    expect(calls).toContain("create:a");
    expect(calls).toContain("set:href=blob:x");
    expect(calls).toContain("set:download=x.md");
    expect(calls).toContain("append");
    expect(calls).toContain("click");
    expect(calls).toContain("remove");
  });

  it("does not throw when document is unavailable", () => {
    const result = triggerDualPeriodMarkdownDownload({
      content: "abc",
      filename: "x.md",
      createObjectUrl: () => "blob:x",
      revokeObjectUrl: () => {},
      resolveDocument: () => null,
    });
    expect(result.downloadTriggered).toBe(false);
  });
});

// ---------- privacy ----------

describe("output privacy scan", () => {
  function makeLargeResult(): DualPeriodComparisonResult {
    return makeResult({
      recurring: {
        continued: [
          makeRecurring("c-1", "公共书 A", {
            author: "公共作者",
            publisher: "公共出版社",
            publishYear: 2020,
            years: [2020, 2021, 2023, 2024],
            yearsOnList: 4,
            bestRank: 1,
            latestYear: 2024,
          }),
        ],
        entered: [],
        left: [],
      },
    });
  }

  it("output never includes note / comment / private IDs", () => {
    const out = buildDualPeriodMarkdown({
      result: makeLargeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const lower = out.content.toLowerCase();
    const forbidden = [
      "note.text",
      "note.comment",
      "markedtext",
      "wereadbookid",
      "noteid",
      "highlightid",
      "chaptertitle",
    ];
    for (const token of forbidden) {
      expect(lower.includes(token), `forbidden: ${token}`).toBe(false);
    }
  });

  it("output never includes token / Authorization / API key", () => {
    const out = buildDualPeriodMarkdown({
      result: makeLargeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const lower = out.content.toLowerCase();
    expect(lower.includes("authorization")).toBe(false);
    expect(lower.includes("api key")).toBe(false);
    expect(out.content).not.toContain("wr_skey");
    expect(out.content).not.toContain("wr_vid");
    expect(lower.includes("token=")).toBe(false);
  });

  it("output never includes AI / themes / fetch / localStorage", () => {
    const out = buildDualPeriodMarkdown({
      result: makeLargeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const lower = out.content.toLowerCase();
    expect(lower.includes("ai summary")).toBe(false);
    expect(lower.includes("themes")).toBe(false);
    expect(lower.includes("fetch(")).toBe(false);
    expect(lower.includes("localstorage")).toBe(false);
    expect(lower.includes("sessionstorage")).toBe(false);
  });

  it("output never includes inference vocabulary", () => {
    const out = buildDualPeriodMarkdown({
      result: makeLargeResult(),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      exportedAt: new Date(2025, 0, 5),
    });
    const inference = [
      "兴趣转变",
      "偏好改变",
      "阅读低谷",
      "阅读高峰期",
      "探索期",
      "成熟期",
      "专注力变化",
      "心态变化",
      "阅读质量提升",
      "阅读质量下降",
      "心理状态",
      "人格",
      "性格",
      "情绪",
      "焦虑",
      "懒惰",
      "提升",
      "成长",
      "退步",
    ];
    for (const token of inference) {
      expect(out.content.includes(token), `inference: ${token}`).toBe(false);
    }
  });

  it("output is deterministic for the same input", () => {
    const args = {
      result: makeLargeResult(),
      rangeLabel: "最近5年" as DualPeriodRangeLabel,
      topBooksLimit: 12 as const,
      exportedAt: new Date(2025, 0, 5, 12, 0),
    };
    const a = buildDualPeriodMarkdown(args);
    const b = buildDualPeriodMarkdown(args);
    expect(a.content).toBe(b.content);
    expect(a.filename).toBe(b.filename);
  });
});

// ---------- helpers ----------

function emptyMetrics(): DualPeriodComparisonResult["periodA"]["metrics"] {
  return {
    years: [],
    totalRecords: 0,
    totalActiveMonths: 0,
    matchedRecords: 0,
    matchedBooks: 0,
    averageRecordsPerYear: 0,
    averageRecordsPerActiveMonth: 0,
    longestActiveStreak: 0,
    peakYear: null,
    peakYearRecords: 0,
  };
}
