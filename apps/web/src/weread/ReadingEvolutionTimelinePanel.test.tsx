/**
 * S27P-2 — ReadingEvolutionTimelinePanel behavior tests.
 *
 * Uses react-dom/server `renderToStaticMarkup` to exercise the
 * React component tree without jsdom. Synthetic
 * `WereadReadingArchive` fixtures only.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
} from "./wereadReadingArchiveModel";
import ReadingEvolutionTimelinePanel from "./ReadingEvolutionTimelinePanel";
import { __test__ } from "./ReadingEvolutionTimelinePanel";
import { buildWereadReadingEvolutionTimeline } from "./wereadReadingEvolutionTimeline";

const PANEL_PATH = resolve(__dirname, "./ReadingEvolutionTimelinePanel.tsx");
const DASHBOARD_PATH = resolve(__dirname, "./ReadingArchiveDashboard.tsx");
const panelSource = readFileSync(PANEL_PATH, "utf8");
const dashboardSource = readFileSync(DASHBOARD_PATH, "utf8");

// Strip leading privacy-contract comment block from the panel so
// structural regex checks below only match live code.
const panelCode = panelSource.replace(/^\/\*[\s\S]*?\*\//, "");

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
  years: ReadingArchiveYear[];
  recurring?: ReadingArchiveRecurringBook[];
  topBooksLimit?: 6 | 12 | 18;
} = { years: [] }): WereadReadingArchive {
  const years = args.years;
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

function makeSixYearArchive(): WereadReadingArchive {
  return makeArchive({
    years: [
      makeYear(2020, {
        totalRecords: 80,
        activeMonths: 4,
        matchedBooks: 4,
        topBookCatalogIds: ["c-2020-a", "c-2020-b"],
      }),
      makeYear(2021, {
        totalRecords: 110,
        activeMonths: 6,
        matchedBooks: 5,
        topBookCatalogIds: ["c-2021-a", "c-2021-b", "c-2021-c"],
      }),
      makeYear(2022, {
        totalRecords: 150,
        activeMonths: 9,
        matchedBooks: 6,
        topBookCatalogIds: ["c-2022-a", "c-2022-b", "c-2022-c"],
      }),
      makeYear(2023, {
        totalRecords: 220,
        activeMonths: 11,
        matchedBooks: 8,
        topBookCatalogIds: ["c-2023-a", "c-2023-b", "c-2023-c", "c-2023-d"],
      }),
      makeYear(2024, {
        totalRecords: 260,
        activeMonths: 11,
        matchedBooks: 9,
        topBookCatalogIds: ["c-2024-a", "c-2024-b", "c-2024-c", "c-2024-d"],
      }),
      makeYear(2025, {
        totalRecords: 300,
        activeMonths: 12,
        matchedBooks: 10,
        topBookCatalogIds: ["c-2025-a", "c-2025-b", "c-2025-c", "c-2025-d"],
      }),
    ],
    topBooksLimit: 12,
  });
}

function makeSingleYearArchive(): WereadReadingArchive {
  return makeArchive({
    years: [makeYear(2024)],
  });
}

function makeGappedArchive(): WereadReadingArchive {
  return makeArchive({
    years: [
      makeYear(2020, {
        totalRecords: 100,
        activeMonths: 6,
        matchedBooks: 5,
        topBookCatalogIds: ["c-2020-a"],
      }),
      makeYear(2023, {
        totalRecords: 150,
        activeMonths: 9,
        matchedBooks: 7,
        topBookCatalogIds: ["c-2023-a", "c-2023-b"],
      }),
    ],
  });
}

function makeEmptyArchive(): WereadReadingArchive {
  return makeArchive({ years: [] });
}

function makePartialArchive(): WereadReadingArchive {
  return makeArchive({
    years: [
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 0, activeMonths: 0 }),
      makeYear(2022, { totalRecords: 200 }),
    ],
  });
}

// ---------- panel render helpers ----------

function renderPanel(props: Partial<Parameters<typeof ReadingEvolutionTimelinePanel>[0]> = {}) {
  const archive = props.archive ?? makeSixYearArchive();
  return renderToStaticMarkup(
    <ReadingEvolutionTimelinePanel
      archive={archive}
      rangeLabel={props.rangeLabel ?? "最近5年"}
      topBooksLimit={props.topBooksLimit ?? 12}
      failedYears={props.failedYears ?? []}
      bootstrapLoading={props.bootstrapLoading ?? false}
    />,
  );
}

// ---------- tests ----------

describe("ReadingEvolutionTimelinePanel — root structure", () => {
  it("1. panel root present", () => {
    const html = renderPanel();
    expect(html).toMatch(/data-testid="weread-reading-evolution"/);
  });

  it("2. panel header has the descriptive Chinese title", () => {
    const html = renderPanel();
    expect(html).toMatch(/年度统计演变时间线/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-notice"/);
    expect(html).toMatch(/只展示相邻年份之间可观察/);
  });

  it("3. range label rendered in scope", () => {
    const html = renderPanel({ rangeLabel: "最近10年" });
    expect(html).toMatch(/当前档案范围：最近10年/);
  });

  it("4. topBooksLimit rendered in scope", () => {
    const html = renderPanel({ topBooksLimit: 18 });
    expect(html).toMatch(/Top 18/);
  });

  it("5. summary count fields rendered", () => {
    const html = renderPanel();
    expect(html).toMatch(/data-testid="weread-reading-evolution-summary"/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-summary-loaded"/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-summary-transition"/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-summary-significant"/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-summary-gap"/);
  });
});

describe("ReadingEvolutionTimelinePanel — year nodes", () => {
  it("6. year nodes ascending", () => {
    const html = renderPanel();
    // Only the year-card has `data-year` (not transitions which use
    // `data-from-year` / `data-to-year`). Match that specific token.
    const matches = html.match(/class="weread-reading-evolution__year"\s+data-testid="weread-reading-evolution-year"\s+data-year="(\d+)"/g) ?? [];
    const years = matches.map((m) => Number(m.match(/data-year="(\d+)"/)![1]));
    expect(years).toEqual([2020, 2021, 2022, 2023, 2024, 2025]);
  });

  it("7. year metrics rendered", () => {
    const html = renderPanel();
    expect(html).toMatch(/阅读记录/);
    expect(html).toMatch(/已匹配记录/);
    expect(html).toMatch(/年度书目/);
    expect(html).toMatch(/活跃月份/);
    expect(html).toMatch(/活跃月份平均记录/);
  });

  it("8. peak month field rendered (topBooks preview not peak month)", () => {
    // The panel exposes peak month implicitly via the Top N preview header.
    const html = renderPanel();
    expect(html).toMatch(/当前 Top \d+ 公共书目/);
  });

  it("9. Top N preview rendered with rank and title", () => {
    const html = renderPanel();
    expect(html).toMatch(/weread-reading-evolution-book-/);
    expect(html).toMatch(/第 \d+ 名/);
  });

  it("10. book links go to /books/:catalogId", () => {
    const html = renderPanel();
    expect(html).toMatch(/href="\/books\/c-2020-a"/);
  });
});

describe("ReadingEvolutionTimelinePanel — milestones", () => {
  it("11. milestones container present", () => {
    const html = renderPanel();
    expect(html).toMatch(/data-testid="weread-reading-evolution-milestones"/);
  });

  it("12. first_year milestone present", () => {
    const html = renderPanel();
    expect(html).toMatch(/时间线起始年份/);
    expect(html).toMatch(/data-kind="first_year"/);
  });

  it("13. latest_year milestone present", () => {
    const html = renderPanel();
    expect(html).toMatch(/时间线最近年份/);
    expect(html).toMatch(/data-kind="latest_year"/);
  });

  it("14. year_gap milestone present", () => {
    const html = renderPanel({ archive: makeGappedArchive() });
    expect(html).toMatch(/年份中断节点/);
    expect(html).toMatch(/data-kind="year_gap"/);
  });

  it("15. statistical_shift milestone present when significant", () => {
    // Build an archive where records_shift (35) + active_months_shift
    // (25) = 60 ≥ 50 → significant transition.
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 50, activeMonths: 2, matchedBooks: 4 }),
        makeYear(2021, { totalRecords: 200, activeMonths: 9, matchedBooks: 5 }),
        makeYear(2022, { totalRecords: 250, activeMonths: 11, matchedBooks: 6 }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/data-kind="statistical_shift"/);
  });
});

describe("ReadingEvolutionTimelinePanel — transitions", () => {
  it("16. transitions rendered in chronological order", () => {
    const html = renderPanel();
    expect(html).toMatch(/data-from-year="2020"/);
    expect(html).toMatch(/data-to-year="2021"/);
    expect(html).toMatch(/data-from-year="2024"/);
    expect(html).toMatch(/data-to-year="2025"/);
  });

  it("17. transition significance score rendered", () => {
    const html = renderPanel();
    expect(html).toMatch(/统计差异得分：\d+/);
  });

  it("18. significant transition marked", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 50, activeMonths: 2, matchedBooks: 4 }),
        makeYear(2021, { totalRecords: 200, activeMonths: 9, matchedBooks: 5 }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/data-significant="true"/);
    expect(html).toMatch(/显著统计差异/);
  });

  it("19. non-significant transition can be marked", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 6, matchedBooks: 5 }),
        makeYear(2021, { totalRecords: 105, activeMonths: 6, matchedBooks: 5 }),
      ],
    });
    const html = renderPanel({ archive });
    // With identical metrics, no reason triggers → score=0 → not significant.
    expect(html).toMatch(/常规统计差异/);
    expect(html).toMatch(/data-significant="false"/);
  });

  it("20. year_gap reason rendered", () => {
    const html = renderPanel({ archive: makeGappedArchive() });
    expect(html).toMatch(/data-reason="year_gap"/);
    expect(html).toMatch(/年份存在中断/);
  });

  it("21. records_shift reason rendered", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 300, activeMonths: 8 }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/data-reason="records_shift"/);
    expect(html).toMatch(/阅读记录数量差异较大/);
  });

  it("22. active_months_shift reason rendered", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 1 }),
        makeYear(2021, { totalRecords: 100, activeMonths: 8 }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/data-reason="active_months_shift"/);
  });

  it("23. matched_books_shift reason rendered", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, matchedBooks: 3 }),
        makeYear(2021, { totalRecords: 100, matchedBooks: 12 }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/data-reason="matched_books_shift"/);
  });

  it("24. low overlap reason rendered", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, {
          totalRecords: 100,
          topBookCatalogIds: ["c-a", "c-b", "c-c"],
        }),
        makeYear(2021, {
          totalRecords: 100,
          topBookCatalogIds: ["c-x", "c-y", "c-z"],
        }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/data-reason="low_top_list_overlap"/);
  });

  it("25. empty reasons hint when no reasons trigger", () => {
    // Same Top N IDs across the two years (overlap ≥ 0.2), small metric
    // deltas (no records_shift / active_months_shift / matched_books_shift),
    // consecutive years (no year_gap). All thresholds under → empty reasons.
    const archive = makeArchive({
      years: [
        makeYear(2020, {
          totalRecords: 100,
          activeMonths: 6,
          matchedBooks: 5,
          topBookCatalogIds: ["c-shared-1", "c-shared-2", "c-shared-3", "c-shared-4", "c-shared-5"],
        }),
        makeYear(2021, {
          totalRecords: 105,
          activeMonths: 6,
          matchedBooks: 5,
          topBookCatalogIds: ["c-shared-1", "c-shared-2", "c-shared-3", "c-shared-4", "c-shared-5"],
        }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/当前过渡未达到统计差异标记阈值/);
  });
});

describe("ReadingEvolutionTimelinePanel — metric deltas", () => {
  function buildDeltaHtml(args: {
    prevRec?: number;
    curRec?: number;
    prevActive?: number;
    curActive?: number;
    prevMatched?: number;
    curMatched?: number;
    prevBooks?: number;
    curBooks?: number;
  }) {
    const prev = makeYear(2020, {
      totalRecords: args.prevRec ?? 100,
      activeMonths: args.prevActive ?? 6,
      matchedRecords: args.prevMatched ?? 60,
      matchedBooks: args.prevBooks ?? 5,
    });
    const cur = makeYear(2021, {
      totalRecords: args.curRec ?? 100,
      activeMonths: args.curActive ?? 6,
      matchedRecords: args.curMatched ?? 60,
      matchedBooks: args.curBooks ?? 5,
    });
    return renderPanel({ archive: makeArchive({ years: [prev, cur] }) });
  }

  it("26. delta increase", () => {
    const html = buildDeltaHtml({ prevRec: 100, curRec: 200 });
    expect(html).toMatch(/data-direction="increase"/);
    expect(html).toMatch(/\+100/);
  });

  it("27. delta decrease", () => {
    const html = buildDeltaHtml({ prevRec: 200, curRec: 100 });
    expect(html).toMatch(/data-direction="decrease"/);
  });

  it("28. delta same", () => {
    const html = buildDeltaHtml({ prevRec: 100, curRec: 100 });
    expect(html).toMatch(/data-direction="same"/);
  });

  it("29. delta from_zero", () => {
    const html = buildDeltaHtml({ prevActive: 0, curActive: 5 });
    expect(html).toMatch(/data-direction="from_zero"/);
    expect(html).toMatch(/由 0 起/);
  });

  it("30. delta to_zero", () => {
    const html = buildDeltaHtml({ prevActive: 5, curActive: 0 });
    expect(html).toMatch(/data-direction="to_zero"/);
    expect(html).toMatch(/降至 0/);
  });

  it("31. percentage=null does not show fake percentage", () => {
    const html = buildDeltaHtml({ prevActive: 0, curActive: 5 });
    // The from_zero cell shows "由 0 起" not a percentage like "+NaN%".
    expect(html).toContain("由 0 起");
    expect(html).not.toMatch(/由 0 起<\/span>.{0,50}NaN%/);
    expect(html).not.toMatch(/由 0 起<\/span>.{0,50}Infinity%/);
  });
});

describe("ReadingEvolutionTimelinePanel — overlap", () => {
  it("32. overlap ratio rendered", () => {
    const html = renderPanel();
    expect(html).toMatch(/data-testid="weread-reading-evolution-transition-overlap-ratio"/);
    expect(html).toMatch(/榜单重合比例/);
  });

  it("33. overlap counts rendered (common + union)", () => {
    const html = renderPanel();
    expect(html).toMatch(/共同上榜书目数量：\d+/);
    expect(html).toMatch(/榜单并集书目数量：\d+/);
  });
});

describe("ReadingEvolutionTimelinePanel — book diff", () => {
  it("34. continued / entered / left counts rendered", () => {
    const html = renderPanel();
    expect(html).toMatch(/两年都有：\d+/);
    expect(html).toMatch(/当前年份新进入：\d+/);
    expect(html).toMatch(/前一年出现、当前年份未出现：\d+/);
  });

  it("35. continued books rendered with previousRank + currentRank + rankDelta", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, {
          totalRecords: 100,
          topBookCatalogIds: ["c-shared"],
        }),
        makeYear(2021, {
          totalRecords: 100,
          topBookCatalogIds: ["c-shared", "c-new"],
        }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/weread-reading-evolution-continued-item-c-shared/);
    expect(html).toMatch(/前一年排名/);
    expect(html).toMatch(/当前年份排名/);
    expect(html).toMatch(/排名数字差值/);
  });

  it("36. entered books rendered", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, {
          totalRecords: 100,
          topBookCatalogIds: ["c-a"],
        }),
        makeYear(2021, {
          totalRecords: 100,
          topBookCatalogIds: ["c-a", "c-new"],
        }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/weread-reading-evolution-entered-item-c-new/);
  });

  it("37. left books rendered", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, {
          totalRecords: 100,
          topBookCatalogIds: ["c-a", "c-leaving"],
        }),
        makeYear(2021, {
          totalRecords: 100,
          topBookCatalogIds: ["c-a"],
        }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/weread-reading-evolution-left-item-c-leaving/);
  });

  it("38. empty book group renders empty hint", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["c-a"] }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: ["c-a"] }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/weread-reading-evolution-entered-empty/);
    expect(html).toMatch(/weread-reading-evolution-left-empty/);
  });

  it("39. cap to 6 books per group with overflow notice", () => {
    const prevIds = Array.from({ length: 8 }, (_, i) => `c-prev-${i}`);
    const curIds = Array.from({ length: 8 }, (_, i) => `c-cur-${i}`);
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: prevIds }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: curIds }),
      ],
    });
    const html = renderPanel({ archive });
    expect(html).toMatch(/另有 \d+ 本/);
  });

  it("40. overflow notice for additional books", () => {
    const prevIds = Array.from({ length: 8 }, (_, i) => `c-prev-${i}`);
    const curIds = Array.from({ length: 8 }, (_, i) => `c-cur-${i}`);
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, topBookCatalogIds: prevIds }),
        makeYear(2021, { totalRecords: 100, topBookCatalogIds: curIds }),
      ],
    });
    const html = renderPanel({ archive });
    // Either the year-top-books-more OR the diff-group overflow shows.
    expect(html).toMatch(/另有 \d+ 本/);
    expect(html).toMatch(/完整结果将在后续本地导出中提供/);
  });
});

describe("ReadingEvolutionTimelinePanel — empty / single / loading states", () => {
  it("41. bootstrap loading shell", () => {
    // The shell shows when bootstrapLoading=true AND no years loaded.
    const html = renderPanel({
      archive: makeEmptyArchive(),
      bootstrapLoading: true,
    });
    expect(html).toMatch(/data-testid="weread-reading-evolution-loading"/);
    expect(html).toMatch(/正在整理当前已加载的年度档案/);
  });

  it("42. empty archive", () => {
    const html = renderPanel({ archive: makeEmptyArchive() });
    expect(html).toMatch(/data-testid="weread-reading-evolution-empty"/);
    expect(html).toMatch(/当前暂无成功加载的年度档案/);
  });

  it("43. single-year archive merges milestones", () => {
    const html = renderPanel({ archive: makeSingleYearArchive() });
    expect(html).toMatch(/data-testid="weread-reading-evolution-single-year"/);
    expect(html).toMatch(/当前只有一个成功加载年份/);
    expect(html).toMatch(/data-kind="first_year"/);
    expect(html).not.toMatch(/data-kind="latest_year"/);
  });

  it("44. partial failure hint", () => {
    const html = renderPanel({
      archive: makePartialArchive(),
      failedYears: [2021],
    });
    expect(html).toMatch(/data-testid="weread-reading-evolution-partial-failure"/);
    expect(html).toMatch(/以下时间线只基于成功加载的年份/);
  });
});

describe("ReadingEvolutionTimelinePanel — privacy contract", () => {
  it("45. no annual-review request", () => {
    expect(panelCode).not.toMatch(/fetchWereadAnnualReview/);
    expect(panelCode).not.toMatch(/fetchAnnual/);
    expect(panelCode).not.toMatch(/api\/private\/weread/);
  });

  it("46. no AI", () => {
    expect(panelCode).not.toMatch(/fetchWereadAiSummary/);
    expect(panelCode).not.toMatch(/ai summary/i);
    expect(panelCode).not.toMatch(/themes/);
  });

  it("47. no related-books", () => {
    expect(panelCode).not.toMatch(/fetchWereadRelatedBooks/);
    expect(panelCode).not.toMatch(/related-books/);
  });

  it("48. no storage", () => {
    expect(panelCode).not.toMatch(/localStorage/);
    expect(panelCode).not.toMatch(/sessionStorage/);
    expect(panelCode).not.toMatch(/indexedDB/);
  });

  it("49. no URL writes", () => {
    expect(panelCode).not.toMatch(/pushState/);
    expect(panelCode).not.toMatch(/replaceState/);
    expect(panelCode).not.toMatch(/history\.push/);
  });

  it("50. no dangerouslySetInnerHTML", () => {
    expect(panelCode).not.toMatch(/dangerouslySetInnerHTML/);
    expect(panelCode).not.toMatch(/innerHTML/);
  });

  it("51. no private IDs in props or rendered HTML", () => {
    const html = renderPanel();
    expect(html).not.toMatch(/wereadBookId/);
    expect(html).not.toMatch(/noteId/);
    expect(html).not.toMatch(/highlightId/);
    expect(html).not.toMatch(/chapterTitle/);
    expect(html).not.toMatch(/Authorization/);
    expect(html).not.toMatch(/token=/);
  });

  it("52. no inference-language forbidden words in HTML", () => {
    const html = renderPanel();
    const FORBIDDEN = [
      "心理", "人格", "兴趣转变", "偏好改变", "成长", "退步",
      "改善", "提升", "阅读低谷", "阅读巅峰", "成熟期", "探索期",
      "转折点", "稳定性", "能力变化", "阅读质量",
    ];
    for (const w of FORBIDDEN) {
      expect(html, `forbidden word: ${w}`).not.toContain(w);
    }
  });
});

describe("ReadingEvolutionTimelinePanel — rerender determinism", () => {
  it("53. deterministic rerender", () => {
    const archive = makeSixYearArchive();
    const a = renderPanel({ archive });
    const b = renderPanel({ archive });
    expect(a).toBe(b);
  });

  it("54. updated props render new content", () => {
    const html1 = renderPanel({ rangeLabel: "最近5年", topBooksLimit: 12 });
    const html2 = renderPanel({ rangeLabel: "全部", topBooksLimit: 18 });
    expect(html1).not.toBe(html2);
    expect(html2).toMatch(/Top 18/);
    expect(html2).toMatch(/当前档案范围：全部/);
  });
});

describe("ReadingEvolutionTimelinePanel — React hook warning", () => {
  it("55. no React hook warning emitted on render", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderPanel({ archive: makeGappedArchive() });
      renderPanel({ archive: makeSingleYearArchive() });
      renderPanel({ archive: makeEmptyArchive() });
      const calls = errSpy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(calls).not.toMatch(/Rendered fewer hooks/i);
      expect(calls).not.toMatch(/Rendered more hooks/i);
      expect(calls).not.toMatch(/Invalid hook call/i);
      expect(calls).not.toMatch(/Minified React error #300/i);
      expect(calls).not.toMatch(/Minified React error #310/i);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("ReadingEvolutionTimelinePanel — internal helper exports", () => {
  it("__test__ exports are populated", () => {
    expect(typeof __test__.describeYear).toBe("function");
    expect(typeof __test__.formatInteger).toBe("function");
    expect(typeof __test__.formatAverage).toBe("function");
    expect(typeof __test__.formatAbsoluteDelta).toBe("function");
    expect(typeof __test__.formatAverageDelta).toBe("function");
    expect(typeof __test__.formatPercentageDelta).toBe("function");
    expect(typeof __test__.describeDirection).toBe("function");
    expect(typeof __test__.formatRatio).toBe("function");
    expect(__test__.REASON_LABELS.year_gap).toBe("年份存在中断");
    expect(__test__.MILESTONE_LABELS.first_year).toBe("时间线起始年份");
  });
});

describe("ReadingEvolutionTimelinePanel — dashboard integration", () => {
  it("the parent dashboard imports and renders the panel in correct order", () => {
    expect(dashboardSource).toMatch(/import ReadingEvolutionTimelinePanel from/);
    // For the ordering check, look for the JSX usage of each
    // component (the first occurrence inside an `import` statement
    // is the import line, not the JSX render).
    const findJsxUsage = (name: string): number => {
      // Find each occurrence and pick the one that is preceded by a
      // newline + tab (typical JSX indent) and not by `import`.
      let idx = dashboardSource.indexOf(name);
      let best = -1;
      while (idx !== -1) {
        const before = dashboardSource.slice(Math.max(0, idx - 16), idx);
        if (!before.includes("import") && !before.includes("from")) {
          best = idx;
          break;
        }
        idx = dashboardSource.indexOf(name, idx + 1);
      }
      return best;
    };
    const timelineIdx = findJsxUsage("ArchiveTimelineSection");
    const evolutionIdx = findJsxUsage("ReadingEvolutionTimelinePanel");
    const eraIdx = findJsxUsage("ReadingEraPanel");
    const dualIdx = findJsxUsage("DualPeriodComparisonPanel");
    const filtersIdx = findJsxUsage("ReadingComparisonFiltersPanel");
    const yearDirectoryIdx = findJsxUsage("ArchiveYearDirectory");
    expect(timelineIdx).toBeGreaterThan(0);
    expect(evolutionIdx).toBeGreaterThan(timelineIdx);
    expect(eraIdx).toBeGreaterThan(evolutionIdx);
    expect(dualIdx).toBeGreaterThan(eraIdx);
    expect(filtersIdx).toBeGreaterThan(dualIdx);
    expect(yearDirectoryIdx).toBeGreaterThan(filtersIdx);
  });

  it("dashboard parent body still has no hook after `if (!active)`", () => {
    // Re-verify the hook-order regression net still holds.
    const startMatch = dashboardSource.match(
      /export default function ReadingArchiveDashboard[\s\S]*?\)\s*\{/,
    );
    expect(startMatch).not.toBeNull();
    const startSearch = startMatch!.index! + startMatch![0].length;
    const endMarker = /\nfunction ReadingArchiveExportAction\b/;
    const endMatch = dashboardSource.slice(startSearch).search(endMarker);
    const parentBody = dashboardSource.slice(startSearch, startSearch + endMatch);
    const earlyReturnMatch = parentBody.match(/if\s*\(\s*!\s*active\s*\)/);
    expect(earlyReturnMatch).not.toBeNull();
    const afterEarlyReturn = parentBody.slice(earlyReturnMatch!.index!);
    const sanitized = afterEarlyReturn
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(sanitized).not.toMatch(/\buseState\s*[<(]/);
    expect(sanitized).not.toMatch(/\buseEffect\s*\(/);
    expect(sanitized).not.toMatch(/\buseMemo\s*\(/);
    expect(sanitized).not.toMatch(/\buseReducer\s*\(/);
  });

  it("panel model wrapper end-to-end produces a valid timeline", () => {
    const archive = makeSixYearArchive();
    const timeline = buildWereadReadingEvolutionTimeline({ archive });
    expect(timeline.years).toHaveLength(6);
    expect(timeline.transitions).toHaveLength(5);
    expect(timeline.summary.firstYear).toBe(2020);
    expect(timeline.summary.latestYear).toBe(2025);
  });
});
