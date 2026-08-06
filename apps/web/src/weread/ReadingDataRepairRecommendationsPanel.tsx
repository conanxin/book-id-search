/**
 * S27R-2A — Reading Data Repair Recommendations Panel.
 *
 * Zero-hook React panel that renders the deterministic repair plan produced
 * by `buildWereadReadingDataRepairPlan(audit)`. The panel:
 *   - never mutates the input audit or the derived plan
 *   - never executes retry / reload / network / storage / DOM-mutation
 *   - never evaluates / re-derives anything outside `buildWereadReadingDataRepairPlan`
 *   - only renders enum-derived Chinese labels via exhaustive `satisfies Record<…>` tables
 *   - exposes no buttons that would mutate archive / call AI / call network
 *   - is meant for embedding inside an existing dashboard (S27R-2B wires it up);
 *     this stage ships the standalone component and tests.
 *
 * The panel preserves the privacy contract:
 *   - no Recommendation ID / Issue ID / `actual` / `expected` /
 *     `title` / `author` / `catalogId` / private IDs / raw audit
 *   - no user-evaluation language (see forbidden list in spec)
 *   - no free-text exception details
 */

import type { JSX } from "react";

import type { WereadReadingDataQualityAudit } from "./wereadReadingDataQualityAudit";

import {
  type ReadingDataRepairAction,
  type ReadingDataRepairCapability,
  type ReadingDataRepairGuidanceKey,
  type ReadingDataRepairPriority,
  type ReadingDataRepairRecommendation,
  type ReadingDataRepairRecommendationGroup,
  type WereadReadingDataRepairPlan,
  buildReadingDataRepairDebugSnapshot,
  buildWereadReadingDataRepairPlan,
  selectActionableRepairRecommendations,
  selectHighestPriorityRepairRecommendations,
  selectManualReviewRepairRecommendations,
  selectUnsupportedRepairRecommendations,
} from "./wereadReadingDataRepairRecommendations";

import ReadingDataRepairExportAction from "./ReadingDataRepairExportAction";

// ---------- i18n tables (exhaustive `satisfies Record<…>`) ----------

const PRIORITY_LABEL: Record<ReadingDataRepairPriority, string> = {
  high: "优先检查",
  medium: "建议检查",
  low: "当前条件有限",
  informational: "信息说明",
};

const PRIORITY_ORDER: readonly ReadingDataRepairPriority[] = [
  "high",
  "medium",
  "low",
  "informational",
];

const ACTION_LABEL: Record<ReadingDataRepairAction, string> = {
  retry_failed_year: "重试暂时失败年份",
  reload_year: "重新加载目标年份",
  inspect_source_data: "核对档案来源数据",
  review_metric_relationship: "核对年度指标关系",
  review_top_book_metadata: "核对 Top N 公共元数据",
  review_year_link: "核对相邻年度链接",
  review_recurring_aggregation: "核对多年重复书目聚合",
  unsupported_with_current_fields: "当前字段不足以独立核对",
  no_action_required: "当前无需操作",
};

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

const CAPABILITY_LABEL: Record<ReadingDataRepairCapability, string> = {
  user_retry: "可由现有重试入口处理",
  user_reload: "可通过重新加载处理",
  manual_review: "需要人工核对",
  information_only: "仅供说明",
  unsupported: "当前模型字段不足",
};

const CAPABILITY_ORDER: readonly ReadingDataRepairCapability[] = [
  "user_retry",
  "user_reload",
  "manual_review",
  "information_only",
  "unsupported",
];

const GUIDANCE_LABEL: Record<ReadingDataRepairGuidanceKey, string> = {
  retry_failed_years: "建议触发重试入口处理暂时失败年份",
  reload_archive_year: "建议重新加载目标年份",
  inspect_archive_source: "建议核对档案来源与年份闭合关系",
  review_year_metric_consistency: "建议核对年度字段一致性与比例关系",
  review_top_book_public_metadata: "建议核对 Top N 书目公共元数据与排名",
  review_adjacent_year_links: "建议核对相邻年度链接的 ratio 与计数",
  review_recurring_aggregation: "建议核对多年上榜书目聚合与年份集合",
  current_fields_insufficient: "当前模型字段不足以独立核对，建议保留 Issue 待字段扩展",
  no_action: "当前无需操作，仅记录审计状态",
};

// Issue code → Chinese label. Exhaustive across the live 36-code union.
// Excluded labels live in `UNUSED_ISSUE_LABELS` (re-used from audit Markdown model).
const ISSUE_CODE_LABEL: Partial<Record<keyof typeof ISSUE_CODE_LABEL_KEYS, string>> =
  {};

