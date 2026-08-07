// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairGuidedSession.test.ts
//
// S27S-3A — Targeted tests for Guided Session model.

import { describe, expect, it } from "vitest";

import type { ReadingDataRepairNavigationRequest } from "./wereadReadingDataRepairNavigationUi";
import type {
  ReadingDataRepairNavigationExecutionResult,
} from "./wereadReadingDataRepairNavigationRuntime";
import type { ReadingDataRepairNavigationTarget } from "./wereadReadingDataRepairNavigation";

import {
  ALL_FEEDBACK_STATUSES_INTERNAL,
  applyReadingDataRepairNavigationFeedback,
  buildReadingDataRepairGuidedSessionDebugSnapshot,
  buildReadingDataRepairGuidedSessionSummary,
  buildReadingDataRepairNavigationFeedback,
  createInitialReadingDataRepairGuidedSession,
  FEEDBACK_STATUS_TO_KIND,
  FEEDBACK_STATUS_TO_LABEL_KEY,
  resetReadingDataRepairGuidedSession,
  RUNTIME_STATUS_TO_FEEDBACK_STATUS,
} from "./wereadReadingDataRepairGuidedSession";

function makeRequest(surfaceKey: string, extras: Partial<ReadingDataRepairNavigationRequest> = {}): ReadingDataRepairNavigationRequest {
  return {
    sourceIssueCode: "empty_archive" as ReadingDataRepairNavigationRequest["sourceIssueCode"],
    action: "retry_failed_year",
    capability: "user_retry",
    target: "failed_year_controls",
    surfaceKey,
    initiatedBy: "user_click",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
    ...extras,
  };
}

function makeResult(status: ReadingDataRepairNavigationExecutionResult["status"]): ReadingDataRepairNavigationExecutionResult {
  return { status, surfaceKey: "weread-reading-archive-controls", scrollCount: 0, focusCount: 0 };
}

// ---------- tests ----------

