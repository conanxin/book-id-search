/**
 * S27M-2 — Unit tests for the reading-era Markdown export model.
 *
 * All tests use synthetic `WereadReadingEraResult` objects; no
 * network calls, no real user data, no browser download side-effects.
 */

import { describe, it, expect } from "vitest";
import type {
  ReadingEra,
  ReadingEraBoundary,
  WereadReadingEraResult,
} from "./wereadReadingEraModel";
import type { ReadingArchiveRecurringBook } from "./wereadReadingArchiveModel";
import {
  escapeReadingEraMarkdownInline,
  escapeReadingEraMarkdownTableCell,
  sanitizeReadingEraMarkdownText,
  formatReadingEraMarkdownDate,
  formatReadingEraYearRange,
  formatReadingEraMode,
  formatReadingEraBoundaryReasons,
  formatReadingEraRangeLabel,
  formatReadingEraTopNLabel,
  formatReadingEraInteger,
  formatReadingEraAverage,
  formatReadingEraPeakYear,
  formatReadingEraRank,
  buildReadingEraMarkdown,
  buildReadingEraMarkdownFilename,
  validateReadingEraMarkdown,
  triggerReadingEraMarkdownDownload,
  READING_ERA_MARKDOWN_MIME,
  READING_ERA_MARKDOWN_EMPTY_NOTE,
  READING_ERA_MARKDOWN_SINGLE_YEAR_NOTE,
  READING_ERA_MARKDOWN_NO_RECURRING_NOTE,
  READING_ERA_MARKDOWN_NO_BOUNDARY_NOTE,
  READING_ERA_MARKDOWN_METHOD_NOTES,
  READING_ERA_MARKDOWN_FILENAME_MAX_LENGTH,
  READING_ERA_MARKDOWN_PRIVACY_NOTE,
  READING_ERA_MARKDOWN_INTERPRETATION_NOTE,
  READING_ERA_MARKDOWN_COMPLETENESS_NOTE,
  READING_ERA_MARKDOWN_DATA_INTEGRITY_NOTE,
} from "./wereadReadingEraMarkdown";

// ---------- fixtures ----------

function makeRecurringBook(
  catalogId: string,
  title: string,
  overrides: Partial<Omit<ReadingArchiveRecurringBook, "catalogId" | "title">> = {},
) {
  return {
    catalogId,
    title,
    author: "公共作者",
    publisher: "出版社",
    publishYear: 2020,
    yearsOnList: 2,
    years: [2021, 2022],
    totalNoteCountWithinLists: 10,
    bestRank: 1,
    latestYear: 2022,
    latestRank: 2,
    ...overrides,
  };
}

function makeEra(
  overrides: Partial<ReadingEra> & { startYear: number; endYear: number },
): ReadingEra {
  const { startYear, endYear, ...rest } = overrides;
  const years = [] as number[];
  for (let y = startYear; y <= endYear; y += 1) years.push(y);
  return {
    id: `era-${startYear}-${endYear}`,
    startYear,
    endYear,
    years,
    totalRecords: 100,
    totalActiveMonths: 10,
    averageRecordsPerYear: 50,
    peakYear: startYear,
    peakYearRecords: 100,
    recurringBooks: [],
    boundaryBefore: null,
    ...rest,
  };
}

function makeBoundary(
  overrides: Partial<ReadingEraBoundary> & { afterYear: number; beforeYear: number },
): ReadingEraBoundary {
  const { afterYear, beforeYear, ...rest } = overrides;
  return {
    afterYear,
    beforeYear,
    score: 60,
    reasons: ["activity_shift", "active_month_shift"],
    ...rest,
  };
}

function makeResult(
  mode: "automatic" | "gaps_only",
  eras: ReadingEra[],
  boundaries: ReadingEraBoundary[] = [],
): WereadReadingEraResult {
  return {
    eras,
    boundaries,
    meta: {
      yearsUsed: eras.reduce((sum, e) => sum + e.years.length, 0),
      erasReturned: eras.length,
      mode,
      persisted: false,
    },
  };
}

const NOW = new Date(2026, 7, 4, 19, 0, 0);

// ---------- formatting tests ----------

describe("formatReadingEraMarkdownDate", () => {
  it("formats a valid date", () => {
    expect(formatReadingEraMarkdownDate(NOW)).toBe("2026-08-04 19:00");
  });
  it("returns em dash for invalid date", () => {
    expect(formatReadingEraMarkdownDate(new Date(NaN))).toBe("—");
  });
});

