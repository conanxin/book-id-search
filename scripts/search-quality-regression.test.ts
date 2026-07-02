import { describe, expect, it } from "vitest";
import {
  bump,
  buildMarkdown,
  evalCase,
  overallStatus,
  parseArgs,
  type CaseResult,
  type Report,
} from "./search-quality-regression.js";
import type { SearchQualityCase } from "./search-quality-cases.js";

describe("search-quality-regression CLI (S25B)", () => {
  describe("parseArgs", () => {
    it("returns default publicUrl when no args", () => {
      const r = parseArgs([]);
      expect(r.publicUrl).toBe("https://books.conanxin.com");
      expect(r.json).toBeUndefined();
      expect(r.markdown).toBeUndefined();
    });

    it("reads --public-url", () => {
      const r = parseArgs(["--public-url", "https://example.test"]);
      expect(r.publicUrl).toBe("https://example.test");
    });

    it("reads --json path", () => {
      const r = parseArgs(["--json", "/tmp/foo.json"]);
      expect(r.json).toBe("/tmp/foo.json");
    });

    it("reads --markdown path", () => {
      const r = parseArgs(["--markdown", "/tmp/foo.md"]);
      expect(r.markdown).toBe("/tmp/foo.md");
    });

    it("reads all flags together", () => {
      const r = parseArgs([
        "--public-url",
        "https://x.test",
        "--json",
        "/tmp/x.json",
        "--markdown",
        "/tmp/x.md",
      ]);
      expect(r.publicUrl).toBe("https://x.test");
      expect(r.json).toBe("/tmp/x.json");
      expect(r.markdown).toBe("/tmp/x.md");
    });

    it("ignores flag with no value (no NPE)", () => {
      const r = parseArgs(["--public-url"]);
      expect(r.publicUrl).toBe("https://books.conanxin.com");
    });
  });

  describe("bump", () => {
    it("PASS + WARN -> WARN", () => {
      expect(bump("PASS", "WARN")).toBe("WARN");
    });
    it("PASS + FAIL -> FAIL", () => {
      expect(bump("PASS", "FAIL")).toBe("FAIL");
    });
    it("WARN + FAIL -> FAIL", () => {
      expect(bump("WARN", "FAIL")).toBe("FAIL");
    });
    it("WARN + WARN -> WARN", () => {
      expect(bump("WARN", "WARN")).toBe("WARN");
    });
    it("FAIL + WARN -> FAIL (FAIL is sticky)", () => {
      expect(bump("FAIL", "WARN")).toBe("FAIL");
    });
  });

  describe("overallStatus", () => {
    it("all PASS -> PASS", () => {
      const cases: CaseResult[] = [
        { caseId: "a", description: "", q: "", status: "PASS", topTitles: [], topIds: [], notes: [] },
        { caseId: "b", description: "", q: "", status: "PASS", topTitles: [], topIds: [], notes: [] },
      ];
      expect(overallStatus(cases)).toBe("PASS");
    });
    it("any WARN, no FAIL -> WARN", () => {
      const cases: CaseResult[] = [
        { caseId: "a", description: "", q: "", status: "PASS", topTitles: [], topIds: [], notes: [] },
        { caseId: "b", description: "", q: "", status: "WARN", topTitles: [], topIds: [], notes: [] },
      ];
      expect(overallStatus(cases)).toBe("WARN");
    });
    it("any FAIL -> FAIL (FAIL trumps WARN)", () => {
      const cases: CaseResult[] = [
        { caseId: "a", description: "", q: "", status: "WARN", topTitles: [], topIds: [], notes: [] },
        { caseId: "b", description: "", q: "", status: "FAIL", topTitles: [], topIds: [], notes: [] },
      ];
      expect(overallStatus(cases)).toBe("FAIL");
    });
  });

  describe("evalCase", () => {
    it("network error -> FAIL", () => {
      const c: SearchQualityCase = {
        id: "t",
        description: "",
        q: "x",
        expectations: { noFiveHundred: true },
      };
      const r = evalCase(c, { status: 0, body: null, error: "ECONNREFUSED" });
      expect(r.status).toBe("FAIL");
      expect(r.error).toBe("ECONNREFUSED");
    });

    it("500 on noFiveHundred case -> FAIL", () => {
      const c: SearchQualityCase = {
        id: "t",
        description: "",
        q: "x",
        expectations: { noFiveHundred: true },
      };
      // Body must be present for the function to reach the
      // status-code branch (network error path returns early).
      const dummyBody = {
        query: "x",
        queryInfo: {
          original: "x",
          normalized: "x",
          cleaned: "x",
          detectedType: "text",
          cleanupApplied: false,
          removedPhrases: [],
          intentType: "general",
          intentLabel: "通用",
        },
        page: 1,
        limit: 10,
        total: 0,
        items: [],
      };
      const r = evalCase(c, { status: 500, body: dummyBody });
      expect(r.status).toBe("FAIL");
      expect(r.notes.some((n) => n.includes("500"))).toBe(true);
    });

    it("PASS body matches all expectations", () => {
      const c: SearchQualityCase = {
        id: "isbn-test",
        description: "",
        q: "9787538455250",
        expectations: {
          detectedType: "isbn",
          topId: "13000000_000008232537",
        },
      };
      const r = evalCase(c, {
        status: 200,
        body: {
          query: "9787538455250",
          queryInfo: {
            original: "9787538455250",
            normalized: "9787538455250",
            cleaned: "9787538455250",
            detectedType: "isbn",
            cleanupApplied: false,
            removedPhrases: [],
            intentType: "general",
            intentLabel: "通用",
          },
          page: 1,
          limit: 10,
          total: 1,
          items: [
            { id: "13000000_000008232537", title: "时尚秋冬披肩、吊带", match: { type: "exact", label: "ISBN 精确匹配" } },
          ],
        },
      });
      expect(r.status).toBe("PASS");
    });

    it("missing topId -> FAIL", () => {
      const c: SearchQualityCase = {
        id: "t",
        description: "",
        q: "x",
        expectations: { topId: "000000000000" },
      };
      const r = evalCase(c, {
        status: 200,
        body: {
          query: "x",
          queryInfo: {
            original: "x",
            normalized: "x",
            cleaned: "x",
            detectedType: "text",
            cleanupApplied: false,
            removedPhrases: [],
            intentType: "general",
            intentLabel: "通用",
          },
          page: 1,
          limit: 10,
          total: 0,
          items: [],
        },
      });
      expect(r.status).toBe("FAIL");
      expect(r.notes.some((n) => n.includes("topIds missing"))).toBe(true);
    });

    it("intent miss is WARN, not FAIL", () => {
      const c: SearchQualityCase = {
        id: "t",
        description: "",
        q: "x",
        expectations: { intentType: "academic_research" },
      };
      const r = evalCase(c, {
        status: 200,
        body: {
          query: "x",
          queryInfo: {
            original: "x",
            normalized: "x",
            cleaned: "x",
            detectedType: "text",
            cleanupApplied: false,
            removedPhrases: [],
            intentType: "general",
            intentLabel: "通用",
          },
          page: 1,
          limit: 10,
          total: 0,
          items: [],
        },
      });
      expect(r.status).toBe("WARN");
    });

    it("topResultsShouldContainAnyTerms miss -> WARN", () => {
      const c: SearchQualityCase = {
        id: "t",
        description: "",
        q: "x",
        expectations: { topResultsShouldContainAnyTerms: ["佛塔", "辽"] },
      };
      const r = evalCase(c, {
        status: 200,
        body: {
          query: "x",
          queryInfo: {
            original: "x",
            normalized: "x",
            cleaned: "x",
            detectedType: "text",
            cleanupApplied: false,
            removedPhrases: [],
            intentType: "general",
            intentLabel: "通用",
          },
          page: 1,
          limit: 10,
          total: 1,
          items: [{ id: "x_1", title: "完全不相关的书" }],
        },
      });
      expect(r.status).toBe("WARN");
    });

    it("topResultsShouldNotInclude hit -> FAIL", () => {
      const c: SearchQualityCase = {
        id: "t",
        description: "",
        q: "x",
        expectations: { topResultsShouldNotInclude: ["查斯特菲尔德伯爵家训"] },
      };
      const r = evalCase(c, {
        status: 200,
        body: {
          query: "x",
          queryInfo: {
            original: "x",
            normalized: "x",
            cleaned: "x",
            detectedType: "text",
            cleanupApplied: false,
            removedPhrases: [],
            intentType: "general",
            intentLabel: "通用",
          },
          page: 1,
          limit: 10,
          total: 1,
          items: [{ id: "x_1", title: "查斯特菲尔德伯爵家训" }],
        },
      });
      expect(r.status).toBe("FAIL");
    });
  });

  describe("buildMarkdown", () => {
    it("includes overall status, totals, and per-case sections", () => {
      const report: Report = {
        startedAt: "2026-07-02T00:00:00Z",
        finishedAt: "2026-07-02T00:00:01Z",
        publicUrl: "https://books.conanxin.com",
        totals: { pass: 1, warn: 1, fail: 0, total: 2 },
        cases: [
          { caseId: "a", description: "test a", q: "a", status: "PASS", topTitles: ["A"], topIds: ["id1"], notes: [] },
          { caseId: "b", description: "test b", q: "b", status: "WARN", topTitles: [], topIds: [], notes: ["near miss"] },
        ],
      };
      const md = buildMarkdown(report);
      expect(md).toContain("**WARN**");
      expect(md).toContain("1 PASS / 1 WARN / 0 FAIL / 2 total");
      expect(md).toContain("## a — PASS");
      expect(md).toContain("## b — WARN");
      expect(md).toContain("near miss");
    });
  });
});
