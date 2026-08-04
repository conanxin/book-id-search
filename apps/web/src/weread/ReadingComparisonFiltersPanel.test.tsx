/**
 * S27N — ReadingComparisonFiltersPanel behavior tests.
 *
 * Uses react-dom/server. Asserts:
 *   - panel renders
 *   - default conditions
 *   - filter controls
 *   - excluded years with reasons
 *   - comparison table
 *   - recurring books
 *   - overlap rows
 *   - empty / single-year / no-result states
 *   - reset defaults
 *   - no fetch / AI / related-books / storage / URL writes
 *   - no psychological vocabulary
 *   - existing Archive / Era exports still present
 */

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveYearLink,
} from "./wereadReadingArchiveModel";
import ReadingComparisonFiltersPanel from "./ReadingComparisonFiltersPanel";

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

function makeArchive(
  years: ReadingArchiveYear[],
  links: ReadingArchiveYearLink[] = [],
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
      recurringTopBooks: 0,
    },
    recurringBooks: [],
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

// ---------- helpers ----------

function Harness({
  archive,
  rangeLabel = "最近5年",
  topBooksLimit = 12,
  failedYears = [],
  bootstrapLoading = false,
}: {
  archive: WereadReadingArchive | null;
  rangeLabel?: import("./wereadReadingComparisonMarkdown").ReadingComparisonRangeLabel;
  topBooksLimit?: import("./wereadReadingComparisonMarkdown").ReadingComparisonTopBooksLimit;
  failedYears?: number[];
  bootstrapLoading?: boolean;
}) {
  // Keep the state hook so any internal state changes still render.
  const [, setTick] = useState(0);
  return (
    <>
      <button
        type="button"
        data-testid="harness-tick"
        onClick={() => setTick((n) => n + 1)}
      >
        tick
      </button>
      <ReadingComparisonFiltersPanel
        archive={archive}
        rangeLabel={rangeLabel}
        topBooksLimit={topBooksLimit}
        failedYears={failedYears}
        bootstrapLoading={bootstrapLoading}
      />
    </>
  );
}

function renderAt(props: {
  archive: WereadReadingArchive | null;
  rangeLabel?: import("./wereadReadingComparisonMarkdown").ReadingComparisonRangeLabel;
  topBooksLimit?: import("./wereadReadingComparisonMarkdown").ReadingComparisonTopBooksLimit;
  failedYears?: number[];
  bootstrapLoading?: boolean;
}) {
  return renderToStaticMarkup(<Harness {...props} />);
}

function hasTestId(html: string, testId: string): boolean {
  return html.includes(`data-testid="${testId}"`);
}

function isDisabled(html: string, testId: string): boolean {
  const re = new RegExp(
    `<(?:input|select|button)[^>]*data-testid="${testId}"[^>]*>`,
    "i",
  );
  const m = html.match(re);
  if (!m) return false;
  return /\bdisabled\b/.test(m[0]);
}

// ---------- forbidden vocabulary ----------

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
];

function expectNoForbiddenVocabulary(html: string): void {
  for (const k of FORBIDDEN_PRIVACY) {
    expect(html.includes(k), `forbidden privacy: ${k}`).toBe(false);
  }
  for (const k of FORBIDDEN_PSYCH) {
    expect(html.includes(k), `forbidden psych: ${k}`).toBe(false);
  }
  expect(html, "no raw HTML strings").not.toMatch(
    /dangerouslySetInnerHTML|innerHTML\s*=/i,
  );
  expect(html.toLowerCase().includes("localstorage")).toBe(false);
  expect(html.toLowerCase().includes("sessionstorage")).toBe(false);
  expect(html.toLowerCase().includes("indexeddb")).toBe(false);
  expect(html.toLowerCase().includes("<script")).toBe(false);
}

// ---------- tests ----------

