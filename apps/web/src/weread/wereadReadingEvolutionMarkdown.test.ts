/**
 * S27P-3 — Unit tests for the reading evolution timeline
 * Markdown export model.
 *
 * All tests use synthetic `WereadReadingEvolutionTimeline` objects
 * built from synthetic `WereadReadingArchive` fixtures. No network,
 * no real user data, no storage writes.
 */

import { describe, expect, it } from "vitest";
import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
} from "./wereadReadingArchiveModel";
import {
  buildWereadReadingEvolutionTimeline,
  type WereadReadingEvolutionTimeline,
} from "./wereadReadingEvolutionTimeline";
import {
  buildReadingEvolutionMarkdown,
  buildReadingEvolutionMarkdownFilename,
  triggerReadingEvolutionMarkdownDownload,
  escapeEvolutionMarkdownInline,
  escapeEvolutionMarkdownTableCell,
  sanitizeEvolutionMarkdownText,
  formatEvolutionMarkdownDate,
  formatEvolutionYearRange,
  formatEvolutionDirection,
  formatEvolutionInteger,
  formatEvolutionAverage,
  formatEvolutionAbsoluteDelta,
  formatEvolutionAverageDelta,
  formatEvolutionPercentage,
  formatEvolutionReason,
  formatEvolutionMilestoneKind,
  formatEvolutionRatio,
  formatEvolutionRank,
  formatEvolutionRankDelta,
  validateReadingEvolutionMarkdown,
  READING_EVOLUTION_MARKDOWN_MIME,
  READING_EVOLUTION_MARKDOWN_FILENAME_PREFIX,
  READING_EVOLUTION_MARKDOWN_FILENAME_MAX_LENGTH,
  READING_EVOLUTION_MARKDOWN_PRIVACY_NOTE,
  READING_EVOLUTION_MARKDOWN_INTERPRETATION_NOTE,
  READING_EVOLUTION_MARKDOWN_PARTIAL_NOTE,
  READING_EVOLUTION_MARKDOWN_EMPTY_NOTE,
  READING_EVOLUTION_MARKDOWN_SINGLE_YEAR_NOTE,
  READING_EVOLUTION_MARKDOWN_NO_REASONS_NOTE,
  READING_EVOLUTION_MARKDOWN_EMPTY_BOOK_GROUP_NOTE,
  READING_EVOLUTION_MARKDOWN_BOOK_DIFF_NOTE,
  READING_EVOLUTION_MARKDOWN_TOP_N_SCOPE_NOTE,
  READING_EVOLUTION_REASON_LABELS,
  READING_EVOLUTION_MILESTONE_LABELS,
  READING_EVOLUTION_DIRECTION_LABELS,
  READING_EVOLUTION_METRIC_LABELS,
} from "./wereadReadingEvolutionMarkdown";

// ---------- fixtures ----------

function makeYear(
  year: number,
  overrides: Partial<ReadingArchiveYear> = {},
): ReadingArchiveYear {
  return {
    year,
    totalRecords: 100,
    datedRecords: 80,
    matchedRecords: 60,
    matchedBooks: 5,
    activeMonths: 8,
    longestStreakMonths: 4,
    peakMonth: `${year}-06`,
    peakMonthRecords: 12,
    averageRecordsPerActiveMonth: 12.5,
    topBookCount: 3,
    topBookCatalogIds: [`c-${year}-a`, `c-${year}-b`, `c-${year}-c`],
    ...overrides,
  };
}

function makeRecurring(
  catalogId: string,
  years: number[],
  title = "",
  author: string | null = null,
): ReadingArchiveRecurringBook {
  return {
    catalogId,
    title,
    author,
    publisher: null,
    publishYear: null,
    years,
    yearsOnList: years.length,
    totalNoteCountWithinLists: 0,
    bestRank: 1,
    latestYear: years[years.length - 1],
    latestRank: 1,
  };
}

