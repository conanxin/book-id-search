// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigationUi.test.ts
//
// S27S-2A — Targeted tests for UI Behavior Contract.

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
  ALL_READING_DATA_REPAIR_NAVIGATION_KINDS,
  buildWereadReadingDataRepairNavigationPlan,
  type ReadingDataRepairNavigationIntent,
} from "./wereadReadingDataRepairNavigation";

import {
  ALL_READING_DATA_REPAIR_NAVIGATION_TRIGGER_STATES,
  ALL_READING_DATA_REPAIR_NAVIGATION_UI_LABEL_KEYS,
  buildReadingDataRepairNavigationRequest,
  resolveNavigationTriggerState,
  resolveNavigationUiLabelKey,
  type ReadingDataRepairNavigationUiLabelKey,
} from "./wereadReadingDataRepairNavigationUi";

// ---------- synthetic intent factory ----------

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

function makeIntent(action: ReadingDataRepairAction, extras: Partial<ReadingDataRepairNavigationIntent> = {}): ReadingDataRepairNavigationIntent {
  const intent: ReadingDataRepairNavigationIntent = {
    sourceIssueCode: "empty_archive" as ReadingDataQualityIssueCode,
    action,
    capability: ACTION_TO_CAPABILITY[action],
    target: "failed_year_controls",
    kind: "focus_existing_surface",
    year: undefined,
    fromYear: undefined,
    toYear: undefined,
    itemIndex: undefined,
    rank: undefined,
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
    ...extras,
  };
  return intent;
}

// ---------- tests ----------

