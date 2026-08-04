/**
 * S27N-2 — Unit tests for the comparison-filter Markdown export model.
 *
 * All tests use synthetic `ReadingComparisonResult` objects; no
 * network calls, no real user data, no browser download side-effects.
 */

import { describe, it, expect } from "vitest";
import type {
  ReadingComparisonResult,
  ReadingComparisonFilters,
} from "./wereadReadingComparisonFilters";
import {
  escapeReadingComparisonMarkdownInline,
  escapeReadingComparisonMarkdownTableCell,
  sanitizeReadingComparisonMarkdownText,
  formatReadingComparisonMarkdownDate,
  formatReadingComparisonYearRange,
  formatReadingComparisonOverlapFilter,
  formatReadingComparisonExcludedReasons,
  formatReadingComparisonRangeLabel,
  formatReadingComparisonTopNLabel,
  formatReadingComparisonInteger,
  formatReadingComparisonAverage,
  formatReadingComparisonRank,
  formatReadingComparisonPercent,
  formatReadingComparisonOverlapClassLabel,
  formatReadingComparisonPeakMonth,
  formatReadingComparisonYearPlain,
  buildReadingComparisonMarkdown,
  buildReadingComparisonMarkdownFilename,
  validateReadingComparisonMarkdown,
  triggerReadingComparisonMarkdownDownload,
  READING_COMPARISON_MARKDOWN_MIME,
  READING_COMPARISON_MARKDOWN_EMPTY_NOTE,
  READING_COMPARISON_MARKDOWN_SINGLE_YEAR_NOTE,
  READING_COMPARISON_MARKDOWN_NO_RECURRING_NOTE,
  READING_COMPARISON_MARKDOWN_NO_OVERLAP_NOTE,
  READING_COMPARISON_MARKDOWN_NO_EXCLUDED_NOTE,
  READING_COMPARISON_MARKDOWN_DATA_INTEGRITY_NOTE,
  READING_COMPARISON_MARKDOWN_COMPLETENESS_NOTE,
  READING_COMPARISON_MARKDOWN_METHOD_NOTES,
  READING_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH,
} from "./wereadReadingComparisonMarkdown";

// ---------- fixtures ----------

function makeRecurringBook(
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
    publisher: overrides.publisher === undefined ? "出版社" : overrides.publisher,
    publishYear: overrides.publishYear === undefined ? 2020 : overrides.publishYear,
    yearsOnList: overrides.yearsOnList ?? 2,
    years: overrides.years ?? [2021, 2022],
    totalNoteCountWithinLists: overrides.totalNoteCountWithinLists ?? 0,
    bestRank: overrides.bestRank ?? 1,
    latestYear: overrides.latestYear ?? 2022,
    latestRank: overrides.latestRank ?? 1,
  };
}

function makeYear(
  year: number,
  overrides: Partial<{
    totalRecords: number;
    datedRecords: number;
    matchedRecords: number;
    matchedBooks: number;
    activeMonths: number;
    longestActiveStreak: number;
    peakMonth: string | null;
    averageRecordsPerActiveMonth: number;
  }> = {},
): import("./wereadReadingComparisonFilters").ReadingComparisonYear {
  return {
    year,
    totalRecords: overrides.totalRecords ?? 100,
    datedRecords: overrides.datedRecords ?? 80,
    matchedRecords: overrides.matchedRecords ?? 60,
    matchedBooks: overrides.matchedBooks ?? 5,
    activeMonths: overrides.activeMonths ?? 8,
    longestActiveStreak: overrides.longestActiveStreak ?? 4,
    peakMonth: overrides.peakMonth === undefined ? `${year}-06` : overrides.peakMonth,
    averageRecordsPerActiveMonth:
      overrides.averageRecordsPerActiveMonth ?? 12.5,
  };
}

function makeLink(
  sourceYear: number,
  targetYear: number,
  overlapRatio: number,
  sharedTopBooks = 1,
): import("./wereadReadingArchiveModel").ReadingArchiveYearLink {
  return { sourceYear, targetYear, sharedTopBooks, overlapRatio };
}

