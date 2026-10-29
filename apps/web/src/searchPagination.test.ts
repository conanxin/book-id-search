import { describe, expect, it } from "vitest";
import { getSearchBrowseScope, SEARCH_BROWSABLE_RESULTS_CAP } from "./searchPagination";

describe("public search browse boundary", () => {
  it("documents the verified production maxTotalHits=1000 contract", () => {
    expect(SEARCH_BROWSABLE_RESULTS_CAP).toBe(1000);
  });

  it("does not invent pages for zero results", () => {
    expect(getSearchBrowseScope(0, 20, 1)).toEqual({
      reportedTotal: 0, browsableTotal: 0, totalPages: 1, truncated: false, outOfRange: false,
    });
  });

  it("preserves small searches without a browse warning", () => {
    expect(getSearchBrowseScope(200, 20, 10)).toMatchObject({
      browsableTotal: 200, totalPages: 10, truncated: false, outOfRange: false,
    });
    expect(getSearchBrowseScope(200, 20, 11).outOfRange).toBe(true);
  });

  it("shows 36,730 estimated matches but only 50 browsable pages (limit=20)", () => {
    expect(getSearchBrowseScope(36730, 20, 50)).toMatchObject({
      reportedTotal: 36730, browsableTotal: 1000,
      totalPages: 50, truncated: true, outOfRange: false,
    });
    expect(getSearchBrowseScope(36730, 20, 51).outOfRange).toBe(true);
  });

  it("limits page=250 for limit=4, refusing page=251", () => {
    expect(getSearchBrowseScope(36730, 4, 250).outOfRange).toBe(false);
    expect(getSearchBrowseScope(36730, 4, 251)).toMatchObject({
      reportedTotal: 36730, totalPages: 250, outOfRange: true,
    });
  });

  it("handles partial last pages for uncommon page sizes", () => {
    expect(getSearchBrowseScope(36730, 25, 40).totalPages).toBe(40);
    expect(getSearchBrowseScope(36730, 33, 31).totalPages).toBe(31);
    expect(getSearchBrowseScope(999, 33, 31)).toMatchObject({
      totalPages: 31, truncated: false, outOfRange: false,
    });
  });

  it("respects an explicitly verified index cap after a future backend change", () => {
    expect(getSearchBrowseScope(36730, 20, 60, 1200)).toMatchObject({
      totalPages: 60, browsableTotal: 1200, truncated: true, outOfRange: false,
    });
    expect(getSearchBrowseScope(36730, 20, 61, 1200).outOfRange).toBe(true);
  });

  it("does not create unlimited pagination from malformed inputs", () => {
    const value = getSearchBrowseScope(Infinity, Number.NaN, -1);
    expect(value).toMatchObject({ reportedTotal: 0, totalPages: 1, outOfRange: false });
    expect(getSearchBrowseScope(-10, 0, 0).totalPages).toBe(1);
    expect(getSearchBrowseScope(36730, 20, 1, -100).totalPages).toBe(50);
  });
});
