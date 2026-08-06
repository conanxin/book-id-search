/**
 * S27R-3A — Reading Data Repair Plan Markdown export (targeted ≥65).
 *
 * Synthetic plan construction only. No fetch, no DOM mutation, no
 * real download. Verifies:
 *   - structure (title, metadata, sections, fixed disclaimers)
 *   - summary, priority / action / capability / guidance / scope
 *     mappings (exhaustive Chinese labels)
 *   - group ordering matches plan.groups order (deterministic)
 *   - per-recommendation location rendering (year / fromYear→toYear /
 *     itemIndex 1-based / rank)
 *   - empty plan, no_action-only plan, unsupported=0 plan
 *   - filename shape, MIME
 *   - escape helpers (inline, table cell, control chars, heading
 *     injection, pipe)
 *   - download trigger (Blob, URL.createObjectURL, anchor click,
 *     remove, URL.revokeObjectURL via setTimeout(0))
 *   - validator (forbidden patterns)
 *   - privacy (no Recommendation ID, Issue ID, actual, expected,
 *     title, author, catalogId, noteId, wereadBookId, raw JSON,
 *     token / API key, debug, automatic-repair claims,
 *     user-evaluation language)
 *   - source safety (no fetch, no storage, no URL writes, no DOM
 *     mutation, no AI, no network)
 */

import { describe, expect, it } from "vitest";

import type {
  ReadingDataRepairAction,
  ReadingDataRepairCapability,
  ReadingDataRepairGuidanceKey,
  ReadingDataRepairPriority,
  ReadingDataRepairRecommendation,
  ReadingDataRepairRecommendationGroup,
  WereadReadingDataRepairPlan,
  WereadReadingDataRepairSummary,
  WereadReadingDataRepairMeta,
} from "./wereadReadingDataRepairRecommendations";

import type {
  ReadingDataQualityIssueCode,
  ReadingDataQualityScope,
  ReadingDataQualitySeverity,
} from "./wereadReadingDataQualityAudit";

import {
  REPAIR_MARKDOWN_ACTION_LABELS,
  REPAIR_MARKDOWN_ACTION_ORDER,
  REPAIR_MARKDOWN_CAPABILITY_LABELS,
  REPAIR_MARKDOWN_GUIDANCE_LABELS,
  REPAIR_MARKDOWN_ISSUE_LABELS,
  REPAIR_MARKDOWN_PRIORITY_LABELS,
  REPAIR_MARKDOWN_SCOPE_LABELS,
  buildReadingDataRepairMarkdown,
  buildReadingDataRepairMarkdownFilename,
  escapeReadingDataRepairMarkdownInline,
  escapeReadingDataRepairMarkdownTableCell,
  formatReadingDataRepairMarkdownDate,
  formatReadingDataRepairAction,
  formatReadingDataRepairCapability,
  formatReadingDataRepairGuidance,
  formatReadingDataRepairPriority,
  formatReadingDataRepairScope,
  sanitizeReadingDataRepairMarkdownText,
  triggerReadingDataRepairMarkdownDownload,
  validateReadingDataRepairMarkdown,
} from "./wereadReadingDataRepairMarkdown";

// ---------- synthetic helpers ----------

function makeSummary(
  partial: Partial<WereadReadingDataRepairSummary> = {},
): WereadReadingDataRepairSummary {
  return {
    total: partial.total ?? 0,
    high: partial.high ?? 0,
    medium: partial.medium ?? 0,
    low: partial.low ?? 0,
    informational: partial.informational ?? 0,
    retryable: partial.retryable ?? 0,
    reloadable: partial.reloadable ?? 0,
    manualReview: partial.manualReview ?? 0,
    unsupported: partial.unsupported ?? 0,
  };
}

function makeMeta(): WereadReadingDataRepairMeta {
  return {
    source: "current_data_quality_audit",
    persisted: false,
    requestedNetwork: false,
    automaticRepair: false,
  };
}

const ACTION_ORDER: readonly ReadingDataRepairAction[] = [
  "retry_failed_year",
  "reload_year",
  "inspect_source_data",
  "review_metric_relationship",
  "review_top_book_metadata",
  "review_year_link",
  "review_recurring_aggregation",
  "unsupported_with_current_fields",
  "no_action_required",
];

const CAPABILITY_BY_ACTION: Record<ReadingDataRepairAction, ReadingDataRepairCapability> = {
  retry_failed_year: "user_retry",
  reload_year: "user_reload",
  inspect_source_data: "manual_review",
  review_metric_relationship: "manual_review",
  review_top_book_metadata: "manual_review",
  review_year_link: "manual_review",
  review_recurring_aggregation: "manual_review",
  unsupported_with_current_fields: "unsupported",
  no_action_required: "information_only",
};

const GUIDANCE_BY_ACTION: Record<ReadingDataRepairAction, ReadingDataRepairGuidanceKey> = {
  retry_failed_year: "retry_failed_years",
  reload_year: "reload_archive_year",
  inspect_source_data: "inspect_archive_source",
  review_metric_relationship: "review_year_metric_consistency",
  review_top_book_metadata: "review_top_book_public_metadata",
  review_year_link: "review_adjacent_year_links",
  review_recurring_aggregation: "review_recurring_aggregation",
  unsupported_with_current_fields: "current_fields_insufficient",
  no_action_required: "no_action",
};

