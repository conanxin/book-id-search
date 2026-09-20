import { describe, expect, it } from "vitest";
import {
  InvalidRediscoverInputError,
  buildNoteExcerpt,
  readMembershipBookIds,
} from "./rediscover.js";

describe("readMembershipBookIds", () => {
  it("accepts empty input and deduplicates while preserving first occurrence", () => {
    expect(readMembershipBookIds({ bookIds: [] })).toEqual([]);
    expect(readMembershipBookIds({ bookIds: ["a", "b", "a"] })).toEqual(["a", "b"]);
  });

  it.each([
    null,
    {},
    { bookIds: "a" },
    { bookIds: [""] },
    { bookIds: ["   "] },
    { bookIds: [1] },
    { bookIds: Array.from({ length: 101 }, (_, i) => `book-${i}`) },
  ])("rejects malformed input %#", (input) => {
    expect(() => readMembershipBookIds(input)).toThrow(InvalidRediscoverInputError);
  });
});

describe("buildNoteExcerpt", () => {
  it("normalizes line endings and Unicode whitespace without changing code-point semantics", () => {
    expect(buildNoteExcerpt("  A\r\n\tB\r　C  ")).toBe("A B C");
  });

  it("keeps exactly 240 code points and adds ellipsis only when truncated", () => {
    const exact = "𠀀".repeat(240);
    expect(Array.from(buildNoteExcerpt(exact))).toHaveLength(240);
    expect(buildNoteExcerpt(exact)).toBe(exact);

    const long = exact + "终";
    const excerpt = buildNoteExcerpt(long);
    expect(Array.from(excerpt.slice(0, -1))).toHaveLength(240);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
