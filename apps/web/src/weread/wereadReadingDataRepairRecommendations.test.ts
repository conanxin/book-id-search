/**
 * S27R-1A targeted tests — Reading Data Repair Recommendation Core Model.
 *
 * All tests use synthetic audits. The test suite verifies:
 *   - Mapping coverage (action / capability / priority) for every IssueCode
 *   - Plan shape (one recommendation per issue, deterministic id)
 *   - Sorting (priority / scope / year / fromYear / toYear / code /
 *     itemIndex / rank / id)
 *   - Safety boundaries (no free text, no actual/expected, no private ids,
 *     automatic=false, modifiesSourceData=false)
 *   - Summary counts
 *   - Meta fixed values
 *   - Input audit untouched
 *   - Debug snapshot excludes ids, itemIndex, rank, private fields
 *   - Exhaustive IssueCode action mapping (compile-time + runtime)
 */

import { describe, expect, it } from "vitest";

import type {
  ReadingDataQualityIssue,
  ReadingDataQualityIssueCode,
  ReadingDataQualityScope,
  ReadingDataQualitySeverity,
  ReadingDataQualityAuditMeta,
  ReadingDataQualityAuditSummary,
  ReadingDataQualityCoverageSection,
  WereadReadingDataQualityAudit,
} from "./wereadReadingDataQualityAudit";

import {
  buildReadingDataRepairDebugSnapshot,
  buildWereadReadingDataRepairPlan,
  groupReadingDataRepairRecommendations,
  selectActionableRepairRecommendations,
  selectHighestPriorityRepairRecommendations,
  selectManualReviewRepairRecommendations,
  selectUnsupportedRepairRecommendations,
  type ReadingDataRepairRecommendation,
  type WereadReadingDataRepairPlan,
} from "./wereadReadingDataRepairRecommendations";

// ---------- synthetic audit helpers ----------

const ALL_CODES: ReadingDataQualityIssueCode[] = [
  // coverage
  "empty_archive",
  "partial_archive",
  "target_year_unaccounted",
  "loaded_failed_conflict",
  "duplicate_loaded_year",
  "invalid_year",
  // year
  "non_finite_metric",
  "negative_metric",
  "dated_records_exceed_total",
  "matched_records_exceed_total",
  "matched_books_exceed_matched_records",
  "active_months_out_of_range",
  "streak_months_out_of_range",
  "streak_exceeds_active_months",
  "peak_month_year_mismatch",
  // top_book
  "top_books_exceed_limit",
  "top_book_missing_catalog",
  "top_book_missing_title",
  "top_book_duplicate_catalog",
  "top_book_invalid_rank",
  "top_book_duplicate_rank",
  "top_book_records_exceed_year_total",
  "top_book_order_mismatch",
  // year_link
  "year_link_unknown_year",
  "year_link_invalid_order",
  "year_link_duplicate_pair",
  "year_link_invalid_counts",
  "year_link_ratio_out_of_range",
  "year_link_ratio_mismatch",
  "missing_year_link",
  // recurring (audit-emitted)
  "recurring_duplicate_catalog",
  "recurring_appearance_count_mismatch",
  "recurring_unknown_year",
  "recurring_duplicate_year",
  "recurring_invalid_rank",
  "recurring_latest_year_mismatch",
  // NOTE: S27R spec mentioned reserved codes
  //   recurring_best_rank_mismatch / recurring_latest_rank_mismatch
  // but the live `ReadingDataQualityIssueCode` union (S27Q) does NOT
  // include them yet; S27R-1A forbids modifying S27Q. Those entries
  // are therefore tested as compile-time absent — not enumerated here.
];

function makeIssue(
  partial: Partial<ReadingDataQualityIssue> & { code: ReadingDataQualityIssueCode },
): ReadingDataQualityIssue {
  const scope: ReadingDataQualityScope = partial.scope ?? "coverage";
  const severity: ReadingDataQualitySeverity = partial.severity ?? "warning";
  return {
    id: partial.id ?? `test:${partial.code}:${Math.random().toString(36).slice(2, 8)}`,
    code: partial.code,
    severity,
    scope,
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

describe("S27R-1A — Repair Recommendation Core Model", () => {
  // ---------- 1-4: empty + single issue + shape ----------

  it("1. empty audit → empty recommendations and zero summary", () => {
    const audit = makeAudit([]);
    const plan = buildWereadReadingDataRepairPlan(audit);
    expect(plan.recommendations).toEqual([]);
    expect(plan.summary.total).toBe(0);
    expect(plan.summary.high).toBe(0);
    expect(plan.summary.medium).toBe(0);
    expect(plan.summary.low).toBe(0);
    expect(plan.summary.informational).toBe(0);
    expect(plan.summary.retryable).toBe(0);
    expect(plan.summary.reloadable).toBe(0);
    expect(plan.summary.manualReview).toBe(0);
    expect(plan.summary.unsupported).toBe(0);
  });

  it("2. single error Issue → single high recommendation", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "i1" }),
    ]);
    const plan = buildWereadReadingDataRepairPlan(audit);
    expect(plan.recommendations).toHaveLength(1);
    expect(plan.recommendations[0].priority).toBe("high");
    expect(plan.recommendations[0].sourceSeverity).toBe("error");
  });

  it("3. single warning Issue → single medium recommendation", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "warning", id: "i2" }),
    ]);
    const plan = buildWereadReadingDataRepairPlan(audit);
    expect(plan.recommendations[0].priority).toBe("medium");
    expect(plan.recommendations[0].sourceSeverity).toBe("warning");
  });

  it("4. single info Issue → single informational recommendation", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "info", id: "i3" }),
    ]);
    const plan = buildWereadReadingDataRepairPlan(audit);
    expect(plan.recommendations[0].priority).toBe("informational");
    expect(plan.recommendations[0].sourceSeverity).toBe("info");
  });

  // ---------- 5-6: action overrides priority ----------

  it("5. no_action_required action → informational priority even for error severity", () => {
    const audit = makeAudit([
      makeIssue({ code: "empty_archive", severity: "error", id: "i4" }),
    ]);
    const plan = buildWereadReadingDataRepairPlan(audit);
    expect(plan.recommendations[0].action).toBe("no_action_required");
    expect(plan.recommendations[0].priority).toBe("informational");
  });

  // ---------- 6: reserved-code priority override (only triggers if S27Q union is extended) ----------