function makeRecommendation(
  partial: {
    id?: string;
    sourceIssueCode: ReadingDataQualityIssueCode;
    sourceSeverity?: ReadingDataQualitySeverity;
    scope: ReadingDataQualityScope;
    priority: ReadingDataRepairPriority;
    action: ReadingDataRepairAction;
    capability?: ReadingDataRepairCapability;
    guidanceKey?: ReadingDataRepairGuidanceKey;
    year?: number;
    fromYear?: number;
    toYear?: number;
    itemIndex?: number;
    rank?: number;
  },
): ReadingDataRepairRecommendation {
  return {
    id: partial.id ?? `rec-${partial.sourceIssueCode}-${Math.random().toString(36).slice(2, 8)}`,
    sourceIssueCode: partial.sourceIssueCode,
    sourceSeverity: partial.sourceSeverity ?? "warning",
    scope: partial.scope,
    priority: partial.priority,
    action: partial.action,
    capability: partial.capability ?? CAPABILITY_BY_ACTION[partial.action],
    guidanceKey: partial.guidanceKey ?? GUIDANCE_BY_ACTION[partial.action],
    year: partial.year,
    fromYear: partial.fromYear,
    toYear: partial.toYear,
    itemIndex: partial.itemIndex,
    rank: partial.rank,
    automatic: false,
    modifiesSourceData: false,
  };
}

function makeGroup(
  priority: ReadingDataRepairPriority,
  action: ReadingDataRepairAction,
  recs: ReadingDataRepairRecommendation[],
): ReadingDataRepairRecommendationGroup {
  return {
    priority,
    action,
    capability: CAPABILITY_BY_ACTION[action],
    guidanceKey: GUIDANCE_BY_ACTION[action],
    count: recs.length,
    recommendations: recs,
  };
}

function makePlan(
  groups: ReadingDataRepairRecommendationGroup[],
): WereadReadingDataRepairPlan {
  const recs = groups.flatMap((g) => g.recommendations);
  const actionCounts = ACTION_ORDER.reduce(
    (acc, a) => {
      acc[a] = recs.filter((r) => r.action === a).length;
      return acc;
    },
    {} as Record<ReadingDataRepairAction, number>,
  );
  const capOrder: readonly ReadingDataRepairCapability[] = [
    "user_retry",
    "user_reload",
    "manual_review",
    "information_only",
    "unsupported",
  ];
  const capabilityCounts = capOrder.reduce(
    (acc, c) => {
      acc[c] = recs.filter((r) => r.capability === c).length;
      return acc;
    },
    {} as Record<ReadingDataRepairCapability, number>,
  );
  const summary: WereadReadingDataRepairSummary = {
    total: recs.length,
    high: recs.filter((r) => r.priority === "high").length,
    medium: recs.filter((r) => r.priority === "medium").length,
    low: recs.filter((r) => r.priority === "low").length,
    informational: recs.filter((r) => r.priority === "informational").length,
    retryable: recs.filter((r) => r.capability === "user_retry").length,
    reloadable: recs.filter((r) => r.capability === "user_reload").length,
    manualReview: recs.filter((r) => r.capability === "manual_review").length,
    unsupported: recs.filter((r) => r.capability === "unsupported").length,
  };
  return {
    recommendations: recs,
    groups,
    actionCounts,
    capabilityCounts,
    summary,
    meta: makeMeta(),
  };
}

const FIXED_EXPORT_AT = new Date("2026-08-07T07:00:00.000Z");

function build(
  plan: WereadReadingDataRepairPlan,
  exportedAt: Date = FIXED_EXPORT_AT,
) {
  return buildReadingDataRepairMarkdown({ plan, exportedAt });
}

// ---------- suite ----------

