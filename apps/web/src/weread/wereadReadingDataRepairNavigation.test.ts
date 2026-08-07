// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigation.test.ts
//
// S27S-1A — Targeted tests for the Guided Repair Navigation Intent Model.
// 50+ tests covering: action coverage, target/kind exhaustive mappings,
// retry/reload/audit/top-books/year-links/recurring targets, unsupported
// information-only, no-action none, locator fields, deterministic order,
// 1:1 mapping, empty plan, summary, targetCounts keys, selectors, selector
// array isolation, input immutability, automatic/executesRepair/network/
// source-data flags, debug allowlist, debug privacy exclusions, no
// fetch/XHR, no retry/reload execution, no storage, no URL, no DOM, no React,
// no evaluation language, no NaN/Infinity.

import { describe, expect, it } from "vitest";

import type {
  ReadingDataRepairAction,
  ReadingDataRepairCapability,
  ReadingDataRepairRecommendation,
  WereadReadingDataRepairPlan,
  WereadReadingDataRepairSummary,
  WereadReadingDataRepairMeta,
} from "./wereadReadingDataRepairRecommendations";
import type { ReadingDataQualityIssueCode, ReadingDataQualitySeverity, ReadingDataQualityScope } from "./wereadReadingDataQualityAudit";

import {
  ALL_READING_DATA_REPAIR_NAVIGATION_KINDS,
  ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS,
  buildReadingDataRepairNavigationDebugSnapshot,
  buildWereadReadingDataRepairNavigationPlan,
  selectFocusableRepairNavigationIntents,
  selectInformationalRepairNavigationIntents,
  selectRepairNavigationIntentsForTarget,
  type ReadingDataRepairNavigationIntent,
  type ReadingDataRepairNavigationKind,
  type ReadingDataRepairNavigationTarget,
} from "./wereadReadingDataRepairNavigation";

// ---------- synthetic plan factory ----------

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

const ALL_GUIDANCE_KEYS = [
  "retry_failed_years",
  "reload_archive_year",
  "inspect_archive_source",
  "review_year_metric_consistency",
  "review_top_book_public_metadata",
  "review_adjacent_year_links",
  "review_recurring_aggregation",
  "current_fields_insufficient",
  "no_action",
] as const;