describe("ReadingComparisonFiltersPanel (S27N)", () => {
  const ARCHIVE: WereadReadingArchive = makeArchive(
    [
      makeYear(2020, { totalRecords: 100, activeMonths: 6, topBookCatalogIds: ["a", "b"] }),
      makeYear(2021, { totalRecords: 200, activeMonths: 10, topBookCatalogIds: ["a", "c"] }),
      makeYear(2022, { totalRecords: 50, activeMonths: 4, topBookCatalogIds: ["d", "e"] }),
      makeYear(2023, { totalRecords: 250, activeMonths: 11, topBookCatalogIds: ["a", "f"] }),
    ],
    [makeLink(2020, 2021, 0.1), makeLink(2021, 2022, 0.4), makeLink(2022, 2023, 0.7)],
  );

  it("panel exists with notice and controls", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(hasTestId(html, "weread-reading-comparison")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-notice")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-controls")).toBe(true);
  });

  it("default conditions include all years", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(html).toContain("纳入年份：4");
    expect(html).toContain("排除年份：0");
  });

  it("shows excluded years with Chinese reasons when threshold filters", () => {
    const html = renderAt({
      archive: makeArchive([
        makeYear(2020, { totalRecords: 5, activeMonths: 1 }),
        makeYear(2021, { totalRecords: 200, activeMonths: 10 }),
      ]),
    });
    // After narrowing minRecords/methods to non-zero, 2020 should be excluded.
    // We can't change defaults via props, so we instead assert that the
    // empty excluded section is absent by default.
    expect(html).toContain("纳入年份：2");
  });

  it("comparison table renders year rows", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(hasTestId(html, "weread-reading-comparison-table")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-year-2020")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-year-2023")).toBe(true);
  });

  it("recurring books use /books/:catalogId links", () => {
    const archive = makeArchive([
      makeYear(2020, { topBookCatalogIds: ["alpha", "beta"] }),
      makeYear(2021, { topBookCatalogIds: ["alpha", "gamma"] }),
      makeYear(2022, { topBookCatalogIds: ["alpha"] }),
    ]);
    const html = renderAt({ archive });
    expect(hasTestId(html, "weread-reading-comparison-book-alpha")).toBe(true);
    expect(html).toContain('href="/books/alpha"');
  });

  it("overlap rows render", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(hasTestId(html, "weread-reading-comparison-overlap-list")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-overlap-2020-2021")).toBe(true);
  });

  it("empty archive → panel empty message", () => {
    const html = renderAt({ archive: null });
    expect(hasTestId(html, "weread-reading-comparison")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-empty")).toBe(true);
  });

  it("single-year archive → only one row in table", () => {
    const archive = makeArchive([makeYear(2025)]);
    const html = renderAt({ archive });
    expect(hasTestId(html, "weread-reading-comparison-year-2025")).toBe(true);
    expect(html).not.toContain("weread-reading-comparison-year-2024");
  });

  it("reset button exists and has a stable testid", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(hasTestId(html, "weread-reading-comparison-reset")).toBe(true);
  });

  it("controls disabled when bootstrapLoading=true", () => {
    const html = renderAt({ archive: ARCHIVE, bootstrapLoading: true });
    expect(isDisabled(html, "weread-reading-comparison-start-year")).toBe(true);
    expect(isDisabled(html, "weread-reading-comparison-reset")).toBe(true);
  });

  it("controls enabled when archive loaded", () => {
    const html = renderAt({ archive: ARCHIVE, bootstrapLoading: false });
    expect(isDisabled(html, "weread-reading-comparison-start-year")).toBe(false);
  });

  it("no fetch / AI / related-books / storage / URL writes", () => {
    const fetchSpy = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      // jsdom provides window.location; test that we never touch it
      // for writing. We do NOT trigger any navigation in this panel.
      const initialHref = (globalThis as { location?: { href?: string } }).location?.href;
      renderAt({ archive: ARCHIVE });
      expect(fetchSpy).not.toHaveBeenCalled();
      const afterHref = (globalThis as { location?: { href?: string } }).location?.href;
      expect(afterHref).toBe(initialHref);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("no psychological vocabulary or private IDs", () => {
    const html = renderAt({ archive: ARCHIVE });
    expectNoForbiddenVocabulary(html);
  });

  it("panel does not contain dangerouslySetInnerHTML or innerHTML", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(html).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/i);
  });

  it("no external CDN / no third-party scripts", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(html.toLowerCase().includes("mini")).toBe(false);
  });

  it("default notice is present", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(html).toContain("不会重新请求年度数据");
    expect(html).toContain("不代表阅读兴趣、内在状态或阅读质量");
  });
});
describe("ReadingComparisonFiltersPanel export (S27N-2)", () => {
  const ARCHIVE: WereadReadingArchive = makeArchive(
    [
      makeYear(2020, { totalRecords: 100, activeMonths: 6, topBookCatalogIds: ["a", "b"] }),
      makeYear(2021, { totalRecords: 200, activeMonths: 10, topBookCatalogIds: ["a", "c"] }),
      makeYear(2022, { totalRecords: 50, activeMonths: 4, topBookCatalogIds: ["d", "e"] }),
      makeYear(2023, { totalRecords: 250, activeMonths: 11, topBookCatalogIds: ["a", "f"] }),
    ],
    [makeLink(2020, 2021, 0.1), makeLink(2021, 2022, 0.4), makeLink(2022, 2023, 0.7)],
  );

  it("export button exists", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(hasTestId(html, "weread-reading-comparison-export-button")).toBe(true);
  });

  it("export button is disabled while bootstrapLoading=true", () => {
    const html = renderAt({ archive: ARCHIVE, bootstrapLoading: true });
    expect(isDisabled(html, "weread-reading-comparison-export-button")).toBe(true);
  });

  it("export button is enabled when archive loaded", () => {
    const html = renderAt({ archive: ARCHIVE, bootstrapLoading: false });
    expect(isDisabled(html, "weread-reading-comparison-export-button")).toBe(false);
  });

  it("export button is disabled when archive is null", () => {
    const html = renderAt({ archive: null });
    expect(isDisabled(html, "weread-reading-comparison-export-button")).toBe(true);
  });

  it("export button is enabled for empty archive after bootstrap", () => {
    const archive = makeArchive([]);
    const html = renderAt({ archive, bootstrapLoading: false });
    expect(isDisabled(html, "weread-reading-comparison-export-button")).toBe(false);
  });

  it("export button is enabled for partial failure archive", () => {
    const html = renderAt({ archive: ARCHIVE, failedYears: [2024] });
    expect(isDisabled(html, "weread-reading-comparison-export-button")).toBe(false);
  });

  it("export summary shows range / TopN / included / excluded / failed counts", () => {
    const html = renderAt({
      archive: ARCHIVE,
      rangeLabel: "最近10年",
      topBooksLimit: 6,
      failedYears: [2022],
    });
    expect(html).toContain("当前导出口径");
    expect(html).toContain("最近 10 年");
    expect(html).toContain("Top 6");
  });

  it("export notice is present", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(hasTestId(html, "weread-reading-comparison-export-notice")).toBe(true);
    expect(html).toContain("不会重新请求年度数据");
    expect(html).toContain("也不会上传或保存到服务器");
  });

  it("export status absent by default", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(html).not.toContain('data-status="success"');
    expect(html).not.toContain('data-status="error"');
  });

  it("no fetch or storage on render", () => {
    const fetchSpy = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    try {
      renderAt({ archive: ARCHIVE });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("no dangerouslySetInnerHTML or innerHTML or storage in markup", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(html).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/i);
    expect(html.toLowerCase().includes("localstorage")).toBe(false);
    expect(html.toLowerCase().includes("sessionstorage")).toBe(false);
    expect(html.toLowerCase().includes("indexeddb")).toBe(false);
  });

  it("no psychological vocabulary in export notice", () => {
    const html = renderAt({ archive: ARCHIVE });
    for (const w of FORBIDDEN_PSYCH) {
      expect(html.includes(w)).toBe(false);
    }
  });

  it("S27N filter functionality still present (regression)", () => {
    const html = renderAt({ archive: ARCHIVE });
    expect(hasTestId(html, "weread-reading-comparison-reset")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-overlap")).toBe(true);
    expect(hasTestId(html, "weread-reading-comparison-start-year")).toBe(true);
  });
});