describe("S27R-3A — Reading Data Repair Plan Markdown", () => {
  // ---------- 1-3: title + metadata + summary structure ----------

  // 1
  it("renders the canonical H1 title", () => {
    const md = build(makePlan([]));
    expect(md.content.startsWith("# 阅读数据修复建议")).toBe(true);
  });

  // 2
  it("renders the metadata block (建议总数 / 优先检查 / … / 保存状态)", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
          year: 2024,
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("## 元数据");
    expect(md.content).toContain("- 建议总数：1");
    expect(md.content).toContain("- 优先检查：1");
    expect(md.content).toContain("- 建议检查：0");
    expect(md.content).toContain("- 当前条件有限：0");
    expect(md.content).toContain("- 信息说明：0");
    expect(md.content).toContain("- 可重试：0");
    expect(md.content).toContain("- 可重新加载：0");
    expect(md.content).toContain("- 需人工核对：1");
    expect(md.content).toContain("- 当前字段不足：0");
    expect(md.content).toContain("- 保存状态：未上传服务器");
    expect(md.content).toContain("- 生成方式：book-id-search 浏览器本地生成");
  });

  // 3
  it("exports a non-empty exportedAt formatted YYYY-MM-DD HH:mm", () => {
    const md = build(makePlan([]));
    expect(md.content).toMatch(/^- 导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
  });

  // ---------- 4-11: summary counts ----------

  // 4
  it("summary total matches plan.summary.total", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
        makeRecommendation({
          sourceIssueCode: "negative_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 建议总数：2");
  });

  // 5-7
  it("summary priority counts (high/medium/low) are rendered", () => {
    const plan = makePlan([
      makeGroup("high", "retry_failed_year", [
        makeRecommendation({
          sourceIssueCode: "partial_archive",
          scope: "coverage",
          priority: "high",
          action: "retry_failed_year",
        }),
      ]),
      makeGroup("medium", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "medium",
          action: "review_metric_relationship",
        }),
      ]),
      makeGroup("low", "review_top_book_metadata", [
        makeRecommendation({
          sourceIssueCode: "top_book_missing_title",
          scope: "top_book",
          priority: "low",
          action: "review_top_book_metadata",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 优先检查：1");
    expect(md.content).toContain("- 建议检查：1");
    expect(md.content).toContain("- 当前条件有限：1");
  });

  // 8
  it("summary informational count renders", () => {
    const plan = makePlan([
      makeGroup("informational", "no_action_required", [
        makeRecommendation({
          sourceIssueCode: "empty_archive",
          scope: "coverage",
          priority: "informational",
          action: "no_action_required",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 信息说明：1");
  });

  // 9
  it("summary retryable count renders", () => {
    const plan = makePlan([
      makeGroup("high", "retry_failed_year", [
        makeRecommendation({
          sourceIssueCode: "partial_archive",
          scope: "coverage",
          priority: "high",
          action: "retry_failed_year",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 可重试：1");
  });

  // 10
  it("summary reloadable count renders", () => {
    const plan = makePlan([
      makeGroup("high", "reload_year", [
        makeRecommendation({
          sourceIssueCode: "target_year_unaccounted",
          scope: "coverage",
          priority: "high",
          action: "reload_year",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 可重新加载：1");
  });

  // 11
  it("summary manualReview count renders", () => {
    const plan = makePlan([
      makeGroup("medium", "inspect_source_data", [
        makeRecommendation({
          sourceIssueCode: "duplicate_loaded_year",
          scope: "coverage",
          priority: "medium",
          action: "inspect_source_data",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 需人工核对：1");
  });

  // ---------- 12-15: mappings ----------

  // 12
  it("Priority mapping has 4 entries with non-empty Chinese labels", () => {
    const keys = Object.keys(REPAIR_MARKDOWN_PRIORITY_LABELS);
    expect(keys.length).toBe(4);
    for (const k of keys) {
      const v = (REPAIR_MARKDOWN_PRIORITY_LABELS as Record<string, string>)[k];
      expect(v.length).toBeGreaterThan(0);
    }
    expect(formatReadingDataRepairPriority("high")).toBe("优先检查");
    expect(formatReadingDataRepairPriority("medium")).toBe("建议检查");
    expect(formatReadingDataRepairPriority("low")).toBe("当前条件有限");
    expect(formatReadingDataRepairPriority("informational")).toBe("信息说明");
  });

  // 13
  it("Action mapping has 9 entries with non-empty Chinese labels", () => {
    const keys = Object.keys(REPAIR_MARKDOWN_ACTION_LABELS);
    expect(keys.length).toBe(9);
    for (const k of keys) {
      const v = (REPAIR_MARKDOWN_ACTION_LABELS as Record<string, string>)[k];
      expect(v.length).toBeGreaterThan(0);
    }
    expect(REPAIR_MARKDOWN_ACTION_ORDER.length).toBe(9);
    expect(formatReadingDataRepairAction("retry_failed_year")).toBe("重试暂时失败年份");
  });

  // 14
  it("Capability mapping has 5 entries with non-empty Chinese labels", () => {
    const keys = Object.keys(REPAIR_MARKDOWN_CAPABILITY_LABELS);
    expect(keys.length).toBe(5);
    for (const k of keys) {
      const v = (REPAIR_MARKDOWN_CAPABILITY_LABELS as Record<string, string>)[k];
      expect(v.length).toBeGreaterThan(0);
    }
    expect(formatReadingDataRepairCapability("user_retry")).toBe("可由现有重试入口处理");
  });

  // 15
  it("Guidance mapping has 9 entries with non-empty Chinese labels (deterministic)", () => {
    const keys = Object.keys(REPAIR_MARKDOWN_GUIDANCE_LABELS);
    expect(keys.length).toBe(9);
    for (const k of keys) {
      const v = (REPAIR_MARKDOWN_GUIDANCE_LABELS as Record<string, string>)[k];
      expect(v.length).toBeGreaterThan(0);
    }
    expect(formatReadingDataRepairGuidance("retry_failed_years")).toBe(
      "使用长期档案现有重试入口处理暂时失败年份",
    );
    expect(formatReadingDataRepairGuidance("current_fields_insufficient")).toBe(
      "当前字段不足，无法独立完成该项核对",
    );
    expect(formatReadingDataRepairGuidance("no_action")).toBe(
      "当前无需额外处理",
    );
  });

  // 16
  it("Scope mapping has 6 entries with non-empty Chinese labels", () => {
    const keys = Object.keys(REPAIR_MARKDOWN_SCOPE_LABELS);
    expect(keys.length).toBe(6);
    expect(formatReadingDataRepairScope("year")).toBe("年度指标");
    expect(formatReadingDataRepairScope("year_link")).toBe("相邻年度链接");
    expect(formatReadingDataRepairScope("recurring_book")).toBe("多年上榜");
  });

  // ---------- 17-19: groups + issue codes ----------

  // 17
  it("groups are emitted in plan.groups order (deterministic)", () => {
    const plan = makePlan([
      makeGroup("high", "reload_year", [
        makeRecommendation({
          sourceIssueCode: "target_year_unaccounted",
          scope: "coverage",
          priority: "high",
          action: "reload_year",
        }),
      ]),
      makeGroup("medium", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "medium",
          action: "review_metric_relationship",
        }),
      ]),
      makeGroup("low", "review_recurring_aggregation", [
        makeRecommendation({
          sourceIssueCode: "recurring_unknown_year",
          scope: "recurring_book",
          priority: "low",
          action: "review_recurring_aggregation",
        }),
      ]),
    ]);
    const md = build(plan);
    const idxReload = md.content.indexOf("重新加载目标年份");
    const idxMetric = md.content.indexOf("核对年度指标关系");
    const idxRecurring = md.content.indexOf("核对多年重复书目聚合");
    expect(idxReload).toBeGreaterThan(-1);
    expect(idxMetric).toBeGreaterThan(idxReload);
    expect(idxRecurring).toBeGreaterThan(idxMetric);
  });

  // 18
  it("each group renders its count", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
        makeRecommendation({
          sourceIssueCode: "negative_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 建议数量：2");
  });

  // 19
  it("emits the Chinese IssueCode label per recommendation", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain(
      `- 来源问题：${REPAIR_MARKDOWN_ISSUE_LABELS.non_finite_metric}`,
    );
  });

  // ---------- 20-23: location rendering ----------

  // 20
  it("renders year (YYYY) location when defined", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
          year: 2024,
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 年份：2024");
  });

  // 21
  it("renders year pair (YYYY → YYYY) location when both defined", () => {
    const plan = makePlan([
      makeGroup("medium", "review_year_link", [
        makeRecommendation({
          sourceIssueCode: "year_link_invalid_order",
          scope: "year_link",
          priority: "medium",
          action: "review_year_link",
          fromYear: 2022,
          toYear: 2023,
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 年份范围：2022 → 2023");
  });

  // 22
  it("renders itemIndex as 1-based (第 N 项)", () => {
    const plan = makePlan([
      makeGroup("low", "review_top_book_metadata", [
        makeRecommendation({
          sourceIssueCode: "top_book_invalid_rank",
          scope: "top_book",
          priority: "low",
          action: "review_top_book_metadata",
          itemIndex: 2,
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 项目位置：第 3 项");
  });

  // 23
  it("renders rank when defined", () => {
    const plan = makePlan([
      makeGroup("low", "review_top_book_metadata", [
        makeRecommendation({
          sourceIssueCode: "top_book_invalid_rank",
          scope: "top_book",
          priority: "low",
          action: "review_top_book_metadata",
          rank: 5,
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("- 排名值：5");
  });

  // 24
  it("omits location fields when undefined", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toMatch(/^- 年份：/m);
    expect(md.content).not.toMatch(/^- 年份范围：/m);
    expect(md.content).not.toMatch(/^- 项目位置：/m);
    expect(md.content).not.toMatch(/^- 排名值：/m);
  });

  // ---------- 25-31: forbidden content ----------

  // 25
  it("does not render Recommendation IDs in the Markdown body", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          id: "recmustnotappearinexportedstring12345",
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toContain("recmustnotappearinexportedstring12345");
  });

  // 26
  it("does not render Issue IDs in the Markdown body", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toMatch(/issue[a-z0-9]{8,}/i);
  });

  // 27
  it("does not render 'actual' or 'expected' values", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toMatch(/\bactual\b/);
    expect(md.content).not.toMatch(/\bexpected\b/);
  });

  // 28
  it("does not render 'title' / 'author' / 'catalogId'", () => {
    const plan = makePlan([
      makeGroup("low", "review_top_book_metadata", [
        makeRecommendation({
          sourceIssueCode: "top_book_missing_title",
          scope: "top_book",
          priority: "low",
          action: "review_top_book_metadata",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toContain("catalogId");
    expect(md.content).not.toMatch(/\bauthor\b\s*[：:]/);
    expect(md.content).not.toMatch(/\btitle\b\s*[：:]/);
  });

  // 29
  it("does not render raw audit / raw plan JSON", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toContain('"recommendations":');
    expect(md.content).not.toContain('"issues":');
    expect(md.content).not.toContain('"actionCounts":');
    expect(md.content).not.toContain('"capabilityCounts":');
    expect(md.content).not.toContain('"summary":');
  });

  // 30
  it("does not render note private IDs / fields", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toContain("noteId");
    expect(md.content).not.toContain("note.text");
    expect(md.content).not.toContain("note.comment");
    expect(md.content).not.toContain("wereadBookId");
    expect(md.content).not.toContain("highlightId");
  });

  // 31
  it("does not render authorization / token / api key material", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toMatch(/Authorization\s*[:=]/);
    expect(md.content).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
    expect(md.content).not.toMatch(/\bapi[_-]?key\b/);
  });

  // ---------- 32-35: special sections ----------

  // 32
  it("renders the '可由现有界面处理' section with retry + reload counts", () => {
    const plan = makePlan([
      makeGroup("high", "retry_failed_year", [
        makeRecommendation({
          sourceIssueCode: "partial_archive",
          scope: "coverage",
          priority: "high",
          action: "retry_failed_year",
        }),
      ]),
      makeGroup("high", "reload_year", [
        makeRecommendation({
          sourceIssueCode: "target_year_unaccounted",
          scope: "coverage",
          priority: "high",
          action: "reload_year",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("## 可由现有界面处理");
    expect(md.content).toContain("共 2 条建议");
    expect(md.content).toContain("不会代替用户执行");
  });

  // 33
  it("renders the manual-review section", () => {
    const plan = makePlan([
      makeGroup("medium", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "medium",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("## 需要人工核对");
    expect(md.content).toContain("共 1 条建议");
  });

  // 34
  it("renders the unsupported section with '不会推测缺失结果' when unsupported > 0", () => {
    const plan = makePlan([
      makeGroup("low", "unsupported_with_current_fields", [
        makeRecommendation({
          sourceIssueCode: "recurring_invalid_rank",
          scope: "recurring_book",
          priority: "low",
          action: "unsupported_with_current_fields",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("## 当前字段不足");
    expect(md.content).toContain("不会推测缺失结果");
    expect(md.content).toContain("共 1 条建议");
  });

  // 35
  it("renders the unsupported section as informational when unsupported = 0 (still supported)", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("## 当前字段不足");
    expect(md.content).not.toMatch(/^- 共 0 条建议/m);
  });

  // ---------- 36-38: empty / no-action / determinism ----------

  // 36
  it("empty plan still exports a valid Markdown document with disclaimer", () => {
    const md = build(makePlan([]));
    expect(md.content).toContain("# 阅读数据修复建议");
    expect(md.content).toContain("## 建议总览");
    expect(md.content).toContain("当前审计结果没有需要生成的修复建议");
    expect(md.content).toContain("- 保存状态：未上传服务器");
    expect(md.content).toContain("## 方法说明");
  });

  // 37
  it("no_action-only plan renders with no Actionable / manual-review claims", () => {
    const plan = makePlan([
      makeGroup("informational", "no_action_required", [
        makeRecommendation({
          sourceIssueCode: "empty_archive",
          scope: "coverage",
          priority: "informational",
          action: "no_action_required",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).toContain("共 0 条建议可通过长期档案已有的重试或重新加载入口处理");
    expect(md.content).toContain("共 0 条建议需要人工核对");
  });

  // 38
  it("deterministic output across rerenders (same input)", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
          year: 2024,
        }),
      ]),
      makeGroup("medium", "review_year_link", [
        makeRecommendation({
          sourceIssueCode: "year_link_invalid_order",
          scope: "year_link",
          priority: "medium",
          action: "review_year_link",
          fromYear: 2022,
          toYear: 2023,
        }),
      ]),
    ]);
    const a = build(plan);
    const b = build(plan);
    expect(a.content).toBe(b.content);
  });

  // 39
  it("input plan is not mutated by build", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const snap = JSON.stringify(plan);
    build(plan);
    expect(JSON.stringify(plan)).toBe(snap);
  });

  // ---------- 40-43: filename + MIME ----------

  // 40
  it("filename follows weread-reading-data-repair-plan-YYYYMMDD.md", () => {
    const fn = buildReadingDataRepairMarkdownFilename(new Date("2026-08-07T07:00:00.000Z"));
    expect(fn).toBe("weread-reading-data-repair-plan-20260807.md");
  });

  // 41
  it("filename is ASCII only", () => {
    const fn = buildReadingDataRepairMarkdownFilename(new Date("2026-08-07T07:00:00.000Z"));
    expect(fn).toMatch(/^[\x20-\x7E]+$/);
  });

  // 42
  it("filename length ≤ 80", () => {
    const fn = buildReadingDataRepairMarkdownFilename(new Date("2026-08-07T07:00:00.000Z"));
    expect(fn.length).toBeLessThanOrEqual(80);
  });

  // 43
  it("MIME is text/markdown;charset=utf-8", () => {
    const md = build(makePlan([]));
    expect(md.mimeType).toBe("text/markdown;charset=utf-8");
  });

  // ---------- 44-48: download helper ----------

  // 44
  it("download helper creates a Blob with the Markdown content (mocked DOM)", () => {
    // Install a minimal document mock so the trigger path is reachable
    // even in the default Node test environment.
    const originalDocument = (globalThis as { document?: unknown }).document;
    let appendedCount = 0;
    let removedCount = 0;
    const fakeBody = {
      appendChild(_el: unknown) {
        appendedCount += 1;
        return _el;
      },
      removeChild(_el: unknown) {
        removedCount += 1;
        return _el;
      },
    } as unknown as HTMLElement;
    const fakeDoc = {
      body: fakeBody,
      createElement(tag: string) {
        const el: Record<string, unknown> = {
          tagName: tag.toUpperCase(),
          href: "",
          download: "",
          rel: "",
          style: { display: "" },
        };
        (el as { click: () => void }).click = function () {
          /* noop */
        };
        return el;
      },
    } as unknown as Document;
    let captured: Blob | null = null;
    try {
      (globalThis as { document?: unknown }).document = fakeDoc;
      const md = build(makePlan([]));
      const handle = triggerReadingDataRepairMarkdownDownload(md, {
        createObjectURL: (blob) => {
          captured = blob;
          return "blob:fake-url";
        },
        revokeObjectURL: () => {
          /* noop */
        },
        setTimeoutFn: () => 0,
        documentBody: fakeBody,
      });
      expect(captured).not.toBeNull();
      expect((captured as unknown as { type: string }).type).toBe(
        "text/markdown;charset=utf-8",
      );
      expect(handle.triggered).toBe(true);
      expect(appendedCount).toBe(1);
      expect(removedCount).toBe(1);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  // 45
  it("download helper returns triggered=false in pure Node env (no document)", () => {
    const originalDocument = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
      const md = build(makePlan([]));
      const handle = triggerReadingDataRepairMarkdownDownload(md);
      expect(handle.triggered).toBe(false);
      expect(handle.filename).toBe(md.filename);
      expect(handle.mimeType).toBe("text/markdown;charset=utf-8");
    } finally {
      if (originalDocument !== undefined) {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  // 46
  it("download helper sets anchor.href / download / rel / style on the click anchor (mocked DOM)", () => {
    const originalDocument = (globalThis as { document?: unknown }).document;
    let capturedAttrs: Record<string, unknown> = {};
    const fakeBody = {
      appendChild(el: unknown) {
        capturedAttrs = el as Record<string, unknown>;
        return el;
      },
      removeChild() {
        /* noop */
      },
    } as unknown as HTMLElement;
    const fakeDoc = {
      body: fakeBody,
      createElement(_tag: string) {
        const el: Record<string, unknown> = {
          tagName: "A",
          href: "",
          download: "",
          rel: "",
          style: { display: "" },
        };
        (el as { click: () => void }).click = function () {
          /* noop */
        };
        return el;
      },
    } as unknown as Document;
    try {
      (globalThis as { document?: unknown }).document = fakeDoc;
      const md = build(makePlan([]));
      triggerReadingDataRepairMarkdownDownload(md, {
        createObjectURL: () => "blob:anchor-test",
        setTimeoutFn: () => 0,
        documentBody: fakeBody,
      });
      expect(capturedAttrs.href).toBe("blob:anchor-test");
      expect(capturedAttrs.download).toBe(md.filename);
      expect(capturedAttrs.rel).toBe("noopener");
      expect(
        (capturedAttrs.style as { display: string }).display,
      ).toBe("none");
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  // 47
  it("download helper schedules revokeObjectURL via setTimeout(0)", () => {
    const originalDocument = (globalThis as { document?: unknown }).document;
    const fakeBody = {
      appendChild(el: unknown) {
        return el;
      },
      removeChild() {
        /* noop */
      },
    } as unknown as HTMLElement;
    const fakeDoc = {
      body: fakeBody,
      createElement(_tag: string) {
        const el: Record<string, unknown> = {
          tagName: "A",
          href: "",
          download: "",
          rel: "",
          style: { display: "" },
        };
        (el as { click: () => void }).click = function () {
          /* noop */
        };
        return el;
      },
    } as unknown as Document;
    let scheduled = -1;
    let revoked: string | null = null;
    try {
      (globalThis as { document?: unknown }).document = fakeDoc;
      const md = build(makePlan([]));
      triggerReadingDataRepairMarkdownDownload(md, {
        createObjectURL: () => "blob:fake-revoke",
        revokeObjectURL: (url) => {
          revoked = url;
        },
        setTimeoutFn: (cb, ms) => {
          scheduled = ms;
          cb();
          return 0;
        },
        documentBody: fakeBody,
      });
      expect(scheduled).toBe(0);
      expect(revoked).toBe("blob:fake-revoke");
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  // 48
  it("download helper recovers when click throws (triggered=false, no exception)", () => {
    const originalDocument = (globalThis as { document?: unknown }).document;
    const fakeBody = {
      appendChild(el: unknown) {
        return el;
      },
      removeChild() {
        /* noop */
      },
    } as unknown as HTMLElement;
    const fakeDoc = {
      body: fakeBody,
      createElement(_tag: string) {
        const el: Record<string, unknown> = {
          tagName: "A",
          href: "",
          download: "",
          rel: "",
          style: { display: "" },
        };
        (el as { click: () => void }).click = function () {
          throw new Error("simulated click failure");
        };
        return el;
      },
    } as unknown as Document;
    try {
      (globalThis as { document?: unknown }).document = fakeDoc;
      const md = build(makePlan([]));
      const handle = triggerReadingDataRepairMarkdownDownload(md, {
        createObjectURL: () => "blob:err",
        setTimeoutFn: () => 0,
        documentBody: fakeBody,
      });
      expect(handle.triggered).toBe(false);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  // ---------- 49-52: escape helpers ----------

  // 49
  it("inline escape neutralises Markdown special chars with backslash prefix", () => {
    const escaped = escapeReadingDataRepairMarkdownInline("a`b*h_i");
    // Backtick and `*` and `_` are escaped to `\` + original char.
    expect(escaped).toContain("\\`");
    expect(escaped).toContain("\\*");
    expect(escaped).toContain("\\_");
    // Pipe is not a special char in inline contexts here, but verify it
    // passes through as-is when present.
    const withPipe = escapeReadingDataRepairMarkdownInline("a|b");
    expect(withPipe).toContain("|");
  });

  // 50
  it("table-cell escape neutralises pipe (prefixed with backslash) and flattens newlines", () => {
    const escaped = escapeReadingDataRepairMarkdownTableCell("a|b\nc");
    // The pipe is escaped to `\|` — no un-escaped pipe should remain.
    expect(escaped).not.toMatch(/[^\\]\|/);
    expect(escaped).not.toMatch(/^\|/);
    expect(escaped).not.toMatch(/\n/);
    // The literal newline becomes a single space.
    expect(escaped).toContain("b c");
  });

  // 51
  it("inline escape prevents heading injection (## becomes \\#\\#)", () => {
    const escaped = escapeReadingDataRepairMarkdownInline("## injected");
    // The escape sequence must add a backslash before `#`.
    expect(escaped.startsWith("\\#\\#")).toBe(true);
  });

  // 52
  it("escape helpers drop control characters", () => {
    const escaped = escapeReadingDataRepairMarkdownInline("a\u0000b\u0007c\u001fd");
    expect(escaped).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  });

  // ---------- 53-54: no NaN / Infinity ----------

  // 53
  it("rendered Markdown contains no NaN token", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toMatch(/\bNaN\b/);
  });

  // 54
  it("rendered Markdown contains no Infinity token", () => {
    const plan = makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toMatch(/\bInfinity\b/);
  });

  // 55
  it("sanitizeReadingDataRepairMarkdownText aliases escapeReadingDataRepairMarkdownInline", () => {
    expect(sanitizeReadingDataRepairMarkdownText).toBe(
      escapeReadingDataRepairMarkdownInline,
    );
  });

  // ---------- 56-63: source safety ----------

  // 56
  it("source does not call fetch / XMLHttpRequest / annual-review / AI / related-books", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    // Strip leading file-level block comment so the privacy contract
    // narrative is not counted as code usage.
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/annual-review/);
    expect(code).not.toMatch(/related-books/);
    expect(code).not.toMatch(/MiniMax|minimax/);
    expect(code).not.toMatch(/ai-summary/);
  });

  // 57
  it("source does not write storage", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/sessionStorage/);
    expect(code).not.toMatch(/indexedDB/);
  });

  // 58
  it("source does not mutate URL / history / window.location", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/pushState/);
    expect(code).not.toMatch(/replaceState/);
    expect(code).not.toMatch(/window\.location/);
  });

  // 59
  it("source does not use dangerouslySetInnerHTML or innerHTML", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/dangerouslySetInnerHTML/);
    expect(code).not.toMatch(/\.innerHTML\b/);
    expect(code).not.toMatch(/\binnerHTML\b/);
  });

  // 60
  it("source does not call retry() / reload()", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/\bretry\s*\(/);
    expect(code).not.toMatch(/\breload\s*\(/);
  });

  // 61
  it("source does not use console.log for the full Markdown content", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/console\.(log|info|debug|warn|error)/);
  });

  // 62
  it("source does not use alert()", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    expect(code).not.toMatch(/\balert\s*\(/);
  });

  // 63
  it("source does not include any third-party Markdown library", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/src/weread/wereadReadingDataRepairMarkdown.ts",
      ),
      "utf8",
    );
    const code = src.replace(/^\/\*[\s\S]*?\*\//, "");
    // No imports of markdown-it / marked / remark / commonmark.
    expect(code).not.toMatch(/from\s+["']markdown-it/);
    expect(code).not.toMatch(/from\s+["']marked/);
    expect(code).not.toMatch(/from\s+["']remark/);
    expect(code).not.toMatch(/from\s+["']commonmark/);
  });

  // ---------- 64-66: validator + safety ----------

  // 64
  it("validator flags Recommendation ID leakage", () => {
    const r = validateReadingDataRepairMarkdown("hello rec12345678abc world");
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  // 65
  it("validator flags evaluation language", () => {
    const r = validateReadingDataRepairMarkdown("系统已修复 / 已帮你修复 / 自动修复完成");
    expect(r.ok).toBe(false);
  });

  // 66
  it("validator flags token / api key leakage", () => {
    const r = validateReadingDataRepairMarkdown("Authorization: Bearer abcdefghij1234567");
    expect(r.ok).toBe(false);
  });

  // ---------- 67-68: unsupported=0 + mixed groups ----------

  // 67
  it("supports plan with all 4 priorities, 9 actions, 5 capabilities, 9 guidance keys", () => {
    const recsByAction: Array<{
      sourceIssueCode: ReadingDataQualityIssueCode;
      scope: ReadingDataQualityScope;
      priority: ReadingDataRepairPriority;
      action: ReadingDataRepairAction;
    }> = [
      { sourceIssueCode: "partial_archive", scope: "coverage", priority: "high", action: "retry_failed_year" },
      { sourceIssueCode: "target_year_unaccounted", scope: "coverage", priority: "high", action: "reload_year" },
      { sourceIssueCode: "duplicate_loaded_year", scope: "coverage", priority: "medium", action: "inspect_source_data" },
      { sourceIssueCode: "non_finite_metric", scope: "year", priority: "medium", action: "review_metric_relationship" },
      { sourceIssueCode: "top_book_missing_title", scope: "top_book", priority: "low", action: "review_top_book_metadata" },
      { sourceIssueCode: "year_link_invalid_order", scope: "year_link", priority: "low", action: "review_year_link" },
      { sourceIssueCode: "recurring_unknown_year", scope: "recurring_book", priority: "low", action: "review_recurring_aggregation" },
      { sourceIssueCode: "recurring_invalid_rank", scope: "recurring_book", priority: "low", action: "unsupported_with_current_fields" },
      { sourceIssueCode: "empty_archive", scope: "coverage", priority: "informational", action: "no_action_required" },
    ];
    const plan = makePlan([
      makeGroup(
        "high",
        "retry_failed_year",
        recsByAction
          .filter((r) => r.priority === "high" && r.action === "retry_failed_year")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "high",
        "reload_year",
        recsByAction
          .filter((r) => r.action === "reload_year")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "medium",
        "inspect_source_data",
        recsByAction
          .filter((r) => r.action === "inspect_source_data")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "medium",
        "review_metric_relationship",
        recsByAction
          .filter((r) => r.action === "review_metric_relationship")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "low",
        "review_top_book_metadata",
        recsByAction
          .filter((r) => r.action === "review_top_book_metadata")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "low",
        "review_year_link",
        recsByAction
          .filter((r) => r.action === "review_year_link")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "low",
        "review_recurring_aggregation",
        recsByAction
          .filter((r) => r.action === "review_recurring_aggregation")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "low",
        "unsupported_with_current_fields",
        recsByAction
          .filter((r) => r.action === "unsupported_with_current_fields")
          .map((r) => makeRecommendation(r)),
      ),
      makeGroup(
        "informational",
        "no_action_required",
        recsByAction
          .filter((r) => r.action === "no_action_required")
          .map((r) => makeRecommendation(r)),
      ),
    ]);
    const md = build(plan);
    // Sanity: covers 9 distinct headings + 9 guidance labels.
    const headings = [
      "重试暂时失败年份",
      "重新加载目标年份",
      "核对档案来源数据",
      "核对年度指标关系",
      "核对 Top N 公共元数据",
      "核对相邻年度链接",
      "核对多年重复书目聚合",
      "当前字段不足以独立核对",
      "当前无需操作",
    ];
    for (const h of headings) {
      expect(md.content).toContain(h);
    }
    // All 9 guidance keys present.
    for (const g of Object.values(REPAIR_MARKDOWN_GUIDANCE_LABELS)) {
      expect(md.content).toContain(g);
    }
  });

  // 68
  it("validator returns ok=true for a clean canonical Markdown", () => {
    const md = build(makePlan([
      makeGroup("high", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "high",
          action: "review_metric_relationship",
          year: 2024,
        }),
      ]),
    ]));
    const v = validateReadingDataRepairMarkdown(md.content);
    expect(v.ok).toBe(true);
    expect(v.issues.length).toBe(0);
  });

  // 69
  it("formatReadingDataRepairMarkdownDate handles invalid Date (no NaN)", () => {
    const s = formatReadingDataRepairMarkdownDate(new Date("not-a-date"));
    expect(s).not.toMatch(/NaN/);
    expect(s).toBe("0000-00-00 00:00");
  });

  // 70
  it("rendered Markdown always contains the 方法说明 block", () => {
    const md = build(makePlan([]));
    expect(md.content).toContain("## 方法说明");
    expect(md.content).toContain("- 本文件不会自动请求、修改或修复任何数据");
    expect(md.content).toContain("- 本文件不会执行重试或重新加载");
    expect(md.content).toContain("- 本文件未调用 AI");
    expect(md.content).toContain("- 本文件未上传或保存到服务器");
    expect(md.content).toContain("- 本文件不评价用户本人或阅读行为");
  });

  // 71
  it("rendered Markdown always contains the 安全说明 block", () => {
    const md = build(makePlan([]));
    expect(md.content).toContain("## 安全说明");
    expect(md.content).toContain("不会自动请求、修改或修复任何数据");
  });

  // 72
  it("rendered Markdown does not include 'review.year_metric_consistency' internal enum", () => {
    const plan = makePlan([
      makeGroup("medium", "review_metric_relationship", [
        makeRecommendation({
          sourceIssueCode: "non_finite_metric",
          scope: "year",
          priority: "medium",
          action: "review_metric_relationship",
        }),
      ]),
    ]);
    const md = build(plan);
    expect(md.content).not.toContain("review_year_metric_consistency");
    expect(md.content).not.toContain("user_retry");
    expect(md.content).not.toContain("manual_review");
  });
});