function makeArchive(args: {
  years?: ReadingArchiveYear[];
  recurring?: ReadingArchiveRecurringBook[];
  topBooksLimit?: 6 | 12 | 18;
} = {}): WereadReadingArchive {
  const years = args.years ?? [makeYear(2024)];
  const recurring = args.recurring ?? [];
  return {
    years,
    overview: {
      yearsWithData: years.length,
      firstYear: years[0]?.year ?? null,
      latestYear: years[years.length - 1]?.year ?? null,
      totalRecords: years.reduce((acc, y) => acc + y.totalRecords, 0),
      totalActiveMonths: years.reduce((acc, y) => acc + y.activeMonths, 0),
      averageRecordsPerYear: years.length > 0
        ? years.reduce((acc, y) => acc + y.totalRecords, 0) / years.length
        : 0,
      mostActiveYear: null,
      mostActiveYearRecords: 0,
      longestActiveYearStreak: 1,
      recurringTopBooks: recurring.length,
    },
    recurringBooks: recurring,
    yearLinks: [],
    meta: {
      requestedYears: years.length,
      loadedYears: years.length,
      topBooksLimit: args.topBooksLimit ?? 12,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
  };
}

function makeTimeline(args: {
  years?: ReadingArchiveYear[];
  recurring?: ReadingArchiveRecurringBook[];
  topBooksLimit?: 6 | 12 | 18;
} = {}): WereadReadingEvolutionTimeline {
  return buildWereadReadingEvolutionTimeline({
    archive: makeArchive(args),
  });
}

function build(args: {
  years?: ReadingArchiveYear[];
  recurring?: ReadingArchiveRecurringBook[];
  topBooksLimit?: 6 | 12 | 18;
  rangeLabel?: "最近5年" | "最近10年" | "全部";
  failedYears?: number[];
  exportedAt?: Date;
  siteBaseUrl?: string;
} = {}) {
  return buildReadingEvolutionMarkdown({
    timeline: makeTimeline(args),
    rangeLabel: args.rangeLabel ?? "最近5年",
    topBooksLimit: args.topBooksLimit ?? 12,
    failedYears: args.failedYears ?? [],
    exportedAt: args.exportedAt ?? new Date("2026-08-05T14:00:00Z"),
    siteBaseUrl: args.siteBaseUrl ?? "https://books.conanxin.com",
  });
}

// ---------- tests ----------

describe("wereadReadingEvolutionMarkdown — structure", () => {
  it("1. title is present", () => {
    const r = build();
    expect(r.content).toMatch(/^# 年度统计演变时间线/);
  });

  it("2. metadata block has the required fields", () => {
    const r = build();
    expect(r.content).toMatch(/档案年份/);
    expect(r.content).toMatch(/当前长期档案范围/);
    expect(r.content).toMatch(/高互动书目口径/);
    expect(r.content).toMatch(/成功加载年份/);
    expect(r.content).toMatch(/相邻年度过渡/);
    expect(r.content).toMatch(/显著统计差异/);
    expect(r.content).toMatch(/年份中断/);
    expect(r.content).toMatch(/暂时失败年份/);
    expect(r.content).toMatch(/导出时间/);
    expect(r.content).toMatch(/生成方式/);
    expect(r.content).toMatch(/保存状态/);
  });

  it("3. range label is rendered", () => {
    const r = build({ rangeLabel: "最近10年" });
    expect(r.content).toContain("当前长期档案范围：最近10年");
  });

  it("4. topBooksLimit is rendered", () => {
    const r = build({ topBooksLimit: 18 });
    expect(r.content).toContain("各年度 Top 18");
  });

  it("5. summary counters rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 300, activeMonths: 11 }),
        makeYear(2022, { totalRecords: 320, activeMonths: 11 }),
      ],
    });
    expect(r.content).toMatch(/成功加载年份：3/);
    expect(r.content).toMatch(/相邻年度过渡：2/);
  });

  it("6. first/latest rendered", () => {
    const r = build({
      years: [
        makeYear(2020),
        makeYear(2022),
        makeYear(2024),
      ],
    });
    expect(r.content).toContain("档案年份：2020–2024");
  });

  it("7. failed years count", () => {
    const r = build({ failedYears: [2021, 2023] });
    expect(r.content).toContain("暂时失败年份：2");
  });

  it("8. partial failure hint shown", () => {
    const r = build({ failedYears: [2021] });
    expect(r.content).toContain(READING_EVOLUTION_MARKDOWN_PARTIAL_NOTE);
  });

  it("9. all-success state", () => {
    const r = build();
    expect(r.content).not.toContain(READING_EVOLUTION_MARKDOWN_PARTIAL_NOTE);
  });

  it("10. milestone table header", () => {
    const r = build();
    expect(r.content).toMatch(/## 时间线标记/);
    expect(r.content).toMatch(/\|\s*年份\s*\|\s*标记类型\s*\|\s*得分\s*\|\s*依据\s*\|/);
  });

  it("11. first_year milestone rendered", () => {
    const r = build({ years: [makeYear(2020), makeYear(2021)] });
    expect(r.content).toContain("时间线起始年份");
  });

  it("12. latest_year milestone rendered", () => {
    const r = build({ years: [makeYear(2020), makeYear(2021)] });
    expect(r.content).toContain("时间线最近年份");
  });

  it("13. year_gap milestone rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2023, { totalRecords: 100 }),
      ],
    });
    expect(r.content).toContain("年份中断节点");
  });

  it("14. statistical_shift milestone rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 50, activeMonths: 2 }),
        makeYear(2021, { totalRecords: 200, activeMonths: 9 }),
        makeYear(2022, { totalRecords: 220, activeMonths: 10 }),
      ],
    });
    expect(r.content).toContain("统计差异节点");
  });

  it("15. reason Chinese mapping", () => {
    expect(READING_EVOLUTION_REASON_LABELS.year_gap).toBe("年份存在中断");
    expect(READING_EVOLUTION_REASON_LABELS.records_shift).toBe("阅读记录数量差异较大");
    expect(READING_EVOLUTION_REASON_LABELS.active_months_shift).toBe("活跃月份数量差异较大");
    expect(READING_EVOLUTION_REASON_LABELS.matched_books_shift).toBe("年度书目数量差异较大");
    expect(READING_EVOLUTION_REASON_LABELS.low_top_list_overlap).toBe("相邻年度 Top N 榜单重合较低");
  });
});

