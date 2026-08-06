/**
 * S27R-1A — Reading Data Repair Recommendation Core Model.
 *
 * Pure-function module that converts the current `WereadReadingDataQualityAudit`
 * (S27Q-1C) into a deterministic, safe-to-display repair plan. Each Issue becomes
 * exactly one Recommendation. The plan is consumed by future UI; it must NOT
 * auto-retry, auto-reload, request network, persist data, modify the archive,
 * or render free-form text that could leak private fields.
 *
 * Boundary contract:
 *   - No fetch / no storage / no URL mutation / no DOM.
 *   - No AI call.
 *   - No `message` / `detail` / `reason` / `instructions` free text.
 *     UI maps enums to Chinese labels with a dedicated i18n table later.
 *   - No `title` / `author` / `catalogId` / note / private IDs / token.
 *   - No `actual` / `expected` numeric or string values (positions only).
 *   - `automatic = false` and `modifiesSourceData = false` are fixed booleans.
 *
 * Sort and grouping contract:
 *   - Recommendations sorted by (priorityRank, scopeRank, yearAsc, fromYear,
 *     toYear, code, itemIndex, rank, id).
 *   - One Recommendation per source Issue. Same Issue → one Recommendation,
 *     never duplicated.
 *   - IDs are deterministic (`repair:<issue-id>:<action>`); no UUID / timestamp.
 *
 * The `buildReadingDataRepairDebugSnapshot(plan)` companion returns a safe
 * JSON-serialisable object containing only allow-listed fields, used by future
 * reset keys and by tests; it MUST NOT include IDs, itemIndex, rank, or any
 * private field.
 */

import type {
  ReadingDataQualityIssue,
  ReadingDataQualityIssueCode,
  ReadingDataQualityScope,
  ReadingDataQualitySeverity,
  WereadReadingDataQualityAudit,
} from "./wereadReadingDataQualityAudit";

// ---------- public types ----------

export type ReadingDataRepairPriority =
  | "high"
  | "medium"
  | "low"
  | "informational";

export type ReadingDataRepairAction =
  | "retry_failed_year"
  | "reload_year"
  | "inspect_source_data"
  | "review_metric_relationship"
  | "review_top_book_metadata"
  | "review_year_link"
  | "review_recurring_aggregation"
  | "unsupported_with_current_fields"
  | "no_action_required";

export type ReadingDataRepairCapability =
  | "user_retry"
  | "user_reload"
  | "manual_review"
  | "information_only"
  | "unsupported";

export type ReadingDataRepairGuidanceKey =
  | "retry_failed_years"
  | "reload_archive_year"
  | "inspect_archive_source"
  | "review_year_metric_consistency"
  | "review_top_book_public_metadata"
  | "review_adjacent_year_links"
  | "review_recurring_aggregation"
  | "current_fields_insufficient"
  | "no_action";

export interface ReadingDataRepairRecommendationGroup {
  priority: ReadingDataRepairPriority;
  action: ReadingDataRepairAction;
  capability: ReadingDataRepairCapability;
  guidanceKey: ReadingDataRepairGuidanceKey;
  count: number;
  recommendations: ReadingDataRepairRecommendation[];
}

export interface ReadingDataRepairRecommendation {
  id: string;
  sourceIssueCode: ReadingDataQualityIssueCode;
  sourceSeverity: ReadingDataQualitySeverity;
  scope: ReadingDataQualityScope;
  priority: ReadingDataRepairPriority;
  action: ReadingDataRepairAction;
  capability: ReadingDataRepairCapability;
  guidanceKey: ReadingDataRepairGuidanceKey;

  year?: number;
  fromYear?: number;
  toYear?: number;
  itemIndex?: number;
  rank?: number;

  automatic: false;
  modifiesSourceData: false;
}

export interface WereadReadingDataRepairSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
  retryable: number;
  reloadable: number;
  manualReview: number;
  unsupported: number;
}

export interface WereadReadingDataRepairMeta {
  source: "current_data_quality_audit";
  persisted: false;
  requestedNetwork: false;
  automaticRepair: false;
}

export interface WereadReadingDataRepairPlan {
  recommendations: ReadingDataRepairRecommendation[];
  groups: ReadingDataRepairRecommendationGroup[];
  actionCounts: Record<ReadingDataRepairAction, number>;
  capabilityCounts: Record<ReadingDataRepairCapability, number>;
  summary: WereadReadingDataRepairSummary;
  meta: WereadReadingDataRepairMeta;
}

// ---------- mappings ----------