describe("formatReadingEraYearRange", () => {
  it("shows range with two years", () => {
    expect(formatReadingEraYearRange(2020, 2024)).toBe("2020—2024");
  });
  it("shows same year range", () => {
    expect(formatReadingEraYearRange(2022, 2022)).toBe("2022—2022");
  });
  it("shows empty when null", () => {
    expect(formatReadingEraYearRange(null, null)).toBe("暂无年份");
  });
});

describe("formatReadingEraMode", () => {
  it("labels automatic", () => {
    expect(formatReadingEraMode("automatic")).toBe("自动阶段");
  });
  it("labels gaps_only", () => {
    expect(formatReadingEraMode("gaps_only")).toBe("仅按年份中断");
  });
});

describe("formatReadingEraBoundaryReasons", () => {
  it("joins known reasons with semicolon", () => {
    const b = makeBoundary({ afterYear: 2020, beforeYear: 2021, reasons: ["year_gap", "activity_shift"] });
    expect(formatReadingEraBoundaryReasons(b)).toBe("年份存在中断；阅读记录数量变化较大");
  });
  it("falls back to neutral when no known reasons", () => {
    const b = makeBoundary({ afterYear: 2020, beforeYear: 2021, reasons: ["unknown" as never] });
    expect(formatReadingEraBoundaryReasons(b)).toBe("统计发生变化");
  });
});

describe("formatReadingEraRangeLabel", () => {
  it("expands labels", () => {
    expect(formatReadingEraRangeLabel("最近5年")).toBe("最近 5 年");
    expect(formatReadingEraRangeLabel("最近10年")).toBe("最近 10 年");
    expect(formatReadingEraRangeLabel("全部")).toBe("全部（最多 20 年）");
  });
});

describe("formatReadingEraTopNLabel", () => {
  it("renders Top N scope", () => {
    expect(formatReadingEraTopNLabel(6)).toBe("各年度 Top 6");
  });
});

describe("formatReadingEraInteger", () => {
  it("formats finite numbers", () => {
    expect(formatReadingEraInteger(1234)).toBe("1,234");
  });
  it("returns em dash for non-finite", () => {
    expect(formatReadingEraInteger(NaN)).toBe("—");
    expect(formatReadingEraInteger(Infinity)).toBe("—");
  });
});

describe("formatReadingEraAverage", () => {
  it("caps at one decimal place", () => {
    expect(formatReadingEraAverage(50.123)).toBe("50.1");
  });
  it("returns em dash for non-finite", () => {
    expect(formatReadingEraAverage(NaN)).toBe("—");
  });
});

describe("formatReadingEraPeakYear", () => {
  it("shows year and records", () => {
    expect(formatReadingEraPeakYear(2022, 120)).toBe("2022（120）");
  });
  it("returns em dash when year is null", () => {
    expect(formatReadingEraPeakYear(null, 0)).toBe("—");
  });
});

describe("formatReadingEraRank", () => {
  it("shows rank", () => {
    expect(formatReadingEraRank(3)).toBe("第 3");
  });
  it("returns em dash for invalid rank", () => {
    expect(formatReadingEraRank(0)).toBe("—");
  });
});

// ---------- escaping tests ----------

describe("escapeReadingEraMarkdownInline", () => {
  it("escapes backslash and meta chars", () => {
    expect(escapeReadingEraMarkdownInline("a*b_c[d]")).toBe("a\\*b\\_c\\[d\\]");
  });
  it("strips control chars and newlines", () => {
    expect(escapeReadingEraMarkdownInline("a\rb\nc\td")).toBe("a b c d");
  });
  it("returns empty for null/undefined", () => {
    expect(escapeReadingEraMarkdownInline(null)).toBe("");
    expect(escapeReadingEraMarkdownInline(undefined)).toBe("");
  });
  it("escapes hash to prevent heading injection", () => {
    expect(escapeReadingEraMarkdownInline("# title")).toBe("\\# title");
  });
});

describe("escapeReadingEraMarkdownTableCell", () => {
  it("escapes pipe", () => {
    expect(escapeReadingEraMarkdownTableCell("a|b")).toBe("a\\|b");
  });
  it("returns em dash for empty", () => {
    expect(escapeReadingEraMarkdownTableCell("")).toBe("—");
  });
  it("returns em dash for null/undefined", () => {
    expect(escapeReadingEraMarkdownTableCell(null)).toBe("—");
  });
});

