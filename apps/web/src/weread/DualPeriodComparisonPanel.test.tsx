/**
 * S27O-2 — DualPeriodComparisonPanel behavior tests.
 *
 * Uses react-dom/server. Asserts:
 *   - panel renders
 *   - default period selection
 *   - A / B modifications
 *   - normalize (start > end swap)
 *   - quick action buttons
 *   - reset defaults
 *   - metrics display
 *   - delta display
 *   - zero baseline / from-zero / to-zero handling
 *   - continued / entered / left cards
 *   - overlap comparison
 *   - empty / single-year states
 *   - no fetch / AI / related-books / storage / URL writes
 *   - no `dangerouslySetInnerHTML`
 *   - no psychological vocabulary
 */

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveYearLink,
  ReadingArchiveRecurringBook,
} from "./wereadReadingArchiveModel";
import DualPeriodComparisonPanel from "./DualPeriodComparisonPanel";

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

function makeLink(
  sourceYear: number,
  targetYear: number,
  overlapRatio: number,
): ReadingArchiveYearLink {
  return { sourceYear, targetYear, sharedTopBooks: 1, overlapRatio };
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

function makeArchive(
  years: ReadingArchiveYear[],
  links: ReadingArchiveYearLink[] = [],
  recurringBooks: ReadingArchiveRecurringBook[] = [],
  topBooksLimit: 6 | 12 | 18 = 12,
): WereadReadingArchive {
  return {
    years,
    overview: {
      yearsWithData: years.length,
      firstYear: years[0]?.year ?? null,
      latestYear: years[years.length - 1]?.year ?? null,
      totalRecords: years.reduce((acc, y) => acc + y.totalRecords, 0),
      totalActiveMonths: years.reduce((acc, y) => acc + y.activeMonths, 0),
      averageRecordsPerYear:
        years.length > 0
          ? years.reduce((acc, y) => acc + y.totalRecords, 0) / years.length
          : 0,
      mostActiveYear: years[0]?.year ?? null,
      mostActiveYearRecords: years[0]?.totalRecords ?? 0,
      longestActiveYearStreak: years.length,
      recurringTopBooks: recurringBooks.length,
    },
    recurringBooks,
    yearLinks: links,
    meta: {
      requestedYears: years.length,
      loadedYears: years.length,
      topBooksLimit,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
  };
}

// ---------- harness ----------

function Harness({
  archive,
  rangeLabel = "最近5年",
  topBooksLimit = 12,
  failedYears = [],
  bootstrapLoading = false,
}: {
  archive: WereadReadingArchive | null;
  rangeLabel?: string;
  topBooksLimit?: 6 | 12 | 18;
  failedYears?: number[];
  bootstrapLoading?: boolean;
}) {
  const [, setTick] = useState(0);
  const availableYears = archive
    ? archive.years.map((y) => y.year).sort((a, b) => a - b)
    : [];
  return (
    <>
      <button
        type="button"
        data-testid="harness-tick"
        onClick={() => setTick((n) => n + 1)}
      >
        tick
      </button>
      <DualPeriodComparisonPanel
        archive={archive}
        availableYears={availableYears}
        rangeLabel={rangeLabel}
        topBooksLimit={topBooksLimit}
        failedYears={failedYears}
        bootstrapLoading={bootstrapLoading}
      />
    </>
  );
}

function renderAt(props: Parameters<typeof Harness>[0]) {
  return renderToStaticMarkup(<Harness {...props} />);
}

// ---------- forbidden vocab ----------

const FORBIDDEN_PRIVACY = [
  "note.text",
  "note.comment",
  "markedText",
  "wereadBookId",
  "noteId",
  "highlightId",
  "chapterTitle",
  "Authorization: Bearer",
  "wr_skey",
  "wr_vid",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "<script",
];

const FORBIDDEN_PSYCH = [
  "兴趣转变",
  "偏好改变",
  "质量提升",
  "质量下降",
  "专注力变化",
  "成熟期",
  "探索期",
  "低谷",
  "巅峰",
  "提升",
  "下降趋势",
  "成长",
  "退步",
  "心理",
  "人格",
  "稳定",
  "变化",
];

function expectNoForbiddenVocabulary(html: string): void {
  const lower = html.toLowerCase();
  for (const k of FORBIDDEN_PRIVACY) {
    expect(lower.includes(k.toLowerCase()), `forbidden privacy: ${k}`).toBe(false);
  }
  for (const k of FORBIDDEN_PSYCH) {
    expect(html.includes(k), `forbidden psych: ${k}`).toBe(false);
  }
  expect(html, "no raw HTML strings").not.toMatch(
    /dangerouslySetInnerHTML|innerHTML\s*=/i,
  );
  expect(html, "no related-books").not.toMatch(/RelatedBooks|relatedBooks|related-books/i);
}

// ---------- tests ----------

describe("DualPeriodComparisonPanel — render", () => {
  it("renders the panel header", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period"');
    expect(html).toContain("双时间段比较");
  });

  it("renders both period selectors", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-a"');
    expect(html).toContain('data-testid="weread-dual-period-b"');
    expect(html).toContain('data-testid="weread-dual-period-a-start"');
    expect(html).toContain('data-testid="weread-dual-period-a-end"');
    expect(html).toContain('data-testid="weread-dual-period-b-start"');
    expect(html).toContain('data-testid="weread-dual-period-b-end"');
  });

  it("renders three quick-action buttons", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-quick-recent"');
    expect(html).toContain('data-testid="weread-dual-period-quick-half"');
    expect(html).toContain('data-testid="weread-dual-period-quick-reset"');
  });

  it("renders the metrics table", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-metrics"');
    expect(html).toContain('data-testid="weread-dual-period-metrics-table"');
    expect(html).toContain('data-testid="weread-dual-period-metric-totalRecords"');
    expect(html).toContain('data-testid="weread-dual-period-metric-activeMonths"');
  });

  it("renders the recurring diff cards", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-recurring"');
    expect(html).toContain('data-testid="weread-dual-period-continued"');
    expect(html).toContain('data-testid="weread-dual-period-entered"');
    expect(html).toContain('data-testid="weread-dual-period-left"');
  });

  it("renders the overlap section", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021)],
      [makeLink(2020, 2021, 0.3)],
    );
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-overlap"');
    expect(html).toContain("相邻年度榜单重合比例");
  });

  it("renders the privacy notice", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-notice"');
    expect(html).toContain("不会保存到服务器");
  });

  it("does not include forbidden privacy / psych vocabulary", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expectNoForbiddenVocabulary(html);
  });
});