const REPAIR_ACTION_BY_ISSUE = {
  // coverage
  empty_archive: "no_action_required",
  partial_archive: "retry_failed_year",
  target_year_unaccounted: "reload_year",
  loaded_failed_conflict: "inspect_source_data",
  duplicate_loaded_year: "inspect_source_data",
  invalid_year: "inspect_source_data",
  // year
  non_finite_metric: "review_metric_relationship",
  negative_metric: "review_metric_relationship",
  dated_records_exceed_total: "review_metric_relationship",
  matched_records_exceed_total: "review_metric_relationship",
  matched_books_exceed_matched_records: "review_metric_relationship",
  active_months_out_of_range: "review_metric_relationship",
  streak_months_out_of_range: "review_metric_relationship",
  streak_exceeds_active_months: "review_metric_relationship",
  peak_month_year_mismatch: "review_metric_relationship",
  // top_book
  top_books_exceed_limit: "review_top_book_metadata",
  top_book_missing_catalog: "review_top_book_metadata",
  top_book_missing_title: "review_top_book_metadata",
  top_book_duplicate_catalog: "review_top_book_metadata",
  top_book_invalid_rank: "review_top_book_metadata",
  top_book_duplicate_rank: "review_top_book_metadata",
  top_book_records_exceed_year_total: "review_top_book_metadata",
  top_book_order_mismatch: "review_top_book_metadata",
  // year_link
  year_link_unknown_year: "review_year_link",
  year_link_invalid_order: "review_year_link",
  year_link_duplicate_pair: "review_year_link",
  year_link_invalid_counts: "review_year_link",
  year_link_ratio_out_of_range: "review_year_link",
  year_link_ratio_mismatch: "review_year_link",
  missing_year_link: "review_year_link",
  // recurring (audit-emitted)
  recurring_duplicate_catalog: "review_recurring_aggregation",
  recurring_appearance_count_mismatch: "review_recurring_aggregation",
  recurring_unknown_year: "review_recurring_aggregation",
  recurring_duplicate_year: "review_recurring_aggregation",
  recurring_invalid_rank: "review_recurring_aggregation",
  recurring_latest_year_mismatch: "review_recurring_aggregation",
  // reserved / unused in current audit but kept exhaustive
  // NOTE: the S27Q `ReadingDataQualityIssueCode` union currently contains
  // 36 audit-emitted codes only; the S27R spec describes two additional
  // reserved codes (`recurring_best_rank_mismatch`,
  // `recurring_latest_rank_mismatch`) that would require extending the
  // S27Q union. That extension is explicitly forbidden in S27R-1A
  // (must not modify the S27Q audit model). Those two entries are
  // therefore noted here for future use only; they are NOT in the live
  // mapping until the audit union itself grows them.
} satisfies Record<ReadingDataQualityIssueCode, ReadingDataRepairAction>;

const REPAIR_CAPABILITY_BY_ACTION: Record<
  ReadingDataRepairAction,
  ReadingDataRepairCapability