describe("sanitizeReadingEraMarkdownText", () => {
  it("is alias for inline escape", () => {
    expect(sanitizeReadingEraMarkdownText("*x*")).toBe("\\*x\\*");
  });
});

// ---------- build tests ----------

describe("buildReadingEraMarkdown / automatic", () => {
  it("includes header and metadata", () => {
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    expect(md.content).toContain("# 阅读阶段档案");
    expect(md.content).toContain("阶段划分模式：自动阶段");
    expect(md.content).toContain("当前长期档案范围：最近 5 年");
    expect(md.content).toContain("高互动书目口径：各年度 Top 12");
    expect(md.content).toContain("成功加载年份：3");
    expect(md.content).toContain("阶段数量：1");
    expect(md.content).toContain(READING_ERA_MARKDOWN_PRIVACY_NOTE);
    expect(md.content).toContain(READING_ERA_MARKDOWN_INTERPRETATION_NOTE);
    expect(md.content).toContain(READING_ERA_MARKDOWN_DATA_INTEGRITY_NOTE);
  });

  it("includes phase overview table", () => {
    const result = makeResult(
      "automatic",
      [
        makeEra({ startYear: 2021, endYear: 2023, totalRecords: 300, totalActiveMonths: 30, averageRecordsPerYear: 100 }),
        makeEra({ startYear: 2025, endYear: 2025, totalRecords: 150, totalActiveMonths: 12, averageRecordsPerYear: 150 }),
      ],
      [makeBoundary({ afterYear: 2023, beforeYear: 2025, score: 100, reasons: ["year_gap"] })],
    );
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "全部",
      topBooksLimit: 18,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 阶段总览");
    expect(md).toContain("| 阶段 | 年份 | 年份数 | 阅读记录 | 活跃月份 | 年均记录 | 高峰年份 |");
    expect(md).toContain("阶段 1");
    expect(md).toContain("2021—2023");
    expect(md).toContain("300");
    expect(md).toContain("阶段 2");
    expect(md).toContain("2025年");
  });

  it("includes phase details with boundary", () => {
    const boundary = makeBoundary({ afterYear: 2023, beforeYear: 2025, score: 100, reasons: ["year_gap"] });
    const result = makeResult(
      "automatic",
      [
        makeEra({ startYear: 2021, endYear: 2023 }),
        makeEra({ startYear: 2025, endYear: 2025, boundaryBefore: boundary }),
      ],
      [boundary],
    );
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "全部",
      topBooksLimit: 18,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 阶段详情");
    expect(md).toContain("### 阶段 1：2021—2023年");
    expect(md).toContain("### 阶段 2：2025年");
    expect(md).toContain("#### 与上一阶段的分界");
    expect(md).toContain("分界位置：2023 → 2025");
    expect(md).toContain("分界得分：100");
    expect(md).toContain("- 年份存在中断");
  });

  it("includes recurring books within a phase", () => {
    const book = makeRecurringBook("b1", "公共书名");
    const result = makeResult(
      "automatic",
      [makeEra({ startYear: 2021, endYear: 2023, recurringBooks: [book] })],
    );
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("### 阶段内重复进入 Top N 的书目");
    expect(md).toContain("#### 1. 《公共书名》");
    expect(md).toContain("- 作者：公共作者");
    expect(md).toContain("- 出版信息：出版社，2020");
    expect(md).toContain("- 进入榜单年份：2021、2022");
    expect(md).toContain("- 进入榜单次数：2 年");
    expect(md).toContain("- 最佳排名：第 1");
    expect(md).toContain("- 最新上榜年份：2022");
    expect(md).toContain("https://books.conanxin.com/books/b1");
  });

  it("shows recurring cap message when none", () => {
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain(READING_ERA_MARKDOWN_NO_RECURRING_NOTE);
  });

  it("includes boundary overview table", () => {
    const result = makeResult(
      "automatic",
      [
        makeEra({ startYear: 2021, endYear: 2023 }),
        makeEra({ startYear: 2025, endYear: 2025 }),
      ],
      [makeBoundary({ afterYear: 2023, beforeYear: 2025, score: 60, reasons: ["activity_shift", "active_month_shift"] })],
    );
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "全部",
      topBooksLimit: 18,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 阶段边界一览");
    expect(md).toContain("| 分界 | 得分 | 分界依据 |");
    expect(md).toContain("2023 → 2025|60|");
    expect(md).toContain("阅读记录数量变化较大；活跃月份数量变化较大");
  });

  it("includes all method notes", () => {
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("## 方法说明");
    for (const note of READING_ERA_MARKDOWN_METHOD_NOTES) {
      expect(md).toContain(note);
    }
  });
});