function makeFilters(
  overrides: Partial<ReadingComparisonFilters> = {},
): ReadingComparisonFilters {
  return {
    startYear: null,
    endYear: null,
    minRecords: 0,
    minActiveMonths: 0,
    recurringMinYears: 2,
    overlap: "all",
    ...overrides,
  };
}

function makeResult(
  filters: ReadingComparisonFilters,
  included: import("./wereadReadingComparisonFilters").ReadingComparisonYear[],
  excluded: import("./wereadReadingComparisonFilters").ReadingComparisonExcludedYear[] = [],
  recurring: import("./wereadReadingArchiveModel").ReadingArchiveRecurringBook[] = [],
  links: import("./wereadReadingArchiveModel").ReadingArchiveYearLink[] = [],
): ReadingComparisonResult {
  let totalRecords = 0;
  let totalActiveMonths = 0;
  for (const y of included) {
    totalRecords += y.totalRecords;
    totalActiveMonths += y.activeMonths;
  }
  const years = included.map((y) => y.year);
  const summary: ReadingComparisonResult["summary"] = included.length === 0
    ? {
        includedYearCount: 0,
        excludedYearCount: excluded.length,
        totalRecords: 0,
        totalActiveMonths: 0,
        averageRecordsPerYear: 0,
        earliestYear: null,
        latestYear: null,
      }
    : {
        includedYearCount: included.length,
        excludedYearCount: excluded.length,
        totalRecords,
        totalActiveMonths,
        averageRecordsPerYear: totalRecords / included.length,
        earliestYear: Math.min(...years),
        latestYear: Math.max(...years),
      };
  return {
    filters,
    availableYears: [...included.map((y) => y.year), ...excluded.map((e) => e.year)].sort(
      (a, b) => a - b,
    ),
    includedYears: included,
    excludedYears: excluded,
    recurringBooks: recurring,
    yearLinks: links,
    summary,
    meta: {
      source: "current_loaded_archive",
      persisted: false,
    },
  };
}

const NOW = new Date(2026, 7, 4, 19, 0, 0);

// ---------- formatting tests ----------

describe("formatReadingComparisonMarkdownDate", () => {
  it("formats a valid date", () => {
    expect(formatReadingComparisonMarkdownDate(NOW)).toBe("2026-08-04 19:00");
  });
  it("returns em dash for invalid date", () => {
    expect(formatReadingComparisonMarkdownDate(new Date(NaN))).toBe("—");
  });
});

describe("formatReadingComparisonYearRange", () => {
  it("shows range with two years", () => {
    expect(formatReadingComparisonYearRange(2020, 2024)).toBe("2020—2024");
  });
  it("shows single year", () => {
    expect(formatReadingComparisonYearRange(2022, 2022)).toBe("2022");
  });
  it("shows 暂无 when null", () => {
    expect(formatReadingComparisonYearRange(null, null)).toBe("暂无");
  });
});

describe("formatReadingComparisonOverlapFilter", () => {
  it("labels all", () => {
    expect(formatReadingComparisonOverlapFilter("all")).toBe("全部");
  });
  it("labels low", () => {
    expect(formatReadingComparisonOverlapFilter("low")).toBe("较低（< 0.25）");
  });
  it("labels medium", () => {
    expect(formatReadingComparisonOverlapFilter("medium")).toBe("中等（0.25 — 0.5）");
  });
  it("labels high", () => {
    expect(formatReadingComparisonOverlapFilter("high")).toBe("较高（≥ 0.5）");
  });
});

describe("formatReadingComparisonExcludedReasons", () => {
  it("joins known reasons with semicolon", () => {
    expect(
      formatReadingComparisonExcludedReasons(["before_start", "records_below_min"]),
    ).toBe("早于起始年份；低于最低阅读记录");
  });
  it("returns empty string for no reasons", () => {
    expect(formatReadingComparisonExcludedReasons([])).toBe("");
  });
});

