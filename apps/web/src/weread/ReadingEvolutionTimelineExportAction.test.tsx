/**
 * S27P-3 — ReadingEvolutionTimelineExportAction behavior tests.
 *
 * Uses `react-dom/server` `renderToStaticMarkup` to exercise the
 * component. Synthetic timeline only.
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
import { buildWereadReadingEvolutionTimeline, type WereadReadingEvolutionTimeline } from "./wereadReadingEvolutionTimeline";
import ReadingEvolutionTimelineExportAction from "./ReadingEvolutionTimelineExportAction";

const ACTION_PATH = resolve(__dirname, "./ReadingEvolutionTimelineExportAction.tsx");
const actionSource = readFileSync(ACTION_PATH, "utf8");
const actionCode = actionSource.replace(/^\/\*[\s\S]*?\*\//, "");

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

function makeArchive(years: ReadingArchiveYear[] = [makeYear(2024)]): WereadReadingArchive {
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
      recurringTopBooks: 0,
    },
    recurringBooks: [],
    yearLinks: [],
    meta: {
      requestedYears: years.length,
      loadedYears: years.length,
      topBooksLimit: 12,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
  };
}

function makeTimeline(years: ReadingArchiveYear[] = [makeYear(2024)]): WereadReadingEvolutionTimeline {
  return buildWereadReadingEvolutionTimeline({
    archive: makeArchive(years),
  });
}

function renderAction(props: Partial<Parameters<typeof ReadingEvolutionTimelineExportAction>[0]> = {}) {
  const timeline = props.timeline ?? makeTimeline();
  return renderToStaticMarkup(
    <ReadingEvolutionTimelineExportAction
      timeline={timeline}
      rangeLabel={props.rangeLabel ?? "最近5年"}
      topBooksLimit={props.topBooksLimit ?? 12}
      failedYears={props.failedYears ?? []}
      bootstrapLoading={props.bootstrapLoading ?? false}
    />,
  );
}

// ---------- tests ----------

describe("ReadingEvolutionTimelineExportAction — render", () => {
  it("1. export button exists", () => {
    const html = renderAction();
    expect(html).toMatch(/data-testid="weread-reading-evolution-export-button"/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-export"/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-export-summary"/);
    expect(html).toMatch(/data-testid="weread-reading-evolution-export-notice"/);
  });

  it("2. loading + empty → button disabled", () => {
    const html = renderAction({
      timeline: makeTimeline([]),
      bootstrapLoading: true,
    });
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="weread-reading-evolution-export-button"/);
  });

  it("3. ready (any years loaded) → button enabled", () => {
    const html = renderAction({
      timeline: makeTimeline([makeYear(2024)]),
      bootstrapLoading: true,
    });
    // With at least one year loaded, button is enabled even during loading.
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*data-testid="weread-reading-evolution-export-button"/);
  });

  it("4. export button copy is Chinese", () => {
    const html = renderAction();
    expect(html).toContain("导出年度统计时间线 Markdown");
  });
});

describe("ReadingEvolutionTimelineExportAction — content", () => {
  it("5. range label rendered in summary", () => {
    const html = renderAction({ rangeLabel: "最近10年" });
    expect(html).toMatch(/当前范围：最近10年/);
  });

  it("6. Top N rendered in summary", () => {
    const html = renderAction({ topBooksLimit: 18 });
    expect(html).toMatch(/Top 18/);
  });

  it("7. failed years count rendered when present", () => {
    const html = renderAction({
      timeline: makeTimeline([
        makeYear(2024, { totalRecords: 100 }),
        makeYear(2025, { totalRecords: 0, activeMonths: 0 }),
      ]),
      failedYears: [2025],
    });
    expect(html).toMatch(/失败 1 个年份/);
  });

  it("8. notice is privacy-safe", () => {
    const html = renderAction();
    expect(html).toContain("不会重新请求年度数据");
    expect(html).toContain("也不会上传或保存到服务器");
  });
});

describe("ReadingEvolutionTimelineExportAction — privacy / network / storage", () => {
  it("9. no annual-review request", () => {
    expect(actionCode).not.toMatch(/fetchWereadAnnualReview/);
    expect(actionCode).not.toMatch(/fetchAnnual/);
  });

  it("10. no AI", () => {
    expect(actionCode).not.toMatch(/fetchWereadAiSummary/);
    expect(actionCode).not.toMatch(/ai summary/i);
    expect(actionCode).not.toMatch(/themes/);
  });

  it("11. no related-books", () => {
    expect(actionCode).not.toMatch(/fetchWereadRelatedBooks/);
    expect(actionCode).not.toMatch(/related-books/);
  });

  it("12. no storage", () => {
    expect(actionCode).not.toMatch(/localStorage/);
    expect(actionCode).not.toMatch(/sessionStorage/);
    expect(actionCode).not.toMatch(/indexedDB/);
  });

  it("13. no URL writes", () => {
    expect(actionCode).not.toMatch(/pushState/);
    expect(actionCode).not.toMatch(/replaceState/);
    expect(actionCode).not.toMatch(/history\.push/);
  });

  it("14. no dangerouslySetInnerHTML", () => {
    expect(actionCode).not.toMatch(/dangerouslySetInnerHTML/);
    expect(actionCode).not.toMatch(/innerHTML/);
  });
});

describe("ReadingEvolutionTimelineExportAction — hook order", () => {
  it("15. all hooks before any conditional return", () => {
    // Strip the privacy comment, then look for any hook AFTER an early
    // return. The component has no early return path, but verify that
    // useState + useEffect appear at the top of the function body
    // (before any conditional logic).
    const startMatch = actionCode.match(
      /export default function ReadingEvolutionTimelineExportAction[\s\S]*?\)\s*\{/,
    );
    expect(startMatch).not.toBeNull();
    const startSearch = startMatch!.index! + startMatch![0].length;
    // Find any early return inside this function
    const earlyReturnMatch = actionCode.slice(startSearch).match(/if\s*\([^)]*\)\s*\{[^}]*return/);
    if (!earlyReturnMatch) {
      // No early return — fine. Verify the first hooks are at the
      // top of the function body.
      const body = actionCode.slice(startSearch, startSearch + 1500);
      const useStateIdx = body.indexOf("useState");
      const useEffectIdx = body.indexOf("useEffect");
      expect(useStateIdx).toBeGreaterThan(-1);
      expect(useEffectIdx).toBeGreaterThan(-1);
      return;
    }
    const beforeEarlyReturn = actionCode.slice(startSearch, startSearch + earlyReturnMatch.index!);
    const afterEarlyReturn = actionCode.slice(
      startSearch + earlyReturnMatch.index! + earlyReturnMatch[0].length,
      startSearch + earlyReturnMatch.index! + earlyReturnMatch[0].length + 1500,
    );
    expect(beforeEarlyReturn).toMatch(/useState/);
    expect(beforeEarlyReturn).toMatch(/useEffect/);
    expect(afterEarlyReturn).not.toMatch(/\buseState\b/);
    expect(afterEarlyReturn).not.toMatch(/\buseEffect\b/);
    expect(afterEarlyReturn).not.toMatch(/\buseMemo\b/);
  });

  it("16. no React hook warning emitted on render", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderAction({ timeline: makeTimeline([makeYear(2024)]) });
      renderAction({ timeline: makeTimeline([makeYear(2024), makeYear(2025, { totalRecords: 200 })]) });
      renderAction({ timeline: makeTimeline([]) });
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

describe("ReadingEvolutionTimelineExportAction — privacy in rendered HTML", () => {
  it("17. no private IDs in rendered HTML", () => {
    const html = renderAction();
    expect(html).not.toMatch(/wereadBookId/);
    expect(html).not.toMatch(/noteId/);
    expect(html).not.toMatch(/highlightId/);
    expect(html).not.toMatch(/chapterTitle/);
    expect(html).not.toMatch(/Authorization/);
    expect(html).not.toMatch(/token=/);
  });

  it("18. no inference-language forbidden words in rendered HTML", () => {
    const html = renderAction();
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

describe("ReadingEvolutionTimelineExportAction — integration with panel", () => {
  it("19. export action does not modify the timeline", () => {
    const timeline = makeTimeline([makeYear(2024), makeYear(2025, { totalRecords: 200 })]);
    const before = JSON.stringify(timeline);
    renderAction({ timeline });
    const after = JSON.stringify(timeline);
    expect(before).toBe(after);
  });

  it("20. deterministic rerender", () => {
    const timeline = makeTimeline([makeYear(2024)]);
    const a = renderAction({ timeline });
    const b = renderAction({ timeline });
    expect(a).toBe(b);
  });
});
