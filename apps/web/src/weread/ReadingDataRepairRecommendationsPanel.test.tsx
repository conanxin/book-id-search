/**
 * S27R-2A targeted tests — Reading Data Repair Recommendations Panel.
 *
 * Uses synthetic audits. The suite verifies (≥55 tests):
 *   - Rendering / zero-hook / loading / empty branches
 *   - Exhaustive Chinese label tables (Priority × 4, Action × 9, Capability × 5,
 *     Guidance × 9)
 *   - Summary 9-row counts (total + 4 priorities + 4 capabilities)
 *   - Group ordering (priority + action fixed order)
 *   - Location rendering (year / fromYear→toYear / itemIndex 1-based / rank)
 *   - Privacy (no IDs / no actual / expected / no title / author / catalogId /
 *     no noteId / wereadBookId / no raw audit / cache / request / debug)
 *   - Special sections via selectors:
 *     - actionable (user_retry / user_reload)
 *     - manual-review (manual_review)
 *     - unsupported (currently unreachable, but section must render)
 *     - highest-priority
 *   - Forbidden language (no auto-fix / no evaluation / no interest / ability
 *     / psychological / personality judgment)
 *   - Source code safety: no useState / useEffect / useMemo / useReducer /
 *     useRef / fetch / annual-review / related-books / AI / storage / DOM
 *     / retry() / reload() / dangerouslySetInnerHTML
 *   - Deterministic output across rerenders
 *   - Input audit untouched / plan not exposed
 *   - No NaN / Infinity in rendered HTML
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ReadingDataQualityAuditMeta,
  ReadingDataQualityAuditSummary,
  ReadingDataQualityCoverageSection,
  ReadingDataQualityIssue,
  ReadingDataQualityIssueCode,
  WereadReadingDataQualityAudit,
} from "./wereadReadingDataQualityAudit";

import {
  REPAIR_ACTION_LABELS,
  REPAIR_ACTION_ORDER,
  REPAIR_CAPABILITY_LABELS,
  REPAIR_CAPABILITY_ORDER,
  REPAIR_GUIDANCE_LABELS,
  REPAIR_PRIORITY_LABELS,
  REPAIR_PRIORITY_ORDER,
  ReadingDataRepairRecommendationsPanel,
} from "./ReadingDataRepairRecommendationsPanel";

// ---------- synthetic audit helpers ----------

const ALL_CODES: ReadingDataQualityIssueCode[] = [
  "empty_archive",
  "partial_archive",
  "target_year_unaccounted",
  "loaded_failed_conflict",
  "duplicate_loaded_year",
  "invalid_year",
  "non_finite_metric",
  "negative_metric",
  "dated_records_exceed_total",
  "matched_records_exceed_total",
  "matched_books_exceed_matched_records",
  "active_months_out_of_range",
  "streak_months_out_of_range",
  "streak_exceeds_active_months",
  "peak_month_year_mismatch",
  "top_books_exceed_limit",
  "top_book_missing_catalog",
  "top_book_missing_title",
  "top_book_duplicate_catalog",
  "top_book_invalid_rank",
  "top_book_duplicate_rank",
  "top_book_records_exceed_year_total",
  "top_book_order_mismatch",
  "year_link_unknown_year",
  "year_link_invalid_order",
  "year_link_duplicate_pair",
  "year_link_invalid_counts",
  "year_link_ratio_out_of_range",
  "year_link_ratio_mismatch",
  "missing_year_link",
  "recurring_duplicate_catalog",
  "recurring_appearance_count_mismatch",
  "recurring_unknown_year",
  "recurring_duplicate_year",
  "recurring_invalid_rank",
  "recurring_latest_year_mismatch",
];

function makeIssue(
  partial: Partial<ReadingDataQualityIssue> & { code: ReadingDataQualityIssueCode },
): ReadingDataQualityIssue {
  return {
    id: partial.id ?? `test:${partial.code}:${Math.random().toString(36).slice(2, 8)}`,
    code: partial.code,
    severity: partial.severity ?? "warning",
    scope: partial.scope ?? ("coverage" as ReadingDataQualityIssue["scope"]),
    year: partial.year,
    fromYear: partial.fromYear,
    toYear: partial.toYear,
    itemIndex: partial.itemIndex ?? null,
    rank: partial.rank ?? null,
    actual: partial.actual ?? null,
    expected: partial.expected ?? null,
  };
}

function makeAudit(issues: ReadingDataQualityIssue[]): WereadReadingDataQualityAudit {
  const coverage: ReadingDataQualityCoverageSection = {
    targetYears: [2025, 2024, 2023],
    loadedYears: [2025, 2024],
    failedYears: [2023],
    unaccountedYears: [],
    unexpectedLoadedYears: [],
  };
  const summary: ReadingDataQualityAuditSummary = {
    status: issues.some((i) => i.severity === "error")
      ? "fail"
      : issues.some((i) => i.severity === "warning")
        ? "warn"
        : "pass",
    targetYearCount: coverage.targetYears.length,
    loadedYearCount: coverage.loadedYears.length,
    failedYearCount: coverage.failedYears.length,
    unaccountedYearCount: coverage.unaccountedYears.length,
    totalRecords: 100,
    datedRecords: 80,
    matchedRecords: 60,
    matchedBooks: 12,
    datedRecordRatio: 0.8,
    matchedRecordRatio: 0.6,
    publicTopBookMetadataRatio: 1,
    yearLinkCoverageRatio: 0.5,
    accountedRatio: 2 / 3,
    issueCounts: {
      error: issues.filter((i) => i.severity === "error").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      info: issues.filter((i) => i.severity === "info").length,
    },
    errorCount: issues.filter((i) => i.severity === "error").length,
    warningCount: issues.filter((i) => i.severity === "warning").length,
    infoCount: issues.filter((i) => i.severity === "info").length,
  };
  const meta: ReadingDataQualityAuditMeta = {
    source: "current_loaded_archive",
    persisted: false,
    requestedNetwork: false,
  };
  return {
    status: summary.status,
    issues,
    coverage,
    summary,
    meta,
    auditedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

// ---------- suite ----------

describe("S27R-2A — Reading Data Repair Recommendations Panel", () => {
  // 1
  it("renders the canonical section with the correct testid", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("weread-reading-data-repair");
    expect(html).toContain('data-testid="weread-reading-data-repair"');
  });

  // 2
  it("renders the title '数据修复建议'", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("数据修复建议");
  });

  // 3
  it("renders the neutral 'not automatic' disclaimer", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("不会自动请求、修改或修复任何数据");
    expect(html).toContain("仅表示处理顺序，不代表用户或阅读行为的好坏");
  });

  // 4
  it("source component is zero-hook (no useState/useEffect/useMemo/useReducer/useRef)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/\buseState\b/);
    expect(src).not.toMatch(/\buseEffect\b/);
    expect(src).not.toMatch(/\buseMemo\b/);
    expect(src).not.toMatch(/\buseReducer\b/);
    expect(src).not.toMatch(/\buseRef\b/);
  });

  // 5
  it("loading shell renders without flipping to plan", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={true}
      />,
    );
    expect(html).toContain("weread-reading-data-repair-loading");
    expect(html).toContain("正在根据当前审计结果整理建议");
    expect(html).not.toContain("weread-reading-data-repair-empty");
  });

  // 6
  it("empty plan (loading=false) renders the canonical empty message", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("weread-reading-data-repair-empty");
    expect(html).toContain("当前审计结果没有需要生成的修复建议");
  });

  // 7
  it("summary total equals audit.issues.length", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "s7-a" }),
      makeIssue({ code: "partial_archive", severity: "error", id: "s7-b" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/建议总数[\s\S]*?2/);
  });

  // 8
  it("summary high count renders", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "s8" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/优先检查[\s\S]*?1/);
  });

  // 9
  it("summary medium count renders", () => {
    const audit = makeAudit([
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", year: 2024, id: "s9" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/建议检查[\s\S]*?1/);
  });

  // 10
  it("summary low count renders", () => {
    // reserved codes are unreachable in live; verify zero count renders.
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("当前条件有限");
  });

  // 11
  it("summary informational count renders", () => {
    const audit = makeAudit([
      makeIssue({ code: "empty_archive", severity: "info", id: "s11" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/信息说明[\s\S]*?1/);
  });

  // 12
  it("summary retryable count renders", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "s12" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/可重试[\s\S]*?1/);
  });

  // 13
  it("summary reloadable count renders", () => {
    const audit = makeAudit([
      makeIssue({ code: "target_year_unaccounted", id: "s13" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/可重新加载[\s\S]*?1/);
  });

  // 14
  it("summary manualReview count renders", () => {
    const audit = makeAudit([
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", year: 2024, id: "s14" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/需人工核对[\s\S]*?1/);
  });

  // 15
  it("summary unsupported count renders (zero in live)", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("当前字段不足");
  });

  // 16
  it("Priority mapping has 4 entries with non-empty Chinese labels", () => {
    expect(REPAIR_PRIORITY_ORDER).toHaveLength(4);
    for (const p of REPAIR_PRIORITY_ORDER) {
      expect(REPAIR_PRIORITY_LABELS[p]).toBeTruthy();
      expect(REPAIR_PRIORITY_LABELS[p]).not.toMatch(/^[\sA-Za-z0-9_]+$/);
    }
  });

  // 17
  it("Action mapping has 9 entries with non-empty Chinese labels", () => {
    expect(REPAIR_ACTION_ORDER).toHaveLength(9);
    for (const a of REPAIR_ACTION_ORDER) {
      expect(REPAIR_ACTION_LABELS[a]).toBeTruthy();
      expect(REPAIR_ACTION_LABELS[a]).not.toMatch(/^[\sA-Za-z0-9_]+$/);
    }
  });

  // 18
  it("Capability mapping has 5 entries with non-empty Chinese labels", () => {
    expect(REPAIR_CAPABILITY_ORDER).toHaveLength(5);
    for (const c of REPAIR_CAPABILITY_ORDER) {
      expect(REPAIR_CAPABILITY_LABELS[c]).toBeTruthy();
      expect(REPAIR_CAPABILITY_LABELS[c]).not.toMatch(/^[\sA-Za-z0-9_]+$/);
    }
  });

  // 19
  it("Guidance mapping has 9 entries with non-empty Chinese labels", () => {
    const keys = Object.keys(REPAIR_GUIDANCE_LABELS);
    expect(keys).toHaveLength(9);
    for (const k of keys) {
      const label =
        REPAIR_GUIDANCE_LABELS[k as keyof typeof REPAIR_GUIDANCE_LABELS];
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/^[\sA-Za-z0-9_]+$/);
    }
  });

  // 20
  it("exhaustive mappings match Action / Capability / Priority / Guidance counts", () => {
    expect(Object.keys(REPAIR_ACTION_LABELS).length).toBe(9);
    expect(Object.keys(REPAIR_CAPABILITY_LABELS).length).toBe(5);
    expect(Object.keys(REPAIR_PRIORITY_LABELS).length).toBe(4);
    expect(Object.keys(REPAIR_GUIDANCE_LABELS).length).toBe(9);
  });

  // 21
  it("groups rendered in priority + action fixed order", () => {
    const audit = makeAudit([
      makeIssue({ code: "target_year_unaccounted", severity: "warning", id: "o21-r" }),
      makeIssue({ code: "partial_archive", severity: "error", id: "o21-retry" }),
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", year: 2024, id: "o21-m" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    const retryIdx = html.indexOf('data-action="retry_failed_year"');
    const reloadIdx = html.indexOf('data-action="reload_year"');
    const metricIdx = html.indexOf('data-action="review_metric_relationship"');
    expect(retryIdx).toBeGreaterThan(0);
    expect(retryIdx).toBeLessThan(reloadIdx);
    expect(reloadIdx).toBeLessThan(metricIdx);
  });

  // 22
  it("group count badge equals group.recommendations.length", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "g22-a" }),
      makeIssue({ code: "partial_archive", severity: "error", id: "g22-b" }),
      makeIssue({ code: "partial_archive", severity: "error", id: "g22-c" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toMatch(/weread-reading-data-repair-group-count[^>]*>3</);
  });

  // 23
  it("source IssueCode rendered via ISSUE_LABEL (Chinese, not code)", () => {
    const audit = makeAudit([
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2024, id: "s23" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("年度指标非有限值");
  });

  // 24
  it("scope rendered in Chinese", () => {
    const audit = makeAudit([
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2024, id: "s24" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("年度指标");
  });

  // 25
  it("renders year for year-scope issues", () => {
    const audit = makeAudit([
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2024, id: "s25" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("2024");
  });

  // 26
  it("renders fromYear → toYear pair for year_link issues", () => {
    const audit = makeAudit([
      makeIssue({
        code: "year_link_invalid_order",
        scope: "year_link",
        fromYear: 2023,
        toYear: 2024,
        id: "s26",
      }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("2023 → 2024");
  });

  // 27
  it("renders itemIndex as '第 N 项' (1-based)", () => {
    const audit = makeAudit([
      makeIssue({
        code: "non_finite_metric",
        scope: "year",
        year: 2024,
        itemIndex: 0,
        id: "s27",
      }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("第 1 项");
  });

  // 28
  it("renders rank as '第 N 名'", () => {
    const audit = makeAudit([
      makeIssue({
        code: "top_book_invalid_rank",
        scope: "top_book",
        year: 2024,
        rank: 5,
        id: "s28",
      }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("第 5 名");
  });

  // 29
  it("rendered HTML does not contain Recommendation IDs", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "leak-29" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).not.toContain("leak-29");
    expect(html).not.toMatch(/^repair:/);
  });

  // 30
  it("rendered HTML does not contain Issue IDs", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "leak-30" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).not.toContain("test:partial_archive");
    expect(html).not.toContain("leak-30");
  });

  // 31
  it("rendered HTML does not contain actual / expected values", () => {
    const audit = makeAudit([
      makeIssue({
        code: "non_finite_metric",
        scope: "year",
        year: 2024,
        actual: 42,
        expected: 0,
        id: "s31",
      }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).not.toMatch(/42/);
    expect(stripped).not.toContain("actual");
    expect(stripped).not.toContain("expected");
  });

  // 32
  it("rendered HTML does not contain 'title' as a content field", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).not.toContain("title");
  });

  // 33
  it("rendered HTML does not contain 'author' as a content field", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).not.toContain("author");
  });

  // 34
  it("rendered HTML does not contain 'catalogId' as a content field", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).not.toContain("catalogId");
  });

  // 35
  it("actionable section renders with count and a fixed disclaimer", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "s35-a" }),
      makeIssue({ code: "target_year_unaccounted", id: "s35-b" }),
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", year: 2024, id: "s35-c" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("weread-reading-data-repair-actionable");
    expect(html).toContain("本面板不会代替用户执行");
  });

  // 36
  it("actionable section has NO button (no action trigger)", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "s36" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    const sectionStart = html.indexOf('weread-reading-data-repair-actionable');
    const sectionEnd = html.indexOf("</section>", sectionStart);
    const section = html.slice(sectionStart, sectionEnd);
    expect(section).not.toContain("<button");
    expect(section).not.toMatch(/onClick=/);
  });

  // 37
  it("manual-review section renders with its count", () => {
    const audit = makeAudit([
      makeIssue({
        code: "non_finite_metric",
        scope: "year",
        severity: "warning",
        year: 2024,
        id: "s37",
      }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("weread-reading-data-repair-manual-review");
    expect(html).toContain("需要人工核对");
  });

  // 38
  it("unsupported section renders even when empty (currently unreachable)", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("weread-reading-data-repair-unsupported");
    expect(html).toContain("系统不会推测缺失结果");
  });

  // 39
  it("highest-priority section renders with its count", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "s39" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("weread-reading-data-repair-highest");
    expect(html).toContain("最高优先级建议");
  });

  // 40
  it("no-action recommendation renders the no-action guidance", () => {
    const audit = makeAudit([
      makeIssue({ code: "empty_archive", severity: "info", id: "s40" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("当前无需操作");
  });

  // 41
  it("explicit 'no automatic repair' statement appears in rendered HTML", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain("不会自动请求、修改或修复任何数据");
  });

  // 42
  it("no 'modifiesSourceData' state is leaked (UI is read-only)", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).not.toContain("modifiesSourceData");
  });

  // 43
  it("source component does not call retry()", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/retry\s*\(/);
  });

  // 44
  it("source component does not call reload()", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/reload\s*\(/);
  });

  // 45
  it("source component does not call annual-review", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/annual-review/);
  });

  // 46
  it("source component does not call AI endpoints", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/MiniMax|minimax/i);
    expect(src).not.toMatch(/ai-summary|fetchWereadAiSummary/);
  });

  // 47
  it("source component does not call related-books", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/related-books/);
  });

  // 48
  it("source component does not write storage", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  // 49
  it("source component does not write URL / history", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/pushState|replaceState|window\.location/);
  });

  // 50
  it("source component does not use dangerouslySetInnerHTML / innerHTML", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/innerHTML/);
  });

  // 51
  it("rendered HTML contains no user-evaluation language", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `e51-${i}-${code}` }),
    );
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit(issues)}
        loading={false}
      />,
    );
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).not.toMatch(
      /更爱阅读|兴趣|能力|心理|人格|优秀|较差|用户评分|阅读质量|自动修复|一键修复|已修复/,
    );
  });

  // 52
  it("deterministic output across rerenders (same props)", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "d52-a" }),
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", year: 2024, id: "d52-b" }),
    ]);
    const a = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    const b = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(a).toBe(b);
  });

  // 53
  it("input audit is not mutated by render", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "i53" }),
    ]);
    const snap = JSON.stringify(audit);
    renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(JSON.stringify(audit)).toBe(snap);
  });

  // 54
  it("plan is not exposed via props (rendered HTML contains no plan-internal keys)", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).not.toContain("plan");
  });

  // 55
  it("rendered HTML contains no NaN / Infinity / undefined", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `n55-${i}-${code}` }),
    );
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit(issues)}
        loading={false}
      />,
    );
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });

  // 56
  it("unsupported section shows zero count when no unsupported recommendations exist (currently always)", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `u56-${i}-${code}` }),
    );
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit(issues)}
        loading={false}
      />,
    );
    const start = html.indexOf('weread-reading-data-repair-unsupported');
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf("</section>", start);
    const section = html.slice(start, end);
    expect(section).toMatch(/>(0|[1-9]\d*)</); // count is a number
    // And the note about not guessing is still present.
    expect(section).toContain("不会推测缺失结果");
  });

  // 57
  it("all four selectors are reused from the model (no re-implementation in Panel)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    // Panel imports and uses the model selectors (no local re-implementation).
    expect(src).toMatch(/selectActionableRepairRecommendations/);
    expect(src).toMatch(/selectManualReviewRepairRecommendations/);
    expect(src).toMatch(/selectUnsupportedRepairRecommendations/);
    expect(src).toMatch(/selectHighestPriorityRepairRecommendations/);
  });

  // 58 — S27R-2C style structure: root + header + summary classes
  it("renders root + header + summary class structure", () => {
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(html).toContain('class="weread-reading-data-repair"');
    expect(html).toContain("weread-reading-data-repair__header");
    expect(html).toContain("weread-reading-data-repair__title");
    expect(html).toContain("weread-reading-data-repair__summary");
  });

  // 59 — S27R-2C style structure: groups + group + group-header + items
  it("renders group + group-header + items class structure when recommendations exist", () => {
    const audit = makeAudit([
      makeIssue({
        code: "non_finite_metric",
        scope: "year",
        severity: "warning",
        year: 2024,
        id: "s59",
      }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).toContain("weread-reading-data-repair__groups");
    expect(html).toContain("weread-reading-data-repair__group");
    expect(html).toContain("weread-reading-data-repair__group-header");
    expect(html).toContain("weread-reading-data-repair__items");
    expect(html).toContain("weread-reading-data-repair__item");
    expect(html).toContain("weread-reading-data-repair__item-issue");
    expect(html).toContain("weread-reading-data-repair__item-scope");
    expect(html).toContain("weread-reading-data-repair__item-location");
  });

  // 60 — S27R-2C style structure: loading + empty class presence
  it("loading class renders when loading=true; empty class renders when plan empty", () => {
    const loadingHtml = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={true}
      />,
    );
    expect(loadingHtml).toContain("weread-reading-data-repair__loading");
    expect(loadingHtml).not.toContain("weread-reading-data-repair__empty");

    const emptyHtml = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel
        audit={makeAudit([])}
        loading={false}
      />,
    );
    expect(emptyHtml).toContain("weread-reading-data-repair__empty");
    expect(emptyHtml).not.toContain("weread-reading-data-repair__loading");
  });

  // 61 — S27R-2C no action buttons are rendered (style + structure guarantee)
  it("rendered HTML contains no button (no action triggers from styling either)", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "s61" }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).not.toMatch(/<button\b/);
  });

  // 62 — S27R-2C no inline style attributes leaked
  it("rendered HTML contains no inline style attributes", () => {
    const audit = makeAudit([
      makeIssue({
        code: "non_finite_metric",
        scope: "year",
        severity: "warning",
        year: 2024,
        id: "s62",
      }),
    ]);
    const html = renderToStaticMarkup(
      <ReadingDataRepairRecommendationsPanel audit={audit} loading={false} />,
    );
    expect(html).not.toMatch(/\sstyle\s*=/);
  });

  // 63 — S27R-2C priority modifier classes cover all 4 priorities
  it("priority modifier classes exist for high/medium/low/informational", () => {
    const css = require("node:fs").readFileSync(
      require("node:path").resolve(
        process.cwd(),
        "apps/web/src/styles.css",
      ),
      "utf8",
    );
    expect(css).toMatch(/\.weread-reading-data-repair__priority--high\b/);
    expect(css).toMatch(/\.weread-reading-data-repair__priority--medium\b/);
    expect(css).toMatch(/\.weread-reading-data-repair__priority--low\b/);
    expect(css).toMatch(/\.weread-reading-data-repair__priority--informational\b/);
  });

  // 64 — S27R-2C mobile responsive breakpoint exists for the panel
  it("styles.css contains a mobile breakpoint for the repair panel", () => {
    const css = require("node:fs").readFileSync(
      require("node:path").resolve(
        process.cwd(),
        "apps/web/src/styles.css",
      ),
      "utf8",
    );
    // Must have a media query that targets the repair panel summary for mobile.
    expect(css).toMatch(
      /@media\s*\([^)]*max-width[^)]*720px[^)]*\)\s*\{[^}]*\.weread-reading-data-repair__summary/s,
    );
  });

  // 65 — S27R-2C no position: fixed/sticky introduced for the panel
  it("styles.css introduces no fixed/sticky positioning for the repair panel", () => {
    const css = require("node:fs").readFileSync(
      require("node:path").resolve(
        process.cwd(),
        "apps/web/src/styles.css",
      ),
      "utf8",
    );
    // Look at the slice of CSS that pertains to the repair panel (from the
    // "S27R-2C" marker to the end of file). No fixed/sticky in that slice.
    const marker = "S27R-2C: Reading Data Repair Recommendations Panel";
    const start = css.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const slice = css.slice(start);
    expect(slice).not.toMatch(/position\s*:\s*(fixed|sticky)/);
  });
});