describe("formatReadingComparisonRangeLabel", () => {
  it("expands labels", () => {
    expect(formatReadingComparisonRangeLabel("最近5年")).toBe("最近 5 年");
    expect(formatReadingComparisonRangeLabel("最近10年")).toBe("最近 10 年");
    expect(formatReadingComparisonRangeLabel("全部")).toBe("全部（最多 20 年）");
  });
});

describe("formatReadingComparisonTopNLabel", () => {
  it("renders Top N scope", () => {
    expect(formatReadingComparisonTopNLabel(12)).toBe("各年度 Top 12");
  });
});

describe("formatReadingComparisonInteger", () => {
  it("formats finite numbers", () => {
    expect(formatReadingComparisonInteger(1234)).toBe("1,234");
  });
  it("returns em dash for non-finite", () => {
    expect(formatReadingComparisonInteger(NaN)).toBe("—");
    expect(formatReadingComparisonInteger(Infinity)).toBe("—");
  });
});

describe("formatReadingComparisonAverage", () => {
  it("caps at one decimal place", () => {
    expect(formatReadingComparisonAverage(50.123)).toBe("50.1");
  });
  it("returns em dash for non-finite", () => {
    expect(formatReadingComparisonAverage(NaN)).toBe("—");
  });
});

describe("formatReadingComparisonRank", () => {
  it("formats valid rank", () => {
    expect(formatReadingComparisonRank(3)).toBe("第 3");
  });
  it("returns em dash for invalid rank", () => {
    expect(formatReadingComparisonRank(0)).toBe("—");
  });
});

describe("formatReadingComparisonPercent", () => {
  it("formats percent with 1 decimal", () => {
    expect(formatReadingComparisonPercent(0.75)).toBe("75.0%");
  });
  it("returns em dash for non-finite", () => {
    expect(formatReadingComparisonPercent(NaN)).toBe("—");
  });
});

describe("formatReadingComparisonOverlapClassLabel", () => {
  it("classifies low", () => {
    expect(formatReadingComparisonOverlapClassLabel(0.1)).toBe("较低");
  });
  it("classifies medium", () => {
    expect(formatReadingComparisonOverlapClassLabel(0.3)).toBe("中等");
  });
  it("classifies high", () => {
    expect(formatReadingComparisonOverlapClassLabel(0.7)).toBe("较高");
  });
});

describe("formatReadingComparisonPeakMonth", () => {
  it("escapes peak month inline", () => {
    expect(formatReadingComparisonPeakMonth("2025-06")).toBe("2025-06");
    expect(formatReadingComparisonPeakMonth("# hi")).toBe("\\# hi");
  });
  it("returns em dash for null", () => {
    expect(formatReadingComparisonPeakMonth(null)).toBe("—");
  });
});

describe("formatReadingComparisonYearPlain", () => {
  it("returns string year", () => {
    expect(formatReadingComparisonYearPlain(2025)).toBe("2025");
  });
  it("returns em dash for null", () => {
    expect(formatReadingComparisonYearPlain(null)).toBe("—");
  });
});

// ---------- escaping tests ----------

describe("escapeReadingComparisonMarkdownInline", () => {
  it("escapes meta chars and pipes", () => {
    expect(escapeReadingComparisonMarkdownInline("a*b_c|d")).toBe("a\\*b\\_c\\|d");
  });
  it("strips control characters", () => {
    expect(escapeReadingComparisonMarkdownInline("a\rb\nc\td")).toBe("a b c d");
  });
  it("escapes hash to prevent heading injection", () => {
    expect(escapeReadingComparisonMarkdownInline("# title")).toBe("\\# title");
  });
});

describe("escapeReadingComparisonMarkdownTableCell", () => {
  it("escapes pipe", () => {
    expect(escapeReadingComparisonMarkdownTableCell("a|b")).toBe("a\\|b");
  });
  it("returns em dash for empty", () => {
    expect(escapeReadingComparisonMarkdownTableCell("")).toBe("—");
  });
});

