// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigationSurfaces.test.ts
//
// S27S-1B — Targeted tests for the Navigation Surface Contract.
// 50+ tests covering: 8 target exhaustive mapping, 7 existing surfaces,
// 1 no_surface, surfaceKey uniqueness, stable key format, no CSS selector,
// no URL, no DOM ID dependency, focus/informational/none resolution,
// unsupported resolution, no_action resolution, summary, surfaceCounts,
// empty navigation plan, deterministic output, input immutability,
// array/object isolation, automatic/executesRepair/network/source-data
// flags, no fetch/storage/URL/DOM/React dependency, no user evaluation
// language, debug/privacy boundaries, no NaN/Infinity.

import { describe, expect, it } from "vitest";

import type {
  ReadingDataRepairAction,
  ReadingDataRepairCapability,
  ReadingDataRepairRecommendation,
  WereadReadingDataRepairPlan,
  WereadReadingDataRepairSummary,
  WereadReadingDataRepairMeta,
} from "./wereadReadingDataRepairRecommendations";
import type { ReadingDataQualityIssueCode } from "./wereadReadingDataQualityAudit";

import {
  ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS,
  ALL_READING_DATA_REPAIR_NAVIGATION_KINDS,
  buildWereadReadingDataRepairNavigationPlan,
  type ReadingDataRepairNavigationTarget,
} from "./wereadReadingDataRepairNavigation";

import {
  SURFACE_CONTRACT_INTERNAL,
  buildReadingDataRepairNavigationSurfacePlan,
  resolveReadingDataRepairNavigationSurface,
  resolveReadingDataRepairNavigationSurfaceForIntent,
  assertFocusableInvariant,
  assertInformationalNeverAutoFocused,
  type ReadingDataRepairNavigationSurfaceContract,
} from "./wereadReadingDataRepairNavigationSurfaces";

// ---------- synthetic plan factory (reused pattern) ----------

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

const ACTION_TO_GUIDANCE = {
  retry_failed_year: "retry_failed_years",
  reload_year: "reload_archive_year",
  inspect_source_data: "inspect_archive_source",
  review_metric_relationship: "review_year_metric_consistency",
  review_top_book_metadata: "review_top_book_public_metadata",
  review_year_link: "review_adjacent_year_links",
  review_recurring_aggregation: "review_recurring_aggregation",
  unsupported_with_current_fields: "current_fields_insufficient",
  no_action_required: "no_action",
} as const;

function makeRec(idx: number, action: ReadingDataRepairAction): ReadingDataRepairRecommendation {
  return {
    id: `rec-s27s1b-${idx}`,
    sourceIssueCode: "empty_archive" as ReadingDataQualityIssueCode,
    sourceSeverity: "info",
    scope: "coverage",
    priority: "informational",
    action,
    capability: ACTION_TO_CAPABILITY[action],
    guidanceKey: ACTION_TO_GUIDANCE[action],
    automatic: false,
    modifiesSourceData: false,
  };
}

function makePlan(recs: ReadingDataRepairRecommendation[]): WereadReadingDataRepairPlan {
  const actionCounts = {} as Record<ReadingDataRepairAction, number>;
  const capabilityCounts = {} as Record<ReadingDataRepairCapability, number>;
  for (const a of ALL_ACTIONS) actionCounts[a] = 0;
  for (const c of Object.keys(ACTION_TO_CAPABILITY)) capabilityCounts[c as ReadingDataRepairCapability] = 0;
  for (const r of recs) {
    actionCounts[r.action] += 1;
    capabilityCounts[r.capability] += 1;
  }
  const summary: WereadReadingDataRepairSummary = {
    total: recs.length,
    high: 0,
    medium: 0,
    low: 0,
    informational: recs.length,
    retryable: actionCounts.retry_failed_year,
    reloadable: actionCounts.reload_year,
    manualReview: actionCounts.inspect_source_data + actionCounts.review_metric_relationship +
      actionCounts.review_top_book_metadata + actionCounts.review_year_link +
      actionCounts.review_recurring_aggregation,
    unsupported: actionCounts.unsupported_with_current_fields,
  };
  const meta: WereadReadingDataRepairMeta = {
    source: "current_data_quality_audit",
    persisted: false,
    requestedNetwork: false,
    automaticRepair: false,
  };
  return { recommendations: recs, groups: [], actionCounts, capabilityCounts, summary, meta };
}