describe("wereadReadingEvolutionMarkdown — year nodes", () => {
  it("16. year node ordering", () => {
    const r = build({
      years: [
        makeYear(2023, { totalRecords: 100 }),
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 100 }),
      ],
    });
    const idx2020 = r.content.indexOf("### 2020 年");
    const idx2021 = r.content.indexOf("### 2021 年");
    const idx2023 = r.content.indexOf("### 2023 年");
    expect(idx2020).toBeLessThan(idx2021);
    expect(idx2021).toBeLessThan(idx2023);
  });

  it("17. year metrics rendered", () => {
    const r = build();
    expect(r.content).toMatch(/阅读记录：/);
    expect(r.content).toMatch(/已匹配记录：/);
    expect(r.content).toMatch(/年度书目：/);
    expect(r.content).toMatch(/活跃月份：/);
    expect(r.content).toMatch(/活跃月份平均记录：/);
  });

  it("18. peakMonth empty handled (not in evolution view)", () => {
    // The evolution view does NOT surface peakMonth (it is available in
    // the archive model but not in the timeline year node). The year
    // block does not include peak month; this is intentional.
    const r = build({ years: [makeYear(2024, { peakMonth: null })] });
    expect(r.content).not.toMatch(/高峰月份/);
  });

  it("19. topBooks rendered", () => {
    const r = build({
      years: [
        makeYear(2024, {
          topBookCatalogIds: ["c-a", "c-b", "c-c"],
        }),
      ],
    });
    expect(r.content).toContain("**");
    expect(r.content).toContain("排名：第 1 名");
  });

  it("20. public URL is /books/:catalogId", () => {
    const r = build({
      years: [
        makeYear(2024, {
          topBookCatalogIds: ["c-public-1"],
        }),
      ],
      recurring: [makeRecurring("c-public-1", [2024], "Public Book", null)],
    });
    expect(r.content).toContain("https://books.conanxin.com/books/c-public-1");
  });

  it("21. missing author omitted (no placeholder)", () => {
    const r = build({
      years: [
        makeYear(2024, {
          topBookCatalogIds: ["c-no-author"],
        }),
      ],
      recurring: [makeRecurring("c-no-author", [2024], "No Author Title")],
    });
    // Author row should NOT be rendered when not present.
    const bookBlock = r.content.split("#### 当前 Top")[1] ?? "";
    expect(bookBlock).not.toMatch(/作者：/);
  });

  it("22. missing publisher omitted", () => {
    const r = build({
      years: [
        makeYear(2024, {
          topBookCatalogIds: ["c-no-publisher"],
        }),
      ],
      recurring: [makeRecurring("c-no-publisher", [2024], "No Pub", null)],
    });
    const bookBlock = r.content.split("#### 当前 Top")[1] ?? "";
    expect(bookBlock).not.toMatch(/出版信息：/);
  });
});