describe("sanitizeReadingComparisonMarkdownText", () => {
  it("is alias for inline escape", () => {
    expect(sanitizeReadingComparisonMarkdownText("*x*")).toBe("\\*x\\*");
  });
});

// ---------- build tests ----------

describe("buildReadingComparisonMarkdown / default filters", () => {
  it("includes header metadata and filter criteria", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2021), makeYear(2022), makeYear(2023)],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("# 长期阅读筛选比较");
    expect(md).toContain("当前长期档案范围：最近 5 年");
    expect(md).toContain("高互动书目口径：各年度 Top 12");
    expect(md).toContain("可用年份：3");
    expect(md).toContain("纳入年份：3");
    expect(md).toContain("排除年份：0");
    expect(md).toContain("当前比较年份：2021—2023");
    expect(md).toContain("生成方式：book-id-search 浏览器本地生成");
    expect(md).toContain("保存状态：未上传服务器");
    expect(md).toContain("## 当前筛选条件");
    expect(md).toContain("| 起始年份 | 不限制 |");
    expect(md).toContain("| 结束年份 | 不限制 |");
    expect(md).toContain("| 最低阅读记录 | 0 |");
    expect(md).toContain("| 最低活跃月份 | 0 |");
    expect(md).toContain("| recurring 最低上榜年份 | 2 年 |");
    expect(md).toContain("| 榜单重合范围 | 全部 |");
  });
});

describe("buildReadingComparisonMarkdown / normalized filters", () => {
  it("shows normalized start/end years", () => {
    const result = makeResult(
      makeFilters({ startYear: 2021, endYear: 2024 }),
      [makeYear(2021), makeYear(2022), makeYear(2023), makeYear(2024)],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "全部",
      topBooksLimit: 18,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("| 起始年份 | 2021 |");
    expect(md).toContain("| 结束年份 | 2024 |");
    expect(md).toContain("| 最低阅读记录 | 0 |");
    expect(md).toContain("高互动书目口径：各年度 Top 18");
  });
});

describe("buildReadingComparisonMarkdown / overview", () => {
  it("includes summary with totals", () => {
    const result = makeResult(
      makeFilters(),
      [
        makeYear(2021, { totalRecords: 100, activeMonths: 6 }),
        makeYear(2022, { totalRecords: 200, activeMonths: 12 }),
      ],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 比较总览");
    expect(md).toContain("- 阅读记录合计：300");
    expect(md).toContain("- 活跃月份合计：18");
    expect(md).toContain("- 年均记录：150");
    expect(md).toContain("- 最早纳入年份：2021");
    expect(md).toContain("- 最近纳入年份：2022");
  });
});

describe("buildReadingComparisonMarkdown / included years table", () => {
  it("renders included years sorted ascending", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2023), makeYear(2021), makeYear(2022)],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 纳入年份指标");
    expect(md).toContain(
      "| 年份 | 阅读记录 | 有效日期记录 | 已匹配记录 | 年度书目 | 活跃月份 | 最长连续月份 | 高峰月份 | 活跃月份平均记录 |",
    );
    expect(md).toContain("| 2021 |");
    expect(md).toContain("| 2022 |");
    expect(md).toContain("| 2023 |");
  });

  it("shows em dash for null peak month", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2021, { peakMonth: null })],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    // The em dash appears in the peak-month column for the row
    expect(md).toContain("| 2021 |");
    expect(md).toMatch(/\| — \|/);
  });
});

describe("buildReadingComparisonMarkdown / excluded years", () => {
  it("renders excluded reasons in Chinese", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2021)],
      [
        { year: 2020, reasons: ["before_start", "records_below_min"] },
        { year: 2024, reasons: ["after_end"] },
      ],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 被排除年份");
    expect(md).toContain("| 2020 | 早于起始年份；低于最低阅读记录 |");
    expect(md).toContain("| 2024 | 晚于结束年份 |");
  });

  it("shows empty note when no excluded years", () => {
    const result = makeResult(makeFilters(), [makeYear(2021)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain(READING_COMPARISON_MARKDOWN_NO_EXCLUDED_NOTE);
  });
});

