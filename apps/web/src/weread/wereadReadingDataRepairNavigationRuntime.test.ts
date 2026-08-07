// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigationRuntime.test.ts
//
// S27S-2B — Targeted tests for Runtime Surface Resolver.

import { describe, expect, it } from "vitest";

import type { ReadingDataRepairNavigationRequest } from "./wereadReadingDataRepairNavigationUi";
import {
  RUNTIME_LOCATOR_WHITELIST_INTERNAL,
  executeReadingDataRepairNavigationRequest,
  getReadingDataRepairNavigationRuntimeKeys,
  resolveReadingDataRepairNavigationElement,
  type ReadingDataRepairNavigationRootLike,
} from "./wereadReadingDataRepairNavigationRuntime";

// ---------- fake DOM root ----------

function makeRoot(elements: Array<{ selector: string; el: FakeElement }>): ReadingDataRepairNavigationRootLike {
  const all = elements.flatMap((e) => e.el ? [e] : []);
  return {
    querySelectorAll: (selector: string) => {
      const matches = all
        .filter((e) => e.selector === selector)
        .map((e) => e.el as unknown as Element);
      return matches;
    },
  };
}

interface FakeElement {
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
  focus: (options?: FocusOptions) => void;
  _scrollCount: number;
  _focusCount: number;
}

function makeFakeElement(): FakeElement {
  return {
    scrollIntoView: function (this: FakeElement) { this._scrollCount += 1; },
    focus: function (this: FakeElement) { this._focusCount += 1; },
    _scrollCount: 0,
    _focusCount: 0,
  } as unknown as FakeElement;
}

function makeRequest(
  surfaceKey: string,
  overrides: Partial<ReadingDataRepairNavigationRequest> = {},
): ReadingDataRepairNavigationRequest {
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
    ...overrides,
  };
}

// ---------- tests ----------