describe("S27S-3A wereadReadingDataRepairGuidedSession", () => {
  // ---- runtime mapping ----
  it("1. runtime status covers all 4 values", () => {
    expect(ALL_FEEDBACK_STATUSES_INTERNAL.length).toBe(4);
  });

  it("2. navigated -> navigation_complete", () => {
    expect(RUNTIME_STATUS_TO_FEEDBACK_STATUS.navigated).toBe("navigation_complete");
  });

  it("3. surface_not_found -> surface_unavailable", () => {
    expect(RUNTIME_STATUS_TO_FEEDBACK_STATUS.surface_not_found).toBe("surface_unavailable");
  });

  it("4. ambiguous_surface -> surface_ambiguous", () => {
    expect(RUNTIME_STATUS_TO_FEEDBACK_STATUS.ambiguous_surface).toBe("surface_ambiguous");
  });

  it("5. rejected_request -> request_rejected", () => {
    expect(RUNTIME_STATUS_TO_FEEDBACK_STATUS.rejected_request).toBe("request_rejected");
  });

  // ---- feedback builder ----
  it("6. navigated feedback has success kind + correct label", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    expect(f.status).toBe("navigation_complete");
    expect(f.kind).toBe("success");
    expect(f.labelKey).toBe("navigation_completed");
  });

  it("7. missing surface -> notice", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("surface_not_found"));
    expect(f.status).toBe("surface_unavailable");
    expect(f.kind).toBe("notice");
    expect(f.labelKey).toBe("surface_not_available");
  });

  it("8. ambiguous -> warning (not critical)", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("ambiguous_surface"));
    expect(f.status).toBe("surface_ambiguous");
    expect(f.kind).toBe("warning");
    expect(f.labelKey).toBe("multiple_surfaces_detected");
  });

  it("9. rejected -> warning", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("rejected_request"));
    expect(f.status).toBe("request_rejected");
    expect(f.kind).toBe("warning");
    expect(f.labelKey).toBe("navigation_request_rejected");
  });

  it("10. feedback.target comes from request.target", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-data-quality", { target: "data_quality_audit" }), makeResult("navigated"));
    expect(f.target).toBe("data_quality_audit");
  });

  it("11. feedback preserves year / fromYear / toYear", () => {
    const f = buildReadingDataRepairNavigationFeedback(
      makeRequest("weread-reading-archive-links", { target: "year_links", year: 2022, fromYear: 2022, toYear: 2023 }),
      makeResult("navigated"),
    );
    expect(f.year).toBe(2022);
    expect(f.fromYear).toBe(2022);
    expect(f.toYear).toBe(2023);
  });

  it("12. feedback omits undefined locators", () => {
    const f = buildReadingDataRepairNavigationFeedback(
      makeRequest("weread-reading-data-quality", { target: "data_quality_audit" }),
      makeResult("navigated"),
    );
    expect(f.year).toBeUndefined();
    expect(f.fromYear).toBeUndefined();
    expect(f.toYear).toBeUndefined();
  });

  it("13. feedback never exposes surfaceKey", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const json = JSON.stringify(f);
    expect(json).not.toContain("weread-reading-archive-controls");
    expect(json).not.toContain("surfaceKey");
  });

  it("14. feedback never exposes itemIndex / rank / IDs", () => {
    const f = buildReadingDataRepairNavigationFeedback(
      makeRequest("archive_book_grid:top", { target: "top_books", itemIndex: 3, rank: 2 }),
      makeResult("navigated"),
    );
    const json = JSON.stringify(f);
    expect(json).not.toMatch(/itemIndex/);
    expect(json).not.toMatch(/rank/);
    expect(json).not.toMatch(/rec[a-z0-9]{8,}/);
    expect(json).not.toMatch(/issue[a-z0-9]{8,}/);
  });

  it("15. feedback never exposes actual / expected / private fields", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-data-quality"), makeResult("navigated"));
    const json = JSON.stringify(f);
    expect(json).not.toMatch(/\bactual\b|\bexpected\b/);
    expect(json).not.toMatch(/title|author|catalogId|noteId|wereadBookId|highlightId/);
    expect(json).not.toMatch(/token|api[_-]?key/i);
  });

  it("16. feedback initiatedBy is user_click for all 4 statuses", () => {
    for (const status of ["navigated", "surface_not_found", "ambiguous_surface", "rejected_request"] as const) {
      const fb = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult(status));
      expect(fb.initiatedBy).toBe("user_click");
    }
  });

  it("17. feedback automatic=false even for rejected_request", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("rejected_request"));
    expect(f.automatic).toBe(false);
  });

  it("18. feedback executesRepair=false even for rejected", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("rejected_request"));
    expect(f.executesRepair).toBe(false);
  });

  it("19. feedback requestedNetwork=false even for rejected", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("rejected_request"));
    expect(f.requestedNetwork).toBe(false);
  });

  it("20. feedback modifiesSourceData=false even for rejected", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("rejected_request"));
    expect(f.modifiesSourceData).toBe(false);
  });

  // ---- builder immutability + determinism ----
  it("21. builder does not mutate request", () => {
    const r = makeRequest("weread-reading-archive-controls", { year: 2024 });
    const before = JSON.stringify(r);
    buildReadingDataRepairNavigationFeedback(r, makeResult("navigated"));
    expect(JSON.stringify(r)).toBe(before);
  });

  it("22. builder does not mutate result", () => {
    const er = makeResult("navigated");
    const before = JSON.stringify(er);
    buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), er);
    expect(JSON.stringify(er)).toBe(before);
  });

  it("23. builder is deterministic", () => {
    const r = makeRequest("weread-reading-archive-controls");
    const er = makeResult("navigated");
    const a = buildReadingDataRepairNavigationFeedback(r, er);
    const b = buildReadingDataRepairNavigationFeedback(r, er);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // ---- session initial ----
  it("24. initial state has all counters = 0", () => {
    const s = createInitialReadingDataRepairGuidedSession();
    expect(s.attempts).toBe(0);
    expect(s.successful).toBe(0);
    expect(s.unavailable).toBe(0);
    expect(s.ambiguous).toBe(0);
    expect(s.rejected).toBe(0);
    expect(s.lastFeedback).toBeNull();
  });

  it("25. initial state has all safety flags = false", () => {
    const s = createInitialReadingDataRepairGuidedSession();
    expect(s.persisted).toBe(false);
    expect(s.requestedNetwork).toBe(false);
    expect(s.modifiesSourceData).toBe(false);
  });

  // ---- transition ----
  it("26. success feedback increments attempts + successful", () => {
    const s0 = createInitialReadingDataRepairGuidedSession();
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const s1 = applyReadingDataRepairNavigationFeedback(s0, f);
    expect(s1.attempts).toBe(1);
    expect(s1.successful).toBe(1);
    expect(s1.unavailable).toBe(0);
    expect(s1.ambiguous).toBe(0);
    expect(s1.rejected).toBe(0);
  });

  it("27. unavailable feedback increments attempts + unavailable", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("surface_not_found"));
    const s1 = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    expect(s1.attempts).toBe(1);
    expect(s1.unavailable).toBe(1);
    expect(s1.successful).toBe(0);
  });

  it("28. ambiguous feedback increments attempts + ambiguous", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("ambiguous_surface"));
    const s1 = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    expect(s1.attempts).toBe(1);
    expect(s1.ambiguous).toBe(1);
    expect(s1.successful).toBe(0);
  });

  it("29. rejected feedback increments attempts + rejected", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("rejected_request"));
    const s1 = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    expect(s1.attempts).toBe(1);
    expect(s1.rejected).toBe(1);
    expect(s1.successful).toBe(0);
  });

  it("30. unrelated counters unchanged after each transition", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const f1 = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    s = applyReadingDataRepairNavigationFeedback(s, f1);
    expect(s.unavailable).toBe(0);
    expect(s.ambiguous).toBe(0);
    expect(s.rejected).toBe(0);
  });

  it("31. lastFeedback updated to newest feedback", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const f1 = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    s = applyReadingDataRepairNavigationFeedback(s, f1);
    expect(s.lastFeedback?.status).toBe("navigation_complete");
    const f2 = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-data-quality", { target: "data_quality_audit" }), makeResult("surface_not_found"));
    s = applyReadingDataRepairNavigationFeedback(s, f2);
    expect(s.lastFeedback?.status).toBe("surface_unavailable");
  });

  // ---- immutability ----
  it("32. transition returns NEW object (not mutates)", () => {
    const s0 = createInitialReadingDataRepairGuidedSession();
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const s1 = applyReadingDataRepairNavigationFeedback(s0, f);
    expect(s1).not.toBe(s0);
    expect(s0.attempts).toBe(0);
  });

  it("33. input feedback is not mutated", () => {
    const s0 = createInitialReadingDataRepairGuidedSession();
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const before = JSON.stringify(f);
    applyReadingDataRepairNavigationFeedback(s0, f);
    expect(JSON.stringify(f)).toBe(before);
  });

  // ---- multiple + mixed transitions ----
  it("34. multiple successes sum correctly", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    for (let i = 0; i < 5; i += 1) {
      const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
      s = applyReadingDataRepairNavigationFeedback(s, f);
    }
    expect(s.attempts).toBe(5);
    expect(s.successful).toBe(5);
  });

  it("35. mixed outcomes maintain invariant", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const outcomes: ReadingDataRepairNavigationExecutionResult["status"][] = [
      "navigated",
      "surface_not_found",
      "ambiguous_surface",
      "rejected_request",
      "navigated",
    ];
    for (const st of outcomes) {
      const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult(st));
      s = applyReadingDataRepairNavigationFeedback(s, f);
    }
    expect(s.attempts).toBe(5);
    expect(s.successful + s.unavailable + s.ambiguous + s.rejected).toBe(5);
  });

  it("36. invariant holds after every transition", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    expect(s.attempts).toBe(s.successful + s.unavailable + s.ambiguous + s.rejected);
    for (let i = 0; i < 10; i += 1) {
      const st = (["navigated", "surface_not_found", "ambiguous_surface", "rejected_request"] as const)[i % 4];
      const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult(st));
      s = applyReadingDataRepairNavigationFeedback(s, f);
      expect(s.attempts).toBe(s.successful + s.unavailable + s.ambiguous + s.rejected);
    }
  });

  // ---- summary ----
  it("37. summary attempts matches state", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const s = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    const sum = buildReadingDataRepairGuidedSessionSummary(s);
    expect(sum.attempts).toBe(1);
    expect(sum.successful).toBe(1);
  });

  it("38. summary successful matches state", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const s = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    const sum = buildReadingDataRepairGuidedSessionSummary(s);
    expect(sum.successful).toBe(1);
  });

  it("39. summary unsuccessful = unavailable + ambiguous + rejected", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    for (const st of ["surface_not_found", "ambiguous_surface", "rejected_request"] as const) {
      const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult(st));
      s = applyReadingDataRepairNavigationFeedback(s, f);
    }
    const sum = buildReadingDataRepairGuidedSessionSummary(s);
    expect(sum.unsuccessful).toBe(3);
    expect(sum.unsuccessful).toBe(sum.unavailable + sum.ambiguous + sum.rejected);
  });

  it("40. summary is safe integer (no NaN/Infinity)", () => {
    const s = createInitialReadingDataRepairGuidedSession();
    const sum = buildReadingDataRepairGuidedSessionSummary(s);
    for (const k of ["attempts", "successful", "unsuccessful", "unavailable", "ambiguous", "rejected"] as const) {
      expect(Number.isSafeInteger(sum[k])).toBe(true);
    }
  });

  // ---- reset ----
  it("41. reset clears all counters and lastFeedback", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    s = applyReadingDataRepairNavigationFeedback(s, f);
    expect(s.attempts).toBe(1);
    const r = resetReadingDataRepairGuidedSession();
    expect(r.attempts).toBe(0);
    expect(r.lastFeedback).toBeNull();
  });

  // ---- snapshot ----
  it("42. snapshot counts are correct", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const s = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    expect(snap.attempts).toBe(1);
    expect(snap.successful).toBe(1);
  });

  it("43. snapshot never includes surfaceKey", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const s = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/surfaceKey/);
    expect(json).not.toMatch(/weread-reading-archive-controls/);
  });

  it("44. snapshot never includes year / fromYear / toYear", () => {
    const f = buildReadingDataRepairNavigationFeedback(
      makeRequest("weread-reading-archive-links", { target: "year_links", year: 2022, fromYear: 2022, toYear: 2023 }),
      makeResult("navigated"),
    );
    const s = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/\byear\b/);
    expect(json).not.toMatch(/fromYear/);
    expect(json).not.toMatch(/toYear/);
  });

  it("45. snapshot never includes IDs", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    const s = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/rec[a-z0-9]{8,}/);
    expect(json).not.toMatch(/issue[a-z0-9]{8,}/);
  });

  it("46. snapshot meta has persisted=false / requestedNetwork=false / modifiesSourceData=false / automaticNavigation=false", () => {
    const s = createInitialReadingDataRepairGuidedSession();
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    const meta = snap.meta as Record<string, unknown>;
    expect(meta.persisted).toBe(false);
    expect(meta.requestedNetwork).toBe(false);
    expect(meta.modifiesSourceData).toBe(false);
    expect(meta.automaticNavigation).toBe(false);
    expect(meta.source).toBe("guided_repair_navigation_session");
  });

  it("47. snapshot only includes allowlisted keys", () => {
    const s = createInitialReadingDataRepairGuidedSession();
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    const allowed = new Set([
      "attempts",
      "successful",
      "unavailable",
      "ambiguous",
      "rejected",
      "lastFeedbackStatus",
      "lastFeedbackKind",
      "lastFeedbackTarget",
      "meta",
    ]);
    for (const key of Object.keys(snap)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  // ---- safety: source code ----
  it("48. source code does not import forbidden globals", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairGuidedSession.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bwindow\b/);
    expect(src).not.toMatch(/\bdocument\b/);
    expect(src).not.toMatch(/\bnavigator\b/);
    expect(src).not.toMatch(/HTMLElement/);
    expect(src).not.toMatch(/\bquerySelector\b/);
    expect(src).not.toMatch(/\bscrollIntoView\b/);
    expect(src).not.toMatch(/history\.|location\.|hash\b/);
    expect(src).not.toMatch(/\blocalStorage\b/);
    expect(src).not.toMatch(/\bsessionStorage\b/);
    expect(src).not.toMatch(/\bIndexedDB\b/);
    expect(src).not.toMatch(/\bfetch\b/);
    expect(src).not.toMatch(/\bXMLHttpRequest\b/);
    expect(src).not.toMatch(/\bWebSocket\b/);
    expect(src).not.toMatch(/retry\(|reload\(/);
    expect(src).not.toMatch(/Date\.now|new Date/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/crypto\.randomUUID|uuid/);
    expect(src).not.toMatch(/react/i);
    expect(src).not.toMatch(/useState|useEffect|useMemo|useReducer|useRef/);
  });

  it("49. source code does not contain evaluation language", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairGuidedSession.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/更爱阅读|兴趣增强|能力提升|能力下降|阅读质量|心理状态|人格|成长用户|退步|低谷|巅峰|用户评分|优秀|较差|健康分|风险分|用户成功|用户失败/);
  });

  it("50. source code does not contain NaN / Infinity", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairGuidedSession.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bNaN\b/);
    expect(src).not.toMatch(/\bInfinity\b/);
  });

  it("51. summary does not return Infinity for large counts", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    for (let i = 0; i < 3; i += 1) {
      const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
      s = applyReadingDataRepairNavigationFeedback(s, f);
    }
    const sum = buildReadingDataRepairGuidedSessionSummary(s);
    expect(Number.isFinite(sum.unsuccessful)).toBe(true);
    expect(sum.unsuccessful).toBe(0);
  });

  // ---- additional invariant / safety ----
  it("52. transition preserves all safety flags = false", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    s = applyReadingDataRepairNavigationFeedback(s, f);
    expect(s.persisted).toBe(false);
    expect(s.requestedNetwork).toBe(false);
    expect(s.modifiesSourceData).toBe(false);
  });

  it("53. reset does not carry over lastFeedback", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    s = applyReadingDataRepairNavigationFeedback(s, f);
    expect(s.lastFeedback).not.toBeNull();
    s = resetReadingDataRepairGuidedSession();
    expect(s.lastFeedback).toBeNull();
  });

  it("54. summary exposes all 6 expected keys", () => {
    const sum = buildReadingDataRepairGuidedSessionSummary(createInitialReadingDataRepairGuidedSession());
    expect(Object.keys(sum).sort()).toEqual(["ambiguous", "attempts", "rejected", "successful", "unavailable", "unsuccessful"].sort());
  });

  it("55. feedback can never expose raw request surfaceKey", () => {
    for (const sk of ["weread-reading-archive-controls", "weread-reading-data-quality", "archive_book_grid:recurring"]) {
      const f = buildReadingDataRepairNavigationFeedback(makeRequest(sk), makeResult("navigated"));
      expect(JSON.stringify(f)).not.toContain(sk);
    }
  });

  it("56. RUNTIME_STATUS_TO_FEEDBACK_STATUS is exhaustive", () => {
    expect(Object.keys(RUNTIME_STATUS_TO_FEEDBACK_STATUS).sort()).toEqual(
      ["ambiguous_surface", "navigated", "rejected_request", "surface_not_found"].sort(),
    );
  });

  it("57. FEEDBACK_STATUS_TO_KIND is exhaustive", () => {
    expect(Object.keys(FEEDBACK_STATUS_TO_KIND).sort()).toEqual(
      ["navigation_complete", "request_rejected", "surface_ambiguous", "surface_unavailable"].sort(),
    );
  });

  it("58. FEEDBACK_STATUS_TO_LABEL_KEY is exhaustive", () => {
    expect(Object.keys(FEEDBACK_STATUS_TO_LABEL_KEY).sort()).toEqual(
      ["navigation_complete", "request_rejected", "surface_ambiguous", "surface_unavailable"].sort(),
    );
  });

  it("59. ALL_FEEDBACK_STATUSES_INTERNAL has exactly 4 entries", () => {
    expect(ALL_FEEDBACK_STATUSES_INTERNAL.length).toBe(4);
  });

  it("60. feedback status 'warning' kinds only cover non-navigation outcomes", () => {
    expect(FEEDBACK_STATUS_TO_KIND.navigation_complete).toBe("success");
    expect(FEEDBACK_STATUS_TO_KIND.surface_unavailable).toBe("notice");
    expect(FEEDBACK_STATUS_TO_KIND.surface_ambiguous).toBe("warning");
    expect(FEEDBACK_STATUS_TO_KIND.request_rejected).toBe("warning");
  });

  it("61. feedback label keys never contain evaluation language", () => {
    expect(FEEDBACK_STATUS_TO_LABEL_KEY.navigation_complete).not.toMatch(/成功|失败|评分/);
    expect(FEEDBACK_STATUS_TO_LABEL_KEY.surface_unavailable).not.toMatch(/成功|失败|评分/);
    expect(FEEDBACK_STATUS_TO_LABEL_KEY.surface_ambiguous).not.toMatch(/成功|失败|评分/);
    expect(FEEDBACK_STATUS_TO_LABEL_KEY.request_rejected).not.toMatch(/成功|失败|评分/);
  });

  it("62. snapshot lastFeedbackStatus is null when lastFeedback is null", () => {
    const s = createInitialReadingDataRepairGuidedSession();
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    expect(snap.lastFeedbackStatus).toBeNull();
    expect(snap.lastFeedbackKind).toBeNull();
    expect(snap.lastFeedbackTarget).toBeNull();
  });

  it("63. snapshot lastFeedbackStatus updates after transition", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("surface_not_found"));
    s = applyReadingDataRepairNavigationFeedback(s, f);
    const snap = buildReadingDataRepairGuidedSessionDebugSnapshot(s);
    expect(snap.lastFeedbackStatus).toBe("surface_unavailable");
    expect(snap.lastFeedbackKind).toBe("notice");
  });

  it("64. multiple sequential transitions maintain monotonic counters", () => {
    let s = createInitialReadingDataRepairGuidedSession();
    const seq = ["navigated", "navigated", "surface_not_found", "navigated", "rejected_request"] as const;
    for (const st of seq) {
      const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult(st));
      s = applyReadingDataRepairNavigationFeedback(s, f);
    }
    expect(s.attempts).toBe(5);
    expect(s.successful).toBe(3);
    expect(s.unavailable).toBe(1);
    expect(s.rejected).toBe(1);
  });

  it("65. feedback JSON has exactly the documented keys", () => {
    const f = buildReadingDataRepairNavigationFeedback(
      makeRequest("weread-reading-archive-controls", { target: "failed_year_controls", year: 2024 }),
      makeResult("navigated"),
    );
    const keys = Object.keys(f).sort();
    expect(keys).toEqual(
      ["automatic", "executesRepair", "fromYear", "initiatedBy", "kind", "labelKey", "modifiesSourceData", "requestedNetwork", "status", "target", "toYear", "year"].sort(),
    );
  });

  it("66. feedback initiatedBy is the only initiatedBy-type string", () => {
    const f = buildReadingDataRepairNavigationFeedback(makeRequest("weread-reading-archive-controls"), makeResult("navigated"));
    expect(f.initiatedBy).toBe("user_click");
  });
});

// End of S27S-3A tests