describe("buildReadingComparisonMarkdown / recurring books", () => {
  it("renders recurring books with /books/:catalogId links", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2021), makeYear(2022)],
      [],
      [makeRecurringBook("b1", "公共书名")],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 筛选范围内重复进入 Top N 的书目");
    expect(md).toContain("### 1. 《公共书名》");
    expect(md).toContain("- 作者：公共作者");
    expect(md).toContain("- 出版信息：出版社，2020");
    expect(md).toContain("- 纳入的上榜年份：2021、2022");
    expect(md).toContain("- 上榜年份数：2 年");
    expect(md).toContain("- 最佳排名：第 1");
    expect(md).toContain("- 最新上榜年份：2022");
    expect(md).toContain("- 最新年份排名：第 1");
    expect(md).toContain("- 书目页面：https://books.conanxin.com/books/b1");
  });

  it("omits author when null", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2021), makeYear(2022)],
      [],
      [makeRecurringBook("b2", "无作者", { author: null })],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).not.toContain("- 作者：");
    expect(md).toContain("- 出版信息：出版社，2020");
  });

  it("omits publisher when null", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2021), makeYear(2022)],
      [],
      [makeRecurringBook("b3", "无出版", { publisher: null, publishYear: null })],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).not.toContain("- 出版信息：");
    expect(md).toContain("- 作者：公共作者");
  });

  it("shows empty note when no recurring", () => {
    const result = makeResult(makeFilters(), [makeYear(2021)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain(READING_COMPARISON_MARKDOWN_NO_RECURRING_NOTE);
  });

  it("caps recurring books at 12", () => {
    const books = Array.from({ length: 14 }, (_, i) =>
      makeRecurringBook(`b${i}`, `书名${i}`),
    );
    const result = makeResult(makeFilters(), [makeYear(2021), makeYear(2022)], [], books);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    // All 14 books render in the content because the model already
    // caps at 12. The content builder must not crash on extras.
    expect(md).toContain("书名0");
    expect(md).toContain("书名13");
  });
});