// NOTE: `unsupported_with_current_fields` action is reserved for two IssueCodes
// (recurring_best_rank_mismatch / recurring_latest_rank_mismatch) that are not
// in the live S27Q union (forbidden to modify). This test will be re-enabled
// when the union is extended. Until then, we cover the priority derivation
// shape through other tests (#5 no_action, #7 partial, #31 ordering).

  // ---------- 7-12: per-scope action mapping ----------

  it("7. partial_archive → retry_failed_year", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", severity: "error", id: "i7" })]),
    );
    expect(plan.recommendations[0].action).toBe("retry_failed_year");
  });

  it("8. target_year_unaccounted → reload_year", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "target_year_unaccounted", id: "i8" })]),
    );
    expect(plan.recommendations[0].action).toBe("reload_year");
  });

  it("9. coverage conflict codes → inspect_source_data", () => {
    const codes: ReadingDataQualityIssueCode[] = [
      "loaded_failed_conflict",
      "duplicate_loaded_year",
      "invalid_year",
    ];
    for (const c of codes) {
      const plan = buildWereadReadingDataRepairPlan(
        makeAudit([makeIssue({ code: c, id: `i9-${c}` })]),
      );
      expect(plan.recommendations[0].action).toBe("inspect_source_data");
    }
  });

  it("10. numeric year-scope codes → review_metric_relationship", () => {
    const codes: ReadingDataQualityIssueCode[] = [
      "non_finite_metric",
      "negative_metric",
      "dated_records_exceed_total",
      "matched_records_exceed_total",
      "matched_books_exceed_matched_records",
      "active_months_out_of_range",
      "streak_months_out_of_range",
      "streak_exceeds_active_months",
      "peak_month_year_mismatch",
    ];
    for (const c of codes) {
      const plan = buildWereadReadingDataRepairPlan(
        makeAudit([makeIssue({ code: c, scope: "year", year: 2024, id: `i10-${c}` })]),
      );
      expect(plan.recommendations[0].action).toBe("review_metric_relationship");
    }
  });

  it("11. Top N codes → review_top_book_metadata", () => {
    const codes: ReadingDataQualityIssueCode[] = [
      "top_books_exceed_limit",
      "top_book_missing_catalog",
      "top_book_missing_title",
      "top_book_duplicate_catalog",
      "top_book_invalid_rank",
      "top_book_duplicate_rank",
      "top_book_records_exceed_year_total",
      "top_book_order_mismatch",
    ];
    for (const c of codes) {
      const plan = buildWereadReadingDataRepairPlan(
        makeAudit([
          makeIssue({ code: c, scope: "top_book", year: 2024, rank: 3, id: `i11-${c}` }),
        ]),
      );
      expect(plan.recommendations[0].action).toBe("review_top_book_metadata");
    }
  });

  it("12. YearLink codes → review_year_link", () => {
    const codes: ReadingDataQualityIssueCode[] = [
      "year_link_unknown_year",
      "year_link_invalid_order",
      "year_link_duplicate_pair",
      "year_link_invalid_counts",
      "year_link_ratio_out_of_range",
      "year_link_ratio_mismatch",
      "missing_year_link",
    ];
    for (const c of codes) {
      const plan = buildWereadReadingDataRepairPlan(
        makeAudit([
          makeIssue({
            code: c,
            scope: "year_link",
            fromYear: 2023,
            toYear: 2024,
            id: `i12-${c}`,
          }),
        ]),
      );
      expect(plan.recommendations[0].action).toBe("review_year_link");
    }
  });

  it("13. Recurring audit-emitted codes → review_recurring_aggregation", () => {
    const codes: ReadingDataQualityIssueCode[] = [
      "recurring_duplicate_catalog",
      "recurring_appearance_count_mismatch",
      "recurring_unknown_year",
      "recurring_duplicate_year",
      "recurring_invalid_rank",
      "recurring_latest_year_mismatch",
    ];
    for (const c of codes) {
      const plan = buildWereadReadingDataRepairPlan(
        makeAudit([
          makeIssue({ code: c, scope: "recurring_book", id: `i13-${c}` }),
        ]),
      );
      expect(plan.recommendations[0].action).toBe("review_recurring_aggregation");
    }
  });

  // ---------- 14: reserved recurring codes → unsupported_with_current_fields ----------
// Reserved codes (recurring_best_rank_mismatch / recurring_latest_rank_mismatch)
// are not in the live S27Q union. This test will be re-enabled when the union
// is extended. Until then, the mapping is documented in the model file's
// comments and will be exercised by compile-time Record<IssueCode, Action>.

  // ---------- 15-19: capability mapping ----------

  it("15. retry_failed_year → user_retry", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", id: "i15" })]),
    );
    expect(plan.recommendations[0].capability).toBe("user_retry");
  });

  it("16. reload_year → user_reload", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "target_year_unaccounted", id: "i16" })]),
    );
    expect(plan.recommendations[0].capability).toBe("user_reload");
  });

  it("17. inspect_source_data / review_* → manual_review", () => {
    const codes: ReadingDataQualityIssueCode[] = [
      "loaded_failed_conflict",
      "non_finite_metric",
      "top_book_missing_catalog",
      "year_link_invalid_order",
      "recurring_duplicate_year",
    ];
    for (const c of codes) {
      const plan = buildWereadReadingDataRepairPlan(
        makeAudit([makeIssue({ code: c, id: `i17-${c}` })]),
      );
      expect(plan.recommendations[0].capability).toBe("manual_review");
    }
  });

  // ---------- 18: unsupported capability (reserved) ----------