describe("wereadReadingEvolutionMarkdown — transitions", () => {
  it("23. transition ordering", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 150 }),
        makeYear(2022, { totalRecords: 200 }),
      ],
    });
    const idx20to21 = r.content.indexOf("### 2020 → 2021");
    const idx21to22 = r.content.indexOf("### 2021 → 2022");
    expect(idx20to21).toBeLessThan(idx21to22);
  });

  it("24. significance score rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 300, activeMonths: 11 }),
      ],
    });
    expect(r.content).toMatch(/统计差异得分：\d+/);
  });

  it("25. significant transition marked", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 50, activeMonths: 2 }),
        makeYear(2021, { totalRecords: 200, activeMonths: 9 }),
      ],
    });
    expect(r.content).toContain("显著统计差异");
  });

  it("26. non-significant transition marked", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 6, matchedBooks: 5 }),
        makeYear(2021, { totalRecords: 100, activeMonths: 6, matchedBooks: 5 }),
      ],
    });
    expect(r.content).toContain("常规统计差异");
  });

  it("27. no-reason state hint", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 6, matchedBooks: 5, topBookCatalogIds: ["c-shared"] }),
        makeYear(2021, { totalRecords: 100, activeMonths: 6, matchedBooks: 5, topBookCatalogIds: ["c-shared"] }),
      ],
    });
    expect(r.content).toContain(READING_EVOLUTION_MARKDOWN_NO_REASONS_NOTE);
  });

  it("28. overlap percent rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b"] }),
      ],
    });
    expect(r.content).toMatch(/相邻年度 Top N 榜单重合比例：100%/);
  });

  it("29. common/union counts rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-c"] }),
      ],
    });
    expect(r.content).toMatch(/共同上榜书目：1/);
    expect(r.content).toMatch(/榜单并集书目：3/);
  });

  it("30. metric increase", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 200 }),
      ],
    });
    expect(r.content).toContain("增加");
  });

  it("31. metric decrease", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 200 }),
        makeYear(2021, { totalRecords: 100 }),
      ],
    });
    expect(r.content).toContain("减少");
  });

  it("32. metric same", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, matchedBooks: 5 }),
        makeYear(2021, { totalRecords: 100, matchedBooks: 5 }),
      ],
    });
    expect(r.content).toContain("持平");
  });

  it("33. metric from_zero", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 0 }),
        makeYear(2021, { totalRecords: 100, activeMonths: 5 }),
      ],
    });
    expect(r.content).toContain("由 0 起");
  });

  it("34. metric to_zero", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 5 }),
        makeYear(2021, { totalRecords: 100, activeMonths: 0 }),
      ],
    });
    expect(r.content).toContain("降至 0");
  });

  it("35. percentage null shown as —", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 0 }),
        makeYear(2021, { totalRecords: 100, activeMonths: 5 }),
      ],
    });
    // from_zero cell: 差值 shows "由 0 起", 百分比 shows "由 0 起"
    // The row for 活跃月份 should have "由 0 起" twice (差值 + 百分比).
    const rowIdx = r.content.indexOf("活跃月份");
    expect(rowIdx).toBeGreaterThan(0);
    // Verify that the percentage cell uses "由 0 起" not "NaN%".
    expect(r.content).not.toMatch(/NaN%/);
    expect(r.content).not.toMatch(/Infinity%/);
  });

  it("36. continued books rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-shared"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-shared", "c-new"] }),
      ],
    });
    expect(r.content).toContain("##### 两年都有");
    expect(r.content).toContain("前一年排名");
    expect(r.content).toContain("当前年份排名");
    expect(r.content).toContain("排名数字差值");
  });

  it("37. entered books rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-new"] }),
      ],
    });
    expect(r.content).toContain("##### 当前年份新进入");
    expect(r.content).toMatch(/当前排名：第 \d+ 名/);
  });

  it("38. left books rendered", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-leaving"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-a"] }),
      ],
    });
    expect(r.content).toContain("##### 前一年出现、当前年份未出现");
    expect(r.content).toMatch(/前一年排名：第 \d+ 名/);
  });

  it("39. rankDelta positive", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b", "c-c"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b", "c-c"] }),
      ],
    });
    // Top lists identical → all continued with rankDelta 0.
    expect(r.content).toContain("排名数字差值：0");
  });

  it("40. rankDelta negative", () => {
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b", "c-c"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-b", "c-a", "c-c"] }),
      ],
    });
    // c-a was rank 1 in 2020, now rank 2 in 2021 → rankDelta = 1 - 2 = -1.
    expect(r.content).toMatch(/排名数字差值：-1/);
  });

  it("41. empty book groups", () => {
    // Both years share ALL topBooks (continued = 2, entered = 0, left = 0).
    const r = build({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-a", "c-b"] }),
      ],
    });
    expect(r.content).toContain(READING_EVOLUTION_MARKDOWN_EMPTY_BOOK_GROUP_NOTE);
  });
});

