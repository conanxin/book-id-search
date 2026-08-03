/**
 * S27K — Structural / behavioural checks for YearComparisonPanel.
 *
 * The project does not currently ship a DOM testing library, so this
 * file follows the existing `weread*Dashboard.test.ts` convention:
 * structural assertions on the source files plus behaviour checks
 * implemented through the pure model layer.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildWereadYearComparison,
  hasYearComparisonData,
} from "./wereadYearComparisonModel";
import type { WereadAnnualReviewResponse } from "../wereadPrivate";

const PANEL_PATH = resolve(__dirname, "./YearComparisonPanel.tsx");
const DASHBOARD_PATH = resolve(__dirname, "./AnnualReviewDashboard.tsx");
const STYLES_PATH = resolve(__dirname, "../styles.css");
const MODEL_PATH = resolve(__dirname, "./wereadYearComparisonModel.ts");

const panel = readFileSync(PANEL_PATH, "utf8");
const dashboard = readFileSync(DASHBOARD_PATH, "utf8");
const styles = readFileSync(STYLES_PATH, "utf8");
const model = readFileSync(MODEL_PATH, "utf8");

function makeBook(
  catalogId: string,
  title: string,
  author: string | null,
  noteCount: number,
  rank: number
): {
  catalogId: string;
  title: string;
  author: string | null;
  publisher: string | null;
  publishYear: number | null;
  noteCount: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  activeMonths: number;
  firstNoteAt: string | null;
  lastNoteAt: string | null;
} {
  return {
    catalogId,
    title,
    author,
    publisher: "测试出版社",
    publishYear: 2020,
    noteCount,
    highlights: Math.max(0, noteCount - 1),
    thoughts: 1,
    reviews: 0,
    unknown: 0,
    activeMonths: 1,
    firstNoteAt: null,
    lastNoteAt: null,
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const year = overrides.selectedYear ?? 2025;
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    total: i === 0 ? 10 : 0,
    highlights: i === 0 ? 10 : 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: i === 0 ? 3 : 0,
    bookCount: i === 0 ? 1 : 0,
  }));
  const quarters = [
    { quarter: "Q1" as const, total: 10, activeMonths: 1, matchedRecords: 3, bookCount: 1 },
    { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
  ];
  return {
    ok: true,
    selectedYear: year,
    availableYears: [year, year - 1, year - 2],
    overview: {
      year,
      totalRecords: 10,
      datedRecords: 10,
      matchedRecords: 3,
      matchedBooks: 1,
      activeMonths: 1,
      longestStreakMonths: 1,
      firstNoteAt: null,
      lastNoteAt: null,
      peakMonth: `${year}-01`,
      peakMonthRecords: 10,
      averageRecordsPerActiveMonth: 10,
    },
    months,
    quarters,
    topBooks: [makeBook("A", "测试书目 A", "作者甲", 10, 1)],
    meta: {
      topBooksRequested: 12,
      topBooksReturned: 1,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
    ...overrides,
  };
}

// ---------- structural checks ----------

describe("YearComparisonPanel structural", () => {
  it("1. declares entry toggle testid for the dashboard", () => {
    expect(dashboard).toContain("weread-year-comparison-toggle");
  });
  it("2. default state keeps the comparison closed (no second request fired)", () => {
    // The dashboard must NOT call fetchWereadAnnualReview unless
    // the toggle is enabled. We assert the structural guard.
    expect(dashboard).toContain("INITIAL_COMPARISON");
    expect(dashboard).toMatch(/comparison\.enabled/);
    // The toggle path only triggers fetchWereadAnnualReview when enabled.
    expect(dashboard).toContain("handleToggleComparison");
  });
  it("3. declares base/target year selectors", () => {
    // base/target year selectors live in AnnualReviewDashboard so the
    // cache invalidation lives next to the request layer.
    expect(dashboard).toContain("weread-year-comparison-base-year");
    expect(dashboard).toContain("weread-year-comparison-target-year");
  });
  it("4. declares swap and close buttons", () => {
    expect(panel).toContain("weread-year-comparison-swap");
    expect(panel).toContain("weread-year-comparison-close");
  });
  it("5. declares topBooks range control on the panel", () => {
    // The panel renders the radio inputs as a dynamic template.
    expect(panel).toContain("weread-year-comparison-top-books-${opt}");
    expect(panel).toMatch(/weread-year-comparison-top-books-\$\{opt\}/);
  });
  it("6. declares metrics, timeline, quarters, book groups, summaries testids", () => {
    const required = [
      "weread-year-comparison-metrics",
      "weread-year-comparison-timeline",
      "weread-year-comparison-timeline-svg",
      "weread-year-comparison-quarters",
      "weread-year-comparison-books",
      "weread-year-comparison-summaries",
    ];
    for (const id of required) {
      expect(panel).toContain(id);
    }
  });
  it("7. does not import MiniMax or related-books helpers (panel + dashboard)", () => {
    const stripComments = (raw: string) =>
      raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "");
    expect(stripComments(panel)).not.toContain("fetchWereadAiSummary");
    expect(stripComments(panel)).not.toContain("fetchWereadRelatedBooks");
    expect(stripComments(dashboard)).not.toContain("fetchWereadAiSummary");
    expect(stripComments(dashboard)).not.toContain("fetchWereadRelatedBooks");
  });
  it("8. does not use storage APIs", () => {
    const stripComments = (raw: string) =>
      raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "");
    expect(stripComments(panel)).not.toMatch(/localStorage|sessionStorage|IndexedDB/);
    expect(stripComments(dashboard)).not.toMatch(/localStorage|sessionStorage|IndexedDB/);
  });
  it("9. does not use dangerouslySetInnerHTML", () => {
    expect(panel).not.toContain("dangerouslySetInnerHTML");
    expect(dashboard).not.toContain("dangerouslySetInnerHTML");
  });
  it("10. does not reference forbidden data fields", () => {
    // Strip the privacy-contract docstring comment lines so the
    // test does not false-positive on documentation. The contract
    // documents what the code must NEVER do — not what it does.
    const codeOnly = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "");
    const codePanel = codeOnly(panel);
    const codeDashboard = codeOnly(dashboard);
    expect(codePanel).not.toMatch(/\bnote\.text\b/);
    expect(codePanel).not.toMatch(/\bnote\.comment\b/);
    expect(codePanel).not.toMatch(/\bsummary\.overview\b/);
    expect(codePanel).not.toMatch(/\bsummary\.keyPoints\b/);
    expect(codePanel).not.toMatch(/\bsummary\.reviewQuestions\b/);
    expect(codePanel).not.toMatch(/\bwereadBookId\b/);
    expect(codePanel).not.toMatch(/\bnoteId\b/);
    expect(codePanel).not.toMatch(/\bhighlightId\b/);
    expect(codeDashboard).not.toMatch(/\bnote\.text\b/);
    expect(codeDashboard).not.toMatch(/\bnote\.comment\b/);
    expect(codeDashboard).not.toMatch(/\bwereadBookId\b/);
  });
  it("11. style classes are declared in styles.css", () => {
    const required = [
      ".weread-year-comparison",
      ".weread-year-comparison__notice",
      ".weread-year-comparison__controls",
      ".weread-year-comparison__metrics",
      ".weread-year-comparison__metric",
      ".weread-year-comparison__timeline",
      ".weread-year-comparison__legend",
      ".weread-year-comparison__bars",
      ".weread-year-comparison__quarters",
      ".weread-year-comparison__books",
      ".weread-year-comparison__book-group",
      ".weread-year-comparison__book-card",
      ".weread-year-comparison__summaries",
      ".weread-year-comparison__empty",
      ".weread-year-comparison__error",
    ];
    for (const cls of required) {
      expect(styles).toContain(cls);
    }
  });
  it("12. YearComparisonPanel renders the notice about topBooks range", () => {
    expect(panel).toContain("并不表示开始或停止阅读");
  });
  it("13. YearComparisonPanel renders the descriptive disclaimer", () => {
    expect(panel).toContain("不代表阅读质量、兴趣或个人状态");
  });
  it("14. model does not import storage or AI helpers", () => {
    expect(model).not.toMatch(/localStorage|sessionStorage|IndexedDB/);
    expect(model).not.toContain("fetchWereadAiSummary");
    expect(model).not.toContain("fetchWereadRelatedBooks");
  });
  it("15. does not generate HTML strings in summaries", () => {
    const base = makeResponse();
    const target = makeResponse({ selectedYear: 2024 });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    for (const line of comparison.summaries) {
      expect(line).not.toMatch(/<[a-z][^>]*>/i);
    }
  });

  // ---------- S27K-2 — Browser-local Markdown export ----------

  it("16. declares the export button, notice and status testids", () => {
    expect(panel).toContain("weread-year-comparison-export");
    expect(panel).toContain("weread-year-comparison-export-actions");
    expect(panel).toContain("weread-year-comparison-export-button");
    expect(panel).toContain("weread-year-comparison-export-notice");
    expect(panel).toContain("weread-year-comparison-export-status");
    expect(panel).toContain("weread-year-comparison-export-status-error");
  });

  it("17. export button is disabled when the panel is in error state", () => {
    // We assert this statically: canExport is gated by `!showError`
    // and `showError` is `Boolean(errorMessage)`.
    expect(panel).toContain("const canExport = !showError;");
    expect(panel).toContain("disabled={!canExport}");
  });

  it("18. export button click handler does not call any fetch", () => {
    // The handler must never re-issue an annual-review request or
    // call AI / related-books helpers.
    const codeOnly = (raw: string) =>
      raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "");
    const codePanel = codeOnly(panel);
    expect(codePanel).toContain("handleExportClick");
    expect(codePanel).toContain("buildYearComparisonMarkdown");
    expect(codePanel).toContain("triggerYearComparisonMarkdownDownload");
    // The click handler body itself must not contain fetch calls.
    const handlerMatch = codePanel.match(
      /const handleExportClick[\s\S]*?\n  \};/m
    );
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch?.[0]).not.toMatch(/fetchWereadAnnualReview/);
    expect(handlerMatch?.[0]).not.toMatch(/fetchWereadAiSummary/);
    expect(handlerMatch?.[0]).not.toMatch(/fetchWereadRelatedBooks/);
  });

  it("19. export success state clears when base/target year or topBooks changes", () => {
    // useEffect with `exportResetKey` as the dependency must reset
    // both exportStatus and exportMessage.
    expect(panel).toContain("const exportResetKey");
    expect(panel).toContain("useEffect");
    expect(panel).toMatch(
      /useEffect\(\(\) => \{[\s\S]*?setExportStatus\("idle"\);[\s\S]*?setExportMessage\(""\);[\s\S]*?\}, \[exportResetKey\]\);/m
    );
  });

  it("20. export still works when both years are empty (canExport ignores emptyComparison)", () => {
    // canExport is `!showError` — it does NOT depend on
    // `emptyComparison`, so the button stays enabled for empty data.
    expect(panel).not.toMatch(/canExport\s*=\s*[^!]*emptyComparison/);
  });

  it("21. does not use dangerouslySetInnerHTML (panel + export)", () => {
    expect(panel).not.toContain("dangerouslySetInnerHTML");
  });

  it("22. does not embed private IDs / token / AI summary fields in the export path", () => {
    const codeOnly = (raw: string) =>
      raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "");
    const codePanel = codeOnly(panel);
    expect(codePanel).not.toMatch(/\bnote\.text\b/);
    expect(codePanel).not.toMatch(/\bnote\.comment\b/);
    expect(codePanel).not.toMatch(/\bsummary\.overview\b/);
    expect(codePanel).not.toMatch(/\bsummary\.keyPoints\b/);
    expect(codePanel).not.toMatch(/\bsummary\.reviewQuestions\b/);
    expect(codePanel).not.toMatch(/\bwereadBookId\b/);
    expect(codePanel).not.toMatch(/\bnoteId\b/);
    expect(codePanel).not.toMatch(/\bhighlightId\b/);
    expect(codePanel).not.toMatch(/\bchapterTitle\b/);
  });

  it("23. style classes for the export block are declared in styles.css", () => {
    for (const cls of [
      ".weread-year-comparison__export",
      ".weread-year-comparison__export-actions",
      ".weread-year-comparison__export-button",
      ".weread-year-comparison__export-notice",
      ".weread-year-comparison__export-status",
      ".weread-year-comparison__export-status--error",
    ]) {
      expect(styles).toContain(cls);
    }
  });

  it("24. export click never alerts / prompts / logs content", () => {
    const codeOnly = (raw: string) =>
      raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "");
    const codePanel = codeOnly(panel);
    const handlerMatch = codePanel.match(
      /const handleExportClick[\s\S]*?\n  \};/m
    );
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch?.[0]).not.toMatch(/\balert\(/);
    expect(handlerMatch?.[0]).not.toMatch(/\bprompt\(/);
    expect(handlerMatch?.[0]).not.toMatch(/\bconfirm\(/);
    expect(handlerMatch?.[0]).not.toMatch(/console\.(log|info|warn|error)/);
  });
});

// ---------- model-driven behaviour ----------

describe("YearComparisonPanel behaviour (via model)", () => {
  it("16. hasYearComparisonData is true when either year has topBooks", () => {
    const base = makeResponse();
    const empty = makeResponse({
      selectedYear: 2024,
      overview: {
        year: 2024,
        totalRecords: 0,
        datedRecords: 0,
        matchedRecords: 0,
        matchedBooks: 0,
        activeMonths: 0,
        longestStreakMonths: 0,
        firstNoteAt: null,
        lastNoteAt: null,
        peakMonth: null,
        peakMonthRecords: 0,
        averageRecordsPerActiveMonth: 0,
      },
      months: Array.from({ length: 12 }, (_, i) => ({
        month: `2024-${String(i + 1).padStart(2, "0")}`,
        total: 0,
        highlights: 0,
        thoughts: 0,
        reviews: 0,
        unknown: 0,
        matched: 0,
        bookCount: 0,
      })),
      quarters: [
        { quarter: "Q1" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
      topBooks: [],
    });
    const comparison = buildWereadYearComparison({ base, target: empty, topBooksRange: 12 });
    expect(hasYearComparisonData(comparison)).toBe(true);
  });
  it("17. base/target year selector defaults are surfaced through data attributes", () => {
    // The panel reads comparison.baseYear / targetYear.
    const base = makeResponse();
    const target = makeResponse({ selectedYear: 2024 });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    expect(comparison.baseYear).toBe(base.selectedYear);
    expect(comparison.targetYear).toBe(target.selectedYear);
    expect(panel).toContain("data-base-year");
    expect(panel).toContain("data-target-year");
  });
  it("18. continuing/entered/left counts survive serialisation", () => {
    const base = makeResponse({
      topBooks: [makeBook("A", "基准 A", "甲", 8, 1), makeBook("B", "基准 B", "乙", 5, 2)],
    });
    const target = makeResponse({
      selectedYear: 2024,
      topBooks: [makeBook("A", "目标 A", "甲", 12, 1), makeBook("C", "目标 C", "丙", 4, 2)],
    });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    expect(comparison.continuingBooks).toHaveLength(1);
    expect(comparison.enteredBooks).toHaveLength(1);
    expect(comparison.leftBooks).toHaveLength(1);
  });
  it("19. delta is target - base (positive when target grew)", () => {
    const base = makeResponse();
    const target = makeResponse({
      selectedYear: 2024,
      overview: {
        year: 2024,
        totalRecords: 20,
        datedRecords: 20,
        matchedRecords: 5,
        matchedBooks: 2,
        activeMonths: 2,
        longestStreakMonths: 2,
        firstNoteAt: null,
        lastNoteAt: null,
        peakMonth: "2024-02",
        peakMonthRecords: 15,
        averageRecordsPerActiveMonth: 10,
      },
    });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const total = comparison.metrics.find((m) => m.key === "totalRecords");
    expect(total?.delta).toBe(10);
  });
  it("20. empty base + non-empty target still produces summaries", () => {
    const empty = makeResponse({
      overview: {
        year: 2024,
        totalRecords: 0,
        datedRecords: 0,
        matchedRecords: 0,
        matchedBooks: 0,
        activeMonths: 0,
        longestStreakMonths: 0,
        firstNoteAt: null,
        lastNoteAt: null,
        peakMonth: null,
        peakMonthRecords: 0,
        averageRecordsPerActiveMonth: 0,
      },
      months: Array.from({ length: 12 }, (_, i) => ({
        month: `2024-${String(i + 1).padStart(2, "0")}`,
        total: 0,
        highlights: 0,
        thoughts: 0,
        reviews: 0,
        unknown: 0,
        matched: 0,
        bookCount: 0,
      })),
      quarters: [
        { quarter: "Q1" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
      topBooks: [],
    });
    const target = makeResponse();
    const comparison = buildWereadYearComparison({ base: empty, target, topBooksRange: 12 });
    expect(comparison.summaries.length).toBeGreaterThan(0);
  });
});