describe("S27S-2A wereadReadingDataRepairNavigationUi", () => {
  // ---- trigger state mapping ----
  it("1. ALL_TRIGGER_STATES has 3 entries", () => {
    expect(ALL_READING_DATA_REPAIR_NAVIGATION_TRIGGER_STATES.length).toBe(3);
  });

  it("2. ALL_LABEL_KEYS has 3 entries", () => {
    expect(ALL_READING_DATA_REPAIR_NAVIGATION_UI_LABEL_KEYS.length).toBe(3);
  });

  it("3. focus_existing_surface -> enabled", () => {
    const i = makeIntent("retry_failed_year");
    expect(resolveNavigationTriggerState(i)).toBe("enabled");
  });

  it("4. information_only -> informational", () => {
    const i = makeIntent("unsupported_with_current_fields", { kind: "information_only" });
    expect(resolveNavigationTriggerState(i)).toBe("informational");
  });

  it("5. none -> hidden", () => {
    const i = makeIntent("no_action_required", { kind: "none" });
    expect(resolveNavigationTriggerState(i)).toBe("hidden");
  });

  it("6. all 3 kinds covered by trigger state mapping", () => {
    for (const kind of ALL_READING_DATA_REPAIR_NAVIGATION_KINDS) {
      const i = makeIntent("retry_failed_year", { kind });
      expect(ALL_READING_DATA_REPAIR_NAVIGATION_TRIGGER_STATES).toContain(
        resolveNavigationTriggerState(i),
      );
    }
  });

  // ---- label key mapping ----
  it("7. enabled -> view_related_area", () => {
    const i = makeIntent("retry_failed_year");
    expect(resolveNavigationUiLabelKey(i)).toBe("view_related_area");
  });

  it("8. informational -> information_only", () => {
    const i = makeIntent("unsupported_with_current_fields", { kind: "information_only" });
    expect(resolveNavigationUiLabelKey(i)).toBe("information_only");
  });

  it("9. hidden -> no_navigation", () => {
    const i = makeIntent("no_action_required", { kind: "none" });
    expect(resolveNavigationUiLabelKey(i)).toBe("no_navigation");
  });

  // ---- request builder ----
  it("10. focusable intent produces a request", () => {
    const i = makeIntent("retry_failed_year", { target: "failed_year_controls", year: 2023 });
    const r = buildReadingDataRepairNavigationRequest(i);
    expect(r).not.toBeNull();
    expect(r!.target).toBe("failed_year_controls");
    expect(r!.surfaceKey).toBe("weread-reading-archive-controls");
    expect(r!.year).toBe(2023);
  });

  it("11. informational returns null", () => {
    const i = makeIntent("unsupported_with_current_fields", { kind: "information_only", target: "repair_recommendations" });
    expect(buildReadingDataRepairNavigationRequest(i)).toBeNull();
  });

  it("12. none returns null", () => {
    const i = makeIntent("no_action_required", { kind: "none", target: "none" });
    expect(buildReadingDataRepairNavigationRequest(i)).toBeNull();
  });

  it("13. retry_failed_year request uses weread-reading-archive-controls", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls", year: 2023 }),
    )!;
    expect(r.surfaceKey).toBe("weread-reading-archive-controls");
  });

  it("14. reload_year request uses weread-reading-archive-year-grid", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("reload_year", { target: "archive_year_directory", year: 2022 }),
    )!;
    expect(r.surfaceKey).toBe("weread-reading-archive-year-grid");
  });

  it("15. inspect_source_data request uses weread-reading-data-quality", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("inspect_source_data", { target: "data_quality_audit" }),
    )!;
    expect(r.surfaceKey).toBe("weread-reading-data-quality");
  });

  it("16. review_metric_relationship request uses weread-reading-data-quality", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("review_metric_relationship", { target: "data_quality_audit" }),
    )!;
    expect(r.surfaceKey).toBe("weread-reading-data-quality");
  });

  it("17. review_top_book_metadata request uses archive_book_grid:top", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("review_top_book_metadata", { target: "top_books", rank: 1, itemIndex: 2 }),
    )!;
    expect(r.surfaceKey).toBe("archive_book_grid:top");
    expect(r.rank).toBe(1);
    expect(r.itemIndex).toBe(2);
  });

  it("18. review_year_link request uses weread-reading-archive-links", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("review_year_link", { target: "year_links", fromYear: 2022, toYear: 2023 }),
    )!;
    expect(r.surfaceKey).toBe("weread-reading-archive-links");
    expect(r.fromYear).toBe(2022);
    expect(r.toYear).toBe(2023);
  });

  it("19. review_recurring_aggregation request uses archive_book_grid:recurring", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("review_recurring_aggregation", { target: "recurring_books" }),
    )!;
    expect(r.surfaceKey).toBe("archive_book_grid:recurring");
  });

  // ---- safety flags ----
  it("20. request.initiatedBy is always 'user_click'", () => {
    for (const action of ALL_ACTIONS) {
      const i = makeIntent(action, {
        target: "failed_year_controls",
        kind: "focus_existing_surface",
      });
      const r = buildReadingDataRepairNavigationRequest(i);
      if (r) expect(r.initiatedBy).toBe("user_click");
    }
  });

  it("21. request.automatic is false", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls" }),
    )!;
    expect(r.automatic).toBe(false);
  });

  it("22. request.executesRepair is false", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls" }),
    )!;
    expect(r.executesRepair).toBe(false);
  });

  it("23. request.requestedNetwork is false", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls" }),
    )!;
    expect(r.requestedNetwork).toBe(false);
  });

  it("24. request.modifiesSourceData is false", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls" }),
    )!;
    expect(r.modifiesSourceData).toBe(false);
  });

  // ---- input immutability ----
  it("25. builder does not mutate input intent", () => {
    const i = makeIntent("retry_failed_year", { target: "failed_year_controls", year: 2024 });
    const before = JSON.stringify(i);
    buildReadingDataRepairNavigationRequest(i);
    expect(JSON.stringify(i)).toBe(before);
  });

  it("26. builder is referentially transparent", () => {
    const i = makeIntent("retry_failed_year", { target: "failed_year_controls" });
    expect(JSON.stringify(buildReadingDataRepairNavigationRequest(i)))
      .toBe(JSON.stringify(buildReadingDataRepairNavigationRequest(i)));
  });

  // ---- privacy ----
  it("27. request does not contain Recommendation ID or Issue ID", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls" }),
    )!;
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/rec[a-z0-9]{8,}/);
    expect(json).not.toMatch(/issue[a-z0-9]{8,}/);
  });

  it("28. request does not contain actual/expected/title/author/catalogId", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("review_top_book_metadata", { target: "top_books" }),
    )!;
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/\bactual\b|\bexpected\b/);
    expect(json).not.toMatch(/Synthetic Book/);
    expect(json).not.toMatch(/synthetic-\d+-\d+/);
  });

  it("29. request does not contain selector / URL / DOM ID fields", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls" }),
    )!;
    expect(r).not.toHaveProperty("selector");
    expect(r).not.toHaveProperty("url");
    expect(r).not.toHaveProperty("hash");
    expect(r).not.toHaveProperty("elementId");
    expect(r).not.toHaveProperty("href");
  });

  // ---- source code scan ----
  it("30. source code does not reference browser globals", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationUi.ts"),
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

  it("31. source code does not contain evaluation language", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationUi.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/更爱阅读|兴趣增强|能力提升|心理状态|用户评分|一键修复|自动修复成功|优秀|较差/);
  });

  it("32. source code does not contain NaN / Infinity", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationUi.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bNaN\b/);
    expect(src).not.toMatch(/\bInfinity\b/);
  });

  // ---- locator pass-through ----
  it("33. request preserves year locator", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("retry_failed_year", { target: "failed_year_controls", year: 2023 }),
    )!;
    expect(r.year).toBe(2023);
  });

  it("34. request preserves fromYear/toYear for year_link", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("review_year_link", { target: "year_links", fromYear: 2022, toYear: 2023 }),
    )!;
    expect(r.fromYear).toBe(2022);
    expect(r.toYear).toBe(2023);
  });

  it("35. request preserves rank/itemIndex for top_books", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("review_top_book_metadata", { target: "top_books", rank: 5, itemIndex: 7 }),
    )!;
    expect(r.rank).toBe(5);
    expect(r.itemIndex).toBe(7);
  });

  it("36. request omits undefined locators", () => {
    const r = buildReadingDataRepairNavigationRequest(
      makeIntent("inspect_source_data", { target: "data_quality_audit" }),
    )!;
    expect(r.year).toBeUndefined();
    expect(r.fromYear).toBeUndefined();
    expect(r.toYear).toBeUndefined();
    expect(r.itemIndex).toBeUndefined();
    expect(r.rank).toBeUndefined();
  });

  it("37. label keys are exhaustive 3 entries", () => {
    expect(ALL_READING_DATA_REPAIR_NAVIGATION_UI_LABEL_KEYS.length).toBe(3);
    expect(new Set(ALL_READING_DATA_REPAIR_NAVIGATION_UI_LABEL_KEYS).size).toBe(3);
  });

  it("38. trigger states are exhaustive 3 entries", () => {
    expect(ALL_READING_DATA_REPAIR_NAVIGATION_TRIGGER_STATES.length).toBe(3);
    expect(new Set(ALL_READING_DATA_REPAIR_NAVIGATION_TRIGGER_STATES).size).toBe(3);
  });

  it("39. label keys never contain forbidden wording", () => {
    for (const k of ALL_READING_DATA_REPAIR_NAVIGATION_UI_LABEL_KEYS) {
      expect(k).not.toMatch(/自动跳转|自动定位|自动修复|一键处理|立即修复/);
    }
  });

  it("40. trigger state mapping is deterministic", () => {
    const i = makeIntent("retry_failed_year", { target: "failed_year_controls" });
    expect(resolveNavigationTriggerState(i)).toBe(resolveNavigationTriggerState(i));
    expect(resolveNavigationUiLabelKey(i)).toBe(resolveNavigationUiLabelKey(i));
  });
});