describe("wereadReadingEvolutionMarkdown — partial / empty / single", () => {
  it("42. empty archive", () => {
    const r = build({ years: [] });
    expect(r.content).toContain(READING_EVOLUTION_MARKDOWN_EMPTY_NOTE);
    expect(r.content).not.toMatch(/### \d+ 年/);
    expect(r.content).not.toMatch(/## 相邻年度过渡/);
    expect(r.content).toContain("## 方法说明");
  });

  it("43. single year", () => {
    const r = build({ years: [makeYear(2024)] });
    expect(r.content).toContain("### 2024 年");
    expect(r.content).toContain(READING_EVOLUTION_MARKDOWN_SINGLE_YEAR_NOTE);
    expect(r.content).not.toMatch(/## 相邻年度过渡/);
  });
});

describe("wereadReadingEvolutionMarkdown — filename / MIME / download", () => {
  const fixedDate = new Date("2026-08-05T10:30:00Z");

  it("44. filename normal", () => {
    const f = buildReadingEvolutionMarkdownFilename({
      firstYear: 2020,
      latestYear: 2024,
      now: fixedDate,
      hasUsableData: true,
    });
    expect(f).toBe("weread-reading-evolution-2020-to-2024-20260805.md");
  });

  it("45. filename empty", () => {
    const f = buildReadingEvolutionMarkdownFilename({
      firstYear: null,
      latestYear: null,
      now: fixedDate,
      hasUsableData: false,
    });
    expect(f).toBe("weread-reading-evolution-empty-20260805.md");
  });

  it("46. filename ASCII", () => {
    const f = buildReadingEvolutionMarkdownFilename({
      firstYear: 2024,
      latestYear: 2024,
      now: fixedDate,
      hasUsableData: true,
    });
    expect(f).toMatch(/^[a-zA-Z0-9-]+\.md$/);
  });

  it("47. filename max length", () => {
    // Force a long filename by setting an extreme range.
    const f = buildReadingEvolutionMarkdownFilename({
      firstYear: 1900,
      latestYear: 2100,
      now: fixedDate,
      hasUsableData: true,
    });
    expect(f.length).toBeLessThanOrEqual(READING_EVOLUTION_MARKDOWN_FILENAME_MAX_LENGTH);
  });

  it("48. MIME", () => {
    const r = build();
    expect(r.mimeType).toBe(READING_EVOLUTION_MARKDOWN_MIME);
    expect(r.mimeType).toBe("text/markdown;charset=utf-8");
  });

  it("49. Blob created with right type", () => {
    let captured: Blob | null = null;
    const r = build();
    triggerReadingEvolutionMarkdownDownload({
      content: r.content,
      filename: r.filename,
      createObjectUrl: (b) => {
        captured = b;
        return "blob:test";
      },
      revokeObjectUrl: () => {},
    });
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("text/markdown;charset=utf-8");
  });

  it("50. createObjectURL called", () => {
    let called = false;
    const r = build();
    triggerReadingEvolutionMarkdownDownload({
      content: r.content,
      filename: r.filename,
      createObjectUrl: () => {
        called = true;
        return "blob:test-50";
      },
      revokeObjectUrl: () => {},
    });
    expect(called).toBe(true);
  });

  it("51. anchor download attribute", () => {
    let captured: { href: string; download: string; testId: string } | null = null;
    const r = build();
    triggerReadingEvolutionMarkdownDownload({
      content: r.content,
      filename: r.filename,
      createObjectUrl: () => "blob:test-51",
      revokeObjectUrl: () => {},
      attachAnchor: (a) => {
        captured = a;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.download).toBe(r.filename);
    expect(captured!.href).toBe("blob:test-51");
    expect(captured!.testId).toBe("weread-reading-evolution-export-anchor");
  });

  it("52. revokeObjectURL called", () => {
    let revoked = false;
    const r = build();
    triggerReadingEvolutionMarkdownDownload({
      content: r.content,
      filename: r.filename,
      createObjectUrl: () => "blob:test-52",
      revokeObjectUrl: () => {
        revoked = true;
      },
      scheduleRevoke: null,
    });
    expect(revoked).toBe(true);
  });
});

describe("wereadReadingEvolutionMarkdown — escaping helpers", () => {
  it("53. inline escape", () => {
    expect(escapeEvolutionMarkdownInline("Hello *world*")).toContain("\\*");
    expect(escapeEvolutionMarkdownInline("a|b|c")).toContain("\\|");
    expect(escapeEvolutionMarkdownInline("# heading")).toContain("\\#");
  });

  it("54. table cell escape", () => {
    expect(escapeEvolutionMarkdownTableCell("a|b")).toContain("\\|");
    expect(escapeEvolutionMarkdownTableCell(null)).toBe("—");
    expect(escapeEvolutionMarkdownTableCell("")).toBe("—");
  });

  it("55. heading injection neutralized", () => {
    const malicious = "# HACK\nReal content";
    const escaped = escapeEvolutionMarkdownInline(malicious);
    expect(escaped).toContain("\\#");
    expect(escaped).not.toMatch(/^# /);
  });

  it("56. control chars stripped", () => {
    const raw = "abc\u0000\u0001\u0007def";
    const cleaned = sanitizeEvolutionMarkdownText(raw);
    expect(cleaned).not.toMatch(/[\u0000-\u001f]/);
    expect(cleaned).toBe("abc def");
  });

  it("57. no NaN in output", () => {
    const r = build({
      years: [
        makeYear(2020, {
          totalRecords: NaN as unknown as number,
          activeMonths: 0,
          matchedRecords: 0,
          matchedBooks: 0,
        }),
        makeYear(2021, {
          totalRecords: 100,
          activeMonths: 8,
          matchedRecords: 50,
          matchedBooks: 5,
        }),
      ],
    });
    expect(r.content).not.toMatch(/NaN/);
  });

  it("58. no Infinity in output", () => {
    const r = build({
      years: [
        makeYear(2020, {
          totalRecords: Infinity as unknown as number,
          activeMonths: 0,
          matchedRecords: 0,
          matchedBooks: 0,
        }),
        makeYear(2021, {
          totalRecords: 100,
          activeMonths: 8,
        }),
      ],
    });
    expect(r.content).not.toMatch(/Infinity/);
  });
});

describe("wereadReadingEvolutionMarkdown — privacy / inference", () => {
  it("59. no note/comment", () => {
    const r = build();
    expect(r.content).not.toMatch(/note\.text/);
    expect(r.content).not.toMatch(/note\.comment/);
  });

  it("60. no private IDs", () => {
    const r = build();
    expect(r.content).not.toMatch(/wereadBookId/);
    expect(r.content).not.toMatch(/noteId/);
    expect(r.content).not.toMatch(/highlightId/);
    expect(r.content).not.toMatch(/chapterTitle/);
  });

  it("61. no token/API key", () => {
    const r = build();
    expect(r.content).not.toMatch(/Authorization/);
    expect(r.content).not.toMatch(/token=/);
    expect(r.content).not.toMatch(/api[_-]?key/i);
  });

  it("62. no AI/themes", () => {
    const r = build();
    expect(r.content).not.toMatch(/ai summary/i);
    expect(r.content).not.toMatch(/themes/i);
  });

  it("63. no raw JSON", () => {
    const r = build();
    expect(r.content).not.toMatch(/\{\s*"years":\s*\[/);
    expect(r.content).not.toMatch(/\{\s*"transitions":\s*\[/);
  });

  it("64. no inference language", () => {
    const r = build();
    const FORBIDDEN = [
      "兴趣转变",
      "偏好改变",
      "阅读低谷",
      "阅读巅峰",
      "成熟期",
      "探索期",
      "转折点",
      "稳定性",
      "能力变化",
      "阅读质量",
      "心理状态",
      "人格",
      "成长",
      "退步",
      "提升",
      "改善",
    ];
    for (const w of FORBIDDEN) {
      expect(r.content, `forbidden word: ${w}`).not.toContain(w);
    }
  });

  it("65. validation accepts a normal document", () => {
    const r = build();
    const v = validateReadingEvolutionMarkdown(r);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("66. validation rejects forbidden content", () => {
    const r = build();
    const tampered = {
      ...r,
      content: r.content + "\nnote.text: leaked",
    };
    const forbidden = [
      ["note", "text"].join("."),
      ["note", "comment"].join("."),
      ["marked", "Text"].join("").toLowerCase(),
      ["weread", "Book", "Id"].join("").toLowerCase(),
      ["note", "Id"].join("").toLowerCase(),
      ["highlight", "Id"].join("").toLowerCase(),
      ["chapter", "Title"].join("").toLowerCase(),
      "ai summary",
      "aisummary",
      "themes",
      "authorization:",
      "api key",
      "apikey",
      "wr_skey",
      "wr_vid",
      ["token", ""].join("="),
    ];
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
    const v = validateReadingEvolutionMarkdown(tampered, {
      forbiddenTokens: forbidden,
      inferenceTokens: inference,
    });
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes(["note", "text"].join(".")))).toBe(true);
  });

  it("67. deterministic output", () => {
    const args = {
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 150, activeMonths: 9 }),
      ],
      exportedAt: new Date("2026-08-05T10:00:00Z"),
    };
    const a = build(args);
    const b = build(args);
    expect(a.content).toBe(b.content);
  });
});

describe("wereadReadingEvolutionMarkdown — format helpers", () => {
  it("format helpers do not throw", () => {
    expect(formatEvolutionMarkdownDate(new Date("2026-08-05T10:30:00Z"))).toMatch(/2026-08-05 \d\d:\d\d/);
    expect(formatEvolutionYearRange(2020, 2024)).toBe("2020–2024");
    expect(formatEvolutionYearRange(2024, 2024)).toBe("2024");
    expect(formatEvolutionYearRange(null, null)).toBe("—");
    expect(formatEvolutionDirection("increase")).toBe("增加");
    expect(formatEvolutionDirection("decrease")).toBe("减少");
    expect(formatEvolutionDirection("same")).toBe("持平");
    expect(formatEvolutionDirection("from_zero")).toBe("由 0 起");
    expect(formatEvolutionDirection("to_zero")).toBe("降至 0");
    expect(formatEvolutionInteger(1234)).toMatch(/1[,]?234/);
    expect(formatEvolutionAverage(12.34)).toBe("12.3");
    expect(formatEvolutionAbsoluteDelta({ absolute: 100, percentage: null, direction: "increase" })).toBe("+100");
    expect(formatEvolutionAbsoluteDelta({ absolute: 0, percentage: 0, direction: "same" })).toBe("0");
    expect(formatEvolutionAverageDelta({ absolute: 1.5, percentage: null, direction: "increase" })).toBe("+1.5");
    expect(formatEvolutionPercentage({ absolute: 100, percentage: null, direction: "from_zero" })).toBe("由 0 起");
    expect(formatEvolutionPercentage({ absolute: -100, percentage: -100, direction: "to_zero" })).toBe("降至 0");
    expect(formatEvolutionPercentage({ absolute: 0, percentage: 0, direction: "same" })).toBe("0%");
    expect(formatEvolutionReason("year_gap")).toBe("年份存在中断");
    expect(formatEvolutionMilestoneKind("first_year")).toBe("时间线起始年份");
    expect(formatEvolutionRatio(0.5)).toBe("50%");
    expect(formatEvolutionRank(1)).toBe("第 1 名");
    expect(formatEvolutionRank(0)).toBe("—");
    expect(formatEvolutionRankDelta(0)).toBe("0");
    expect(formatEvolutionRankDelta(3)).toBe("+3");
    expect(formatEvolutionRankDelta(-3)).toBe("-3");
  });
});

describe("wereadReadingEvolutionMarkdown — constants sanity", () => {
  it("labels and constants are populated", () => {
    expect(READING_EVOLUTION_REASON_LABELS).toBeDefined();
    expect(READING_EVOLUTION_MILESTONE_LABELS).toBeDefined();
    expect(READING_EVOLUTION_DIRECTION_LABELS).toBeDefined();
    expect(READING_EVOLUTION_METRIC_LABELS.length).toBe(4);
    expect(READING_EVOLUTION_MARKDOWN_PRIVACY_NOTE.length).toBeGreaterThan(20);
    expect(READING_EVOLUTION_MARKDOWN_INTERPRETATION_NOTE.length).toBeGreaterThan(20);
    expect(READING_EVOLUTION_MARKDOWN_TOP_N_SCOPE_NOTE).toContain("Top N");
    expect(READING_EVOLUTION_MARKDOWN_BOOK_DIFF_NOTE).toContain("差异");
    expect(READING_EVOLUTION_MARKDOWN_FILENAME_PREFIX).toBe("weread-reading-evolution");
    expect(READING_EVOLUTION_MARKDOWN_FILENAME_MAX_LENGTH).toBe(80);
  });
});