> = {
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

const GUIDANCE_BY_ACTION: Record<
  ReadingDataRepairAction,
  ReadingDataRepairGuidanceKey
> = {
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

const ALL_ACTIONS: readonly ReadingDataRepairAction[] = [
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

const ALL_CAPABILITIES: readonly ReadingDataRepairCapability[] = [
  "user_retry",
  "user_reload",
  "manual_review",
  "information_only",
  "unsupported",
];

const PRIORITY_RANK: Record<ReadingDataRepairPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
  informational: 3,
};

const SCOPE_RANK: Record<ReadingDataQualityScope, number> = {
  archive: 0,
  coverage: 1,
  year: 2,
  top_book: 3,
  year_link: 4,
  recurring_book: 5,
};

// ---------- priority derivation ----------

function derivePriority(
  severity: ReadingDataQualitySeverity,
  action: ReadingDataRepairAction,
): ReadingDataRepairPriority {
  if (action === "no_action_required") return "informational";
  if (action === "unsupported_with_current_fields") return "low";
  if (severity === "error") return "high";
  if (severity === "warning") return "medium";
  return "informational";
}

// ---------- position extraction ----------

function positionOf(
  issue: ReadingDataQualityIssue,
): {
  year?: number;
  fromYear?: number;
  toYear?: number;
  itemIndex?: number;
  rank?: number;
} {
  const itemIndex =
    issue.itemIndex == null
      ? undefined
      : typeof issue.itemIndex === "number"
        ? issue.itemIndex
        : undefined;
  const rank =
    issue.rank == null
      ? undefined
      : typeof issue.rank === "number"
        ? issue.rank
        : undefined;
  return {
    year: typeof issue.year === "number" ? issue.year : undefined,
    fromYear: typeof issue.fromYear === "number" ? issue.fromYear : undefined,
    toYear: typeof issue.toYear === "number" ? issue.toYear : undefined,
    itemIndex,
    rank,
  };
}

// ---------- plan builder ----------

export function buildWereadReadingDataRepairPlan(
  audit: WereadReadingDataQualityAudit,
): WereadReadingDataRepairPlan {
  const recommendations: ReadingDataRepairRecommendation[] = audit.issues.map(
    (issue) => {
      const action = REPAIR_ACTION_BY_ISSUE[issue.code];
      const capability = REPAIR_CAPABILITY_BY_ACTION[action];
      const priority = derivePriority(issue.severity, action);
      const guidanceKey = GUIDANCE_BY_ACTION[action];
      const pos = positionOf(issue);
      return {
        id: `repair:${issue.id}:${action}`,
        sourceIssueCode: issue.code,
        sourceSeverity: issue.severity,
        scope: issue.scope,
        priority,
        action,
        capability,
        guidanceKey,
        ...pos,
        automatic: false as const,
        modifiesSourceData: false as const,
      };
    },
  );

  recommendations.sort((a, b) => {
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    }
    if (SCOPE_RANK[a.scope] !== SCOPE_RANK[b.scope]) {
      return SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    }
    const ay = a.year ?? Number.POSITIVE_INFINITY;
    const by = b.year ?? Number.POSITIVE_INFINITY;
    if (ay !== by) return ay - by;
    const af = a.fromYear ?? Number.POSITIVE_INFINITY;
    const bf = b.fromYear ?? Number.POSITIVE_INFINITY;
    if (af !== bf) return af - bf;
    const at = a.toYear ?? Number.POSITIVE_INFINITY;
    const bt = b.toYear ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    if (a.sourceIssueCode !== b.sourceIssueCode) {
      return a.sourceIssueCode < b.sourceIssueCode ? -1 : 1;
    }
    const ai = a.itemIndex ?? Number.POSITIVE_INFINITY;
    const bi = b.itemIndex ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    const ar = a.rank ?? Number.POSITIVE_INFINITY;
    const br = b.rank ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const summary: WereadReadingDataRepairSummary = {
    total: recommendations.length,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
    retryable: 0,
    reloadable: 0,
    manualReview: 0,
    unsupported: 0,
  };
  const actionCounts = {} as Record<ReadingDataRepairAction, number>;
  for (const a of ALL_ACTIONS) actionCounts[a] = 0;
  const capabilityCounts = {} as Record<ReadingDataRepairCapability, number>;
  for (const c of ALL_CAPABILITIES) capabilityCounts[c] = 0;

  for (const rec of recommendations) {
    summary[rec.priority] += 1;
    if (rec.capability === "user_retry") summary.retryable += 1;
    else if (rec.capability === "user_reload") summary.reloadable += 1;
    else if (rec.capability === "manual_review") summary.manualReview += 1;
    else if (rec.capability === "unsupported") summary.unsupported += 1;
    actionCounts[rec.action] += 1;
    capabilityCounts[rec.capability] += 1;
  }

  const groups = groupReadingDataRepairRecommendations(recommendations);

  return {
    recommendations,
    groups,
    actionCounts,
    capabilityCounts,
    summary,
    meta: {
      source: "current_data_quality_audit",
      persisted: false,
      requestedNetwork: false,
      automaticRepair: false,
    },
  };
}

// ---------- debug snapshot (safe fields only) ----------

// ---------- grouping ----------

export function groupReadingDataRepairRecommendations(
  recommendations: ReadingDataRepairRecommendation[],
): ReadingDataRepairRecommendationGroup[] {
  const buckets = new Map<
    string,
    {
      priority: ReadingDataRepairPriority;
      action: ReadingDataRepairAction;
      capability: ReadingDataRepairCapability;
      guidanceKey: ReadingDataRepairGuidanceKey;
      items: ReadingDataRepairRecommendation[];
    }
  >();
  for (const rec of recommendations) {
    const key = `${rec.priority}|${rec.action}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.items.push(rec);
    } else {
      buckets.set(key, {
        priority: rec.priority,
        action: rec.action,
        capability: rec.capability,
        guidanceKey: rec.guidanceKey,
        items: [rec],
      });
    }
  }
  const out: ReadingDataRepairRecommendationGroup[] = [];
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => {
    const [pa, aa] = a.split("|") as [ReadingDataRepairPriority, ReadingDataRepairAction];
    const [pb, ab] = b.split("|") as [ReadingDataRepairPriority, ReadingDataRepairAction];
    if (PRIORITY_RANK[pa] !== PRIORITY_RANK[pb]) {
      return PRIORITY_RANK[pa] - PRIORITY_RANK[pb];
    }
    return ALL_ACTIONS.indexOf(aa) - ALL_ACTIONS.indexOf(ab);
  });
  for (const k of sortedKeys) {
    const b = buckets.get(k);
    if (!b) continue;
    out.push({
      priority: b.priority,
      action: b.action,
      capability: b.capability,
      guidanceKey: b.guidanceKey,
      count: b.items.length,
      recommendations: b.items.slice(),
    });
  }
  return out;
}

// ---------- selectors ----------

export function selectHighestPriorityRepairRecommendations(
  plan: WereadReadingDataRepairPlan,
): ReadingDataRepairRecommendation[] {
  const order: ReadingDataRepairPriority[] = [
    "high",
    "medium",
    "low",
    "informational",
  ];
  for (const p of order) {
    const items = plan.recommendations.filter((r) => r.priority === p);
    if (items.length > 0) return items.slice();
  }
  return [];
}

export function selectActionableRepairRecommendations(
  plan: WereadReadingDataRepairPlan,
): ReadingDataRepairRecommendation[] {
  return plan.recommendations
    .filter(
      (r) => r.capability === "user_retry" || r.capability === "user_reload",
    )
    .slice();
}

export function selectManualReviewRepairRecommendations(
  plan: WereadReadingDataRepairPlan,
): ReadingDataRepairRecommendation[] {
  return plan.recommendations
    .filter((r) => r.capability === "manual_review")
    .slice();
}

export function selectUnsupportedRepairRecommendations(
  plan: WereadReadingDataRepairPlan,
): ReadingDataRepairRecommendation[] {
  return plan.recommendations
    .filter((r) => r.capability === "unsupported")
    .slice();
}

// ---------- debug snapshot (safe fields only) ----------

export interface ReadingDataRepairDebugSnapshot {
  count: number;
  priorityCounts: WereadReadingDataRepairSummary;
  actionCounts: Record<ReadingDataRepairAction, number>;
  capabilityCounts: Record<ReadingDataRepairCapability, number>;
  groupCount: number;
  groups: Array<{
    priority: ReadingDataRepairPriority;
    action: ReadingDataRepairAction;
    capability: ReadingDataRepairCapability;
    guidanceKey: ReadingDataRepairGuidanceKey;
    count: number;
  }>;
  actions: ReadingDataRepairAction[];
  guidanceKeys: ReadingDataRepairGuidanceKey[];
  codes: ReadingDataQualityIssueCode[];
  scopes: ReadingDataQualityScope[];
  priorities: ReadingDataRepairPriority[];
  capabilities: ReadingDataRepairCapability[];
  years: number[];
  fromYears: number[];
  toYears: number[];
  meta: WereadReadingDataRepairMeta;
}

export function buildReadingDataRepairDebugSnapshot(
  plan: WereadReadingDataRepairPlan,
): ReadingDataRepairDebugSnapshot {
  return {
    count: plan.summary.total,
    priorityCounts: plan.summary,
    actionCounts: plan.actionCounts,
    capabilityCounts: plan.capabilityCounts,
    groupCount: plan.groups.length,
    groups: plan.groups.map((g) => ({
      priority: g.priority,
      action: g.action,
      capability: g.capability,
      guidanceKey: g.guidanceKey,
      count: g.count,
    })),
    actions: plan.recommendations.map((r) => r.action),
    guidanceKeys: plan.recommendations.map((r) => r.guidanceKey),
    codes: plan.recommendations.map((r) => r.sourceIssueCode),
    scopes: plan.recommendations.map((r) => r.scope),
    priorities: plan.recommendations.map((r) => r.priority),
    capabilities: plan.recommendations.map((r) => r.capability),
    years: plan.recommendations
      .map((r) => r.year)
      .filter((y): y is number => typeof y === "number"),
    fromYears: plan.recommendations
      .map((r) => r.fromYear)
      .filter((y): y is number => typeof y === "number"),
    toYears: plan.recommendations
      .map((r) => r.toYear)
      .filter((y): y is number => typeof y === "number"),
    meta: plan.meta,
  };
}