const ACTION_TO_CAPABILITY: Record<ReadingDataRepairAction, ReadingDataRepairCapability> = {
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

const ACTION_TO_GUIDANCE: Record<ReadingDataRepairAction, typeof ALL_GUIDANCE_KEYS[number]> = {
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

function makeRec(
  idx: number,
  action: ReadingDataRepairAction,
  extras: Partial<ReadingDataRepairRecommendation> = {},
): ReadingDataRepairRecommendation {
  return {
    id: `rec-s27s1a-${idx}`,
    sourceIssueCode: "empty_archive" as ReadingDataQualityIssueCode,
    sourceSeverity: "info",
    scope: "coverage",
    priority: "informational",
    action,
    capability: ACTION_TO_CAPABILITY[action],
    guidanceKey: ACTION_TO_GUIDANCE[action],
    automatic: false,
    modifiesSourceData: false,
    ...extras,
  };
}

function makePlan(
  recommendations: ReadingDataRepairRecommendation[],
): WereadReadingDataRepairPlan {
  const actionCounts = {} as Record<ReadingDataRepairAction, number>;
  const capabilityCounts = {} as Record<ReadingDataRepairCapability, number>;
  for (const action of ALL_ACTIONS) actionCounts[action] = 0;
  for (const cap of ALL_CAPABILITIES) capabilityCounts[cap] = 0;
  for (const rec of recommendations) {
    actionCounts[rec.action] += 1;
    capabilityCounts[rec.capability] += 1;
  }
  const summary: WereadReadingDataRepairSummary = {
    total: recommendations.length,
    high: 0,
    medium: 0,
    low: 0,
    informational: recommendations.length,
    retryable: actionCounts.retry_failed_year,
    reloadable: actionCounts.reload_year,
    manualReview: actionCounts.inspect_source_data +
      actionCounts.review_metric_relationship +
      actionCounts.review_top_book_metadata +
      actionCounts.review_year_link +
      actionCounts.review_recurring_aggregation,
    unsupported: actionCounts.unsupported_with_current_fields,
  };
  const meta: WereadReadingDataRepairMeta = {
    source: "current_data_quality_audit",
    persisted: false,
    requestedNetwork: false,
    automaticRepair: false,
  };
  return {
    recommendations,
    groups: [],
    actionCounts,
    capabilityCounts,
    summary,
    meta,
  };
}

// ---------- tests ----------

describe("S27S-1A wereadReadingDataRepairNavigation", () => {
  // ---- action coverage ----
  it("1. all 9 actions covered with target mapping", () => {
    for (const action of ALL_ACTIONS) {
      const recs = [makeRec(1, action)];
      const plan = makePlan(recs);
      const nav = buildWereadReadingDataRepairNavigationPlan(plan);
      expect(nav.intents).toHaveLength(1);
      expect(nav.intents[0].action).toBe(action);
      expect(nav.targetCounts[nav.intents[0].target]).toBe(1);
    }
  });

  it("2. retry_failed_year -> failed_year_controls", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year", { year: 2023 })]),
    );
    expect(nav.intents[0].target).toBe("failed_year_controls");
  });

  it("3. reload_year -> archive_year_directory", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "reload_year", { year: 2022 })]),
    );
    expect(nav.intents[0].target).toBe("archive_year_directory");
  });

  it("4. inspect_source_data -> data_quality_audit", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "inspect_source_data")]),
    );
    expect(nav.intents[0].target).toBe("data_quality_audit");
  });

  it("5. review_metric_relationship -> data_quality_audit", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "review_metric_relationship")]),
    );
    expect(nav.intents[0].target).toBe("data_quality_audit");
  });

  it("6. review_top_book_metadata -> top_books", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "review_top_book_metadata", { rank: 1 })]),
    );
    expect(nav.intents[0].target).toBe("top_books");
  });

  it("7. review_year_link -> year_links", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "review_year_link", { fromYear: 2022, toYear: 2023 })]),
    );
    expect(nav.intents[0].target).toBe("year_links");
  });

  it("8. review_recurring_aggregation -> recurring_books", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "review_recurring_aggregation", { itemIndex: 3 })]),
    );
    expect(nav.intents[0].target).toBe("recurring_books");
  });

  it("9. unsupported_with_current_fields -> repair_recommendations (information_only)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "unsupported_with_current_fields")]),
    );
    expect(nav.intents[0].target).toBe("repair_recommendations");
    expect(nav.intents[0].kind).toBe("information_only");
  });

  it("10. no_action_required -> none", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "no_action_required")]),
    );
    expect(nav.intents[0].target).toBe("none");
    expect(nav.intents[0].kind).toBe("none");
  });

  // ---- exhaustive target ----
  it("11. ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS has 8 entries", () => {
    expect(ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS).toHaveLength(8);
  });

  it("12. ALL_READING_DATA_REPAIR_NAVIGATION_KINDS has 3 entries", () => {
    expect(ALL_READING_DATA_REPAIR_NAVIGATION_KINDS).toHaveLength(3);
  });

  // ---- intent fields ----
  it("13. intent includes safe locator fields (year/fromYear/toYear/itemIndex/rank)", () => {
    const rec = makeRec(1, "retry_failed_year", {
      year: 2023,
      fromYear: 2022,
      toYear: 2024,
      itemIndex: 7,
      rank: 2,
    });
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([rec]));
    const intent = nav.intents[0];
    expect(intent.year).toBe(2023);
    expect(intent.fromYear).toBe(2022);
    expect(intent.toYear).toBe(2024);
    expect(intent.itemIndex).toBe(7);
    expect(intent.rank).toBe(2);
  });

  it("14. intent propagates sourceIssueCode", () => {
    const rec = makeRec(1, "review_year_link", {});
    rec.sourceIssueCode = "year-link:duplicate:abc" as ReadingDataQualityIssueCode;
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([rec]));
    expect(nav.intents[0].sourceIssueCode).toBe("year-link:duplicate:abc");
  });

  it("15. intent propagates capability unchanged", () => {
    const rec = makeRec(1, "inspect_source_data", {});
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([rec]));
    expect(nav.intents[0].capability).toBe("manual_review");
  });

  // ---- safety flags ----
  it("16. every intent has automatic=false", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    for (const intent of nav.intents) expect(intent.automatic).toBe(false);
  });

  it("17. every intent has executesRepair=false", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    for (const intent of nav.intents) expect(intent.executesRepair).toBe(false);
  });

  it("18. every intent has requestedNetwork=false", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    for (const intent of nav.intents) expect(intent.requestedNetwork).toBe(false);
  });

  it("19. every intent has modifiesSourceData=false", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    for (const intent of nav.intents) expect(intent.modifiesSourceData).toBe(false);
  });

  it("20. meta flags all false (no automatic navigation / repair / network / source-modify)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    expect(nav.meta.automaticNavigation).toBe(false);
    expect(nav.meta.executesRepair).toBe(false);
    expect(nav.meta.requestedNetwork).toBe(false);
    expect(nav.meta.modifiesSourceData).toBe(false);
    expect(nav.meta.source).toBe("current_repair_recommendation_plan");
  });

  // ---- 1:1 mapping + deterministic order ----
  it("21. one recommendation -> one intent (1:1 mapping)", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    expect(nav.intents).toHaveLength(recs.length);
    for (let i = 0; i < recs.length; i++) {
      expect(nav.intents[i].action).toBe(recs[i].action);
    }
  });

  it("22. preserves source plan order (deterministic)", () => {
    const order: ReadingDataRepairAction[] = [
      "reload_year",
      "retry_failed_year",
      "review_top_book_metadata",
      "review_year_link",
      "review_recurring_aggregation",
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(order.map((a, i) => makeRec(i, a))),
    );
    expect(nav.intents.map((i) => i.action)).toEqual(order);
  });

  // ---- empty plan ----
  it("23. empty plan yields empty intents and zero counts", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    expect(nav.intents).toHaveLength(0);
    expect(nav.summary.total).toBe(0);
    expect(nav.summary.focusable).toBe(0);
    expect(nav.summary.informational).toBe(0);
    expect(nav.summary.none).toBe(0);
    for (const t of ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS) {
      expect(nav.targetCounts[t]).toBe(0);
    }
  });

  // ---- summary / targetCounts ----
  it("24. summary counts match intents by kind", () => {
    const recs: ReadingDataRepairRecommendation[] = [
      makeRec(1, "retry_failed_year"),
      makeRec(2, "reload_year"),
      makeRec(3, "inspect_source_data"),
      makeRec(4, "unsupported_with_current_fields"),
      makeRec(5, "no_action_required"),
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    expect(nav.summary.total).toBe(5);
    expect(nav.summary.focusable).toBe(3);
    expect(nav.summary.informational).toBe(1);
    expect(nav.summary.none).toBe(1);
  });

  it("25. targetCounts always contains every NavigationTarget key", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    for (const t of ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS) {
      expect(Object.prototype.hasOwnProperty.call(nav.targetCounts, t)).toBe(true);
    }
  });

  it("26. targetCounts sum equals total", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    const sum = Object.values(nav.targetCounts).reduce((s, v) => s + v, 0);
    expect(sum).toBe(nav.summary.total);
  });

  // ---- selectors ----
  it("27. selectFocusableRepairNavigationIntents returns only focusable", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const plan = makePlan(recs);
    const focusable = selectFocusableRepairNavigationIntents(plan);
    expect(focusable.length).toBe(7); // 7 focusable actions
    for (const i of focusable) expect(i.kind).toBe("focus_existing_surface");
  });

  it("28. selectInformationalRepairNavigationIntents returns only informational", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const plan = makePlan(recs);
    const info = selectInformationalRepairNavigationIntents(plan);
    expect(info.length).toBe(1);
    expect(info[0].kind).toBe("information_only");
  });

  it("29. selectRepairNavigationIntentsForTarget returns only matching target", () => {
    const recs: ReadingDataRepairRecommendation[] = [
      makeRec(1, "inspect_source_data"),
      makeRec(2, "review_metric_relationship"),
      makeRec(3, "review_top_book_metadata"),
    ];
    const plan = makePlan(recs);
    const audit = selectRepairNavigationIntentsForTarget(plan, "data_quality_audit");
    expect(audit.length).toBe(2);
    for (const i of audit) expect(i.target).toBe("data_quality_audit");
  });

  it("30. selectors return new arrays (no aliasing)", () => {
    const plan = makePlan([makeRec(1, "retry_failed_year")]);
    const a = selectFocusableRepairNavigationIntents(plan);
    const b = selectFocusableRepairNavigationIntents(plan);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  // ---- input immutability ----
  it("31. input plan is not mutated by build / selectors", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const plan = makePlan(recs);
    const snapshotBefore = JSON.stringify(plan);
    buildWereadReadingDataRepairNavigationPlan(plan);
    selectFocusableRepairNavigationIntents(plan);
    selectInformationalRepairNavigationIntents(plan);
    selectRepairNavigationIntentsForTarget(plan, "data_quality_audit");
    expect(JSON.stringify(plan)).toBe(snapshotBefore);
  });

  // ---- debug snapshot ----
  it("32. debug snapshot only includes allowlisted keys", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    const snap = buildReadingDataRepairNavigationDebugSnapshot(nav);
    const allowed = new Set([
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
    for (const key of Object.keys(snap)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it("33. debug snapshot excludes itemIndex / rank / id-like fields", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([
        makeRec(1, "review_top_book_metadata", { itemIndex: 5, rank: 1 }),
        makeRec(2, "review_year_link", { fromYear: 2022, toYear: 2023 }),
      ]),
    );
    const snap = buildReadingDataRepairNavigationDebugSnapshot(nav);
    expect(snap.itemIndex).toBeUndefined();
    expect(snap.rank).toBeUndefined();
    expect(snap.id).toBeUndefined();
    expect(snap.recommendationId).toBeUndefined();
    expect(snap.issueId).toBeUndefined();
    expect(snap.actual).toBeUndefined();
    expect(snap.expected).toBeUndefined();
    expect(snap.title).toBeUndefined();
    expect(snap.author).toBeUndefined();
    expect(snap.catalogId).toBeUndefined();
  });

  it("34. debug snapshot years are sorted", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([
        makeRec(1, "retry_failed_year", { year: 2024 }),
        makeRec(2, "reload_year", { year: 2021 }),
        makeRec(3, "review_year_link", { fromYear: 2023, toYear: 2025 }),
      ]),
    );
    const snap = buildReadingDataRepairNavigationDebugSnapshot(nav);
    expect(snap.years).toEqual([2021, 2024]);
    expect(snap.fromYears).toEqual([2023]);
    expect(snap.toYears).toEqual([2025]);
  });

  // ---- no side effects ----
  it("35. build is referentially transparent (same input -> same output)", () => {
    const plan = makePlan([
      makeRec(1, "retry_failed_year", { year: 2023 }),
      makeRec(2, "review_top_book_metadata", { rank: 2 }),
    ]);
    const a = buildWereadReadingDataRepairNavigationPlan(plan);
    const b = buildWereadReadingDataRepairNavigationPlan(plan);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("36. build does not modify input recommendation objects", () => {
    const rec = makeRec(1, "retry_failed_year", { year: 2023 });
    const before = JSON.stringify(rec);
    buildWereadReadingDataRepairNavigationPlan(makePlan([rec]));
    expect(JSON.stringify(rec)).toBe(before);
  });

  it("37. source code does not reference window / document / navigator", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigation.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bwindow\b/);
    expect(src).not.toMatch(/\bdocument\b/);
    expect(src).not.toMatch(/\bnavigator\b/);
    expect(src).not.toMatch(/\blocalStorage\b/);
    expect(src).not.toMatch(/\bsessionStorage\b/);
    expect(src).not.toMatch(/\bIndexedDB\b/);
    expect(src).not.toMatch(/\blocalStorage\b\./);
    expect(src).not.toMatch(/\bsessionStorage\b\./);
    expect(src).not.toMatch(/\bIndexedDB\b\./);
    expect(src).not.toMatch(/\bfetch\b/);
    expect(src).not.toMatch(/\bXMLHttpRequest\b/);
    expect(src).not.toMatch(/\bWebSocket\b/);
    expect(src).not.toMatch(/react/i);
    expect(src).not.toMatch(/history\.|location\.|hash\b/);
  });

  it("38. source code does not contain user-evaluation language", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigation.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/更爱阅读|兴趣增强|能力提升|心理状态|用户评分|一键修复|自动修复成功|优秀|较差/);
  });

  it("39. source code does not contain NaN / Infinity literals", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigation.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bNaN\b/);
    expect(src).not.toMatch(/\bInfinity\b/);
  });

  // ---- exhaustive kind coverage ----
  it("40. every focusable action maps to focus_existing_surface", () => {
    const focusableActions: ReadingDataRepairAction[] = [
      "retry_failed_year",
      "reload_year",
      "inspect_source_data",
      "review_metric_relationship",
      "review_top_book_metadata",
      "review_year_link",
      "review_recurring_aggregation",
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(focusableActions.map((a, i) => makeRec(i, a))),
    );
    for (const intent of nav.intents) {
      expect(intent.kind).toBe("focus_existing_surface");
    }
  });

  it("41. focusable + informational + none sum equals total", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    expect(nav.summary.focusable + nav.summary.informational + nav.summary.none).toBe(
      nav.summary.total,
    );
  });

  // ---- locator field pass-through for review_year_link ----
  it("42. year_link passes fromYear and toYear", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "review_year_link", { fromYear: 2022, toYear: 2023 })]),
    );
    expect(nav.intents[0].fromYear).toBe(2022);
    expect(nav.intents[0].toYear).toBe(2023);
  });

  it("43. review_top_book_metadata passes rank and itemIndex", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "review_top_book_metadata", { rank: 3, itemIndex: 7 })]),
    );
    expect(nav.intents[0].rank).toBe(3);
    expect(nav.intents[0].itemIndex).toBe(7);
  });

  it("44. retry_failed_year passes year only (no rank / itemIndex)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year", { year: 2024 })]),
    );
    expect(nav.intents[0].year).toBe(2024);
    expect(nav.intents[0].rank).toBeUndefined();
    expect(nav.intents[0].itemIndex).toBeUndefined();
  });

  it("45. no_action_required carries no locator fields", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "no_action_required")]),
    );
    expect(nav.intents[0].year).toBeUndefined();
    expect(nav.intents[0].fromYear).toBeUndefined();
    expect(nav.intents[0].toYear).toBeUndefined();
    expect(nav.intents[0].itemIndex).toBeUndefined();
    expect(nav.intents[0].rank).toBeUndefined();
  });

  it("46. unsupported_with_current_fields may carry year (informational only)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "unsupported_with_current_fields", { year: 2025 })]),
    );
    expect(nav.intents[0].year).toBe(2025);
    expect(nav.intents[0].kind).toBe("information_only");
    expect(nav.intents[0].target).toBe("repair_recommendations");
  });

  // ---- kind ordering stability ----
  it("47. multiple intents with same target preserved in order", () => {
    const recs = [
      makeRec(1, "inspect_source_data", { year: 2023 }),
      makeRec(2, "inspect_source_data", { year: 2024 }),
      makeRec(3, "inspect_source_data", { year: 2025 }),
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    expect(nav.intents.map((i) => i.year)).toEqual([2023, 2024, 2025]);
    expect(nav.targetCounts.data_quality_audit).toBe(3);
  });

  it("48. debug snapshot years are deduped by sort (no duplicates collapsed)", () => {
    const recs = [
      makeRec(1, "retry_failed_year", { year: 2024 }),
      makeRec(2, "reload_year", { year: 2024 }),
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    const snap = buildReadingDataRepairNavigationDebugSnapshot(nav);
    expect(snap.years).toEqual([2024, 2024]);
  });

  // ---- numeric safety ----
  it("49. numeric locator fields are finite (no NaN / Infinity)", () => {
    const recs: ReadingDataRepairRecommendation[] = [
      makeRec(1, "retry_failed_year", { year: 2024 }),
      makeRec(2, "review_top_book_metadata", { rank: 1, itemIndex: 2 }),
      makeRec(3, "review_year_link", { fromYear: 2022, toYear: 2023 }),
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    for (const intent of nav.intents) {
      if (intent.year !== undefined) {
        expect(Number.isFinite(intent.year)).toBe(true);
      }
      if (intent.fromYear !== undefined) {
        expect(Number.isFinite(intent.fromYear)).toBe(true);
      }
      if (intent.toYear !== undefined) {
        expect(Number.isFinite(intent.toYear)).toBe(true);
      }
      if (intent.itemIndex !== undefined) {
        expect(Number.isFinite(intent.itemIndex)).toBe(true);
      }
      if (intent.rank !== undefined) {
        expect(Number.isFinite(intent.rank)).toBe(true);
      }
    }
  });

  // ---- kind exhaustive Record ----
  it("50. every action is in kind Record", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    for (const intent of nav.intents) {
      expect(["focus_existing_surface", "information_only", "none"]).toContain(intent.kind);
    }
  });

  it("51. ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS are exactly 8 unique values", () => {
    const set = new Set(ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS);
    expect(set.size).toBe(ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS.length);
  });

  it("52. ALL_READING_DATA_REPAIR_NAVIGATION_KINDS are exactly 3 unique values", () => {
    const set = new Set(ALL_READING_DATA_REPAIR_NAVIGATION_KINDS);
    expect(set.size).toBe(ALL_READING_DATA_REPAIR_NAVIGATION_KINDS.length);
  });

  it("53. snapshot meta matches nav plan meta", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    const snap = buildReadingDataRepairNavigationDebugSnapshot(nav);
    expect(snap.meta).toEqual(nav.meta);
  });

  it("54. targetCounts for unsupplied targets remain 0 in mixed plan", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    expect(nav.targetCounts.failed_year_controls).toBe(1);
    expect(nav.targetCounts.archive_year_directory).toBe(0);
    expect(nav.targetCounts.data_quality_audit).toBe(0);
    expect(nav.targetCounts.top_books).toBe(0);
    expect(nav.targetCounts.year_links).toBe(0);
    expect(nav.targetCounts.recurring_books).toBe(0);
    expect(nav.targetCounts.repair_recommendations).toBe(0);
    expect(nav.targetCounts.none).toBe(0);
  });

  it("55. type compile: intents is a readonly-shape record", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    const intent: ReadingDataRepairNavigationIntent = nav.intents[0];
    const t: ReadingDataRepairNavigationTarget = intent.target;
    const k: ReadingDataRepairNavigationKind = intent.kind;
    expect(typeof t).toBe("string");
    expect(typeof k).toBe("string");
  });

  it("56. capability untouched for retry (user_retry -> focus)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    expect(nav.intents[0].capability).toBe("user_retry");
  });

  it("57. capability untouched for unsupported (unsupported -> information_only)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "unsupported_with_current_fields")]),
    );
    expect(nav.intents[0].capability).toBe("unsupported");
  });

  it("58. capability untouched for no_action_required (information_only -> none)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "no_action_required")]),
    );
    expect(nav.intents[0].capability).toBe("information_only");
  });

  it("59. target enum value 'data_quality_audit' is reused for both inspect & review_metric_relationship", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([
        makeRec(1, "inspect_source_data"),
        makeRec(2, "review_metric_relationship"),
      ]),
    );
    expect(nav.targetCounts.data_quality_audit).toBe(2);
  });

  it("60. summary fields are exhaustive (total/focusable/informational/none)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    expect(Object.keys(nav.summary).sort()).toEqual(["focusable", "informational", "none", "total"].sort());
  });

  it("61. meta keys exhaustive", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    expect(Object.keys(nav.meta).sort()).toEqual(
      ["automaticNavigation", "executesRepair", "modifiesSourceData", "requestedNetwork", "source"].sort(),
    );
  });

  it("62. targetCounts keys exhaustive (8 entries)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    expect(Object.keys(nav.targetCounts).length).toBe(8);
  });

  it("63. intent is plain data (no class identity)", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    const intent = nav.intents[0];
    expect(intent.constructor?.name).toBe("Object");
  });

  it("64. summary/none can exceed focusable when plan has many no_action_required", () => {
    const recs = [
      makeRec(1, "no_action_required"),
      makeRec(2, "no_action_required"),
      makeRec(3, "retry_failed_year"),
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    expect(nav.summary.none).toBe(2);
    expect(nav.summary.focusable).toBe(1);
    expect(nav.targetCounts.none).toBe(2);
    expect(nav.targetCounts.failed_year_controls).toBe(1);
  });

  it("65. intent omits undefined keys when recommendation has no locator", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "inspect_source_data")]),
    );
    const intent = nav.intents[0];
    expect(intent.year).toBeUndefined();
    expect(intent.fromYear).toBeUndefined();
    expect(intent.toYear).toBeUndefined();
    expect(intent.itemIndex).toBeUndefined();
    expect(intent.rank).toBeUndefined();
  });
});