const ISSUE_CODE_LABEL_KEYS = {
  // coverage
  empty_archive: "空档案",
  partial_archive: "档案部分加载",
  target_year_unaccounted: "目标年份未闭合",
  loaded_failed_conflict: "加载与失败年份冲突",
  duplicate_loaded_year: "重复加载年份",
  invalid_year: "非法年份",
  // year
  non_finite_metric: "年度指标非有限值",
  negative_metric: "年度指标为负",
  dated_records_exceed_total: "有效日期记录超过总记录",
  matched_records_exceed_total: "已匹配记录超过总记录",
  matched_books_exceed_matched_records: "已匹配书目超过已匹配记录",
  active_months_out_of_range: "活跃月份数越界",
  streak_months_out_of_range: "连续月份数越界",
  streak_exceeds_active_months: "连续月份数超过活跃月份",
  peak_month_year_mismatch: "高峰月份与年份不匹配",
  // top_book
  top_books_exceed_limit: "Top N 书目超过上限",
  top_book_missing_catalog: "Top N 书目缺少 catalog",
  top_book_duplicate_catalog: "Top N 书目 catalog 重复",
  top_book_missing_title: "Top N 书目缺少 title",
  top_book_invalid_rank: "Top N 书目 rank 非法",
  top_book_duplicate_rank: "Top N 书目 rank 重复",
  top_book_records_exceed_year_total: "Top N 记录超过年度 total",
  top_book_order_mismatch: "Top N 排序与指标不一致",
  // year_link
  year_link_unknown_year: "YearLink 涉及未加载年份",
  year_link_invalid_order: "YearLink 年份顺序非法",
  year_link_duplicate_pair: "YearLink pair 重复",
  year_link_invalid_counts: "YearLink 计数非法",
  year_link_ratio_out_of_range: "YearLink ratio 越界",
  year_link_ratio_mismatch: "YearLink ratio 与 common/union 不一致",
  missing_year_link: "相邻年度 YearLink 缺失",
  // recurring (audit-emitted)
  recurring_duplicate_catalog: "Recurring catalog 重复",
  recurring_appearance_count_mismatch: "Recurring 上榜次数不一致",
  recurring_unknown_year: "Recurring 涉及未加载年份",
  recurring_duplicate_year: "Recurring 年份集合重复",
  recurring_invalid_rank: "Recurring rank 非法",
  recurring_latest_year_mismatch: "Recurring latestYear 不在 years 中",
} as const;

const ISSUE_LABEL = ISSUE_CODE_LABEL_KEYS;

const SCOPE_LABEL: Record<
  "archive" | "coverage" | "year" | "top_book" | "year_link" | "recurring_book",
  string
> = {
  archive: "档案",
  coverage: "年份覆盖",
  year: "年度指标",
  top_book: "Top N",
  year_link: "相邻年度链接",
  recurring_book: "多年上榜",
};

// ---------- component ----------

export interface ReadingDataRepairRecommendationsPanelProps {
  audit: WereadReadingDataQualityAudit;
  loading: boolean;
}

export function ReadingDataRepairRecommendationsPanel(
  props: ReadingDataRepairRecommendationsPanelProps,
): JSX.Element {
  const plan: WereadReadingDataRepairPlan = buildWereadReadingDataRepairPlan(
    props.audit,
  );

  // Privacy-safe reset key for the export child component.
  // JSON.stringify of the model's debug snapshot gives us a
  // deterministic, side-effect-free digest that excludes the raw
  // audit, Recommendation / Issue IDs, title / author / catalogId,
  // and private IDs. Any change to the plan forces a fresh remount
  // of the export child, clearing any prior success status.
  const repairExportResetKey = JSON.stringify(
    buildReadingDataRepairDebugSnapshot(plan),
  );

  return (
    <section
      className="weread-reading-data-repair"
      data-testid="weread-reading-data-repair"
    >
      <header className="weread-reading-data-repair__header">
        <h3 className="weread-reading-data-repair__title">数据修复建议</h3>
        <p className="weread-reading-data-repair__intro">
          建议根据当前数据质量审计结果生成，只说明可检查或可重试的方向，
          <strong>不会自动请求、修改或修复任何数据</strong>。
        </p>
        <p className="weread-reading-data-repair__priority-note">
          建议优先级仅表示处理顺序，不代表用户或阅读行为的好坏。
        </p>
      </header>

      <RepairPlanSummary plan={plan} loading={props.loading} />

      <ReadingDataRepairExportAction
        key={repairExportResetKey}
        plan={plan}
        loading={props.loading}
      />

      <RepairPlanGroups plan={plan} loading={props.loading} />

      <RepairPlanActionable plan={plan} loading={props.loading} />
      <RepairPlanManualReview plan={plan} loading={props.loading} />
      <RepairPlanUnsupported plan={plan} loading={props.loading} />
      <RepairPlanHighestPriority plan={plan} loading={props.loading} />
    </section>
  );
}