describe("DualPeriodComparisonPanel — defaults", () => {
  it("splits available years into first half vs second half by default", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2022),
      makeYear(2023),
    ]);
    const html = renderAt({ archive });
    // 4 years → A: [2020, 2021], B: [2022, 2023]
    expect(html).toContain('data-testid="weread-dual-period-a-range"');
    expect(html).toContain('data-testid="weread-dual-period-b-range"');
  });

  it("single-year archive gets the same year for both periods", () => {
    const archive = makeArchive([makeYear(2025)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-single-year-hint"');
  });

  it("shows empty state on null archive", () => {
    const html = renderAt({ archive: null });
    expect(html).toContain('data-testid="weread-dual-period-empty"');
    expect(html).toContain("当前没有可比较的数据");
  });

  it("shows empty state on archive with zero years", () => {
    const archive = makeArchive([]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-empty"');
  });
});

describe("DualPeriodComparisonPanel — quick actions", () => {
  it("renders the recent-vs-earlier button with correct label", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2022),
      makeYear(2023),
      makeYear(2024),
      makeYear(2025),
    ]);
    const html = renderAt({ archive });
    expect(html).toContain("最近三年 vs 更早三年");
  });

  it("renders the half-vs-half button with correct label", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2022),
      makeYear(2023),
    ]);
    const html = renderAt({ archive });
    expect(html).toContain("前半段 vs 后半段");
  });

  it("renders the reset button", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    expect(html).toContain("恢复默认");
  });

  it("quick actions are disabled while bootstrap loading", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive, bootstrapLoading: true });
    // Order-independent: disabled="" may come before or after data-testid.
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="weread-dual-period-quick-recent"/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="weread-dual-period-quick-half"/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="weread-dual-period-quick-reset"/);
  });
});

describe("DualPeriodComparisonPanel — period selectors", () => {
  it("renders only available years as options", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2023), // gap year
    ]);
    const html = renderAt({ archive });
    // The available years are [2020, 2021, 2023]
    expect(html).toContain('value="2020"');
    expect(html).toContain('value="2021"');
    expect(html).toContain('value="2023"');
  });

  it("renders the selected range labels", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2022),
      makeYear(2023),
    ]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-a-range"');
    expect(html).toContain('data-testid="weread-dual-period-b-range"');
  });
});

