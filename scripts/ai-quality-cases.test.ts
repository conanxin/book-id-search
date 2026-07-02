import { describe, it, expect } from "vitest";
import {
  searchIntentCases,
  bookInsightCases,
  FORBIDDEN_FULL_CONTENT_PHRASES,
  DEFAULT_MAX_AI_CALLS,
} from "./ai-quality-cases.js";

describe("ai-quality-cases.ts", () => {
  it("search-intent has at least 6 cases", () => {
    expect(searchIntentCases.length).toBeGreaterThanOrEqual(6);
  });

  it("book-insight has at least 3 cases (including not-found logic-only)", () => {
    expect(bookInsightCases.length).toBeGreaterThanOrEqual(3);
    const ids = bookInsightCases.map((c) => c.id);
    expect(ids).toContain("insight-not-found");
  });

  it("insight-weak-missing-isbn is live and asserts missing ISBN", () => {
    const c = bookInsightCases.find((x) => x.id === "insight-weak-missing-isbn");
    expect(c).toBeDefined();
    expect(c?.live).toBe(true);
    expect(c?.expected.mustMentionMissingIsbn).toBe(true);
    expect(c?.expected.trustLevelNotHigh).toBe(true);
    expect(c?.expected.shouldNotInventIsbn).toBe(true);
  });

  it("insight-not-found is logic-only (live: false) and expects 404", () => {
    const c = bookInsightCases.find((x) => x.id === "insight-not-found");
    expect(c).toBeDefined();
    expect(c?.live).toBe(false);
    expect(c?.expected.expectedStatus).toBe(404);
    expect(c?.expected.shouldNot500).toBe(true);
  });

  it("cases are well-formed: no secret-looking strings", () => {
    const dump = JSON.stringify({ searchIntentCases, bookInsightCases });
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });

  it("no live case ID is duplicated", () => {
    const ids = [...searchIntentCases, ...bookInsightCases].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("insight-complete-book asserts no forbidden claims + scope + basis fields", () => {
    const c = bookInsightCases.find((x) => x.id === "insight-complete-book");
    expect(c).toBeDefined();
    expect(c?.expected.mustHaveScopeNote).toBe(true);
    expect(c?.expected.mustHaveSubjectTags).toBe(true);
    expect(c?.expected.mustHaveCaveats).toBe(true);
    expect(c?.expected.forbiddenClaims).toBeDefined();
    expect((c?.expected.forbiddenClaims ?? []).length).toBeGreaterThan(0);
    expect(c?.expected.requiredBasisFields).toContain("title");
    expect(c?.expected.requiredBasisFields).toContain("isbn");
  });

  it("low-confidence-weird-query must not 500 and allows empty", () => {
    const c = searchIntentCases.find((x) => x.id === "low-confidence-weird-query");
    expect(c).toBeDefined();
    expect(c?.expected.shouldNot500).toBe(true);
    expect(c?.expected.allowEmpty).toBe(true);
  });

  it("FORBIDDEN_FULL_CONTENT_PHRASES contains canonical phrases", () => {
    expect(FORBIDDEN_FULL_CONTENT_PHRASES).toContain("本书详细介绍");
    expect(FORBIDDEN_FULL_CONTENT_PHRASES).toContain("读者评价");
    expect(FORBIDDEN_FULL_CONTENT_PHRASES).toContain("作者生平");
    // Bare 全文 / 内容 are deliberately NOT in the list to avoid corrupting
    // legitimate caveats like "非全文内容".
    expect(FORBIDDEN_FULL_CONTENT_PHRASES).not.toContain("全文");
    expect(FORBIDDEN_FULL_CONTENT_PHRASES).not.toContain("内容");
  });

  it("DEFAULT_MAX_AI_CALLS is 10", () => {
    expect(DEFAULT_MAX_AI_CALLS).toBe(10);
  });
});