// ---------- subviews (kept inline; component is zero-hook) ----------

function RepairPlanSummary(
  props: { plan: WereadReadingDataRepairPlan; loading: boolean },
): JSX.Element {
  const { plan, loading } = props;
  const disabled = loading;
  return (
    <dl
      className="weread-reading-data-repair__summary"
      data-testid="weread-reading-data-repair-summary"
      data-loading={disabled ? "true" : "false"}
    >
      <SummaryRow label="建议总数" value={plan.summary.total} />
      {PRIORITY_ORDER.map((p) => (
        <SummaryRow
          key={`prio-${p}`}
          label={PRIORITY_LABEL[p]}
          value={plan.summary[p]}
        />
      ))}
      <SummaryRow label="可重试" value={plan.summary.retryable} />
      <SummaryRow label="可重新加载" value={plan.summary.reloadable} />
      <SummaryRow label="需人工核对" value={plan.summary.manualReview} />
      <SummaryRow label="当前字段不足" value={plan.summary.unsupported} />
    </dl>
  );
}

function SummaryRow(props: { label: string; value: number }): JSX.Element {
  return (
    <div className="weread-reading-data-repair__summary-row">
      <dt className="weread-reading-data-repair__summary-label">
        {props.label}
      </dt>
      <dd className="weread-reading-data-repair__summary-value">
        {props.value}
      </dd>
    </div>
  );
}

function RepairPlanGroups(
  props: { plan: WereadReadingDataRepairPlan; loading: boolean },
): JSX.Element {
  const { plan, loading } = props;
  if (loading) {
    return (
      <p
        className="weread-reading-data-repair__loading"
        data-testid="weread-reading-data-repair-loading"
      >
        正在根据当前审计结果整理建议……
      </p>
    );
  }
  if (plan.recommendations.length === 0) {
    return (
      <p
        className="weread-reading-data-repair__empty"
        data-testid="weread-reading-data-repair-empty"
      >
        当前审计结果没有需要生成的修复建议。
      </p>
    );
  }
  return (
    <ol
      className="weread-reading-data-repair__groups"
      data-testid="weread-reading-data-repair-groups"
    >
      {plan.groups.map((group) => (
        <RepairPlanGroup
          key={`${group.priority}|${group.action}`}
          group={group}
        />
      ))}
    </ol>
  );
}

function RepairPlanGroup(
  props: { group: ReadingDataRepairRecommendationGroup },
): JSX.Element {
  const { group } = props;
  return (
    <li
      className="weread-reading-data-repair__group"
      data-testid="weread-reading-data-repair-group"
      data-priority={group.priority}
      data-action={group.action}
    >
      <header className="weread-reading-data-repair__group-header">
        <span
          className={`weread-reading-data-repair__priority weread-reading-data-repair__priority--${group.priority}`}
        >
          {PRIORITY_LABEL[group.priority]}
        </span>
        <span className="weread-reading-data-repair__action">
          {ACTION_LABEL[group.action]}
        </span>
        <span className="weread-reading-data-repair__capability">
          {CAPABILITY_LABEL[group.capability]}
        </span>
        <span className="weread-reading-data-repair__guidance">
          {GUIDANCE_LABEL[group.guidanceKey]}
        </span>
        <span
          className="weread-reading-data-repair__count"
          data-testid="weread-reading-data-repair-group-count"
        >
          {group.count}
        </span>
      </header>
      <ul className="weread-reading-data-repair__items">
        {group.recommendations.map((rec) => (
          <RepairPlanItem key={rec.id} rec={rec} />
        ))}
      </ul>
    </li>
  );
}

function RepairPlanItem(
  props: { rec: ReadingDataRepairRecommendation },
): JSX.Element {
  const { rec } = props;
  return (
    <li
      className="weread-reading-data-repair__item"
      data-testid="weread-reading-data-repair-item"
    >
      <div className="weread-reading-data-repair__item-issue">
        {ISSUE_LABEL[rec.sourceIssueCode] ?? rec.sourceIssueCode}
        <span className="weread-reading-data-repair__item-scope">
          {SCOPE_LABEL[rec.scope]}
        </span>
      </div>
      <RepairPlanItemLocation rec={rec} />
    </li>
  );
}

