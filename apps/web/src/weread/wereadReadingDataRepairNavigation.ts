// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigation.ts
//
// S27S-1A — Guided Repair Navigation Intent Model.
//
// Pure model layer for "where should the user look next?" derived from an
// existing repair recommendation plan. This module DOES NOT:
//   - mutate DOM (no scrollIntoView / focus / dispatchEvent)
//   - issue network requests (no HTTP / XHR / WS)
//   - retry / reload / re-issue any data
//   - write to browser persistent storage (no LS / SS / IDB)
//   - modify URL / fragment / past-state
//   - execute any repair action
//   - import framework / DOM / browser globals
//
// The model is purely functional: given a `WereadReadingDataRepairPlan`, it
// produces a `WereadReadingDataRepairNavigationPlan` (immutable, deterministic).
// It only references existing UI surfaces (panels, controls, sections) by
// semantic target name — never by DOM selector, element id, or URL.
//
// Navigation targets correspond to existing UI regions verified in the
// Dashboard / Panels (see `ReadingArchiveDashboard.tsx`,
// `ReadingDataQualityAuditPanel.tsx`, `ReadingDataRepairRecommendationsPanel.tsx`,
// `ReadingDataRepairExportAction.tsx`):

import type {
  ReadingDataRepairAction,
  ReadingDataRepairCapability,
  ReadingDataRepairRecommendation,
  WereadReadingDataRepairPlan,
} from "./wereadReadingDataRepairRecommendations";
import type { ReadingDataQualityIssueCode } from "./wereadReadingDataQualityAudit";

// ---------- navigation target ----------

/**
 * Semantic navigation target names. Each value maps to an existing UI surface
 * already present in the Dashboard / Panels. No DOM selector / element id /
 * URL is stored in the model — only a stable enum that future UI layers can
 * bind to their preferred interaction (scroll / focus / highlight).
 *
 * `none` is reserved for "no navigation is appropriate" (e.g. actions that
 * require no follow-up surface).
 */
export type ReadingDataRepairNavigationTarget =
  | "failed_year_controls"
  | "archive_year_directory"
  | "data_quality_audit"
  | "top_books"
  | "year_links"
  | "recurring_books"
  | "repair_recommendations"
  | "none";

export const ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS: readonly ReadingDataRepairNavigationTarget[] = [
  "failed_year_controls",
  "archive_year_directory",
  "data_quality_audit",
  "top_books",
  "year_links",
  "recurring_books",
  "repair_recommendations",
  "none",
] as const;

// ---------- navigation kind ----------

/**
 * Classification of how a navigation intent should be presented.
 *
 * `focus_existing_surface` — future UI may guide the user to the named surface
 *   (e.g. scroll / focus). This does NOT trigger any action.
 * `information_only` — the recommendation is informational; no navigation
 *   is appropriate (e.g. `unsupported_with_current_fields`).
 * `none` — no navigation is needed (e.g. `no_action_required`).
 */
export type ReadingDataRepairNavigationKind =
  | "focus_existing_surface"
  | "information_only"
  | "none";

export const ALL_READING_DATA_REPAIR_NAVIGATION_KINDS: readonly ReadingDataRepairNavigationKind[] = [
  "focus_existing_surface",
  "information_only",
  "none",
] as const;

// ---------- intent ----------

/**
 * Per-recommendation navigation intent. Carries the safe locator fields
 * already present on the source recommendation (year, fromYear, toYear,
 * itemIndex, rank). It does NOT carry recommendation id, issue id, actual /
 * expected values, title / author / catalogId, or any raw audit / plan data.
 */
export interface ReadingDataRepairNavigationIntent {
  sourceIssueCode: ReadingDataQualityIssueCode;
  action: ReadingDataRepairAction;
  capability: ReadingDataRepairCapability;
  target: ReadingDataRepairNavigationTarget;
  kind: ReadingDataRepairNavigationKind;

  year?: number;
  fromYear?: number;
  toYear?: number;
  itemIndex?: number;
  rank?: number;

  automatic: false;
  executesRepair: false;
  requestedNetwork: false;
  modifiesSourceData: false;
}

// ---------- action -> target mapping ----------