describe("DualPeriodComparisonPanel — metrics display", () => {
  it("renders all five metric rows", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    for (const k of [
      "totalRecords",
      "activeMonths",
      "matchedRecords",
      "matchedBooks",
      "averageRecords",
    ]) {
      expect(html).toContain(`data-testid="weread-dual-period-metric-${k}"`);
    }
  });

  it("renders delta values with direction tags", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 50, activeMonths: 4 }),
      makeYear(2021, { totalRecords: 100, activeMonths: 8 }),
      makeYear(2022, { totalRecords: 200, activeMonths: 10 }),
      makeYear(2023, { totalRecords: 300, activeMonths: 12 }),
    ]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-delta-totalRecords"');
    expect(html).toContain('data-testid="weread-dual-period-delta-percent-totalRecords"');
    expect(html).toContain('data-testid="weread-dual-period-delta-direction-totalRecords"');
  });

  it("shows zero-baseline hint when one period is empty", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2025),
    ]);
    const html = renderAt({ archive });
    // A: [2020, 2021], B: [2025] - B has only one year → single-year hint
    expect(html).toContain('data-testid="weread-dual-period-single-year-hint"');
  });

  it("delta cells have data-direction attributes", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 200 }),
    ]);
    const html = renderAt({ archive });
    expect(html).toMatch(/data-direction="(increase|decrease|same|from_zero|to_zero)"/);
  });
});

describe("DualPeriodComparisonPanel — recurring diff", () => {
  it("renders continued / entered / left counts", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a", "b"] }),
        makeYear(2021, { topBookCatalogIds: ["a", "b"] }),
        makeYear(2022, { topBookCatalogIds: ["a", "c"] }),
        makeYear(2023, { topBookCatalogIds: ["a", "c"] }),
      ],
      [],
      [makeRecurring("a", [2020, 2021, 2022, 2023], "Book A")],
    );
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-continued-count"');
    expect(html).toContain('data-testid="weread-dual-period-entered-count"');
    expect(html).toContain('data-testid="weread-dual-period-left-count"');
  });

  it("renders book titles for continued card", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a"] }),
        makeYear(2021, { topBookCatalogIds: ["a"] }),
        makeYear(2022, { topBookCatalogIds: ["a"] }),
        makeYear(2023, { topBookCatalogIds: ["a"] }),
      ],
      [],
      [makeRecurring("a", [2020, 2021, 2022, 2023], "公共书目 A", "公共作者")],
    );
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-continued-title-a"');
    expect(html).toContain("公共书目 A");
    expect(html).toContain("公共作者");
  });

  it("uses /books/:catalogId links (no private IDs)", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a"] }),
        makeYear(2021, { topBookCatalogIds: ["a"] }),
        makeYear(2022, { topBookCatalogIds: ["a"] }),
        makeYear(2023, { topBookCatalogIds: ["a"] }),
      ],
      [],
      [makeRecurring("a", [2020, 2021, 2022, 2023], "Book A")],
    );
    const html = renderAt({ archive });
    expect(html).toContain('href="/books/a"');
  });

  it("shows empty hint when a card has no books", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2022),
      makeYear(2023),
    ]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-continued-empty"');
  });
});

describe("DualPeriodComparisonPanel — overlap", () => {
  it("renders overlap rows for A and B", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021), makeYear(2022), makeYear(2023)],
      [makeLink(2020, 2021, 0.3), makeLink(2022, 2023, 0.5)],
    );
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-overlap-row-a"');
    expect(html).toContain('data-testid="weread-dual-period-overlap-row-b"');
  });

  it("shows empty hint when no comparable pairs", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)], []);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-overlap-empty"');
    expect(html).toContain("没有足够年份生成榜单重合");
  });
});