function RepairPlanItemLocation(
  props: { rec: ReadingDataRepairRecommendation },
): JSX.Element {
  const { rec } = props;
  const parts: string[] = [];
  if (typeof rec.year === "number") parts.push(String(rec.year));
  if (
    typeof rec.fromYear === "number" &&
    typeof rec.toYear === "number"
  ) {
    parts.push(`${rec.fromYear} → ${rec.toYear}`);
  }
  if (typeof rec.itemIndex === "number") {
    parts.push(`第 ${rec.itemIndex + 1} 项`);
  }
  if (typeof rec.rank === "number") {
    parts.push(`第 ${rec.rank} 名`);
  }
  if (parts.length === 0) {
    return <span className="weread-reading-data-repair__item-location" />;
  }
  return (
    <span className="weread-reading-data-repair__item-location">
      {parts.join(" · ")}
    </span>
  );
}

// ---------- special sections driven by model selectors ----------

function RepairPlanActionable(
  props: { plan: WereadReadingDataRepairPlan; loading: boolean },
): JSX.Element {
  const { plan, loading } = props;
  if (loading) return <></>;
  const items = selectActionableRepairRecommendations(plan);
  return (
    <section
      className="weread-reading-data-repair__actionable"
      data-testid="weread-reading-data-repair-actionable"
    >
      <h4 className="weread-reading-data-repair__special-title">
        可直接由现有界面处理
      </h4>
      <p className="weread-reading-data-repair__special-note">
        这些建议可通过长期档案现有的重试或重新加载入口处理，本面板不会代替用户执行。
      </p>
      <p className="weread-reading-data-repair__special-count">
        {items.length}
      </p>
    </section>
  );
}

function RepairPlanManualReview(
  props: { plan: WereadReadingDataRepairPlan; loading: boolean },
): JSX.Element {
  const { plan, loading } = props;
  if (loading) return <></>;
  const items = selectManualReviewRepairRecommendations(plan);
  return (
    <section
      className="weread-reading-data-repair__manual-review"
      data-testid="weread-reading-data-repair-manual-review"
    >
      <h4 className="weread-reading-data-repair__special-title">
        需要人工核对
      </h4>
      <p className="weread-reading-data-repair__special-count">
        {items.length}
      </p>
    </section>
  );
}

function RepairPlanUnsupported(
  props: { plan: WereadReadingDataRepairPlan; loading: boolean },
): JSX.Element {
  const { plan, loading } = props;
  if (loading) return <></>;
  const items = selectUnsupportedRepairRecommendations(plan);
  return (
    <section
      className="weread-reading-data-repair__unsupported"
      data-testid="weread-reading-data-repair-unsupported"
    >
      <h4 className="weread-reading-data-repair__special-title">
        当前字段不足
      </h4>
      <p className="weread-reading-data-repair__special-note">
        当前审计字段不足时，系统不会推测缺失结果。
      </p>
      <p className="weread-reading-data-repair__special-count">
        {items.length}
      </p>
    </section>
  );
}

function RepairPlanHighestPriority(
  props: { plan: WereadReadingDataRepairPlan; loading: boolean },
): JSX.Element {
  const { plan, loading } = props;
  if (loading) return <></>;
  const items = selectHighestPriorityRepairRecommendations(plan);
  return (
    <section
      className="weread-reading-data-repair__highest"
      data-testid="weread-reading-data-repair-highest"
    >
      <h4 className="weread-reading-data-repair__special-title">
        最高优先级建议
      </h4>
      <p className="weread-reading-data-repair__special-count">
        {items.length}
      </p>
    </section>
  );
}

// Re-export label maps so future tests / reports can iterate over them.
export const REPAIR_PRIORITY_LABELS = PRIORITY_LABEL;
export const REPAIR_ACTION_LABELS = ACTION_LABEL;
export const REPAIR_CAPABILITY_LABELS = CAPABILITY_LABEL;
export const REPAIR_GUIDANCE_LABELS = GUIDANCE_LABEL;
export const REPAIR_PRIORITY_ORDER = PRIORITY_ORDER;
export const REPAIR_ACTION_ORDER = ACTION_ORDER;
export const REPAIR_CAPABILITY_ORDER = CAPABILITY_ORDER;