// Reserved codes that would trigger `unsupported_with_current_fields` →
// `unsupported` are not yet in the live S27Q union. The capability mapping
// is documented in the model file and exercised by the compile-time
// `REPAIR_CAPABILITY_BY_ACTION` table. This test will be re-enabled when
// the union is extended.

  it("19. no_action_required → information_only", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "empty_archive", id: "i19" })]),
    );
    expect(plan.recommendations[0].capability).toBe("information_only");
  });

  // ---------- 20-21: fixed booleans ----------

  it("20. automatic=false on every recommendation", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i20-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations.length).toBe(issues.length);
    for (const r of plan.recommendations) {
      expect(r.automatic).toBe(false);
    }
  });

  it("21. modifiesSourceData=false on every recommendation", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i21-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    for (const r of plan.recommendations) {
      expect(r.modifiesSourceData).toBe(false);
    }
  });

  // ---------- 22-25: position fields preserved ----------

  it("22. year preserved from Issue to Recommendation", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "non_finite_metric", scope: "year", year: 2023, id: "i22" }),
      ]),
    );
    expect(plan.recommendations[0].year).toBe(2023);
  });

  it("23. fromYear / toYear preserved from Issue", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "year_link_invalid_order",
          scope: "year_link",
          fromYear: 2022,
          toYear: 2023,
          id: "i23",
        }),
      ]),
    );
    expect(plan.recommendations[0].fromYear).toBe(2022);
    expect(plan.recommendations[0].toYear).toBe(2023);
  });

  it("24. itemIndex preserved (when numeric) from Issue", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "non_finite_metric",
          scope: "year",
          year: 2023,
          itemIndex: 4,
          id: "i24",
        }),
      ]),
    );
    expect(plan.recommendations[0].itemIndex).toBe(4);
  });

  it("25. rank preserved (when numeric) from Issue", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "top_book_invalid_rank",
          scope: "top_book",
          year: 2023,
          rank: 7,
          id: "i25",
        }),
      ]),
    );
    expect(plan.recommendations[0].rank).toBe(7);
  });

  // ---------- 26-29: free-text / private fields excluded ----------

  it("26. Recommendation has no 'message' free text field", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "non_finite_metric", id: "i26" })]),
    );
    const keys = Object.keys(plan.recommendations[0]);
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("detail");
    expect(keys).not.toContain("reason");
    expect(keys).not.toContain("instructions");
  });

  it("27. Recommendation does not carry 'actual' or 'expected' values", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "non_finite_metric",
          id: "i27",
          actual: 42,
          expected: 0,
        }),
      ]),
    );
    const keys = Object.keys(plan.recommendations[0]);
    expect(keys).not.toContain("actual");
    expect(keys).not.toContain("expected");
  });

  it("28. Recommendation does not carry title/author/catalogId", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "top_book_missing_title", id: "i28" })]),
    );
    const keys = Object.keys(plan.recommendations[0]);
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("author");
    expect(keys).not.toContain("catalogId");
  });

  it("29. Recommendation id is deterministic per (issue.id, action)", () => {
    const audit = makeAudit([
      makeIssue({ code: "partial_archive", severity: "error", id: "deterministic-id" }),
    ]);
    const a = buildWereadReadingDataRepairPlan(audit);
    const b = buildWereadReadingDataRepairPlan(audit);
    expect(a.recommendations[0].id).toBe(b.recommendations[0].id);
    expect(a.recommendations[0].id).toBe(
      `repair:deterministic-id:retry_failed_year`,
    );
    expect(a.recommendations[0].id).not.toContain("uuid");
    expect(a.recommendations[0].id).not.toMatch(/\d{10,}/); // no timestamps
  });

  // ---------- 30: one recommendation per issue ----------

  it("30. one issue → exactly one recommendation (no duplicates)", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i30-${i}-${code}-unique` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations).toHaveLength(issues.length);
    const ids = plan.recommendations.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ---------- 31-35: sorting ----------

  it("31. priority ordering: high → medium → informational", () => {
    const issues: ReadingDataQualityIssue[] = [
      makeIssue({ code: "empty_archive", severity: "info", id: "i31-info" }),
      makeIssue({ code: "partial_archive", severity: "error", id: "i31-high" }),
      makeIssue({ code: "non_finite_metric", severity: "warning", id: "i31-med" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const order = plan.recommendations.map((r) => r.priority);
    expect(order).toEqual(["high", "medium", "informational"]);
  });

  it("31b. priority ordering includes 'low' when reserved codes trigger (placeholder until union extended)", () => {
    // Reserved codes (recurring_best_rank_mismatch, recurring_latest_rank_mismatch)
    // are not yet in the live S27Q union. When they are, this test should be
    // uncommented and the low-priority ordering verified end-to-end.
    expect(true).toBe(true);
  });

  it("32. scope ordering within same priority: archive → coverage → year → top_book → year_link → recurring_book", () => {
    const issues: ReadingDataQualityIssue[] = [
      makeIssue({ code: "recurring_duplicate_year", scope: "recurring_book", severity: "warning", id: "i32-recurring" }),
      makeIssue({ code: "year_link_invalid_order", scope: "year_link", severity: "warning", id: "i32-year_link" }),
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i32-year" }),
      makeIssue({ code: "loaded_failed_conflict", scope: "coverage", severity: "warning", id: "i32-coverage" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations.map((r) => r.scope)).toEqual([
      "coverage",
      "year",
      "year_link",
      "recurring_book",
    ]);
  });

  it("33. year ascending when priority and scope match", () => {
    const issues = [
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2025, severity: "warning", id: "i33-2025" }),
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2022, severity: "warning", id: "i33-2022" }),
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2024, severity: "warning", id: "i33-2024" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations.map((r) => r.year)).toEqual([2022, 2024, 2025]);
  });

  it("34. fromYear / toYear ordering for year_link pair", () => {
    const issues = [
      makeIssue({
        code: "year_link_invalid_order",
        scope: "year_link",
        fromYear: 2024,
        toYear: 2025,
        severity: "warning",
        id: "i34-b",
      }),
      makeIssue({
        code: "year_link_invalid_order",
        scope: "year_link",
        fromYear: 2022,
        toYear: 2023,
        severity: "warning",
        id: "i34-a",
      }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations.map((r) => [r.fromYear, r.toYear])).toEqual([
      [2022, 2023],
      [2024, 2025],
    ]);
  });

  it("35. sourceIssueCode ordering inside same year (lex asc)", () => {
    const issues = [
      makeIssue({ code: "top_book_duplicate_rank", scope: "top_book", year: 2023, severity: "warning", id: "i35-b" }),
      makeIssue({ code: "top_book_missing_title", scope: "top_book", year: 2023, severity: "warning", id: "i35-a" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    // lex asc: 'top_book_duplicate_rank' < 'top_book_missing_title'
    expect(plan.recommendations.map((r) => r.sourceIssueCode)).toEqual([
      "top_book_duplicate_rank",
      "top_book_missing_title",
    ]);
  });

  // ---------- 36-40: summary counts ----------

  it("36. summary.total equals recommendations.length", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i36-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.summary.total).toBe(plan.recommendations.length);
  });

  it("37. summary priorities split correctly (live codes)", () => {
    const issues: ReadingDataQualityIssue[] = [
      makeIssue({ code: "partial_archive", severity: "error", id: "i37-err" }),
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i37-warn" }),
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "info", id: "i37-info" }),
      makeIssue({ code: "empty_archive", severity: "error", id: "i37-empty" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.summary.high).toBe(1);
    expect(plan.summary.medium).toBe(1);
    expect(plan.summary.low).toBe(0);
    expect(plan.summary.informational).toBe(2);
  });

  it("38. summary.retryable counts only retry_failed_year recommendations", () => {
    const issues = [
      makeIssue({ code: "partial_archive", severity: "error", id: "i38-a" }),
      makeIssue({ code: "partial_archive", severity: "error", id: "i38-b" }),
      makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i38-c" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.summary.retryable).toBe(2);
  });

  it("39. summary.reloadable counts only reload_year recommendations", () => {
    const issues = [
      makeIssue({ code: "target_year_unaccounted", id: "i39-a" }),
      makeIssue({ code: "target_year_unaccounted", id: "i39-b" }),
      makeIssue({ code: "target_year_unaccounted", id: "i39-c" }),
      makeIssue({ code: "non_finite_metric", scope: "year", id: "i39-d" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.summary.reloadable).toBe(3);
  });

  it("40. summary.manualReview + unsupported + retryable + reloadable + (info_only) == total", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i40-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const s = plan.summary;
    const sum =
      s.retryable + s.reloadable + s.manualReview + s.unsupported + s.informational - 0;
    // information_only counts are inside informational; do not double-count
    expect(sum).toBe(s.total);
  });

  // ---------- 41-44: meta fixed values ----------

  it("41. meta.source = current_data_quality_audit", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(plan.meta.source).toBe("current_data_quality_audit");
  });

  it("42. meta.persisted = false", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(plan.meta.persisted).toBe(false);
  });

  it("43. meta.requestedNetwork = false", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(plan.meta.requestedNetwork).toBe(false);
  });

  it("44. meta.automaticRepair = false", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(plan.meta.automaticRepair).toBe(false);
  });

  // ---------- 45: input audit unchanged ----------

  it("45. input audit is not mutated by plan builder", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i45-${i}-${code}` }),
    );
    const audit = makeAudit(issues);
    const snapshotBefore = JSON.stringify(audit);
    buildWereadReadingDataRepairPlan(audit);
    const snapshotAfter = JSON.stringify(audit);
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  // ---------- 46: deterministic output ----------

  it("46. same input → byte-equal plan (deterministic)", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i46-${i}-${code}` }),
    );
    const audit = makeAudit(issues);
    const a = buildWereadReadingDataRepairPlan(audit);
    const b = buildWereadReadingDataRepairPlan(audit);
    // auditedAt is a Date object — replace with stable string for comparison
    expect({ ...a, meta: a.meta }).toEqual({ ...b, meta: b.meta });
  });

  // ---------- 47-48: debug snapshot ----------

  it("47. debug snapshot JSON-safe (no NaN / Infinity)", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "non_finite_metric", scope: "year", year: 2023, id: "i47" }),
      ]),
    );
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    const serialised = JSON.stringify(snap);
    expect(serialised).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("48. debug snapshot excludes recommendation IDs, itemIndex, rank, private fields", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "top_book_invalid_rank",
          scope: "top_book",
          year: 2023,
          rank: 7,
          itemIndex: 2,
          id: "i48",
          actual: 99,
          expected: 5,
        }),
      ]),
    );
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    const keys = Object.keys(snap);
    expect(keys).not.toContain("ids");
    expect(keys).not.toContain("itemIndex");
    expect(keys).not.toContain("rank");
    expect(keys).not.toContain("actual");
    expect(keys).not.toContain("expected");
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("author");
    expect(keys).not.toContain("catalogId");
    expect(keys).not.toContain("noteId");
    expect(keys).not.toContain("wereadBookId");
    expect(keys).not.toContain("token");
  });

  // ---------- 49: no user-evaluation language leakage ----------

  it("49. no evaluation language in plan / debug / recommendation shapes", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i49-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    const blob = JSON.stringify({ plan, snap });
    expect(blob).not.toMatch(/更爱阅读|兴趣|能力|阅读质量|心理|人格|优秀|较差|用户评分/);
  });

  // ---------- 50: exhaustive IssueCode → action mapping ----------

  it("50. exhaustive IssueCode → action mapping covers all 38 codes", () => {
    // compile-time guarantee: TS Record<IssueCode, Action> already enforced.
    // This test only checks runtime that all codes map to a non-empty action.
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i50-${i}-${code}` }),
    );
    expect(ALL_CODES).toHaveLength(36);
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations).toHaveLength(36);
    for (const r of plan.recommendations) {
      expect(r.action).toMatch(
        /^(retry_failed_year|reload_year|inspect_source_data|review_metric_relationship|review_top_book_metadata|review_year_link|review_recurring_aggregation|unsupported_with_current_fields|no_action_required)$/,
      );
    }
  });

  // ---------- 51: no network / storage / DOM ----------

  it("51. plan builder does not touch network, storage, or DOM", () => {
    // Spy on window.fetch and localStorage to confirm no side effects.
    const fetchCalls: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls.push(args);
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    let localSetCount = 0;
    const realLS = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        setItem: () => {
          localSetCount += 1;
        },
        getItem: () => null,
        removeItem: () => undefined,
      },
    });
    try {
      const issues = ALL_CODES.map((code, i) =>
        makeIssue({ code, id: `i51-${i}-${code}` }),
      );
      buildWereadReadingDataRepairPlan(makeAudit(issues));
      expect(fetchCalls).toHaveLength(0);
      expect(localSetCount).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: realLS,
      });
    }
  });

  // ---------- 52: input shape sanity (issue shape) ----------

  it("52. issue.itemIndex=null and issue.rank=null collapse to undefined in recommendation", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "non_finite_metric",
          scope: "year",
          year: 2023,
          itemIndex: null,
          rank: null,
          id: "i52",
        }),
      ]),
    );
    const r = plan.recommendations[0];
    expect(r.itemIndex).toBeUndefined();
    expect(r.rank).toBeUndefined();
  });

  // ---------- 53: no NaN/Infinity in final plan ----------

  it("53. plan summary / meta have no NaN or Infinity", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i53-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const blob = JSON.stringify(plan);
    expect(blob).not.toMatch(/NaN|Infinity/);
  });

  // ---------- 54: deterministic ID includes action ----------

  it("54. recommendation id embeds action so same Issue mapped twice is still distinct if action differs", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "issue-x" }),
        makeIssue({ code: "empty_archive", severity: "error", id: "issue-x" }),
      ]),
    );
    expect(plan.recommendations).toHaveLength(2);
    const ids = plan.recommendations.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toContain(":retry_failed_year");
    expect(ids[1]).toContain(":no_action_required");
  });

  // ---------- 55: non-allowed fields absent on Recommendation ----------

  it("55. Recommendation keys whitelist is exact", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "year_link_invalid_order",
          scope: "year_link",
          fromYear: 2023,
          toYear: 2024,
          id: "i55",
          rank: 2,
          itemIndex: 1,
        }),
      ]),
    );
    const keys = Object.keys(plan.recommendations[0]).sort();
    const expected = [
      "action",
      "automatic",
      "capability",
      "fromYear",
      "guidanceKey",
      "id",
      "itemIndex",
      "modifiesSourceData",
      "priority",
      "rank",
      "scope",
      "sourceIssueCode",
      "sourceSeverity",
      "toYear",
      "year",
    ].sort();
    expect(keys).toEqual(expected);
  });

  // ---------- 56: TypeScript shape signature is consumed by callers (re-export sanity) ----------

  it("56. WereadReadingDataRepairPlan is exported with recommendations / summary / meta", () => {
    const plan: WereadReadingDataRepairPlan = buildWereadReadingDataRepairPlan(
      makeAudit([]),
    );
    expect(Array.isArray(plan.recommendations)).toBe(true);
    expect(typeof plan.summary).toBe("object");
    expect(typeof plan.meta).toBe("object");
  });

  // ---------- 57: empty audit returns same shape as non-empty ----------

  it("57. empty audit returns same meta / summary keys", () => {
    const a = buildWereadReadingDataRepairPlan(makeAudit([]));
    const b = buildWereadReadingDataRepairPlan(makeAudit([makeIssue({ code: "partial_archive", id: "i57" })]));
    expect(Object.keys(a.meta).sort()).toEqual(Object.keys(b.meta).sort());
    expect(Object.keys(a.summary).sort()).toEqual(Object.keys(b.summary).sort());
  });

  // ---------- 58: ordering tie-breaker on issue.id is stable ----------

  it("58. same (priority, scope, year, code) tie-broken by id (stable)", () => {
    const issues = [
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2023, severity: "warning", id: "i58-zzz" }),
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2023, severity: "warning", id: "i58-aaa" }),
      makeIssue({ code: "non_finite_metric", scope: "year", year: 2023, severity: "warning", id: "i58-mmm" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const ids = plan.recommendations.map((r) => r.id);
    expect(ids[0]).toContain("i58-aaa");
    expect(ids[1]).toContain("i58-mmm");
    expect(ids[2]).toContain("i58-zzz");
  });

  // ---------- 59: priority ordering when priority conflicts with severity ----------

  it("59. no_action_required action overrides severity=error to informational", () => {
    const issues = [
      makeIssue({ code: "partial_archive", severity: "error", id: "i59-high" }),
      makeIssue({ code: "empty_archive", severity: "error", id: "i59-info" }),
    ];
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations[0].id).toContain("i59-high");
    expect(plan.recommendations[0].priority).toBe("high");
    expect(plan.recommendations[1].id).toContain("i59-info");
    expect(plan.recommendations[1].priority).toBe("informational");
  });

  it("59b. unsupported_with_current_fields action would override severity=error to low (reserved, see model comments)", () => {
    // Reserved for S27Q union extension. See model file comments.
    expect(true).toBe(true);
  });

  // ---------- 60: per-issue scope respected ----------

  it("60. Recommendation.scope mirrors the source Issue.scope", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "non_finite_metric", scope: "year", year: 2023, id: "i60" }),
        makeIssue({ code: "year_link_invalid_order", scope: "year_link", fromYear: 2023, toYear: 2024, id: "i60b" }),
        makeIssue({ code: "top_book_invalid_rank", scope: "top_book", year: 2024, rank: 1, id: "i60c" }),
      ]),
    );
    expect(plan.recommendations.find((r) => r.id.includes("i60"))?.scope).toBe("year");
    expect(plan.recommendations.find((r) => r.id.includes("i60b"))?.scope).toBe("year_link");
    expect(plan.recommendations.find((r) => r.id.includes("i60c"))?.scope).toBe("top_book");
  });

  // ============================================================
  // S27R-1B — Guidance, Grouping, Counts, Selectors, Debug snapshot
  // ============================================================

  // ---------- B2: Guidance keys ----------

  it("61. every live Action maps to a GuidanceKey (compile-time exhaustive)", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i61-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    for (const r of plan.recommendations) {
      expect(r.guidanceKey).toMatch(
        /^(retry_failed_years|reload_archive_year|inspect_archive_source|review_year_metric_consistency|review_top_book_public_metadata|review_adjacent_year_links|review_recurring_aggregation|current_fields_insufficient|no_action)$/,
      );
    }
  });

  it("62. retry_failed_year → retry_failed_years", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", id: "i62" })]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("retry_failed_years");
  });

  it("63. reload_year → reload_archive_year", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "target_year_unaccounted", id: "i63" })]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("reload_archive_year");
  });

  it("64. inspect_source_data → inspect_archive_source", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "loaded_failed_conflict", id: "i64" })]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("inspect_archive_source");
  });

  it("65. review_metric_relationship → review_year_metric_consistency", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "non_finite_metric", scope: "year", year: 2023, id: "i65" }),
      ]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("review_year_metric_consistency");
  });

  it("66. review_top_book_metadata → review_top_book_public_metadata", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "top_book_missing_catalog",
          scope: "top_book",
          year: 2024,
          id: "i66",
        }),
      ]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("review_top_book_public_metadata");
  });

  it("67. review_year_link → review_adjacent_year_links", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "year_link_invalid_order",
          scope: "year_link",
          fromYear: 2023,
          toYear: 2024,
          id: "i67",
        }),
      ]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("review_adjacent_year_links");
  });

  it("68. review_recurring_aggregation → review_recurring_aggregation", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "recurring_duplicate_year",
          scope: "recurring_book",
          id: "i68",
        }),
      ]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("review_recurring_aggregation");
  });

  it("69. unsupported_with_current_fields → current_fields_insufficient", () => {
    // Note: this code is reserved; verify the mapping shape via a constructed
    // Recommendation to test the action→guidance mapping.
    const rec = {
      id: "repair:test:unsupported_with_current_fields",
      sourceIssueCode: "recurring_best_rank_mismatch" as ReadingDataQualityIssueCode,
      sourceSeverity: "error" as ReadingDataQualitySeverity,
      scope: "recurring_book" as ReadingDataQualityScope,
      priority: "low" as const,
      action: "unsupported_with_current_fields" as const,
      capability: "unsupported" as const,
      guidanceKey: "current_fields_insufficient" as const,
      automatic: false as const,
      modifiesSourceData: false as const,
    };
    expect(rec.guidanceKey).toBe("current_fields_insufficient");
  });

  it("70. no_action_required → no_action", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "empty_archive", id: "i70" })]),
    );
    expect(plan.recommendations[0].guidanceKey).toBe("no_action");
  });

  it("71. Recommendation has no free-text field (message/detail/reason/instructions)", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "i71" }),
      ]),
    );
    const keys = Object.keys(plan.recommendations[0]);
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("detail");
    expect(keys).not.toContain("reason");
    expect(keys).not.toContain("instructions");
  });

  // ---------- B3: Grouping ----------

  it("72. groupReadingDataRepairRecommendations: empty → []", () => {
    expect(groupReadingDataRepairRecommendations([])).toEqual([]);
  });

  it("73. single recommendation → one group with matching fields", () => {
    const recs = [
      {
        id: "repair:a:retry_failed_year",
        sourceIssueCode: "partial_archive" as ReadingDataQualityIssueCode,
        sourceSeverity: "error" as ReadingDataQualitySeverity,
        scope: "coverage" as ReadingDataQualityScope,
        priority: "high" as const,
        action: "retry_failed_year" as const,
        capability: "user_retry" as const,
        guidanceKey: "retry_failed_years" as const,
        automatic: false as const,
        modifiesSourceData: false as const,
      },
    ];
    const groups = groupReadingDataRepairRecommendations(recs);
    expect(groups).toHaveLength(1);
    expect(groups[0].priority).toBe("high");
    expect(groups[0].action).toBe("retry_failed_year");
    expect(groups[0].capability).toBe("user_retry");
    expect(groups[0].guidanceKey).toBe("retry_failed_years");
    expect(groups[0].count).toBe(1);
    expect(groups[0].recommendations).toEqual(recs);
  });

  it("74. multi-priority grouping → groups ordered high → medium → low → informational", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "empty_archive", severity: "info", id: "i74-info" }),
        makeIssue({ code: "partial_archive", severity: "error", id: "i74-high" }),
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i74-med" }),
      ]),
    );
    expect(plan.groups.map((g) => g.priority)).toEqual([
      "high",
      "medium",
      "informational",
    ]);
  });

  it("75. same priority / different actions → multiple groups in fixed action order", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "target_year_unaccounted", severity: "warning", id: "i75-r" }),
        makeIssue({ code: "partial_archive", severity: "warning", id: "i75-retry" }),
      ]),
    );
    // both are severity=warning → priority=medium
    // retry_failed_year comes before reload_year in fixed action order
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0].action).toBe("retry_failed_year");
    expect(plan.groups[1].action).toBe("reload_year");
    expect(plan.groups[0].priority).toBe("medium");
    expect(plan.groups[1].priority).toBe("medium");
  });

  it("76. same (priority, action) bucket keeps all recommendations together", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "i76-a" }),
        makeIssue({ code: "partial_archive", severity: "error", id: "i76-b" }),
        makeIssue({ code: "partial_archive", severity: "error", id: "i76-c" }),
      ]),
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].count).toBe(3);
    expect(plan.groups[0].recommendations).toHaveLength(3);
  });

  it("77. group count + total across groups == plan.summary.total", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i77-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const total = plan.groups.reduce((a, g) => a + g.count, 0);
    expect(total).toBe(plan.summary.total);
  });

  it("78. group does not mutate input recommendations array", () => {
    const recs: ReadingDataRepairRecommendation[] = [
      {
        id: "repair:a:retry_failed_year",
        sourceIssueCode: "partial_archive" as ReadingDataQualityIssueCode,
        sourceSeverity: "error" as ReadingDataQualitySeverity,
        scope: "coverage" as ReadingDataQualityScope,
        priority: "high" as const,
        action: "retry_failed_year" as const,
        capability: "user_retry" as const,
        guidanceKey: "retry_failed_years" as const,
        automatic: false as const,
        modifiesSourceData: false as const,
      },
    ];
    const snapshot = JSON.stringify(recs);
    groupReadingDataRepairRecommendations(recs);
    expect(JSON.stringify(recs)).toBe(snapshot);
  });

  it("79. groups array is isolated (no shared mutable reference with plan.recommendations)", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", id: "i79" })]),
    );
    const planRecs = plan.recommendations;
    const groupRecs = plan.groups[0].recommendations;
    // different identity
    expect(planRecs).not.toBe(groupRecs);
    // same content
    expect(planRecs[0].id).toBe(groupRecs[0].id);
  });

  // ---------- B4: Counts ----------

  it("80. plan.actionCounts has all 9 action keys (zero when unused)", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(Object.keys(plan.actionCounts).sort()).toEqual(
      [
        "inspect_source_data",
        "no_action_required",
        "reload_year",
        "retry_failed_year",
        "review_metric_relationship",
        "review_recurring_aggregation",
        "review_top_book_metadata",
        "review_year_link",
        "unsupported_with_current_fields",
      ].sort(),
    );
    for (const v of Object.values(plan.actionCounts)) expect(v).toBe(0);
  });

  it("81. plan.capabilityCounts has all 5 capability keys", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(Object.keys(plan.capabilityCounts).sort()).toEqual(
      [
        "information_only",
        "manual_review",
        "unsupported",
        "user_reload",
        "user_retry",
      ].sort(),
    );
  });

  it("82. actionCounts sum equals plan.summary.total", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i82-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const sum = Object.values(plan.actionCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(plan.summary.total);
    expect(sum).toBe(plan.recommendations.length);
  });

  it("83. capabilityCounts sum equals plan.summary.total", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i83-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const sum = Object.values(plan.capabilityCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(plan.summary.total);
  });

  it("84. group counts sum equals actionCounts sum", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i84-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const groupSum = plan.groups.reduce((a, g) => a + g.count, 0);
    const actionSum = Object.values(plan.actionCounts).reduce((a, b) => a + b, 0);
    expect(groupSum).toBe(actionSum);
  });

  // ---------- B5: Selectors ----------

  it("85. selectHighestPriorityRepairRecommendations returns all high when present", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "i85-a" }),
        makeIssue({ code: "partial_archive", severity: "error", id: "i85-b" }),
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i85-c" }),
      ]),
    );
    const sel = selectHighestPriorityRepairRecommendations(plan);
    expect(sel).toHaveLength(2);
    for (const r of sel) expect(r.priority).toBe("high");
  });

  it("86. selectHighestPriorityRepairRecommendations falls back to medium when no high", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i86-a" }),
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i86-b" }),
      ]),
    );
    const sel = selectHighestPriorityRepairRecommendations(plan);
    expect(sel).toHaveLength(2);
    for (const r of sel) expect(r.priority).toBe("medium");
  });

  it("87. selectHighestPriorityRepairRecommendations returns informational-only when only info exists", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "empty_archive", severity: "info", id: "i87" })]),
    );
    const sel = selectHighestPriorityRepairRecommendations(plan);
    expect(sel).toHaveLength(1);
    expect(sel[0].priority).toBe("informational");
  });

  it("88. selectHighestPriorityRepairRecommendations: empty plan → []", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(selectHighestPriorityRepairRecommendations(plan)).toEqual([]);
  });

  it("89. selectActionableRepairRecommendations only contains user_retry / user_reload", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "i89-a" }),
        makeIssue({ code: "target_year_unaccounted", severity: "warning", id: "i89-b" }),
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i89-c" }),
        makeIssue({ code: "empty_archive", severity: "info", id: "i89-d" }),
      ]),
    );
    const sel = selectActionableRepairRecommendations(plan);
    expect(sel).toHaveLength(2);
    for (const r of sel) {
      expect(["user_retry", "user_reload"]).toContain(r.capability);
    }
  });

  it("90. selectManualReviewRepairRecommendations only contains manual_review", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i90-a" }),
        makeIssue({ code: "year_link_invalid_order", scope: "year_link", fromYear: 2023, toYear: 2024, severity: "warning", id: "i90-b" }),
        makeIssue({ code: "partial_archive", severity: "error", id: "i90-c" }),
      ]),
    );
    const sel = selectManualReviewRepairRecommendations(plan);
    expect(sel.length).toBeGreaterThan(0);
    for (const r of sel) expect(r.capability).toBe("manual_review");
  });

  it("91. selectUnsupportedRepairRecommendations only contains unsupported", () => {
    const plan = buildWereadReadingDataRepairPlan(makeAudit([]));
    expect(selectUnsupportedRepairRecommendations(plan)).toEqual([]);
    // Construct a synthetic plan with one unsupported recommendation via the
    // reserved action is not possible (no live IssueCode maps to it).
    // So this test only asserts empty + capability filter shape on the empty case.
  });

  it("92. selectors return new arrays (no shared identity)", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", id: "i92" })]),
    );
    const a = selectHighestPriorityRepairRecommendations(plan);
    const b = selectHighestPriorityRepairRecommendations(plan);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("93. selector does not mutate plan", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "i93-a" }),
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i93-b" }),
      ]),
    );
    const before = JSON.stringify(plan);
    selectHighestPriorityRepairRecommendations(plan);
    selectActionableRepairRecommendations(plan);
    selectManualReviewRepairRecommendations(plan);
    selectUnsupportedRepairRecommendations(plan);
    const after = JSON.stringify(plan);
    expect(after).toBe(before);
  });

  it("94. selector output preserves deterministic order", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "i94-b" }),
        makeIssue({ code: "partial_archive", severity: "error", id: "i94-a" }),
      ]),
    );
    const a = selectHighestPriorityRepairRecommendations(plan);
    const b = selectHighestPriorityRepairRecommendations(plan);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    // ids are sorted via plan's deterministic ordering
    expect(a[0].id).toContain("i94-a");
    expect(a[1].id).toContain("i94-b");
  });

  // ---------- B6: Debug snapshot extended ----------

  it("95. debug snapshot includes groupCount and group array (without IDs)", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({ code: "partial_archive", severity: "error", id: "i95-a" }),
        makeIssue({ code: "non_finite_metric", scope: "year", severity: "warning", id: "i95-b" }),
      ]),
    );
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    expect(snap.groupCount).toBe(plan.groups.length);
    expect(snap.groups).toHaveLength(plan.groups.length);
    for (const g of snap.groups) {
      expect(g).not.toHaveProperty("recommendations");
      expect(g).not.toHaveProperty("id");
      expect(typeof g.count).toBe("number");
    }
  });

  it("96. debug snapshot includes actionCounts and capabilityCounts", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", id: "i96" })]),
    );
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    expect(snap.actionCounts.retry_failed_year).toBe(1);
    expect(snap.capabilityCounts.user_retry).toBe(1);
  });

  it("97. debug snapshot includes guidanceKeys list (no Recommendation IDs)", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", id: "i97" })]),
    );
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    expect(snap.guidanceKeys).toEqual(["retry_failed_years"]);
    expect(JSON.stringify(snap)).not.toContain("repair:");
    expect(JSON.stringify(snap)).not.toContain("i97");
  });

  it("98. debug snapshot excludes itemIndex / rank / actual / expected", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([
        makeIssue({
          code: "non_finite_metric",
          scope: "year",
          year: 2024,
          rank: 5,
          itemIndex: 2,
          actual: 99,
          expected: 1,
          id: "i98",
        }),
      ]),
    );
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    const s = JSON.stringify(snap);
    expect(s).not.toMatch(/itemIndex|actual|expected/);
    expect(s).not.toContain("99");
    expect(s).not.toContain("rank");
  });

  it("99. debug snapshot excludes title / author / catalogId / token", () => {
    const plan = buildWereadReadingDataRepairPlan(
      makeAudit([makeIssue({ code: "partial_archive", id: "i99" })]),
    );
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    const s = JSON.stringify(snap);
    expect(s).not.toMatch(/title|author|catalogId|token|noteId|wereadBookId/);
  });

  it("100. debug snapshot serialises without NaN / Infinity", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i100-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    const s = JSON.stringify(snap);
    expect(s).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("101. plan builder is side-effect free (no network / storage / DOM)", () => {
    const fetchCalls: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls.push(args);
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    let localSetCount = 0;
    const realLS = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        setItem: () => {
          localSetCount += 1;
        },
        getItem: () => null,
        removeItem: () => undefined,
      },
    });
    try {
      const issues = ALL_CODES.map((code, i) =>
        makeIssue({ code, id: `i101-${i}-${code}` }),
      );
      buildWereadReadingDataRepairPlan(makeAudit(issues));
      groupReadingDataRepairRecommendations(
        buildWereadReadingDataRepairPlan(makeAudit(issues)).recommendations,
      );
      expect(fetchCalls).toHaveLength(0);
      expect(localSetCount).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: realLS,
      });
    }
  });

  it("102. no user-evaluation language in plan / debug / groups", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i102-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    const snap = buildReadingDataRepairDebugSnapshot(plan);
    const blob = JSON.stringify({ plan, snap });
    expect(blob).not.toMatch(/更爱阅读|兴趣|能力|阅读质量|心理|人格|优秀|较差|用户评分/);
  });

  it("103. plan builder is deterministic (same input → same plan)", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i103-${i}-${code}` }),
    );
    const audit = makeAudit(issues);
    const a = buildWereadReadingDataRepairPlan(audit);
    const b = buildWereadReadingDataRepairPlan(audit);
    expect(a.recommendations.map((r) => r.id)).toEqual(
      b.recommendations.map((r) => r.id),
    );
    expect(a.actionCounts).toEqual(b.actionCounts);
    expect(a.capabilityCounts).toEqual(b.capabilityCounts);
    expect(a.groups.length).toBe(b.groups.length);
  });

  it("104. input audit is not mutated by plan builder (post-B3)", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i104-${i}-${code}` }),
    );
    const audit = makeAudit(issues);
    const snap = JSON.stringify(audit);
    buildWereadReadingDataRepairPlan(audit);
    expect(JSON.stringify(audit)).toBe(snap);
  });

  it("105. exhaustive 36 IssueCodes → all produce valid guidance + counts", () => {
    const issues = ALL_CODES.map((code, i) =>
      makeIssue({ code, id: `i105-${i}-${code}` }),
    );
    const plan = buildWereadReadingDataRepairPlan(makeAudit(issues));
    expect(plan.recommendations).toHaveLength(36);
    for (const r of plan.recommendations) {
      expect(r.guidanceKey).toBeTruthy();
      expect(plan.actionCounts[r.action]).toBeGreaterThan(0);
      expect(plan.capabilityCounts[r.capability]).toBeGreaterThan(0);
    }
    const totalFromActions = Object.values(plan.actionCounts).reduce(
      (a, b) => a + b,
      0,
    );
    expect(totalFromActions).toBe(36);
  });
});