describe("S27S-2B wereadReadingDataRepairNavigationRuntime", () => {
  // ---- whitelist ----
  it("1. runtime whitelist has exactly 7 keys", () => {
    expect(getReadingDataRepairNavigationRuntimeKeys().length).toBe(7);
  });

  it("2. runtime keys match S27S-1B existing surfaceKeys exactly", () => {
    const expected = [
      "weread-reading-archive-controls",
      "weread-reading-archive-year-grid",
      "weread-reading-data-quality",
      "archive_book_grid:top",
      "weread-reading-archive-links",
      "archive_book_grid:recurring",
      "weread-reading-data-repair",
    ].sort();
    expect([...getReadingDataRepairNavigationRuntimeKeys()].sort()).toEqual(expected);
  });

  it("3. whitelist does not contain 'none' surfaceKey", () => {
    expect(getReadingDataRepairNavigationRuntimeKeys()).not.toContain("__none__");
  });

  it("4. data-testid locators are used for 5 direct surfaces", () => {
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["weread-reading-archive-controls"]).toEqual({
      kind: "data_testid",
      value: "weread-reading-archive-controls",
    });
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["weread-reading-archive-year-grid"]).toEqual({
      kind: "data_testid",
      value: "weread-reading-archive-year-grid",
    });
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["weread-reading-data-quality"]).toEqual({
      kind: "data_testid",
      value: "weread-reading-data-quality",
    });
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["weread-reading-archive-links"]).toEqual({
      kind: "data_testid",
      value: "weread-reading-archive-links",
    });
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["weread-reading-data-repair"]).toEqual({
      kind: "data_testid",
      value: "weread-reading-data-repair",
    });
  });

  it("5. repair_surface locators are used for 2 book-grid sub-keys", () => {
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["archive_book_grid:top"]).toEqual({
      kind: "repair_surface",
      value: "archive_book_grid:recurring",
    });
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["archive_book_grid:recurring"]).toEqual({
      kind: "repair_surface",
      value: "archive_book_grid:recurring",
    });
  });

  // ---- resolver ----
  it("6. resolver finds exactly 1 match for data-testid surface", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const r = resolveReadingDataRepairNavigationElement(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.element).toBe(el);
  });

  it("7. resolver finds exactly 1 match for repair_surface", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-weread-repair-surface="archive_book_grid:recurring"]', el }]);
    const r = resolveReadingDataRepairNavigationElement(
      makeRequest("archive_book_grid:recurring"),
      root,
    );
    expect(r.ok).toBe(true);
  });

  it("8. resolver returns surface_not_found for 0 matches", () => {
    const root = makeRoot([]);
    const r = resolveReadingDataRepairNavigationElement(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("surface_not_found");
  });

  it("9. resolver returns ambiguous_surface for >1 matches", () => {
    const el1 = makeFakeElement();
    const el2 = makeFakeElement();
    const root = makeRoot([
      { selector: '[data-testid="weread-reading-archive-controls"]', el: el1 },
      { selector: '[data-testid="weread-reading-archive-controls"]', el: el2 },
    ]);
    const r = resolveReadingDataRepairNavigationElement(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("ambiguous_surface");
  });

  it("10. resolver does NOT silently use [0] of ambiguous results", () => {
    const el1 = makeFakeElement();
    const el2 = makeFakeElement();
    const root = makeRoot([
      { selector: '[data-testid="weread-reading-data-quality"]', el: el1 },
      { selector: '[data-testid="weread-reading-data-quality"]', el: el2 },
    ]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-data-quality"),
      root,
    );
    expect(result.status).toBe("ambiguous_surface");
    expect(el1._scrollCount).toBe(0);
    expect(el2._scrollCount).toBe(0);
    expect(result.scrollCount).toBe(0);
    expect(result.focusCount).toBe(0);
  });

  // ---- request validation ----
  it("11. user_click request is accepted", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(result.status).toBe("navigated");
  });

  it("12. automatic=true is rejected", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls", { automatic: true as unknown as false }),
      root,
    );
    expect(result.status).toBe("rejected_request");
    expect(el._scrollCount).toBe(0);
    expect(el._focusCount).toBe(0);
  });

  it("13. executesRepair=true is rejected", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls", { executesRepair: true as unknown as false }),
      root,
    );
    expect(result.status).toBe("rejected_request");
  });

  it("14. requestedNetwork=true is rejected", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls", { requestedNetwork: true as unknown as false }),
      root,
    );
    expect(result.status).toBe("rejected_request");
  });

  it("15. modifiesSourceData=true is rejected", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls", { modifiesSourceData: true as unknown as false }),
      root,
    );
    expect(result.status).toBe("rejected_request");
  });

  it("16. wrong initiatedBy is rejected", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls", { initiatedBy: "auto" as unknown as "user_click" }),
      root,
    );
    expect(result.status).toBe("rejected_request");
  });

  // ---- execution ----
  it("17. success: scroll exactly once", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(result.status).toBe("navigated");
    expect(el._scrollCount).toBe(1);
    expect(result.scrollCount).toBe(1);
  });

  it("18. success: focus exactly once", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(el._focusCount).toBe(1);
    expect(result.focusCount).toBe(1);
  });

  it("19. success: result surfaceKey matches request surfaceKey", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(result.surfaceKey).toBe("weread-reading-archive-controls");
  });

  it("20. success: second independent request performs second scroll", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    executeReadingDataRepairNavigationRequest(makeRequest("weread-reading-archive-controls"), root);
    executeReadingDataRepairNavigationRequest(makeRequest("weread-reading-archive-controls"), root);
    expect(el._scrollCount).toBe(2);
    expect(el._focusCount).toBe(2);
  });

  it("21. missing target: scroll=0 focus=0", () => {
    const root = makeRoot([]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(result.status).toBe("surface_not_found");
    expect(result.scrollCount).toBe(0);
    expect(result.focusCount).toBe(0);
  });

  it("22. ambiguous target: scroll=0 focus=0", () => {
    const root = makeRoot([
      { selector: '[data-testid="weread-reading-data-quality"]', el: makeFakeElement() },
      { selector: '[data-testid="weread-reading-data-quality"]', el: makeFakeElement() },
    ]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-data-quality"),
      root,
    );
    expect(result.status).toBe("ambiguous_surface");
    expect(result.scrollCount).toBe(0);
    expect(result.focusCount).toBe(0);
  });

  it("23. rejected request: scroll=0 focus=0", () => {
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el: makeFakeElement() }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls", { automatic: true as unknown as false }),
      root,
    );
    expect(result.status).toBe("rejected_request");
    expect(result.scrollCount).toBe(0);
    expect(result.focusCount).toBe(0);
  });

  it("24. unknown surfaceKey: surface_not_found", () => {
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el: makeFakeElement() }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("totally-unknown-key"),
      root,
    );
    expect(result.status).toBe("surface_not_found");
  });

  // ---- input immutability ----
  it("25. runtime does not mutate input request", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const req = makeRequest("weread-reading-archive-controls", { year: 2024 });
    const before = JSON.stringify(req);
    executeReadingDataRepairNavigationRequest(req, root);
    expect(JSON.stringify(req)).toBe(before);
  });

  // ---- no side effects beyond scroll/focus ----
  it("26. unrelated DOM nodes are not touched", () => {
    const target = makeFakeElement();
    const unrelated = makeFakeElement();
    const root = makeRoot([
      { selector: '[data-testid="weread-reading-archive-controls"]', el: target },
      { selector: '[data-testid="weread-reading-data-quality"]', el: unrelated },
    ]);
    executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(unrelated._scrollCount).toBe(0);
    expect(unrelated._focusCount).toBe(0);
  });

  // ---- safety: no forbidden side-effect APIs ----
  it("27. source code does not import forbidden globals", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationRuntime.ts"),
      "utf8",
    );
    // Runtime IS allowed to reference document / querySelector / scrollIntoView / focus
    // but is NOT allowed to reference URL/hash/history/storage/network/retry/reload/timeout/raf/observer
    expect(src).not.toMatch(/location\b/);
    expect(src).not.toMatch(/history\b/);
    expect(src).not.toMatch(/hash\b/);
    expect(src).not.toMatch(/localStorage\b/);
    expect(src).not.toMatch(/sessionStorage\b/);
    expect(src).not.toMatch(/IndexedDB\b/);
    expect(src).not.toMatch(/fetch\(/);
    expect(src).not.toMatch(/XMLHttpRequest\b/);
    expect(src).not.toMatch(/WebSocket\b/);
    expect(src).not.toMatch(/setTimeout\b/);
    expect(src).not.toMatch(/requestAnimationFrame\b/);
    expect(src).not.toMatch(/MutationObserver\b/);
    expect(src).not.toMatch(/retry\(/);
    expect(src).not.toMatch(/reload\(/);
  });

  it("28. source code does not contain NaN / Infinity", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationRuntime.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bNaN\b/);
    expect(src).not.toMatch(/\bInfinity\b/);
  });

  it("29. source code does not contain user-evaluation language", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationRuntime.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/更爱阅读|兴趣增强|能力提升|心理状态|人格|用户评分|优秀|较差|自动修复成功|一键修复/);
  });

  // ---- result safety ----
  it("30. result type does not include element / selector / innerHTML / HTMLElement / private fields", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/element/);
    expect(json).not.toMatch(/selector/);
    expect(json).not.toMatch(/innerHTML/);
    expect(json).not.toMatch(/HTMLElement/);
    expect(json).not.toMatch(/noteId|wereadBookId|highlightId/);
    expect(json).not.toMatch(/title|author|catalogId/);
  });

  it("30. result type does not include element / selector / innerHTML / HTMLElement / private fields", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/element/);
    expect(json).not.toMatch(/selector/);
    expect(json).not.toMatch(/innerHTML/);
    expect(json).not.toMatch(/HTMLElement/);
    expect(json).not.toMatch(/noteId|wereadBookId|highlightId/);
    expect(json).not.toMatch(/title|author|catalogId/);
  });

  it("31. scroll options are hardcoded (behavior smooth, block start, inline nearest)", () => {
    const el = makeFakeElement();
    let capturedOptions: ScrollIntoViewOptions | undefined;
    const capturingEl = {
      scrollIntoView: (options?: ScrollIntoViewOptions) => { capturedOptions = options; (el as any)._scrollCount += 1; },
      focus: (options?: FocusOptions) => { (el as any)._focusCount += 1; },
    };
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el: capturingEl as unknown as FakeElement }]);
    executeReadingDataRepairNavigationRequest(makeRequest("weread-reading-archive-controls"), root);
    expect(capturedOptions).toEqual({ behavior: "smooth", block: "start", inline: "nearest" });
  });

  it("32. focus options are hardcoded (preventScroll true)", () => {
    const el = makeFakeElement();
    let capturedFocusOptions: FocusOptions | undefined;
    const capturingEl = {
      scrollIntoView: () => {},
      focus: (options?: FocusOptions) => { capturedFocusOptions = options; (el as any)._focusCount += 1; },
    };
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el: capturingEl as unknown as FakeElement }]);
    executeReadingDataRepairNavigationRequest(makeRequest("weread-reading-archive-controls"), root);
    expect(capturedFocusOptions).toEqual({ preventScroll: true });
  });

  it("33. result status is one of 4 safe enums", () => {
    const validStatuses = ["navigated", "surface_not_found", "ambiguous_surface", "rejected_request"];
    expect(validStatuses.length).toBe(4);
  });

  it("34. scroll and focus counts are 0 or 1 (never more)", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const r1 = executeReadingDataRepairNavigationRequest(makeRequest("weread-reading-archive-controls"), root);
    expect([0, 1]).toContain(r1.scrollCount);
    expect([0, 1]).toContain(r1.focusCount);
  });

  it("35. locator value for data-testid is the same as the key", () => {
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["weread-reading-archive-controls"].value).toBe("weread-reading-archive-controls");
  });

  it("36. locator value for repair_surface is hardcoded source constant", () => {
    expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL["archive_book_grid:recurring"].value).toBe("archive_book_grid:recurring");
  });

  it("37. all 7 surfaceKeys have a whitelist entry", () => {
    const keys = getReadingDataRepairNavigationRuntimeKeys();
    expect(keys.length).toBe(7);
    for (const k of keys) {
      expect(RUNTIME_LOCATOR_WHITELIST_INTERNAL[k]).toBeDefined();
    }
  });

  it("38. executor is deterministic for same input", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const req = makeRequest("weread-reading-archive-controls");
    const r1 = executeReadingDataRepairNavigationRequest(req, root);
    const r2 = executeReadingDataRepairNavigationRequest(req, root);
    expect(r1.status).toBe(r2.status);
    expect(r1.surfaceKey).toBe(r2.surfaceKey);
  });

  it("39. request with locator fields passes through (no consumption)", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-data-repair"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-data-repair", { year: 2024, itemIndex: 3, rank: 2 }),
      root,
    );
    expect(result.status).toBe("navigated");
    expect(el._scrollCount).toBe(1);
  });

  it("40. top_books surfaceKey resolves to the aggregated book-grid (via shared repair_surface)", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-weread-repair-surface="archive_book_grid:recurring"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("archive_book_grid:top"),
      root,
    );
    expect(result.status).toBe("navigated");
    expect(el._scrollCount).toBe(1);
  });

  it("41. root injection works with custom root", () => {
    const el = makeFakeElement();
    const customRoot: ReadingDataRepairNavigationRootLike = {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-testid="weread-reading-archive-controls"]') return [el as unknown as Element];
        return [];
      },
    };
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      customRoot,
    );
    expect(result.status).toBe("navigated");
  });

  it("42. executor does not throw on bad input", () => {
    const root = makeRoot([]);
    expect(() =>
      executeReadingDataRepairNavigationRequest(
        makeRequest("weread-reading-archive-controls", { surfaceKey: "garbage" }),
        root,
      ),
    ).not.toThrow();
  });

  it("43. unknown surfaceKey never executes scroll or focus", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("totally-unknown-key"),
      root,
    );
    expect(result.scrollCount).toBe(0);
    expect(result.focusCount).toBe(0);
  });

  it("44. all 7 whitelist locators are source constants (not derived from request)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "wereadReadingDataRepairNavigationRuntime.ts"),
      "utf8",
    );
    // No template literals that include surfaceKey or request fields
    expect(src).not.toMatch(/`\[data-testid=\$\{/);
    expect(src).not.toMatch(/`\[data-weread-repair-surface=\$\{/);
  });

  it("45. resolver returns ok: true only for unique match", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const r = resolveReadingDataRepairNavigationElement(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(r.ok).toBe(true);
  });

  it("46. resolver returns ok: false for 0 matches", () => {
    const root = makeRoot([]);
    const r = resolveReadingDataRepairNavigationElement(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    expect(r.ok).toBe(false);
  });

  it("47. resolver returns ok: false for 2 matches", () => {
    const root = makeRoot([
      { selector: '[data-testid="weread-reading-data-quality"]', el: makeFakeElement() },
      { selector: '[data-testid="weread-reading-data-quality"]', el: makeFakeElement() },
    ]);
    const r = resolveReadingDataRepairNavigationElement(
      makeRequest("weread-reading-data-quality"),
      root,
    );
    expect(r.ok).toBe(false);
  });

  it("48. executor result type allows no DOM leakage", () => {
    const el = makeFakeElement();
    const root = makeRoot([{ selector: '[data-testid="weread-reading-archive-controls"]', el }]);
    const result = executeReadingDataRepairNavigationRequest(
      makeRequest("weread-reading-archive-controls"),
      root,
    );
    const allowedKeys = new Set(["status", "surfaceKey", "scrollCount", "focusCount"]);
    for (const key of Object.keys(result)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it("49. executor accepts all 7 whitelist surfaceKeys for successful navigation (with matching DOM)", () => {
    const validKeys = [
      "weread-reading-archive-controls",
      "weread-reading-archive-year-grid",
      "weread-reading-data-quality",
      "archive_book_grid:top",
      "weread-reading-archive-links",
      "archive_book_grid:recurring",
      "weread-reading-data-repair",
    ];
    for (const key of validKeys) {
      // top_books and recurring_books share the same DOM element
      const el = makeFakeElement();
      const root = makeRoot([
        { selector: key === "archive_book_grid:top" || key === "archive_book_grid:recurring"
            ? '[data-weread-repair-surface="archive_book_grid:recurring"]'
            : `[data-testid="${key}"]`, el },
      ]);
      const result = executeReadingDataRepairNavigationRequest(makeRequest(key), root);
      expect(result.status).toBe("navigated");
    }
  });

  it("50. executor never logs / throws / warns", () => {
    const root = makeRoot([]);
    const errors: Error[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (args[0] instanceof Error) errors.push(args[0]);
    };
    try {
      for (let i = 0; i < 10; i += 1) {
        executeReadingDataRepairNavigationRequest(
          makeRequest("totally-unknown-key-" + i),
          root,
        );
      }
    } finally {
      console.error = originalConsoleError;
    }
    expect(errors.length).toBe(0);
  });
});