// ---------- tests ----------

describe("S27S-1B wereadReadingDataRepairNavigationSurfaces", () => {
  // ---- exhaustive contract ----
  it("1. SURFACE_CONTRACT covers all 8 NavigationTargets", () => {
    for (const t of ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS) {
      expect(SURFACE_CONTRACT_INTERNAL[t]).toBeDefined();
    }
  });

  it("2. SURFACE_CONTRACT keys are exactly 8", () => {
    expect(Object.keys(SURFACE_CONTRACT_INTERNAL).length).toBe(8);
  });

  it("3. 7 targets have availability=existing_surface", () => {
    const existing = Object.values(SURFACE_CONTRACT_INTERNAL).filter(
      (c) => c.availability === "existing_surface",
    );
    expect(existing.length).toBe(7);
  });

  it("4. only 'none' has availability=no_surface", () => {
    const noSurface = Object.values(SURFACE_CONTRACT_INTERNAL).filter(
      (c) => c.availability === "no_surface",
    );
    expect(noSurface.length).toBe(1);
    expect(noSurface[0].target).toBe("none");
  });

  // ---- surfaceKey uniqueness ----
  it("5. all existing_surface surfaceKeys are unique", () => {
    const keys = Object.values(SURFACE_CONTRACT_INTERNAL)
      .filter((c) => c.availability === "existing_surface")
      .map((c) => c.surfaceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("6. no_surface contract has no surfaceKey", () => {
    const none = SURFACE_CONTRACT_INTERNAL.none;
    expect(none.surfaceKey).toBeUndefined();
  });

  it("7. surfaceKeys match real data-testids (or are explicit semantic sub-keys)", () => {
    const keys = Object.values(SURFACE_CONTRACT_INTERNAL)
      .filter((c) => c.availability === "existing_surface")
      .map((c) => c.surfaceKey!);
    // The 5 that map directly to data-testids must start with `weread-reading-archive-` or `weread-reading-data-`
    const direct = [
      "weread-reading-archive-controls",
      "weread-reading-archive-year-grid",
      "weread-reading-data-quality",
      "weread-reading-archive-links",
      "weread-reading-data-repair",
    ];
    for (const k of direct) expect(keys).toContain(k);
    // The 2 sub-keys for book-grid
    expect(keys).toContain("archive_book_grid:top");
    expect(keys).toContain("archive_book_grid:recurring");
  });

  // ---- resolver ----
  it("8. resolveReadingDataRepairNavigationSurface returns contract for each target", () => {
    for (const t of ALL_READING_DATA_REPAIR_NAVIGATION_TARGETS) {
      const c = resolveReadingDataRepairNavigationSurface(t);
      expect(c.target).toBe(t);
    }
  });

  it("9. resolveReadingDataRepairNavigationSurfaceForIntent uses intent.target", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    const c = resolveReadingDataRepairNavigationSurfaceForIntent(nav.intents[0]);
    expect(c.target).toBe("failed_year_controls");
  });

  // ---- exhaustive Action -> Target -> Surface chain ----
  it("10. all 9 actions resolve to a contract without holes", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.contracts.length).toBe(9);
    for (let i = 0; i < 9; i += 1) {
      expect(sp.contracts[i].target).toBe(nav.intents[i].target);
    }
  });

  // ---- focusable invariant ----
  it("11. all focus_existing_surface intents map to existing_surface", () => {
    const recs = ALL_ACTIONS.filter((a) => a !== "no_action_required" && a !== "unsupported_with_current_fields")
      .map((a, i) => makeRec(i, a));
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    expect(assertFocusableInvariant(nav)).toBe(true);
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    for (let i = 0; i < sp.contracts.length; i += 1) {
      expect(sp.contracts[i].availability).toBe("existing_surface");
    }
  });

  it("12. no_action_required intent resolves to no_surface", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "no_action_required")]),
    );
    const c = resolveReadingDataRepairNavigationSurfaceForIntent(nav.intents[0]);
    expect(c.availability).toBe("no_surface");
  });

  it("13. unsupported_with_current_fields resolves to existing_surface but stays information_only", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "unsupported_with_current_fields")]),
    );
    const intent = nav.intents[0];
    const c = resolveReadingDataRepairNavigationSurfaceForIntent(intent);
    expect(c.availability).toBe("existing_surface");
    expect(intent.kind).toBe("information_only");
    expect(c.automatic).toBe(false);
  });

  // ---- informational never auto-focused ----
  it("14. informational invariant holds for all actions", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    expect(assertInformationalNeverAutoFocused(nav)).toBe(true);
  });

  it("15. focusable + informational + none = total in surface plan", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.summary.focusableSurface + sp.summary.informationalSurface + sp.summary.noSurface)
      .toBe(sp.summary.total);
  });

  // ---- summary / surfaceCounts ----
  it("16. summary counts match contracts", () => {
    const recs = [
      makeRec(1, "retry_failed_year"),
      makeRec(2, "reload_year"),
      makeRec(3, "inspect_source_data"),
      makeRec(4, "unsupported_with_current_fields"),
      makeRec(5, "no_action_required"),
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.summary.total).toBe(5);
    expect(sp.summary.existingSurface).toBe(4);
    expect(sp.summary.noSurface).toBe(1);
  });

  it("17. surfaceCounts always has all 8 keys", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    const keys = Object.keys(sp.surfaceCounts).sort();
    expect(keys.length).toBe(8);
    expect(keys).toContain("__no_surface__");
    expect(keys).toContain("weread-reading-archive-controls");
  });

  it("18. surfaceCounts sum equals total", () => {
    const recs = ALL_ACTIONS.map((a, i) => makeRec(i, a));
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(recs));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    const sum = Object.values(sp.surfaceCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(sp.summary.total);
  });

  // ---- empty / deterministic ----
  it("19. empty navigation plan yields empty surface plan", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.contracts).toHaveLength(0);
    expect(sp.summary.total).toBe(0);
    expect(sp.summary.existingSurface).toBe(0);
    expect(sp.summary.noSurface).toBe(0);
  });

  it("20. surface plan is referentially transparent", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year"), makeRec(2, "review_top_book_metadata")]),
    );
    const a = buildReadingDataRepairNavigationSurfacePlan(nav);
    const b = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // ---- immutability ----
  it("21. navigation plan is not mutated by surface plan build", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    const before = JSON.stringify(nav);
    buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(JSON.stringify(nav)).toBe(before);
  });

  it("22. contracts array is independent from input", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "retry_failed_year")]),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    sp.contracts[0].surfaceLabel = "mutated";
    const sp2 = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp2.contracts[0].surfaceLabel).not.toBe("mutated");
  });

  // ---- safety flags ----
  it("23. every contract has automatic=false", () => {
    for (const c of Object.values(SURFACE_CONTRACT_INTERNAL)) {
      expect(c.automatic).toBe(false);
    }
  });

  it("24. every contract has executesRepair=false", () => {
    for (const c of Object.values(SURFACE_CONTRACT_INTERNAL)) {
      expect(c.executesRepair).toBe(false);
    }
  });

  it("25. every contract has requestedNetwork=false", () => {
    for (const c of Object.values(SURFACE_CONTRACT_INTERNAL)) {
      expect(c.requestedNetwork).toBe(false);
    }
  });

  it("26. every contract has modifiesSourceData=false", () => {
    for (const c of Object.values(SURFACE_CONTRACT_INTERNAL)) {
      expect(c.modifiesSourceData).toBe(false);
    }
  });

  it("27. surface plan meta flags all false", () => {
    const sp = buildReadingDataRepairNavigationSurfacePlan(
      buildWereadReadingDataRepairNavigationPlan(makePlan([])),
    );
    expect(sp.meta.automaticNavigation).toBe(false);
    expect(sp.meta.executesRepair).toBe(false);
    expect(sp.meta.requestedNetwork).toBe(false);
    expect(sp.meta.modifiesSourceData).toBe(false);
  });

  // ---- no side effects ----
  it("28. source code does not reference window / document / navigator", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationSurfaces.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bwindow\b/);
    expect(src).not.toMatch(/\bdocument\b/);
    expect(src).not.toMatch(/\bnavigator\b/);
    expect(src).not.toMatch(/\blocalStorage\b/);
    expect(src).not.toMatch(/\bsessionStorage\b/);
    expect(src).not.toMatch(/\bIndexedDB\b/);
    expect(src).not.toMatch(/\bfetch\b/);
    expect(src).not.toMatch(/\bXMLHttpRequest\b/);
    expect(src).not.toMatch(/\bWebSocket\b/);
    expect(src).not.toMatch(/react/i);
    expect(src).not.toMatch(/history\.|location\.|hash\b/);
  });

  it("29. source code does not contain user-evaluation language", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationSurfaces.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/更爱阅读|兴趣增强|能力提升|心理状态|用户评分|一键修复|自动修复成功|优秀|较差/);
  });

  it("30. source code does not contain NaN / Infinity literals", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationSurfaces.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bNaN\b/);
    expect(src).not.toMatch(/\bInfinity\b/);
  });

  // ---- stable key format ----
  it("31. surfaceKeys for direct bindings are kebab-case data-testid values", () => {
    const direct = [
      SURFACE_CONTRACT_INTERNAL.failed_year_controls,
      SURFACE_CONTRACT_INTERNAL.archive_year_directory,
      SURFACE_CONTRACT_INTERNAL.data_quality_audit,
      SURFACE_CONTRACT_INTERNAL.year_links,
      SURFACE_CONTRACT_INTERNAL.repair_recommendations,
    ];
    for (const c of direct) {
      expect(c.surfaceKey).toMatch(/^weread-[a-z0-9-]+$/);
    }
  });

  it("32. surfaceKeys for book-grid sub-keys are colon-separated semantic identifiers", () => {
    expect(SURFACE_CONTRACT_INTERNAL.top_books.surfaceKey).toMatch(/^archive_book_grid:[a-z]+$/);
    expect(SURFACE_CONTRACT_INTERNAL.recurring_books.surfaceKey).toMatch(/^archive_book_grid:[a-z]+$/);
  });

  it("33. no surfaceKey is a CSS selector, URL, or element ID", () => {
    for (const c of Object.values(SURFACE_CONTRACT_INTERNAL)) {
      if (!c.surfaceKey) continue;
      expect(c.surfaceKey).not.toMatch(/^[.#]/);
      expect(c.surfaceKey).not.toMatch(/^https?:/);
      expect(c.surfaceKey).not.toMatch(/^\/\//);
      expect(c.surfaceKey).not.toMatch(/^\[data-/);
      expect(c.surfaceKey).not.toMatch(/^[a-z]+=[a-z]/);
    }
  });

  // ---- target-specific resolution ----
  it("34. failed_year_controls resolves to controls surface", () => {
    const c = resolveReadingDataRepairNavigationSurface("failed_year_controls");
    expect(c.availability).toBe("existing_surface");
    expect(c.surfaceKey).toBe("weread-reading-archive-controls");
  });

  it("35. archive_year_directory resolves to year-grid surface", () => {
    const c = resolveReadingDataRepairNavigationSurface("archive_year_directory");
    expect(c.availability).toBe("existing_surface");
    expect(c.surfaceKey).toBe("weread-reading-archive-year-grid");
  });

  it("36. data_quality_audit resolves to audit panel surface", () => {
    const c = resolveReadingDataRepairNavigationSurface("data_quality_audit");
    expect(c.availability).toBe("existing_surface");
    expect(c.surfaceKey).toBe("weread-reading-data-quality");
  });

  it("37. top_books resolves to book-grid:top sub-key", () => {
    const c = resolveReadingDataRepairNavigationSurface("top_books");
    expect(c.availability).toBe("existing_surface");
    expect(c.surfaceKey).toBe("archive_book_grid:top");
  });

  it("38. year_links resolves to links surface", () => {
    const c = resolveReadingDataRepairNavigationSurface("year_links");
    expect(c.availability).toBe("existing_surface");
    expect(c.surfaceKey).toBe("weread-reading-archive-links");
  });

  it("39. recurring_books resolves to book-grid:recurring sub-key", () => {
    const c = resolveReadingDataRepairNavigationSurface("recurring_books");
    expect(c.availability).toBe("existing_surface");
    expect(c.surfaceKey).toBe("archive_book_grid:recurring");
  });

  it("40. repair_recommendations resolves to repair panel surface", () => {
    const c = resolveReadingDataRepairNavigationSurface("repair_recommendations");
    expect(c.availability).toBe("existing_surface");
    expect(c.surfaceKey).toBe("weread-reading-data-repair");
  });

  it("41. none resolves to no_surface with no surfaceKey", () => {
    const c = resolveReadingDataRepairNavigationSurface("none");
    expect(c.availability).toBe("no_surface");
    expect(c.surfaceKey).toBeUndefined();
  });

  // ---- meta structure ----
  it("42. meta includes contractVersion 'S27S-1B'", () => {
    const sp = buildReadingDataRepairNavigationSurfacePlan(
      buildWereadReadingDataRepairNavigationPlan(makePlan([])),
    );
    expect(sp.meta.contractVersion).toBe("S27S-1B");
  });

  it("43. meta keys are exhaustive", () => {
    const sp = buildReadingDataRepairNavigationSurfacePlan(
      buildWereadReadingDataRepairNavigationPlan(makePlan([])),
    );
    expect(Object.keys(sp.meta).sort()).toEqual(
      ["automaticNavigation", "contractVersion", "executesRepair", "modifiesSourceData", "requestedNetwork", "source"].sort(),
    );
  });

  it("44. summary keys are exhaustive", () => {
    const sp = buildReadingDataRepairNavigationSurfacePlan(
      buildWereadReadingDataRepairNavigationPlan(makePlan([])),
    );
    expect(Object.keys(sp.summary).sort()).toEqual(
      ["existingSurface", "focusableSurface", "informationalSurface", "noSurface", "total"].sort(),
    );
  });

  // ---- cross-model invariants from spec B8 ----
  it("45. RepairAction -> NavigationTarget -> Surface chain has no holes", () => {
    for (const action of ALL_ACTIONS) {
      const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([makeRec(1, action)]));
      const target = nav.intents[0].target;
      const contract = resolveReadingDataRepairNavigationSurface(target);
      expect(contract.target).toBe(target);
      if (action === "no_action_required") {
        expect(contract.availability).toBe("no_surface");
      } else {
        expect(contract.availability).toBe("existing_surface");
      }
    }
  });

  it("46. inspect_source_data + review_metric_relationship both resolve to data_quality_audit surface", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "inspect_source_data"), makeRec(2, "review_metric_relationship")]),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.contracts[0].surfaceKey).toBe("weread-reading-data-quality");
    expect(sp.contracts[1].surfaceKey).toBe("weread-reading-data-quality");
    expect(sp.surfaceCounts["weread-reading-data-quality"]).toBe(2);
  });

  it("47. top_books + recurring_books resolve to distinct sub-keys on book-grid", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([makeRec(1, "review_top_book_metadata"), makeRec(2, "review_recurring_aggregation")]),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.contracts[0].surfaceKey).toBe("archive_book_grid:top");
    expect(sp.contracts[1].surfaceKey).toBe("archive_book_grid:recurring");
    expect(sp.surfaceCounts["archive_book_grid:top"]).toBe(1);
    expect(sp.surfaceCounts["archive_book_grid:recurring"]).toBe(1);
  });

  // ---- no DOM / no React in model ----
  it("48. surface plan build does not call any browser globals", () => {
    // If any browser global were touched, vitest would fail with a ReferenceError.
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp).toBeDefined();
  });

  it("49. resolver returns plain data objects (no class instances)", () => {
    const c = resolveReadingDataRepairNavigationSurface("failed_year_controls");
    expect(c.constructor?.name).toBe("Object");
  });

  // ---- order preservation ----
  it("50. surface plan preserves input intent order", () => {
    const order: ReadingDataRepairAction[] = [
      "reload_year",
      "retry_failed_year",
      "review_top_book_metadata",
      "no_action_required",
    ];
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan(order.map((a, i) => makeRec(i, a))));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.contracts.map((c) => c.target)).toEqual([
      "archive_year_directory",
      "failed_year_controls",
      "top_books",
      "none",
    ]);
  });

  it("51. surfaceCounts for unsupplied surfaces remain 0", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([makeRec(1, "retry_failed_year")]));
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.surfaceCounts["weread-reading-archive-controls"]).toBe(1);
    expect(sp.surfaceCounts["weread-reading-archive-year-grid"]).toBe(0);
    expect(sp.surfaceCounts["weread-reading-data-quality"]).toBe(0);
    expect(sp.surfaceCounts["weread-reading-archive-links"]).toBe(0);
    expect(sp.surfaceCounts["weread-reading-data-repair"]).toBe(0);
    expect(sp.surfaceCounts.__no_surface__).toBe(0);
  });

  it("52. unsupported_with_current_fields maps to repair_recommendations surface", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([makeRec(1, "unsupported_with_current_fields")]));
    const c = resolveReadingDataRepairNavigationSurfaceForIntent(nav.intents[0]);
    expect(c.target).toBe("repair_recommendations");
    expect(c.surfaceKey).toBe("weread-reading-data-repair");
    expect(nav.intents[0].kind).toBe("information_only");
  });

  it("53. ALL_READING_DATA_REPAIR_NAVIGATION_KINDS has 3 entries", () => {
    expect(ALL_READING_DATA_REPAIR_NAVIGATION_KINDS.length).toBe(3);
  });

  it("54. focusable count = contracts with kind=focus_existing_surface", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    const expectedFocusable = nav.intents.filter((i) => i.kind === "focus_existing_surface").length;
    expect(sp.summary.focusableSurface).toBe(expectedFocusable);
  });

  it("55. informational count = contracts with kind=information_only", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    const expectedInfo = nav.intents.filter((i) => i.kind === "information_only").length;
    expect(sp.summary.informationalSurface).toBe(expectedInfo);
  });

  it("56. existing surface count includes both focusable and informational", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan([
        makeRec(1, "retry_failed_year"),
        makeRec(2, "unsupported_with_current_fields"),
        makeRec(3, "no_action_required"),
      ]),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.summary.existingSurface).toBe(2);
    expect(sp.summary.noSurface).toBe(1);
    expect(sp.summary.focusableSurface + sp.summary.informationalSurface).toBe(2);
  });

  it("57. contract type-narrows availability correctly", () => {
    const c: ReadingDataRepairNavigationSurfaceContract =
      resolveReadingDataRepairNavigationSurface("none");
    if (c.availability === "no_surface") {
      expect(c.surfaceKey).toBeUndefined();
    } else {
      throw new Error("expected no_surface");
    }
  });

  it("58. contract surfaceLabel is a stable enum-like string (not a UI copy)", () => {
    for (const c of Object.values(SURFACE_CONTRACT_INTERNAL)) {
      expect(c.surfaceLabel).toMatch(/^[A-Z].{0,80}$/);
    }
  });

  it("59. contract.surfaceLabel never contains user-evaluation language", () => {
    for (const c of Object.values(SURFACE_CONTRACT_INTERNAL)) {
      expect(c.surfaceLabel).not.toMatch(/更爱阅读|兴趣增强|能力提升|心理状态|用户评分|优秀|较差/);
    }
  });

  it("60. resolver input immutability: caller-owned target is not mutated", () => {
    const t: ReadingDataRepairNavigationTarget = "failed_year_controls";
    const before = t;
    resolveReadingDataRepairNavigationSurface(t);
    expect(t).toBe(before);
  });

  it("61. focusable invariant on empty plan is trivially true", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    expect(assertFocusableInvariant(nav)).toBe(true);
  });

  it("62. informational invariant on empty plan is trivially true", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(makePlan([]));
    expect(assertInformationalNeverAutoFocused(nav)).toBe(true);
  });

  it("63. surface plan source is 'current_repair_recommendation_plan'", () => {
    const sp = buildReadingDataRepairNavigationSurfacePlan(
      buildWereadReadingDataRepairNavigationPlan(makePlan([])),
    );
    expect(sp.meta.source).toBe("current_repair_recommendation_plan");
  });

  it("64. contracts contain exactly the same count as intents", () => {
    const nav = buildWereadReadingDataRepairNavigationPlan(
      makePlan(ALL_ACTIONS.map((a, i) => makeRec(i, a))),
    );
    const sp = buildReadingDataRepairNavigationSurfacePlan(nav);
    expect(sp.contracts.length).toBe(nav.intents.length);
  });

  it("65. surfaceKey uniqueness is enforced at construction (not via separate guard)", () => {
    // Each surfaceKey value appears exactly once in the contract table.
    const keys = Object.values(SURFACE_CONTRACT_INTERNAL)
      .map((c) => c.surfaceKey ?? null);
    const seen = keys.filter((k): k is string => typeof k === "string");
    expect(new Set(seen).size).toBe(seen.length);
  });
});