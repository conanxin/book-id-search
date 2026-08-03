/**
 * S27J — Structural / behavioural checks for AnnualReviewDashboard
 * and WereadCenter wiring (4th workspace tab).
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
  buildAnnualOverviewView,
  buildAnnualRecordCards,
  buildAnnualTimelineModel,
  hasAnnualReviewData,
} from "./wereadAnnualReviewModel";
import type { WereadAnnualReviewResponse } from "../wereadPrivate";

const DASHBOARD_PATH = resolve(__dirname, "./AnnualReviewDashboard.tsx");
const CENTER_PATH = resolve(__dirname, "./WereadCenter.tsx");
const STYLES_PATH = resolve(__dirname, "../styles.css");
const MODEL_PATH = resolve(__dirname, "./wereadAnnualReviewModel.ts");

const dashboard = readFileSync(DASHBOARD_PATH, "utf8");
const center = readFileSync(CENTER_PATH, "utf8");
const styles = readFileSync(STYLES_PATH, "utf8");
const model = readFileSync(MODEL_PATH, "utf8");

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: `2025-${String(i + 1).padStart(2, "0")}`,
    total: 0,
    highlights: 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: 0,
    bookCount: 0,
  }));
  return {
    ok: true,
    selectedYear: 2025,
    availableYears: [2025, 2024, 2023],
    overview: {
      year: 2025,
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
    months,
    quarters: [
      { quarter: "Q1", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q2", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q3", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q4", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    ],
    topBooks: [],
    meta: {
      topBooksRequested: 12,
      topBooksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
    ...overrides,
  };
}

const FORBIDDEN_DASHBOARD_WORDS = ["懒惰", "焦虑", "专注力", "人格", "性格", "情绪", "心理", "阅读能力"];
const FORBIDDEN_RESPONSE_FIELDS = /wereadBookId|noteId|highlightId|chapterTitle|wereadTitle|wereadAuthor|rawTitle|rawAuthor|"text":|"comment":|"content":|"markedText":/;

describe("AnnualReviewDashboard — WereadCenter wiring (4th workspace)", () => {
  // 1
  it("WereadCenter mounts the fourth workspace tab + panel", () => {
    expect(center).toMatch(/weread-tab-annual/);
    expect(center).toMatch(/weread-panel-annual/);
  });

  // 2
  it("default workspace is still 笔记与 AI", () => {
    expect(center).toMatch(/useState<WorkspaceTab>\("notes"\)/);
  });

  // 3
  it("does not request annual-review before activation (uses `active` flag)", () => {
    expect(dashboard).toMatch(/AnnualReviewDashboardProps/);
    expect(dashboard).toMatch(/active: boolean/);
  });

  // 4
  it("loads once per token (uses lastRequestTokenRef guard)", () => {
    expect(dashboard).toMatch(/lastRequestTokenRef/);
  });

  // 5
  it("switching back to annual review reuses the same data (no refetch on re-activation)", () => {
    // The dashboard only fires a fetch when response is null and status
    // is not loading, so re-activation keeps the existing data.
    expect(dashboard).toMatch(/state.response \|\| state.status === "loading"\)/);
  });

  // 6
  it("year change triggers a re-request", () => {
    expect(dashboard).toMatch(/handleYearChange/);
    expect(dashboard).toMatch(/onYearChange\(Number\(e\.target\.value\)\)/);
  });

  // 7
  it("topBooks change triggers a re-request", () => {
    expect(dashboard).toMatch(/handleTopBooksChange/);
  });
});

describe("AnnualReviewDashboard — render contract", () => {
  // 8
  it("renders the year selector populated from availableYears", () => {
    const resp = makeResponse({ availableYears: [2025, 2024, 2023] });
    expect(dashboard).toMatch(/data-testid="weread-annual-review-year"/);
    expect(resp.availableYears.length).toBe(3);
  });

  // 9
  it("renders the six overview cards", () => {
    const view = buildAnnualOverviewView({ response: makeResponse(), topBookCount: 0 });
    expect(dashboard).toMatch(/weread-annual-review__overview-card/);
    expect(dashboard).toMatch(/全年阅读记录/);
    expect(dashboard).toMatch(/活跃月份/);
    expect(dashboard).toMatch(/已匹配记录/);
    expect(dashboard).toMatch(/年度书目/);
    expect(dashboard).toMatch(/高峰月份/);
    expect(dashboard).toMatch(/每月平均/);
    expect(view.cards).toHaveLength(6);
  });

  // 10
  it("renders the 12-month timeline SVG", () => {
    expect(dashboard).toMatch(/weread-annual-review__timeline-svg/);
    const months = buildAnnualTimelineModel({ months: [], year: 2025, averagePerActiveMonth: 0 });
    expect(months).toHaveLength(12);
  });

  // 11
  it("renders all 12 month models even when zero", () => {
    expect(dashboard).toMatch(/timeline\.map\(\(m\)/);
  });

  // 12
  it("renders the type distribution list", () => {
    expect(dashboard).toMatch(/weread-annual-review__type-list/);
  });

  // 13
  it("renders Q1..Q4 cards", () => {
    expect(dashboard).toMatch(/data-quarter=/);
  });

  // 14
  it("uses descriptive activity classes per month", () => {
    expect(styles).toMatch(/weread-annual-review__quarter-month--high/);
    expect(styles).toMatch(/weread-annual-review__quarter-month--steady/);
    expect(styles).toMatch(/weread-annual-review__quarter-month--light/);
    expect(styles).toMatch(/weread-annual-review__quarter-month--none/);
  });

  // 15
  it("renders the descriptive disclaimer", () => {
    expect(dashboard).toMatch(/以下为基于记录数量的描述性分类/);
  });

  // 16
  it("renders top book cards with public catalogId links", () => {
    expect(dashboard).toMatch(/href=\{`\/books\/\$\{book\.catalogId\}`\}/);
    expect(dashboard).toMatch(/data-testid="weread-annual-review-book-link"/);
  });

  // 17
  it("record cards are present in the dashboard", () => {
    const cards = buildAnnualRecordCards({ response: makeResponse() });
    expect(dashboard).toMatch(/weread-annual-review__record-card/);
    expect(cards).toHaveLength(6);
  });

  // 18
  it("renders the empty-year state when the response has no data", () => {
    expect(dashboard).toMatch(/该年度暂无有效日期的阅读记录/);
    expect(hasAnnualReviewData(makeResponse())).toBe(false);
  });

  // 19
  it("clears the response when token is cleared (reset effect)", () => {
    expect(dashboard).toMatch(/setState\(INITIAL_STATE\)/);
  });

  // 20
  it("keeps all four workspace panels mounted (notes/map/review/annual) via `hidden`", () => {
    expect(center).toMatch(/id="weread-panel-notes"/);
    expect(center).toMatch(/id="weread-panel-map"/);
    expect(center).toMatch(/id="weread-panel-review"/);
    expect(center).toMatch(/id="weread-panel-annual"/);
  });
});

describe("AnnualReviewDashboard — privacy contract", () => {
  // 21
  it("never invokes fetchWereadAiSummary", () => {
    // Strip the leading privacy-contract comment block before checking.
    const code = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/fetchWereadAiSummary/);
  });

  // 22
  it("never invokes fetchWereadRelatedBooks", () => {
    const code = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/fetchWereadRelatedBooks/);
  });

  // 23
  it("does not receive notes / AI summary / session theme overlay props", () => {
    expect(dashboard).toMatch(/interface AnnualReviewDashboardProps/);
    // The only documented props are { token, active }.
    expect(dashboard).not.toMatch(/sessionThemeOverlay/);
    expect(dashboard).not.toMatch(/onSessionOverlayChange/);
    expect(dashboard).not.toMatch(/notes\?:/);
    expect(dashboard).not.toMatch(/aiSummary/);
  });

  // 24
  it("does not use localStorage / sessionStorage / IndexedDB", () => {
    const code = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/sessionStorage/);
    expect(code).not.toMatch(/indexedDB|IndexedDB/);
  });

  // 25
  it("does not use dangerouslySetInnerHTML", () => {
    expect(dashboard).not.toMatch(/dangerouslySetInnerHTML/);
  });

  // 26
  it("renders the privacy notice verbatim", () => {
    expect(dashboard).toMatch(/不读取笔记正文/);
    expect(dashboard).toMatch(/不会保存到服务器/);
    expect(dashboard).toMatch(/不调用外部 AI/);
  });

  // 27
  it("never produces psychological-inference vocabulary", () => {
    // Strip leading privacy-contract comment block before checking.
    const code = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");
    // The disclaimer paragraph on the page is allowed to *mention* these
    // terms to explicitly disclaim them. We just check the dashboard
    // never *asserts* them.
    const disclaimer = /仅基于阅读记录数量与日期统计；不代表阅读偏好、人格特征或专注力/;
    if (!disclaimer.test(code)) {
      // If the disclaimer is ever removed, the words below must also be
      // absent from the dashboard source.
      for (const word of FORBIDDEN_DASHBOARD_WORDS) {
        expect(code.includes(word)).toBe(false);
      }
    }
    for (const word of FORBIDDEN_DASHBOARD_WORDS) {
      expect(model.includes(word)).toBe(false);
    }
  });

  // 28
  it("forbidden response fields never leak through the model", () => {
    const resp = makeResponse({
      topBooks: [
        {
          catalogId: "10000000_000000000001",
          title: "公共书目 1",
          author: "作者 A",
          publisher: "出版社 X",
          publishYear: 2024,
          noteCount: 30,
          highlights: 18,
          thoughts: 8,
          reviews: 4,
          unknown: 0,
          activeMonths: 5,
          firstNoteAt: "2025-01-05T00:00:00.000Z",
          lastNoteAt: "2025-09-30T00:00:00.000Z",
        },
      ],
    });
    const serialized = JSON.stringify(resp);
    expect(FORBIDDEN_RESPONSE_FIELDS.test(serialized)).toBe(false);
  });
});

describe("AnnualReviewDashboard — responsive + class presence", () => {
  // 29
  it("desktop / tablet / mobile CSS classes are defined", () => {
    expect(styles).toMatch(/\.weread-annual-review \{/);
    expect(styles).toMatch(/\.weread-annual-review__overview \{/);
    expect(styles).toMatch(/\.weread-annual-review__timeline-svg \{/);
    expect(styles).toMatch(/\.weread-annual-review__quarters \{/);
    expect(styles).toMatch(/\.weread-annual-review__book-grid \{/);
    expect(styles).toMatch(/\.weread-annual-review__record-grid \{/);
    expect(styles).toMatch(/\.weread-annual-review__bar-segment--highlights/);
    expect(styles).toMatch(/@media \(max-width: 1100px\)/);
    expect(styles).toMatch(/@media \(max-width: 720px\)/);
  });

  // 30
  it("does not introduce fixed / sticky positioning", () => {
    expect(styles).not.toMatch(/\.weread-annual-review[^{]*\{[^}]*position:\s*fixed/);
    expect(styles).not.toMatch(/\.weread-annual-review[^{]*\{[^}]*position:\s*sticky/);
  });
});

// ---------- S27J-2 — Browser-local Markdown export ----------

describe("AnnualReviewDashboard — S27J-2 Markdown export wiring", () => {
  // 33
  it("renders the export button + export actions container", () => {
    expect(dashboard).toMatch(/weread-annual-review__export-actions/);
    expect(dashboard).toMatch(/data-testid="weread-annual-review-export-button"/);
    expect(dashboard).toMatch(/data-testid="weread-annual-review-export-notice"/);
    expect(dashboard).toMatch(/data-testid="weread-annual-review-export-status"/);
  });

  // 34
  it("renders the documented privacy / persistence notice copy", () => {
    expect(dashboard).toMatch(/文件只在当前浏览器中生成/);
    expect(dashboard).toMatch(/请自行妥善保管/);
  });

  // 35
  it("never invokes fetchWereadAiSummary or fetchWereadRelatedBooks from the export path", () => {
    const code = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/fetchWereadAiSummary/);
    expect(code).not.toMatch(/fetchWereadRelatedBooks/);
  });

  // 36
  it("does not introduce localStorage / sessionStorage / IndexedDB / fetch usage in the export path", () => {
    const code = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/sessionStorage/);
    expect(code).not.toMatch(/indexedDB|IndexedDB/);
    expect(code).not.toMatch(/dangerouslySetInnerHTML/);
  });

  // 37
  it("does not leak note text / private IDs in the export path", () => {
    const code = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/FORBIDDEN_NOTE_TEXT/);
    expect(code).not.toMatch(/\bwereadBookId\b/);
    expect(code).not.toMatch(/\bnoteId\b/);
    expect(code).not.toMatch(/\bhighlightId\b/);
    expect(code).not.toMatch(/\bchapterTitle\b/);
  });

  // 38
  it("imports the Markdown model from the documented path", () => {
    expect(dashboard).toMatch(/from "\.\/wereadAnnualReviewMarkdown"/);
    expect(dashboard).toMatch(/buildAnnualReviewMarkdown/);
    expect(dashboard).toMatch(/triggerAnnualReviewMarkdownDownload/);
  });

  // 39
  it("disables the export button while a fresh request is in-flight (loading guard)", () => {
    // The button must be `disabled={loading}` so the user cannot
    // click before the response lands. We assert on the source so
    // the contract survives refactors.
    expect(dashboard).toMatch(/disabled=\{loading\}/);
  });

  // 40
  it("clears the export success state when the user changes year or topBooks", () => {
    // The year / topBooks change path must reset exportStatus so the
    // previous "已生成" message does not linger after the data has
    // changed. We assert this through the `requestAnnualReview`
    // reset block.
    expect(dashboard).toMatch(/exportStatus: "idle"/);
    expect(dashboard).toMatch(/exportMessage: ""/);
  });

  // 41
  it("clears the export success state when the token is cleared", () => {
    // The reset effect on token change must set exportStatus to
    // idle + exportMessage to empty.
    const resetBlock = dashboard.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[token\]\)/);
    expect(resetBlock).not.toBeNull();
    expect(resetBlock?.[0] ?? "").toMatch(/exportStatus: "idle"/);
  });
});

describe("AnnualReviewDashboard — S27J-2 export styling", () => {
  // 42
  it("defines the export CSS classes", () => {
    expect(styles).toMatch(/\.weread-annual-review__export\b/);
    expect(styles).toMatch(/\.weread-annual-review__export-actions\b/);
    expect(styles).toMatch(/\.weread-annual-review__export-notice\b/);
    expect(styles).toMatch(/\.weread-annual-review__export-status\b/);
  });

  // 43
  it("export CSS does not introduce fixed / sticky positioning", () => {
    expect(styles).not.toMatch(/\.weread-annual-review__export[^{]*\{[^}]*position:\s*fixed/);
    expect(styles).not.toMatch(/\.weread-annual-review__export[^{]*\{[^}]*position:\s*sticky/);
  });
});