const ACTION_TO_TARGET = {
  retry_failed_year: "failed_year_controls",
  reload_year: "archive_year_directory",
  inspect_source_data: "data_quality_audit",
  review_metric_relationship: "data_quality_audit",
  review_top_book_metadata: "top_books",
  review_year_link: "year_links",
  review_recurring_aggregation: "recurring_books",
  unsupported_with_current_fields: "repair_recommendations",
  no_action_required: "none",
} as const satisfies Record<ReadingDataRepairAction, ReadingDataRepairNavigationTarget>;

// ---------- capability -> kind mapping ----------

const ACTION_TO_KIND: Record<ReadingDataRepairAction, ReadingDataRepairNavigationKind> = {
  retry_failed_year: "focus_existing_surface",
  reload_year: "focus_existing_surface",
  inspect_source_data: "focus_existing_surface",
  review_metric_relationship: "focus_existing_surface",
  review_top_book_metadata: "focus_existing_surface",
  review_year_link: "focus_existing_surface",
  review_recurring_aggregation: "focus_existing_surface",
  unsupported_with_current_fields: "information_only",
  no_action_required: "none",
};

// ---------- navigation plan ----------

export interface WereadReadingDataRepairNavigationSummary {
  total: number;
  focusable: number;
  informational: number;
  none: number;
}

export interface WereadReadingDataRepairNavigationTargetCounts {
  failed_year_controls: number;
  archive_year_directory: number;
  data_quality_audit: number;
  top_books: number;
  year_links: number;
  recurring_books: number;
  repair_recommendations: number;
  none: number;
}

export interface WereadReadingDataRepairNavigationMeta {
  source: "current_repair_recommendation_plan";
  automaticNavigation: false;
  executesRepair: false;
  requestedNetwork: false;
  modifiesSourceData: false;
}

export interface WereadReadingDataRepairNavigationPlan {
  intents: ReadingDataRepairNavigationIntent[];
  summary: WereadReadingDataRepairNavigationSummary;
  targetCounts: WereadReadingDataRepairNavigationTargetCounts;
  meta: WereadReadingDataRepairNavigationMeta;
}

// ---------- builders ----------

function makeEmptyTargetCounts(): WereadReadingDataRepairNavigationTargetCounts {
  return {
    failed_year_controls: 0,
    archive_year_directory: 0,
    data_quality_audit: 0,
    top_books: 0,
    year_links: 0,
    recurring_books: 0,
    repair_recommendations: 0,
    none: 0,
  };
}

function makeIntentFromRecommendation(
  rec: ReadingDataRepairRecommendation,
): ReadingDataRepairNavigationIntent {
  const target = ACTION_TO_TARGET[rec.action];
  const kind = ACTION_TO_KIND[rec.action];
  return {
    sourceIssueCode: rec.sourceIssueCode,
    action: rec.action,
    capability: rec.capability,
    target,
    kind,
    year: rec.year,
    fromYear: rec.fromYear,
    toYear: rec.toYear,
    itemIndex: rec.itemIndex,
    rank: rec.rank,
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  };
}

/**
 * Build the navigation plan from an existing repair recommendation plan.
 *
 * Contract:
 *   - one intent per recommendation (1:1 mapping)
 *   - preserves source plan order (no re-sort)
 *   - does not mutate the input plan
 *   - no network / storage / URL / DOM side effects
 *   - targetCounts always includes every NavigationTarget (even when 0)
 */
export function buildWereadReadingDataRepairNavigationPlan(
  plan: WereadReadingDataRepairPlan,
): WereadReadingDataRepairNavigationPlan {
  const intents = plan.recommendations.map(makeIntentFromRecommendation);

  const targetCounts = makeEmptyTargetCounts();
  let focusable = 0;
  let informational = 0;
  let none = 0;

  for (const intent of intents) {
    targetCounts[intent.target] += 1;
    if (intent.kind === "focus_existing_surface") focusable += 1;
    else if (intent.kind === "information_only") informational += 1;
    else none += 1;
  }

  return {
    intents,
    summary: { total: intents.length, focusable, informational, none },
    targetCounts,
    meta: {
      source: "current_repair_recommendation_plan",
      automaticNavigation: false,
      executesRepair: false,
      requestedNetwork: false,
      modifiesSourceData: false,
    },
  };
}

