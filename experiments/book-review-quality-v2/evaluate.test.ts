import { describe, expect, it, vi } from "vitest";
import { compareCandidates } from "./evaluate.js";

const data = () => ({
  schemaVersion: 1, baselineCommit: "ce420a3c010b4a6bf1b261df374baf1d1cd85ef7",
  books: { book: { title: "A Work", author: "Some Author", isbn: "" } },
  cases: [
    { id: "review", bookKey: "book", origin: "page_excerpt", label: "yes",
      source: { title: "A Work", excerpt: "Some Author. Review by A Reader.", url: "https://example.test/review" } },
    { id: "catalog", bookKey: "book", origin: "page_excerpt", label: "no",
      source: { title: "A Work", excerpt: "Some Author.", url: "https://example.test/catalog" } },
    { id: "unknown", bookKey: "book", origin: "page_excerpt", label: "uncertain",
      source: { title: "A Work: Book Review", excerpt: "Some Author.", url: "https://example.test/unknown" } },
    { id: "constructed", bookKey: "book", origin: "synthetic", label: "yes",
      source: { title: "A Work: review", excerpt: "Some Author.", url: "https://example.test/constructed" } },
  ].map(row => ({ ...row, editionStatus: "unresolved", labelReason: "Fixture annotation.",
    humanReview: "pending", assessor: "assistant" })),
});
describe("frozen baseline and current candidate comparison", () => {
  it("keeps baseline/current confusion counts separate and excludes uncertain labels", () => {
    const report = compareCandidates(data());
    expect(report.observed.baseline).toMatchObject({ tp: 0, fn: 1, tn: 1, excluded: 1, precision: null });
    expect(report.observed.candidate).toMatchObject({ tp: 1, fn: 0, tn: 1, excluded: 1, precision: 1 });
    expect(report.synthetic.candidate).toMatchObject({ total: 1, tp: 1 });
    expect(report.rows[0].candidate.evidence.edition.isbnText).toBe("unavailable");
  });
  it("is deterministic and read-only, and does not invoke network APIs", () => {
    const input = data(), before = JSON.stringify(input);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("NETWORK_FORBIDDEN"));
    try {
      expect(compareCandidates(input)).toEqual(compareCandidates(input));
      expect(JSON.stringify(input)).toBe(before);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("does not turn a whole-page positive label into missing input genre evidence", () => {
    const input = data();
    input.cases[0].source.excerpt = "Some Author.";
    const report = compareCandidates(input);
    expect(report.rows[0].candidate).toMatchObject({ admitted: false, verdict: "FN",
      evidence: { genre: { reviewTextSeen: false } } });
  });
  it("rejects fake human approval and invalid labels instead of scoring them", () => {
    const input = data();
    input.cases[0].humanReview = "verified";
    expect(() => compareCandidates(input)).toThrow("INVALID_CASE");
    input.cases[0].humanReview = "pending"; input.cases[0].label = "maybe";
    expect(() => compareCandidates(input)).toThrow("INVALID_CASE");
  });
});
