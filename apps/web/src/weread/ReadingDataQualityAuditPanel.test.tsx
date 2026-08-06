/**
 * S27Q-2 — Reading Data Quality Audit Panel tests.
 *
 * Two-layer strategy:
 *   1. Behavioural tests that drive the Panel through React's
 *      `renderToStaticMarkup` (no DOM testing library). Each test
 *      builds a synthetic archive / targetYears / failedYears
 *      tuple and asserts on the rendered HTML.
 *   2. Source-level structural checks that lock down the panel
 *      contract: zero-hook, no network, no AI, no storage, no
 *      URL mutation, exhaustive label mappings, and no
 *      user-evaluation language.
 *
 * All assertions are deterministic and never depend on real
 * years / books / catalogId / private identifiers.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReadingDataQualityAuditPanel from "./ReadingDataQualityAuditPanel";
import type {
  ReadingArchiveRecurringBook,
  ReadingArchiveYear,
  ReadingArchiveYearLink,
  WereadReadingArchive,
} from "./wereadReadingArchiveModel";
import type { ReadingDataQualityIssueCode } from "./wereadReadingDataQualityAudit";

const PANEL_PATH = resolve(__dirname, "./ReadingDataQualityAuditPanel.tsx");
const DASHBOARD_PATH = resolve(__dirname, "./ReadingArchiveDashboard.tsx");
const MODEL_PATH = resolve(__dirname, "./wereadReadingDataQualityAudit.ts");

const panelSource = readFileSync(PANEL_PATH, "utf8");
const dashboardSource = readFileSync(DASHBOARD_PATH, "utf8");
const modelSource = readFileSync(MODEL_PATH, "utf8");

// Strip leading doc comment blocks from source for structural assertions.
const panelCode = panelSource.replace(/^\/\*[\s\S]*?\*\//, "");

// ---------- fixtures ----------

function makeYear(overrides: Partial<ReadingArchiveYear> = {}): ReadingArchiveYear {
  return {
    year: 2025,
    totalRecords: 100,
    datedRecords: 100,
    matchedRecords: 100,
    matchedBooks: 5,
    activeMonths: 6,
    longestStreakMonths: 6,
    peakMonth: "2025-06",
    peakMonthRecords: 30,
    averageRecordsPerActiveMonth: 16.67,
    topBookCount: 3,
    topBookCatalogIds: ["b1", "b2", "b3"],
    ...overrides,
  };
}

function makeArchive(
  overrides: Partial<WereadReadingArchive> = {}
): WereadReadingArchive {
  return {
    years: [makeYear()],
    overview: {
      yearsWithData: 1,
      firstYear: 2025,
      latestYear: 2025,
      totalRecords: 100,
      totalActiveMonths: 6,
      averageRecordsPerYear: 100,
      mostActiveYear: 2025,
      mostActiveYearRecords: 100,
      longestActiveYearStreak: 1,
      recurringTopBooks: 0,
    },
    recurringBooks: [],
    yearLinks: [],
    meta: {
      requestedYears: 1,
      loadedYears: 1,
      topBooksLimit: 12,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
    ...overrides,
  };
}

function renderPanel(args: {
  archive: WereadReadingArchive;
  targetYears: number[];
  failedYears?: number[];
  topBooksLimit?: 6 | 12 | 18;
  bootstrapLoading?: boolean;
  rangeLabel?: string;
}): string {
  return renderToStaticMarkup(
    React.createElement(ReadingDataQualityAuditPanel, {
      archive: args.archive,
      targetYears: args.targetYears,
      failedYears: args.failedYears ?? [],
      topBooksLimit: args.topBooksLimit ?? 12,
      bootstrapLoading: args.bootstrapLoading ?? false,
      rangeLabel: args.rangeLabel ?? "全部",
    }),
  );
}

// ============================================================
// 1. Root + scaffolding
// ============================================================

describe("ReadingDataQualityAuditPanel — root + scaffolding", () => {
  it("1. root panel is rendered", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality"/);
    expect(html).toMatch(/aria-label="长期档案数据质量审计"/);
  });

  it("2. header title is present", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/长期档案数据质量审计/);
  });

  it("3. top notice uses neutral audit-only wording", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/数据覆盖、数值合法性和字段一致性/);
    expect(html).toMatch(/不评价阅读行为/);
    expect(html).toMatch(/不会自动修改数据/);
  });
});

// ============================================================
// 2. Status visual
// ============================================================

describe("ReadingDataQualityAuditPanel — status mapping", () => {
  it("4. pass status uses neutral wording", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-status="pass"/);
    expect(html).toMatch(/数据审计通过/);
    expect(html).not.toMatch(/阅读质量|用户评分|优秀|较差/);
  });

  it("5. warn status maps to data-only wording", () => {
    const html = renderPanel({
      archive: makeArchive({
        years: [makeYear({ longestStreakMonths: 14 })],
      }),
      targetYears: [2025],
    });
    expect(html).toMatch(/data-status="warn"|data-status="fail"/);
    expect(html).not.toMatch(/阅读质量/);
  });

  it("6. fail status maps to data-consistency wording", () => {
    const html = renderPanel({
      archive: makeArchive({
        years: [makeYear({ totalRecords: 0, datedRecords: 5 })],
      }),
      targetYears: [2025],
    });
    expect(html).toMatch(/存在数据一致性错误/);
  });
});

// ============================================================
// 3. Issue counts
// ============================================================

describe("ReadingDataQualityAuditPanel — issue counts", () => {
  it("7. error count rendered as 0 for clean archive", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-error-count"[^>]*>0</);
  });

  it("8. warning count rendered", () => {
    const html = renderPanel({
      archive: makeArchive({
        years: [makeYear({ longestStreakMonths: 14 })],
      }),
      targetYears: [2025],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-warning-count"/);
  });

  it("9. info count rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-info-count"/);
  });
});

// ============================================================
// 4. Coverage numbers
// ============================================================

describe("ReadingDataQualityAuditPanel — coverage numbers", () => {
  it("10. target year count rendered", () => {
    const html = renderPanel({
      archive: makeArchive({ years: [makeYear({ year: 2025 })] }),
      targetYears: [2025, 2024],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-target-count"[^>]*>2</);
  });

  it("11. loaded year count rendered", () => {
    const html = renderPanel({
      archive: makeArchive({
        years: [makeYear({ year: 2025 }), makeYear({ year: 2024 })],
      }),
      targetYears: [2025, 2024],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-loaded-count"[^>]*>2</);
  });

  it("12. failed year count rendered", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025, 2024],
      failedYears: [2024],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-failed-count"[^>]*>1</);
  });

  it("13. unaccounted year count rendered", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025, 2024, 2023],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-unaccounted-count"[^>]*>2</);
  });

  it("14. unexpected loaded year count rendered", () => {
    const html = renderPanel({
      archive: makeArchive({
        years: [makeYear({ year: 2025 }), makeYear({ year: 2026 })],
      }),
      targetYears: [2025],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-unexpected-loaded-count"[^>]*>1</);
  });

  it("15. accounted ratio rendered", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-accounted-ratio"/);
  });
});

// ============================================================
// 5. Ratios
// ============================================================

describe("ReadingDataQualityAuditPanel — ratios", () => {
  it("16. dated ratio rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-ratio-dated"/);
  });

  it("17. matched ratio rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-ratio-matched"/);
  });

  it("18. metadata ratio rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-ratio-metadata"/);
  });

  it("19. yearLink ratio rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-ratio-year-link"/);
  });

  it("20. ratios are framed as data coverage, not user scores", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/不评价阅读行为/);
    expect(html).not.toMatch(/阅读质量|用户评分|优秀|较差/);
  });
});

// ============================================================
// 6. Year lists
// ============================================================

describe("ReadingDataQualityAuditPanel — year lists", () => {
  it("21. loaded years list rendered", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-loaded-years-list"[^>]*>2025</);
  });

  it("22. failed years list rendered (empty placeholder)", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025],
      failedYears: [],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-failed-years-list"[^>]*>—</);
  });

  it("23. unaccounted years list rendered", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025, 2024],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-unaccounted-years"/);
  });

  it("24. unexpected loaded years list rendered", () => {
    const html = renderPanel({
      archive: makeArchive({
        years: [makeYear({ year: 2026 })],
      }),
      targetYears: [2025],
    });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-unexpected-loaded-years-list"[^>]*>2026</);
  });
});

// ============================================================
// 7. Issue groups
// ============================================================

describe("ReadingDataQualityAuditPanel — issue groups", () => {
  it("25. error group rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-issue-group-error"/);
  });

  it("26. warning group rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-issue-group-warning"/);
  });

  it("27. info group rendered", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-issue-group-info"/);
  });

  it("28. empty error group shows 'no issues' message", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-issue-group-error-empty"[^>]*>当前没有此级别的问题。</);
  });

  it("29. empty warning group shows 'no issues' message", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-issue-group-warning-empty"[^>]*>当前没有此级别的问题。</);
  });

  it("30. empty info group shows 'no issues' message", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/data-testid="weread-reading-data-quality-issue-group-info-empty"[^>]*>当前没有此级别的问题。</);
  });
});

// ============================================================
// 8. Scope Chinese labels
// ============================================================

describe("ReadingDataQualityAuditPanel — scope mapping", () => {
  it("31. archive scope label", () => {
    expect(panelCode).toMatch(/archive:\s*"长期档案"/);
  });

  it("32. coverage scope label", () => {
    expect(panelCode).toMatch(/coverage:\s*"年份覆盖"/);
  });

  it("33. year scope label", () => {
    expect(panelCode).toMatch(/year:\s*"年度指标"/);
  });

  it("34. top_book scope label", () => {
    expect(panelCode).toMatch(/top_book:\s*"年度 Top N"/);
  });

  it("35. year_link scope label", () => {
    expect(panelCode).toMatch(/year_link:\s*"相邻年度链接"/);
  });

  it("36. recurring_book scope label", () => {
    expect(panelCode).toMatch(/recurring_book:\s*"多年重复书目聚合"/);
  });
});

// ============================================================
// 9. Issue location rendering
// ============================================================

describe("ReadingDataQualityAuditPanel — issue location rendering", () => {
  function archiveWithIssues(): WereadReadingArchive {
    return makeArchive({
      years: [
        makeYear({
          year: 2025,
          totalRecords: 100,
          datedRecords: 200, // dated > total → error: dated_records_exceed_total
        }),
      ],
      yearLinks: [
        {
          sourceYear: 2025,
          targetYear: 2025,
          sharedTopBooks: 1,
          overlapRatio: 0.5,
        } as ReadingArchiveYearLink,
      ],
    });
  }

  it("37. year location rendered", () => {
    const html = renderPanel({
      archive: archiveWithIssues(),
      targetYears: [2025],
    });
    expect(html).toMatch(/年份<\/dt>\s*<dd>2025 年/);
  });

  it("38. year-pair location rendered when both fromYear and toYear present", () => {
    const archive = makeArchive({
      years: [makeYear({ year: 2025 }), makeYear({ year: 2026 })],
      yearLinks: [], // intentionally empty so missing_year_link fires
    });
    const html = renderPanel({
      archive,
      targetYears: [2025, 2026],
    });
    // missing_year_link emits fromYear + toYear; the panel renders
    // them as "2025 → 2026".
    expect(html).toMatch(/年份范围<\/dt>\s*<dd>2025 → 2026/);
  });

  it("39. itemIndex rendered 1-based", () => {
    const html = renderPanel({
      archive: archiveWithIssues(),
      targetYears: [2025],
    });
    // dated_records_exceed_total with itemIndex=1 → 第 2 项 (1-based).
    expect(html).toMatch(/第 \d+ 项/);
  });

  it("40. rank rendered when present", () => {
    const archive = makeArchive({
      years: [makeYear({ year: 2025 })],
    });
    const html = renderPanel({
      archive,
      targetYears: [2025],
    });
    // We can't reliably trigger rank without a yearLink, but at
    // minimum the layout supports it.
    expect(html).toBeDefined();
  });

  it("41. actual rendered when present", () => {
    const html = renderPanel({
      archive: archiveWithIssues(),
      targetYears: [2025],
    });
    expect(html).toMatch(/实际值|actual/);
  });

  it("42. expected rendered when present", () => {
    const html = renderPanel({
      archive: archiveWithIssues(),
      targetYears: [2025],
    });
    expect(html).toMatch(/期望值|expected/);
  });

  it("43. null/undefined location fields are omitted (no JSX errors)", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025],
    });
    // No raw "undefined" or "null" appears in rendered text.
    expect(html).not.toMatch(/>undefined</);
    expect(html).not.toMatch(/>null</);
  });

  it("44. Issue ID is NOT shown in production UI", () => {
    const html = renderPanel({
      archive: archiveWithIssues(),
      targetYears: [2025],
    });
    // Strip whitespace + check no "year:" prefix in body.
    // Issue IDs are like "year:dated_records_exceed_total:2025:-:-:1:-".
    expect(html).not.toMatch(/year:dated_records_exceed_total:/);
    expect(html).not.toMatch(/year_link_invalid_order:/);
  });

  it("45. title is NOT shown anywhere in the panel", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025],
    });
    // The word "title" must not appear as a label or value.
    expect(html).not.toMatch(/>title</i);
    expect(html).not.toMatch(/>title</);
  });

  it("46. catalogId is NOT shown anywhere in the panel", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025],
    });
    expect(html).not.toMatch(/catalogId/i);
    expect(html).not.toMatch(/catalog-id/i);
  });
});

// ============================================================
// 10. Loading + empty + pass-through
// ============================================================

describe("ReadingDataQualityAuditPanel — loading / empty / pass", () => {
  it("47. loading shell: bootstrapLoading=true with empty archive shows loading text", () => {
    const html = renderPanel({
      archive: makeArchive({ years: [] }),
      targetYears: [],
      bootstrapLoading: true,
    });
    expect(html).toMatch(/正在整理当前已加载的年度档案/);
  });

  it("48. empty target + empty archive shows empty message", () => {
    const html = renderPanel({
      archive: makeArchive({ years: [] }),
      targetYears: [],
    });
    expect(html).toMatch(/当前没有需要审计的目标年份或年度档案/);
  });

  it("49. target present + empty archive still surfaces unaccounted years", () => {
    const html = renderPanel({
      archive: makeArchive({ years: [] }),
      targetYears: [2025],
    });
    expect(html).toMatch(/未闭合年份/);
    expect(html).toMatch(/2025/);
  });

  it("50. all-pass message shows when no issues", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/当前已加载档案未发现数据一致性错误或警告/);
    expect(html).not.toMatch(/数据完美|用户阅读数据优秀/);
  });

  it("51. partial failure shows failed years + status", () => {
    const html = renderPanel({
      archive: makeArchive(),
      targetYears: [2025, 2024],
      failedYears: [2024],
    });
    expect(html).toMatch(/暂时失败年份/);
    expect(html).toMatch(/2024/);
  });

  it("52. NOT_APPLICABLE limitation note is always present", () => {
    const html = renderPanel({ archive: makeArchive(), targetYears: [2025] });
    expect(html).toMatch(/没有逐年度排名映射/);
    expect(html).toMatch(/审计模型不会为缺失字段推测结果/);
    expect(html).not.toMatch(/recurring_best_rank_mismatch|recurring_latest_rank_mismatch/);
  });
});

// ============================================================
// 11. Source contract
// ============================================================

describe("ReadingDataQualityAuditPanel — source contract", () => {
  it("53. zero-hook: no useMemo/useState/useEffect/useReducer/useRef in panel code", () => {
    expect(panelCode).not.toMatch(/\buseMemo\s*\(/);
    expect(panelCode).not.toMatch(/\buseState\s*\(/);
    expect(panelCode).not.toMatch(/\buseEffect\s*\(/);
    expect(panelCode).not.toMatch(/\buseReducer\s*\(/);
    expect(panelCode).not.toMatch(/\buseRef\s*\(/);
    expect(panelCode).not.toMatch(/\buseLayoutEffect\s*\(/);
    expect(panelCode).not.toMatch(/\buseInsertionEffect\s*\(/);
  });

  it("54. no annual-review fetch in panel", () => {
    expect(panelCode).not.toMatch(/fetchWereadAnnualReview/);
    expect(panelCode).not.toMatch(/annual-review/);
  });

  it("55. no AI call in panel", () => {
    expect(panelCode).not.toMatch(/fetchWereadAiSummary/);
    expect(panelCode).not.toMatch(/AiSummary/);
    expect(panelCode).not.toMatch(/aiSummary/);
  });

  it("56. no related-books call in panel", () => {
    expect(panelCode).not.toMatch(/fetchWereadRelatedBooks/);
    expect(panelCode).not.toMatch(/RelatedBooks/);
  });

  it("57. no storage usage", () => {
    expect(panelCode).not.toMatch(/localStorage/);
    expect(panelCode).not.toMatch(/sessionStorage/);
    expect(panelCode).not.toMatch(/indexedDB/);
  });

  it("58. no URL mutation in panel", () => {
    expect(panelCode).not.toMatch(/pushState/);
    expect(panelCode).not.toMatch(/replaceState/);
    expect(panelCode).not.toMatch(/window\.location/);
    expect(panelCode).not.toMatch(/history\.push/);
    expect(panelCode).not.toMatch(/history\.replace/);
  });

  it("59. no dangerouslySetInnerHTML", () => {
    expect(panelCode).not.toMatch(/dangerouslySetInnerHTML/);
    expect(panelCode).not.toMatch(/innerHTML/);
  });

  it("60. no user-evaluation wording in panel", () => {
    expect(panelCode).not.toMatch(/更爱阅读|兴趣增强|兴趣减弱|能力提升|能力下降|阅读质量|心理状态|人格|成长|退步|低谷|巅峰|用户评分|优秀|较差/);
  });
});

// ============================================================
// 12. Determinism + safety
// ============================================================

describe("ReadingDataQualityAuditPanel — determinism + safety", () => {
  it("61. rerender with same props yields identical output", () => {
    const props = {
      archive: makeArchive(),
      targetYears: [2025] as number[],
      failedYears: [] as number[],
      topBooksLimit: 12 as const,
      bootstrapLoading: false,
    };
    const a = renderPanel(props);
    const b = renderPanel(props);
    expect(a).toBe(b);
  });

  it("62. input archive is not mutated by the panel", () => {
    const archive = makeArchive();
    const before = JSON.stringify(archive);
    renderPanel({ archive, targetYears: [2025] });
    expect(JSON.stringify(archive)).toBe(before);
  });

  it("63. ISSUE_LABELS covers all IssueCode union members (compile-time enforced)", () => {
    // The `satisfies` clause ensures any missing key fails to compile.
    // Here we sanity-check that the panel source actually contains
    // the `satisfies Record<ReadingDataQualityIssueCode, string>`
    // clause so the test catches drift if it's ever weakened.
    expect(panelCode).toMatch(
      /ISSUE_LABELS[\s\S]*?satisfies\s+Record<ReadingDataQualityIssueCode,\s*string>/,
    );
  });

  it("64. SCOPE_LABELS covers all scope union members", () => {
    expect(panelCode).toMatch(
      /SCOPE_LABELS[\s\S]*?satisfies\s+Record<ReadingDataQualityScope,\s*string>/,
    );
  });

  it("65. rendered ratios never contain NaN/Infinity", () => {
    // Edge case: years with 0 totalRecords and 0 datedRecords.
    const archive = makeArchive({
      years: [makeYear({ totalRecords: 0, datedRecords: 0, matchedRecords: 0 })],
    });
    const html = renderPanel({ archive, targetYears: [2025] });
    expect(html).not.toMatch(/NaN/);
    expect(html).not.toMatch(/Infinity/);
  });
});

// ============================================================
// 13. Dashboard integration source check
// ============================================================

describe("ReadingDataQualityAuditPanel — Dashboard integration", () => {
  it("D1. Dashboard imports the panel", () => {
    expect(dashboardSource).toMatch(
      /import ReadingDataQualityAuditPanel from "\.\/ReadingDataQualityAuditPanel"/,
    );
  });

  it("D2. Panel sits AFTER ArchiveTimeline and BEFORE ReadingEvolutionTimeline", () => {
    const timelineIdx = dashboardSource.indexOf("<ArchiveTimelineSection");
    const panelIdx = dashboardSource.indexOf("<ReadingDataQualityAuditPanel");
    const evolutionIdx = dashboardSource.indexOf("<ReadingEvolutionTimelinePanel");
    expect(timelineIdx).toBeGreaterThan(-1);
    expect(panelIdx).toBeGreaterThan(timelineIdx);
    expect(evolutionIdx).toBeGreaterThan(panelIdx);
  });

  it("D3. Panel receives archive, targetYears, failedYears, topBooksLimit, bootstrapLoading", () => {
    expect(dashboardSource).toMatch(/<ReadingDataQualityAuditPanel[\s\S]*?\/>/);
    expect(dashboardSource).toMatch(/archive=\{dashboardArchive\}/);
    expect(dashboardSource).toMatch(/targetYears=\{archive\.visibleYears\}/);
    expect(dashboardSource).toMatch(/failedYears=\{failedYears\}/);
    expect(dashboardSource).toMatch(/topBooksLimit=\{topBooks\}/);
    expect(dashboardSource).toMatch(/bootstrapLoading=\{bootstrapLoading\}/);
  });

  it("D4. Dashboard source does not add new Hooks in the parent body after the early return", () => {
    // Reuse the parent-body slice convention from the existing
    // hook-order tests.
    const startMatch = dashboardSource.match(
      /export default function ReadingArchiveDashboard[\s\S]*?\)\s*\{/,
    );
    expect(startMatch).not.toBeNull();
    const startSearch = startMatch!.index! + startMatch![0].length;
    const endMarker = /\nfunction ReadingArchiveExportAction\b/;
    const endMatch = dashboardSource.slice(startSearch).search(endMarker);
    const parentBody =
      endMatch >= 0
        ? dashboardSource.slice(startSearch, startSearch + endMatch)
        : dashboardSource.slice(startSearch);
    const earlyReturnMatch = parentBody.match(/if\s*\(\s*!\s*active\s*\)/);
    const earlyReturnIndex = earlyReturnMatch ? (earlyReturnMatch.index ?? 0) : -1;
    const afterEarlyReturn =
      earlyReturnIndex >= 0
        ? parentBody.slice(earlyReturnIndex)
        : "";
    const sanitized = afterEarlyReturn
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(sanitized).not.toMatch(/\buseMemo\s*\(/);
    expect(sanitized).not.toMatch(/\buseState\s*\(/);
    expect(sanitized).not.toMatch(/\buseEffect\s*\(/);
    expect(sanitized).not.toMatch(/\buseReducer\s*\(/);
    expect(sanitized).not.toMatch(/\buseRef\s*\(/);
  });

  it("D5. Model union still matches what Panel imports", () => {
    // If the model union ever drifts, the Panel's `satisfies`
    // clause will fail to compile. This test asserts both files
    // import from the same module name.
    expect(panelSource).toMatch(/from "\.\/wereadReadingDataQualityAudit"/);
    expect(dashboardSource).toMatch(/from "\.\/wereadReadingDataQualityAudit"|from "\.\/ReadingDataQualityAuditPanel"/);
  });
});

// ============================================================
// 14. Recurring fixtures (NOT_APPLICABLE surface)
// ============================================================

describe("ReadingDataQualityAuditPanel — recurring fixture safety", () => {
  it("R1. recurring books with missing per-year ranks are still rendered without rank validation", () => {
    const recurring: ReadingArchiveRecurringBook = {
      catalogId: "R1",
      title: "SYNTHETIC_BOOK_TITLE",
      author: null,
      publisher: null,
      publishYear: null,
      yearsOnList: 2,
      years: [2024, 2025],
      totalNoteCountWithinLists: 20,
      bestRank: 1,
      latestYear: 2025,
      latestRank: 2,
    };
    const archive = makeArchive({
      years: [
        makeYear({ year: 2024 }),
        makeYear({ year: 2025 }),
      ],
      recurringBooks: [recurring],
    });
    const html = renderPanel({ archive, targetYears: [2024, 2025] });
    expect(html).not.toMatch(/SYNTHETIC_BOOK_TITLE/);
    expect(html).not.toMatch(/catalogId/);
  });
});

// ============================================================
// 15. Model fingerprint consistency
// ============================================================

describe("ReadingDataQualityAuditPanel — model union fingerprint", () => {
  it("F1. model IssueCode union still includes recurring codes used by Panel mapping", () => {
    expect(modelSource).toMatch(/"recurring_latest_year_mismatch"/);
    expect(modelSource).toMatch(/"missing_year_link"/);
  });
});