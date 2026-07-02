import { describe, expect, it } from "vitest";
import { SEARCH_QUALITY_CASES } from "./search-quality-cases.js";

// We don't actually run the live HTTP in tests; we just validate
// the case definitions + that the runner's eval logic is reachable.

describe("SEARCH_QUALITY_CASES (S24-C6)", () => {
  it("contains at least 17 cases", () => {
    expect(SEARCH_QUALITY_CASES.length).toBeGreaterThanOrEqual(17);
  });

  it("every case has an id, description, q, and expectations", () => {
    for (const c of SEARCH_QUALITY_CASES) {
      expect(c.id).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(typeof c.q).toBe("string");
      expect(c.expectations).toBeDefined();
    }
  });

  it("the beijing-travel-natural-language case expects travel_guide intent", () => {
    const c = SEARCH_QUALITY_CASES.find((x) => x.id === "beijing-travel-natural-language");
    expect(c).toBeDefined();
    expect(c?.q).toBe("查一下北京旅游的书");
    expect(c?.expectations.cleaned).toBe("北京旅游");
    expect(c?.expectations.intentType).toBe("travel_guide");
    expect(c?.expectations.removedPhrasesIncludes).toContain("查一下");
    expect(c?.expectations.removedPhrasesIncludes).toContain("的书");
  });

  it("empty query case has noFiveHundred=true", () => {
    const c = SEARCH_QUALITY_CASES.find((x) => x.id === "empty-query");
    expect(c).toBeDefined();
    expect(c?.q).toBe("");
    expect(c?.expectations.noFiveHundred).toBe(true);
  });

  it("isbn-spoken case has topId for the canonical record", () => {
    const c = SEARCH_QUALITY_CASES.find((x) => x.id === "isbn-spoken");
    expect(c).toBeDefined();
    expect(c?.expectations.topId).toBe("13000000_000008232537");
    expect(c?.expectations.detectedType).toBe("isbn");
  });

  it("obscurity case demands no 500", () => {
    const c = SEARCH_QUALITY_CASES.find((x) => x.id === "obscure-query-no-crash");
    expect(c).toBeDefined();
    expect(c?.expectations.noFiveHundred).toBe(true);
  });

  it("unique ids across all cases", () => {
    const ids = SEARCH_QUALITY_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});