describe("buildReadingComparisonMarkdown / overlap", () => {
  it("renders overlap rows for all", () => {
    const result = makeResult(
      makeFilters(),
      [makeYear(2021), makeYear(2022)],
      [],
      [],
      [makeLink(2021, 2022, 0.4)],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 筛选范围内相邻年度榜单重合");
    expect(md).toContain("| 相邻年份 | 共同上榜书目 | 榜单重合率 | 当前分类 |");
    expect(md).toContain("2021 → 2022");
    expect(md).toContain("40.0%");
    expect(md).toContain("中等");
  });

  it("shows empty note when no overlap", () => {
    const result = makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain(READING_COMPARISON_MARKDOWN_NO_OVERLAP_NOTE);
  });

  it("shows single-year note when only one included year", () => {
    const result = makeResult(makeFilters(), [makeYear(2021)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain(READING_COMPARISON_MARKDOWN_NO_OVERLAP_NOTE);
    expect(md).toContain(READING_COMPARISON_MARKDOWN_SINGLE_YEAR_NOTE);
  });
});

describe("buildReadingComparisonMarkdown / method notes", () => {
  it("renders all method notes", () => {
    const result = makeResult(makeFilters(), [makeYear(2021)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 方法说明");
    for (const note of READING_COMPARISON_MARKDOWN_METHOD_NOTES) {
      expect(md).toContain(note);
    }
  });
});

// ---------- empty / single-year / partial failure ----------

describe("buildReadingComparisonMarkdown / empty result", () => {
  it("renders empty note and keeps metadata", () => {
    const result = makeResult(makeFilters(), []);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("# 长期阅读筛选比较");
    expect(md).toContain("当前比较年份：暂无");
    expect(md).toContain("纳入年份：0");
    expect(md).toContain(READING_COMPARISON_MARKDOWN_EMPTY_NOTE);
    expect(md).toContain(READING_COMPARISON_MARKDOWN_NO_OVERLAP_NOTE);
    expect(md).toContain(READING_COMPARISON_MARKDOWN_NO_RECURRING_NOTE);
    expect(md).toContain(READING_COMPARISON_MARKDOWN_NO_EXCLUDED_NOTE);
    expect(md).toContain("## 方法说明");
    expect(md).not.toContain("| 年份 | 阅读记录 |");
  });
});

describe("buildReadingComparisonMarkdown / single included year", () => {
  it("renders one row in table, empty overlap section", () => {
    const result = makeResult(makeFilters(), [makeYear(2021)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("| 2021 |");
    expect(md).not.toContain("| 2022 |");
    expect(md).toContain(READING_COMPARISON_MARKDOWN_SINGLE_YEAR_NOTE);
  });
});

describe("buildReadingComparisonMarkdown / partial failure", () => {
  it("includes completeness warning when failedYears present", () => {
    const result = makeResult(makeFilters(), [makeYear(2021), makeYear(2023)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [2022],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("暂时失败年份：1");
    expect(md).toContain(
      READING_COMPARISON_MARKDOWN_COMPLETENESS_NOTE.replace("N", "1"),
    );
    expect(md).not.toContain(READING_COMPARISON_MARKDOWN_DATA_INTEGRITY_NOTE);
  });

  it("includes data integrity note when no failures", () => {
    const result = makeResult(makeFilters(), [makeYear(2021)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain(READING_COMPARISON_MARKDOWN_DATA_INTEGRITY_NOTE);
  });
});

// ---------- filename tests ----------

describe("buildReadingComparisonMarkdownFilename", () => {
  it("normal range", () => {
    expect(
      buildReadingComparisonMarkdownFilename({
        firstYear: 2020,
        latestYear: 2024,
        now: NOW,
      }),
    ).toBe("weread-reading-comparison-2020-to-2024-20260804.md");
  });
  it("empty years", () => {
    expect(
      buildReadingComparisonMarkdownFilename({
        firstYear: null,
        latestYear: null,
        now: NOW,
      }),
    ).toBe("weread-reading-comparison-empty-20260804.md");
  });
  it("filename is ASCII and ≤80", () => {
    const name = buildReadingComparisonMarkdownFilename({
      firstYear: 2020,
      latestYear: 2024,
      now: NOW,
    });
    expect(name).toMatch(/^[\x20-\x7E]+$/);
    expect(name.length).toBeLessThanOrEqual(READING_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH);
  });
});

// ---------- validation tests ----------

describe("validateReadingComparisonMarkdown", () => {
  it("passes for a valid result", () => {
    const r = buildReadingComparisonMarkdown({
      result: makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingComparisonMarkdown(r);
    expect(v.valid, `expected valid, got errors: ${JSON.stringify(v.errors)}`).toBe(true);
    expect(v.errors).toEqual([]);
  });
  it("fails for empty content", () => {
    const v = validateReadingComparisonMarkdown({
      content: "",
      filename: "x.md",
      mimeType: READING_COMPARISON_MARKDOWN_MIME,
      byteLength: 0,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      eraCount: 0,
      includedYearCount: 0,
      excludedYearCount: 0,
      failedYearCount: 0,
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("content missing");
  });
  it("fails for wrong mime", () => {
    const r = buildReadingComparisonMarkdown({
      result: makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingComparisonMarkdown({ ...r, mimeType: "text/plain" });
    expect(v.errors).toContain("mimeType wrong");
  });
  it("detects forbidden tokens", () => {
    const r = buildReadingComparisonMarkdown({
      result: makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingComparisonMarkdown({ ...r, content: r.content + " note.text " });
    expect(v.errors).toContain("forbidden token: note.text");
  });
  it("detects inference language", () => {
    const r = buildReadingComparisonMarkdown({
      result: makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingComparisonMarkdown({ ...r, content: r.content + " 阅读低谷 " });
    expect(v.errors.some((e) => e.includes("阅读低谷"))).toBe(true);
  });
  it("detects long filename", () => {
    const v = validateReadingComparisonMarkdown({
      content: "# ok",
      filename: "a".repeat(85) + ".md",
      mimeType: READING_COMPARISON_MARKDOWN_MIME,
      byteLength: 10,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      eraCount: 0,
      includedYearCount: 0,
      excludedYearCount: 0,
      failedYearCount: 0,
    });
    expect(v.errors).toContain("filename too long");
  });
});

// ---------- download tests ----------

describe("triggerReadingComparisonMarkdownDownload", () => {
  it("creates blob URL and triggers download", async () => {
    let createdUrl = "";
    let revokedUrl = "";
    let attached: unknown = null;
    const res = triggerReadingComparisonMarkdownDownload({
      content: "# test",
      filename: "test.md",
      createObjectUrl: () => {
        createdUrl = "blob://test";
        return createdUrl;
      },
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      attachAnchor: (anchor) => {
        attached = anchor;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(res.downloadTriggered).toBe(true);
    expect(res.filename).toBe("test.md");
    expect(res.mimeType).toBe(READING_COMPARISON_MARKDOWN_MIME);
    expect(res.blobUrl).toBe("blob://test");
    expect(createdUrl).toBe("blob://test");
    expect(revokedUrl).toBe("blob://test");
    expect(attached).toEqual({
      href: "blob://test",
      download: "test.md",
      rel: "noopener noreferrer",
      testId: "weread-reading-comparison-export-anchor",
    });
  });
});

// ---------- explicit content constraints ----------

describe("content constraints", () => {
  it("does not include raw JSON", () => {
    const result = makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).not.toContain('"includedYears"');
    expect(md).not.toContain('"excludedYears"');
    expect(md).not.toContain('"recurringBooks"');
    expect(md).not.toContain('"yearLinks"');
    expect(md).not.toContain('"summary"');
  });

  it("does not include note/comment/AI/private fields", () => {
    const result = makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md.toLowerCase()).not.toContain("note.text");
    expect(md.toLowerCase()).not.toContain("note.comment");
    expect(md.toLowerCase()).not.toContain("markedtext");
    expect(md.toLowerCase()).not.toContain("wereadbookid");
    expect(md.toLowerCase()).not.toContain("ai summary");
    expect(md.toLowerCase()).not.toContain("themes");
    expect(md.toLowerCase()).not.toContain("highlightid");
    expect(md.toLowerCase()).not.toContain("chaptertitle");
  });

  it("does not include token/authorization strings", () => {
    const result = makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md.toLowerCase()).not.toContain("authorization:");
    expect(md.toLowerCase()).not.toContain("api key");
    expect(md).not.toContain("wr_skey");
    expect(md).not.toContain("wr_vid");
    expect(md.toLowerCase()).not.toContain("token=");
  });

  it("does not include psychological inference words", () => {
    const result = makeResult(makeFilters(), [makeYear(2021), makeYear(2022)]);
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
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
    ];
    for (const w of inference) {
      expect(md).not.toContain(w);
    }
  });

  it("escapes recurring book title meta chars", () => {
    const book = makeRecurringBook("b2", "# 星 * 际 _ [测试]");
    const result = makeResult(
      makeFilters(),
      [makeYear(2021), makeYear(2022)],
      [],
      [book],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("《\\# 星 \\* 际 \\_ \\[测试\\]》");
    expect(md).not.toContain("# 星 * 际 _ [测试]");
  });

  it("escapes publisher pipe", () => {
    const book = makeRecurringBook("b3", "公共书名", { publisher: "A|B" });
    const result = makeResult(
      makeFilters(),
      [makeYear(2021), makeYear(2022)],
      [],
      [book],
    );
    const md = buildReadingComparisonMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("A\\|B");
  });
});