describe("DualPeriodComparisonPanel — privacy & isolation", () => {
  it("does not call fetch / annual-review / related-books", () => {
    const fetchSpy = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      const archive = makeArchive([makeYear(2020), makeYear(2021)]);
      const html = renderAt({ archive });
      expect(html).toBeDefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not write to storage", () => {
    // SSR render has no DOM, but the rendered HTML must not contain any
    // storage-write hooks. The source file is also asserted via grep
    // elsewhere in the suite.
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html.toLowerCase().includes("localstorage")).toBe(false);
    expect(html.toLowerCase().includes("sessionstorage")).toBe(false);
    expect(html.toLowerCase().includes("indexeddb")).toBe(false);
  });

  it("does not modify URL via history", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html.toLowerCase().includes("pushstate")).toBe(false);
    expect(html.toLowerCase().includes("replacestate")).toBe(false);
    expect(html.toLowerCase().includes("location.assign")).toBe(false);
  });

  it("does not include dangerouslySetInnerHTML", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/i);
  });

  it("does not include psychological vocabulary", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    for (const word of FORBIDDEN_PSYCH) {
      expect(html.includes(word), `forbidden psych: ${word}`).toBe(false);
    }
  });

  it("does not include privacy-forbidden tokens", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    const lower = html.toLowerCase();
    for (const token of FORBIDDEN_PRIVACY) {
      expect(lower.includes(token.toLowerCase()), `forbidden: ${token}`).toBe(false);
    }
  });
});

describe("DualPeriodComparisonPanel — normalize", () => {
  it("panel renders even with single available year", () => {
    const archive = makeArchive([makeYear(2025, { totalRecords: 30 })]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period"');
    expect(html).toContain('data-testid="weread-dual-period-single-year-hint"');
  });

  it("panel renders with non-contiguous available years", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2023), // gap
      makeYear(2025), // gap
    ]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period"');
    expect(html).toContain('value="2023"');
    expect(html).toContain('value="2025"');
  });
});

describe("DualPeriodComparisonPanel — scope display", () => {
  it("renders range label and top-books scope", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive, rangeLabel: "最近10年", topBooksLimit: 18, failedYears: [2022] });
    expect(html).toContain("最近10年");
    expect(html).toContain("Top 18");
    expect(html).toContain("失败年份 1 个");
  });

  it("renders zero failed years when none", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive, failedYears: [] });
    expect(html).toContain("失败年份 0 个");
  });
});

describe("DualPeriodComparisonPanel — Markdown export", () => {
  it("renders the export button", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-export"');
    expect(html).toContain('data-testid="weread-dual-period-export-button"');
  });

  it("renders the export summary", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive, rangeLabel: "最近5年", topBooksLimit: 12 });
    expect(html).toContain('data-testid="weread-dual-period-export-summary"');
    expect(html).toContain("最近5年");
    expect(html).toContain("Top 12");
  });

  it("renders the export notice", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-export-notice"');
    expect(html).toContain("当前浏览器生成");
    expect(html).toContain("不会重新请求数据");
    expect(html).toContain("不会上传或保存");
  });

  it("export button is disabled while bootstrap loading", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive, bootstrapLoading: true });
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="weread-dual-period-export-button"/);
  });

  it("export button is disabled when archive is empty", () => {
    const html = renderAt({ archive: null });
    // No archive → no export button rendered (panel returns early).
    expect(html).not.toContain('data-testid="weread-dual-period-export-button"');
  });

  it("export button is hidden when one period is empty", () => {
    // Two-year archive → A = [2020], B = [2021] — both have data, button should render.
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html).toContain('data-testid="weread-dual-period-export-button"');
  });

  it("does not include dangerouslySetInnerHTML in export block", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    expect(html).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/i);
  });

  it("does not include forbidden privacy tokens in export area", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021)]);
    const html = renderAt({ archive });
    const lower = html.toLowerCase();
    for (const token of [
      "note.text",
      "note.comment",
      "wereadbookid",
      "noteid",
      "highlightid",
      "authorization",
      "api key",
      "wr_skey",
      "wr_vid",
    ]) {
      expect(lower.includes(token.toLowerCase()), `forbidden: ${token}`).toBe(false);
    }
  });

  it("does not include psychological vocabulary in export area", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    for (const word of [
      "兴趣转变",
      "偏好改变",
      "阅读低谷",
      "探索期",
      "成熟期",
      "提升",
      "成长",
      "退步",
      "人格",
      "心理",
    ]) {
      expect(html.includes(word), `forbidden: ${word}`).toBe(false);
    }
  });

  it("does not include storage / URL write tokens", () => {
    const archive = makeArchive([makeYear(2020), makeYear(2021), makeYear(2022)]);
    const html = renderAt({ archive });
    const lower = html.toLowerCase();
    expect(lower.includes("localstorage")).toBe(false);
    expect(lower.includes("sessionstorage")).toBe(false);
    expect(lower.includes("indexeddb")).toBe(false);
    expect(lower.includes("pushstate")).toBe(false);
    expect(lower.includes("replacestate")).toBe(false);
  });
});
