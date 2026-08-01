import { describe, expect, it } from "vitest";
import {
  AI_SUMMARY_CLIENT_LIMITS,
  buildAiSummaryInput,
  buildAiSummaryMarkdown,
  formatAiSummaryMeta,
  getAiSummaryErrorMessage,
  hasAiSummaryContent,
  validateAiSummaryEligibility,
} from "./wereadAiSummaryModel";
import type {
  WereadAiSummaryMeta,
  WereadAiSummaryResult,
} from "../wereadPrivate";

describe("buildAiSummaryInput", () => {
  it("caps at 30 items even when more are provided", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      type: "highlight" as const,
      text: `合成笔记 ${i}。`,
      comment: null,
    }));
    expect(buildAiSummaryInput(items)).toHaveLength(30);
  });

  it("drops items with empty text AND empty comment", () => {
    const out = buildAiSummaryInput([
      { type: "highlight", text: "保留的合成笔记。", comment: null },
      { type: "thought", text: "", comment: "" },
      { type: "review", text: "   ", comment: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("保留的合成笔记。");
  });

  it("preserves comment-only items", () => {
    const out = buildAiSummaryInput([
      { type: "thought", text: "", comment: "  合成想法保留。  " },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("");
    expect(out[0].comment).toBe("合成想法保留。");
  });

  it("normalizes unknown / invalid type to 'unknown'", () => {
    const out = buildAiSummaryInput([
      { type: "garbage" as unknown as "highlight", text: "X", comment: null },
      { type: 42 as unknown as "highlight", text: "Y", comment: null },
    ]);
    expect(out.every((o) => o.type === "unknown")).toBe(true);
  });

  it("rebuilds the payload — no extra fields survive", () => {
    const out = buildAiSummaryInput([
      {
        type: "highlight",
        text: "合成笔记：边界。",
        comment: null,
        q: "secret-q",
        catalogId: "123_000000000001",
        wereadBookId: "secret-book",
        noteId: "secret-note",
        matched: true,
        title: "secret-title",
        author: "secret-author",
        createdAt: "2026-01-01T00:00:00.000Z",
      } as unknown as Parameters<typeof buildAiSummaryInput>[0][number],
    ]);
    expect(out[0]).toEqual({
      type: "highlight",
      text: "合成笔记：边界。",
      comment: null,
    });
    // The object only has 3 keys — no leakage.
    expect(Object.keys(out[0]).sort()).toEqual(["comment", "text", "type"]);
  });

  it("does not mutate the input array", () => {
    const items = [{ type: "highlight" as const, text: "a", comment: null }];
    const snapshot = JSON.parse(JSON.stringify(items));
    buildAiSummaryInput(items);
    expect(items).toEqual(snapshot);
  });

  it("ignores non-object entries", () => {
    const out = buildAiSummaryInput([
      null,
      undefined,
      "string",
      42,
      { type: "highlight", text: "保留", comment: null },
    ] as unknown as Parameters<typeof buildAiSummaryInput>[0]);
    expect(out).toHaveLength(1);
  });
});

describe("validateAiSummaryEligibility", () => {
  it("returns eligible:true for any non-empty cleaned list", () => {
    expect(
      validateAiSummaryEligibility([
        { type: "highlight", text: "合成笔记：边界。", comment: null },
      ])
    ).toEqual({ eligible: true });
  });
  it("returns eligible:false with reason when the list is empty after cleaning", () => {
    expect(
      validateAiSummaryEligibility([
        { type: "highlight", text: "", comment: "" },
      ])
    ).toEqual({ eligible: false, reason: "当前没有可整理的笔记。" });
  });
});

describe("formatAiSummaryMeta", () => {
  const meta: WereadAiSummaryMeta = {
    itemsUsed: 5,
    totalCharacters: 1234,
    persisted: false,
    provider: "minimax",
  };
  it("contains counts and the provider name", () => {
    const s = formatAiSummaryMeta(meta);
    expect(s).toContain("5");
    expect(s).toContain("1234");
    expect(s).toContain("MiniMax");
  });
});

describe("hasAiSummaryContent", () => {
  const valid: WereadAiSummaryResult = {
    overview: "合成概览。",
    themes: [{ title: "T", summary: "S", evidenceCount: 1 }],
    keyPoints: ["k"],
    reviewQuestions: [],
    readingDirections: [],
  };
  it("returns true for a fully populated result", () => {
    expect(hasAiSummaryContent(valid)).toBe(true);
  });
  it("returns false when overview is empty / whitespace", () => {
    expect(hasAiSummaryContent({ ...valid, overview: "   " })).toBe(false);
  });
  it("returns false when themes is empty", () => {
    expect(hasAiSummaryContent({ ...valid, themes: [] })).toBe(false);
  });
  it("returns false when keyPoints is empty", () => {
    expect(hasAiSummaryContent({ ...valid, keyPoints: [] })).toBe(false);
  });
  it("returns false for null", () => {
    expect(hasAiSummaryContent(null)).toBe(false);
  });
});

describe("buildAiSummaryMarkdown", () => {
  const summary: WereadAiSummaryResult = {
    overview: "合成概览文本。",
    themes: [
      { title: "主题一", summary: "主题摘要一。", evidenceCount: 2 },
      { title: "主题二", summary: "主题摘要二。", evidenceCount: 1 },
    ],
    keyPoints: ["观点 A", "观点 B"],
    reviewQuestions: ["问题一？"],
    readingDirections: ["方向一", "方向二"],
  };
  const meta: WereadAiSummaryMeta = {
    itemsUsed: 3,
    totalCharacters: 1024,
    persisted: false,
    provider: "minimax",
  };

  it("contains all four required sections", () => {
    const md = buildAiSummaryMarkdown(summary, meta);
    expect(md).toContain("## 主题概览");
    expect(md).toContain("## 主要主题");
    expect(md).toContain("## 关键观点");
    expect(md).toContain("## 待复习问题");
    expect(md).toContain("## 延伸阅读方向");
  });

  it("does not contain token, q, ids, or prompt fragments", () => {
    const md = buildAiSummaryMarkdown(summary, meta);
    for (const forbidden of [
      "WEREAD_PRIVATE_API_TOKEN",
      "wereadBookId",
      "noteId",
      "highlightId",
      "chapterTitle",
      "catalogId",
      "Bearer ",
      "Authorization",
      "prompt",
      "system message",
    ]) {
      expect(md).not.toContain(forbidden);
    }
  });

  it("passes HTML through as text — component renders as React children, not dangerouslySetInnerHTML", () => {
    // The Markdown is generated client-side and is rendered through React
    // children (no dangerouslySetInnerHTML). That means HTML tags in the
    // Markdown appear as plain text and never become executable. The test
    // asserts the Markdown includes the source string verbatim — if anyone
    // later strips or transforms the text unexpectedly, the integrity of
    // what the AI returned is preserved.
    const evil: WereadAiSummaryResult = {
      overview: "evil <script>alert(1)</script>",
      themes: [{ title: "<img onerror=1>", summary: "<b>bold</b>", evidenceCount: 1 }],
      keyPoints: ["k"],
      reviewQuestions: [],
      readingDirections: [],
    };
    const md = buildAiSummaryMarkdown(evil, meta);
    expect(md).toContain("<script>");
    expect(md).toContain("<img");
    expect(md).toContain("<b>");
  });
});

describe("getAiSummaryErrorMessage", () => {
  it("maps 401 to a friendly Chinese message", () => {
    expect(getAiSummaryErrorMessage(new Error("401 Unauthorized"))).toMatch(/Token/);
  });
  it("maps 403 / disabled to a friendly Chinese message", () => {
    expect(getAiSummaryErrorMessage(new Error("disabled"))).toMatch(/未启用/);
  });
  it("maps 429 / rate limit to a friendly Chinese message", () => {
    expect(getAiSummaryErrorMessage(new Error("429 too many requests"))).toMatch(/限流/);
  });
  it("maps timeout / aborted / 504 to a friendly Chinese message", () => {
    expect(getAiSummaryErrorMessage(new Error("aborted"))).toMatch(/超时/);
    expect(getAiSummaryErrorMessage(new Error("504 Gateway Timeout"))).toMatch(/超时/);
  });
  it("maps 502 / provider / empty / parse failures to a friendly Chinese message", () => {
    expect(getAiSummaryErrorMessage(new Error("502 provider down"))).toMatch(/不可用/);
    expect(getAiSummaryErrorMessage(new Error("无法解析"))).toMatch(/不可用/);
    expect(getAiSummaryErrorMessage(new Error("empty content"))).toMatch(/不可用/);
  });
  it("maps 413 / too-large to a friendly Chinese message", () => {
    expect(getAiSummaryErrorMessage(new Error("413 too large"))).toMatch(/过大/);
  });
  it("maps EMPTY_ITEMS / no-eligibility to a friendly Chinese message", () => {
    expect(getAiSummaryErrorMessage(new Error("至少需要 1 条"))).toMatch(/加载至少 1 条/);
  });
  it("falls back to a generic message for unknown errors", () => {
    expect(getAiSummaryErrorMessage(new Error("weird failure"))).toMatch(/失败/);
  });

  it("does NOT leak token / note text / provider raw body from the original error", () => {
    const msg = getAiSummaryErrorMessage(
      new Error("token secret-leaked-token and note text 合成秘密片段 UNIQUE_NEVER_LEAK")
    );
    expect(msg).not.toContain("secret-leaked-token");
    expect(msg).not.toContain("UNIQUE_NEVER_LEAK");
  });
});

describe("AI_SUMMARY_CLIENT_LIMITS", () => {
  it("MAX_INPUT_ITEMS matches the server limit", () => {
    expect(AI_SUMMARY_CLIENT_LIMITS.MAX_INPUT_ITEMS).toBe(30);
  });
  it("MAX_TOTAL_CHARS matches the server limit", () => {
    expect(AI_SUMMARY_CLIENT_LIMITS.MAX_TOTAL_CHARS).toBe(30_000);
  });
});