// ---------- selectors ----------

/**
 * Return intents whose kind is `focus_existing_surface`. New array; preserves
 * source plan order; does not mutate `plan`.
 */
export function selectFocusableRepairNavigationIntents(
  plan: WereadReadingDataRepairPlan,
): ReadingDataRepairNavigationIntent[] {
  const navPlan = buildWereadReadingDataRepairNavigationPlan(plan);
  return navPlan.intents.filter((i) => i.kind === "focus_existing_surface");
}

/**
 * Return intents whose kind is `information_only`. New array; preserves
 * source plan order; does not mutate `plan`.
 */
export function selectInformationalRepairNavigationIntents(
  plan: WereadReadingDataRepairPlan,
): ReadingDataRepairNavigationIntent[] {
  const navPlan = buildWereadReadingDataRepairNavigationPlan(plan);
  return navPlan.intents.filter((i) => i.kind === "information_only");
}

/**
 * Return intents whose `target` matches the supplied target. New array;
 * preserves source plan order; does not mutate `plan`.
 */
export function selectRepairNavigationIntentsForTarget(
  plan: WereadReadingDataRepairPlan,
  target: ReadingDataRepairNavigationTarget,
): ReadingDataRepairNavigationIntent[] {
  const navPlan = buildWereadReadingDataRepairNavigationPlan(plan);
  return navPlan.intents.filter((i) => i.target === target);
}

// ---------- safe debug snapshot ----------

const SAFE_NAVIGATION_DEBUG_KEYS: ReadonlySet<string> = new Set([
  "total",
  "summary",
  "targetCounts",
  "actions",
  "capabilities",
  "targets",
  "kinds",
  "sourceIssueCodes",
  "years",
  "fromYears",
  "toYears",
  "meta",
]);

/**
 * Build a debug snapshot from the navigation plan that only contains safe,
 * non-private fields. Intentionally excludes: `itemIndex`, `rank`,
 * recommendation id, issue id, raw recommendation, raw repair plan,
 * actual / expected, title / author / catalogId.
 */
export function buildReadingDataRepairNavigationDebugSnapshot(
  navPlan: WereadReadingDataRepairNavigationPlan,
): Record<string, unknown> {
  const years: number[] = [];
  const fromYears: number[] = [];
  const toYears: number[] = [];
  const actions = new Set<ReadingDataRepairAction>();
  const capabilities = new Set<ReadingDataRepairCapability>();
  const targets = new Set<ReadingDataRepairNavigationTarget>();
  const kinds = new Set<ReadingDataRepairNavigationKind>();
  const sourceIssueCodes = new Set<ReadingDataQualityIssueCode>();

  for (const intent of navPlan.intents) {
    actions.add(intent.action);
    capabilities.add(intent.capability);
    targets.add(intent.target);
    kinds.add(intent.kind);
    sourceIssueCodes.add(intent.sourceIssueCode);
    if (typeof intent.year === "number") years.push(intent.year);
    if (typeof intent.fromYear === "number") fromYears.push(intent.fromYear);
    if (typeof intent.toYear === "number") toYears.push(intent.toYear);
  }

  const snapshot: Record<string, unknown> = {
    total: navPlan.intents.length,
    summary: navPlan.summary,
    targetCounts: navPlan.targetCounts,
    actions: Array.from(actions).sort(),
    capabilities: Array.from(capabilities).sort(),
    targets: Array.from(targets).sort(),
    kinds: Array.from(kinds).sort(),
    sourceIssueCodes: Array.from(sourceIssueCodes).sort(),
    years: years.sort((a, b) => a - b),
    fromYears: fromYears.sort((a, b) => a - b),
    toYears: toYears.sort((a, b) => a - b),
    meta: navPlan.meta,
  };

  // Defensive allowlist: any non-listed key is filtered out. This protects
  // against future fields leaking into the snapshot by mistake.
  for (const key of Object.keys(snapshot)) {
    if (!SAFE_NAVIGATION_DEBUG_KEYS.has(key)) {
      delete snapshot[key];
    }
  }
  return snapshot;
}