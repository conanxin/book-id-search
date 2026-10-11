import { describe, expect, it } from "vitest";
import { parseBookWebResearchTrialArgs } from "./book-web-research-live-trial.js";

const valid = ["--book-id", "10118949_000001131331", "--query", "中国古代旅行之研究", "--question", " 查找本书相关研究 "];
describe("live web-research trial input before external IO", () => {
  it("requires an exact book identity, public query and explicit question", () => {
    expect(parseBookWebResearchTrialArgs(valid)).toEqual({ bookId: valid[1], query: valid[3], question: "查找本书相关研究", outDir: "progress/book-web-research-live" });
  });
  it.each([[], valid.slice(0, 4), [...valid, "--question", "second"], [...valid, "--api-key", "not-an-accepted-argument"], [...valid, "--out"]].map(args => ({ args })))("rejects incomplete, repeated or credential-bearing options", ({ args }) => {
    expect(() => parseBookWebResearchTrialArgs(args)).toThrow("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
  });
  it("rejects oversized questions and invalid catalog identities", () => {
    expect(() => parseBookWebResearchTrialArgs([...valid.slice(0, -1), "x".repeat(1001)])).toThrow();
    expect(() => parseBookWebResearchTrialArgs(["--book-id", "not-a-catalog-id", ...valid.slice(2)])).toThrow();
  });
});
