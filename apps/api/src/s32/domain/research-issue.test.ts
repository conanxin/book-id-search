import { describe, expect, it } from "vitest";
import {
  InvalidIdempotencyKeyError,
  InvalidResearchIssueInputError,
  buildResearchIssueQuestionExcerpt,
  hashResearchIssueCreateRequest,
  readIdempotencyKey,
  readResearchIssueId,
  readResearchIssueInput,
} from "./research-issue.js";

describe("research issue domain", () => {
  it("normalizes canonical title and question input", () => {
    expect(readResearchIssueInput({
      title: "  刘祥店迁出时间  ",
      question: "  第一行\r\n第二行\r第三行  ",
      lifecycleState: "ARCHIVED",
    })).toEqual({
      title: "刘祥店迁出时间",
      question: "第一行\n第二行\n第三行",
    });
  });

  it.each([
    null,
    [],
    "question",
    {},
    { title: "", question: "q" },
    { title: "   ", question: "q" },
    { title: "title", question: " \r\n " },
    { title: "line\nbreak", question: "q" },
    { title: "line\rbreak", question: "q" },
    { title: 1, question: "q" },
    { title: "title", question: 1 },
    { title: "𠮷".repeat(161), question: "q" },
    { title: "title", question: "𠮷".repeat(4001) },
  ])("rejects invalid input %#", (input) => {
    expect(() => readResearchIssueInput(input)).toThrow(InvalidResearchIssueInputError);
  });

  it("counts supplementary-plane characters as one code point", () => {
    expect(readResearchIssueInput({ title: "𠮷".repeat(160), question: "𠮷".repeat(4000) }))
      .toEqual({ title: "𠮷".repeat(160), question: "𠮷".repeat(4000) });
  });

  it("normalizes identifiers and rejects malformed UUIDs", () => {
    expect(readResearchIssueId("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(readIdempotencyKey("BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"))
      .toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(() => readResearchIssueId("not-a-uuid")).toThrow(InvalidResearchIssueInputError);
    expect(() => readIdempotencyKey("not-a-uuid")).toThrow(InvalidIdempotencyKeyError);
  });

  it("builds a whitespace-normalized code-point-limited excerpt", () => {
    expect(buildResearchIssueQuestionExcerpt("  第一行\r\n\t第二行  ")).toBe("第一行 第二行");
    const exact = "𠮷".repeat(160);
    expect(buildResearchIssueQuestionExcerpt(exact)).toBe(exact);
    expect(buildResearchIssueQuestionExcerpt(`${exact}甲`)).toBe(`${exact}…`);
  });

  it("hashes the fixed-order normalized canonical request deterministically", () => {
    const input = readResearchIssueInput({
      title: " 刘祥店迁出时间 ",
      question: " 第一行\r\n第二行 ",
    });
    const hashA = hashResearchIssueCreateRequest("11111111-1111-4111-8111-111111111111", input);
    const hashB = hashResearchIssueCreateRequest("11111111-1111-4111-8111-111111111111", {
      title: "刘祥店迁出时间",
      question: "第一行\n第二行",
    });
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });
});

it("uses Unicode White_Space for NEL edges and excerpts", () => {
  expect(readResearchIssueInput({ title: "\u0085标题\u0085", question: "\u0085第一段\u0085第二段\u0085" }))
    .toEqual({ title: "标题", question: "第一段\u0085第二段" });
  expect(buildResearchIssueQuestionExcerpt("\u0085第一段\u0085第二段\u0085")).toBe("第一段 第二段");
});