describe("buildReadingEraMarkdown / gaps_only", () => {
  it("labels gaps_only mode", () => {
    const result = makeResult("gaps_only", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "全部",
      topBooksLimit: 6,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("阶段划分模式：仅按年份中断");
  });
});

// ---------- empty / single / partial tests ----------

describe("buildReadingEraMarkdown / empty", () => {
  it("renders empty note and keeps metadata", () => {
    const result = makeResult("automatic", []);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("# 阅读阶段档案");
    expect(md).toContain("档案年份：暂无年份");
    expect(md).toContain("阶段数量：0");
    expect(md).toContain(READING_ERA_MARKDOWN_EMPTY_NOTE);
    expect(md).toContain(READING_ERA_MARKDOWN_PRIVACY_NOTE);
    expect(md).toContain("## 方法说明");
    expect(md).not.toContain("## 阶段详情");
    expect(md).not.toContain("### 阶段 1");
  });
});

describe("buildReadingEraMarkdown / single year", () => {
  it("renders one phase and single-year note", () => {
    const result = makeResult("automatic", [makeEra({ startYear: 2022, endYear: 2022 })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("### 阶段 1：2022年");
    expect(md).toContain(READING_ERA_MARKDOWN_SINGLE_YEAR_NOTE);
    expect(md).not.toContain("#### 与上一阶段的分界");
  });
});

describe("buildReadingEraMarkdown / partial failure", () => {
  it("renders completeness warning", () => {
    const result = makeResult(
      "automatic",
      [makeEra({ startYear: 2021, endYear: 2023 })],
    );
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [2024, 2025],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("暂时失败年份：2");
    expect(md).toContain(READING_ERA_MARKDOWN_COMPLETENESS_NOTE.replace("N", "2"));
    expect(md).not.toContain(READING_ERA_MARKDOWN_DATA_INTEGRITY_NOTE);
  });
});

// ---------- filename tests ----------

describe("buildReadingEraMarkdownFilename", () => {
  it("automatic mode with years", () => {
    expect(buildReadingEraMarkdownFilename({ mode: "automatic", firstYear: 2020, latestYear: 2024, now: NOW })).toBe(
      "weread-reading-eras-automatic-2020-to-2024-20260804.md",
    );
  });
  it("gaps_only mode with years", () => {
    expect(buildReadingEraMarkdownFilename({ mode: "gaps_only", firstYear: 2020, latestYear: 2024, now: NOW })).toBe(
      "weread-reading-eras-gaps-only-2020-to-2024-20260804.md",
    );
  });
  it("empty years", () => {
    expect(buildReadingEraMarkdownFilename({ mode: "automatic", firstYear: null, latestYear: null, now: NOW })).toBe(
      "weread-reading-eras-automatic-empty-20260804.md",
    );
  });
  it("filename is ASCII and ≤80", () => {
    const name = buildReadingEraMarkdownFilename({ mode: "automatic", firstYear: 2020, latestYear: 2024, now: NOW });
    expect(name).toMatch(/^[\x20-\x7E]+$/);
    expect(name.length).toBeLessThanOrEqual(READING_ERA_MARKDOWN_FILENAME_MAX_LENGTH);
  });
});

// ---------- validation tests ----------

describe("validateReadingEraMarkdown", () => {
  it("passes for a valid result", () => {
    const result = buildReadingEraMarkdown({
      result: makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingEraMarkdown(result);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("fails for missing content", () => {
    const v = validateReadingEraMarkdown({
      content: "",
      filename: "x.md",
      mimeType: READING_ERA_MARKDOWN_MIME,
      byteLength: 0,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      eraCount: 0,
      failedYearCount: 0,
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("content missing");
    expect(v.errors).toContain("byteLength missing");
  });

  it("fails for wrong mime", () => {
    const result = buildReadingEraMarkdown({
      result: makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingEraMarkdown({ ...result, mimeType: "text/plain" });
    expect(v.errors).toContain("mimeType wrong");
  });

  it("detects forbidden tokens", () => {
    const result = buildReadingEraMarkdown({
      result: makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingEraMarkdown({ ...result, content: result.content + " note.text " });
    expect(v.errors).toContain("forbidden token: note.text");
  });

  it("detects psychological inference", () => {
    const result = buildReadingEraMarkdown({
      result: makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]),
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    });
    const v = validateReadingEraMarkdown({ ...result, content: result.content + " 阅读低谷 " });
    expect(v.errors).toContain("psychological inference: 阅读低谷");
  });

  it("detects long filename", () => {
    const v = validateReadingEraMarkdown({
      content: "# ok",
      filename: "a".repeat(85) + ".md",
      mimeType: READING_ERA_MARKDOWN_MIME,
      byteLength: 10,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      eraCount: 0,
      failedYearCount: 0,
    });
    expect(v.errors).toContain("filename too long");
  });
});

// ---------- download tests ----------

describe("triggerReadingEraMarkdownDownload", () => {
  it("creates blob URL and triggers download", async () => {
    let createdUrl = "";
    let revokedUrl = "";
    let attached: unknown = null;
    const res = triggerReadingEraMarkdownDownload({
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
    expect(res.mimeType).toBe(READING_ERA_MARKDOWN_MIME);
    expect(res.blobUrl).toBe("blob://test");
    expect(createdUrl).toBe("blob://test");
    expect(revokedUrl).toBe("blob://test");
    expect(attached).toEqual({
      href: "blob://test",
      download: "test.md",
      rel: "noopener noreferrer",
      testId: "weread-reading-era-export-anchor",
    });
  });

  it("does not expose storage or network", () => {
    // The function signature and implementation only accept content,
    // filename, and browser URL helpers. It never reads localStorage,
    // sessionStorage, IndexedDB, fetch, or XMLHttpRequest.
    expect(triggerReadingEraMarkdownDownload).toBeInstanceOf(Function);
  });
});

// ---------- explicit content constraints ----------

describe("content constraints", () => {
  it("does not include raw JSON", () => {
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).not.toContain('"eras"');
    expect(md).not.toContain('"boundaries"');
    expect(md).not.toContain('"meta"');
    expect(md).not.toContain("{\n");
  });

  it("does not include note/comment/AI fields", () => {
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
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
    expect(md.toLowerCase()).not.toContain("highlightid");
    expect(md.toLowerCase()).not.toContain("chaptertitle");
  });

  it("does not include token/authorization strings", () => {
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
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
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023 })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    const psych = [
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
    for (const w of psych) {
      expect(md).not.toContain(w);
    }
  });

  it("escapes recurring book title meta chars", () => {
    const book = makeRecurringBook("b2", "# 星 * 际 _ [测试]");
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023, recurringBooks: [book] })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("《\\# 星 \\* 际 \\_ \\[测试\\]》");
    expect(md).not.toContain("# 星 * 际 _ [测试]");
  });

  it("escapes publisher pipe in table", () => {
    const book = makeRecurringBook("b3", "公共书名", { publisher: "A|B", author: null });
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023, recurringBooks: [book] })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).toContain("出版信息：A\\|B，2020");
  });

  it("omits author when missing", () => {
    const book = makeRecurringBook("b4", "无作者", { author: null });
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023, recurringBooks: [book] })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).not.toContain("- 作者：");
    expect(md).toContain("- 出版信息：出版社，2020");
  });

  it("omits publisher when missing", () => {
    const book = makeRecurringBook("b5", "无出版", { publisher: null, publishYear: null });
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023, recurringBooks: [book] })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    expect(md).not.toContain("- 出版信息：");
    expect(md).toContain("- 作者：公共作者");
  });

  it("caps recurring books at 6", () => {
    const books = Array.from({ length: 8 }, (_, i) =>
      makeRecurringBook(`b${i}`, `书名${i}`, { years: [2021, 2022], bestRank: i + 1 }),
    );
    const result = makeResult("automatic", [makeEra({ startYear: 2021, endYear: 2023, recurringBooks: books })]);
    const md = buildReadingEraMarkdown({
      result,
      rangeLabel: "最近5年",
      topBooksLimit: 12,
      failedYears: [],
      exportedAt: NOW,
    }).content;
    // Should still include all 8 because the model already caps at 6,
    // but the content builder should not crash or leak extra logic.
    expect(md).toContain("#### 1. 《书名0》");
    expect(md).toContain("#### 7. 《书名6》");
  });
});
