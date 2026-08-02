import { describe, expect, it } from "vitest";

import {
  buildRelatedBookExclusions,
  buildRelatedBookSeeds,
  formatRelatedBookMeta,
  getRelatedBookReason,
  mergeRelatedBookResults,
  validateRelatedBookEligibility,
  WEREAD_RELATED_BOOKS_UI_LIMITS,
} from "./wereadRelatedBooksModel";
import type {
  WereadAiSummaryResult,
  WereadRelatedBookItem,
  WereadPrivateNoteItem,
} from "../wereadPrivate";

function makeSummary(overrides: Partial<WereadAiSummaryResult> = {}): WereadAiSummaryResult {
  return {
    overview: "",
    themes: [],
    keyPoints: [],
    reviewQuestions: [],
    readingDirections: [],
    ...overrides,
  };
}

describe("WEREAD_RELATED_BOOKS_UI_LIMITS", () => {
  it("exposes the documented UI-level cap values", () => {
    expect(WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEEDS).toBe(6);
    expect(WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEED_CHARS).toBe(80);
    expect(WEREAD_RELATED_BOOKS_UI_LIMITS.MIN_THEMES_PRIORITISED).toBe(2);
  });
});

describe("buildRelatedBookSeeds", () => {
  it("1) uses themes as the primary source", () => {
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        themes: [
          { title: "合成主题 A", summary: "synthetic", evidenceCount: 1 },
          { title: "合成主题 B", summary: "synthetic", evidenceCount: 1 },
        ],
        readingDirections: ["fallback direction"],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.seeds.map((s) => s.id)).toEqual(["theme-0", "theme-1"]);
    expect(result.seeds.every((s) => !s.text.startsWith("fallback"))).toBe(true);
  });

  it("2) appends readingDirections only when fewer than 2 themes are available", () => {
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        themes: [{ title: "唯一合成主题", summary: "synthetic", evidenceCount: 1 }],
        readingDirections: ["合成方向 A", "合成方向 B"],
      }),
    });
    expect(result.ok).toBe(true);
    // 1 theme + 2 directions → all are appended; the cap is MAX_SEEDS=6.
    expect(result.seeds.map((s) => s.id)).toEqual([
      "theme-0",
      "direction-0",
      "direction-1",
    ]);
  });

  it("3) caps at MAX_SEEDS (6)", () => {
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        themes: Array.from({ length: 10 }, (_, i) => ({
          title: `合成主题 ${i}`,
          summary: "synthetic",
          evidenceCount: 1,
        })),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.seeds).toHaveLength(6);
    expect(result.seeds[5].id).toBe("theme-5");
  });

  it("4) clamps seed.text to MAX_SEED_CHARS (80)", () => {
    const long = "合".repeat(200);
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        themes: [{ title: long, summary: "synthetic", evidenceCount: 1 }],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.seeds[0].text.length).toBeLessThanOrEqual(WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEED_CHARS);
  });

  it("5) dedupes near-identical theme titles", () => {
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        themes: [
          { title: "  合成主题  ", summary: "synthetic", evidenceCount: 1 },
          { title: "合成主题", summary: "synthetic", evidenceCount: 1 },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.seeds).toHaveLength(1);
    expect(result.seeds[0].text).toBe("合成主题");
  });

  it("6) returns ok=false when there is no summary", () => {
    const result = buildRelatedBookSeeds({ summary: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("returns ok=false when the summary is empty", () => {
    const result = buildRelatedBookSeeds({ summary: makeSummary() });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("does NOT include overview / keyPoints / questions as seeds", () => {
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        overview: "绝不应当出现在种子中的合成主题全文",
        themes: [],
        keyPoints: ["绝不能成为种子的合成关键观点 X", "关键观点 Y"],
        reviewQuestions: ["绝不能成为种子的合成问题"],
        readingDirections: ["允许作为合成的方向 A"],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.seeds).toHaveLength(1);
    expect(result.seeds[0].text).toBe("允许作为合成的方向 A");
  });

  it("never emits note text as a seed", () => {
    const fakeNoteText = "绝不能成为种子的合成笔记正文片段";
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        themes: [{ title: fakeNoteText, summary: "synthetic", evidenceCount: 1 }],
      }),
    });
    expect(result.ok).toBe(true);
    // The whole fake note becomes the seed text — never echoed in q or notes.
    expect(JSON.stringify(result.seeds)).not.toContain("q");
    expect(JSON.stringify(result.seeds).includes(fakeNoteText)).toBe(true);
  });
});

describe("buildRelatedBookExclusions", () => {
  it("collects non-empty catalogIds and caps at 100", () => {
    const notes: WereadPrivateNoteItem[] = [];
    for (let i = 0; i < 120; i++) {
      notes.push({
        type: "highlight",
        text: `合成-${i}`,
        comment: null,
        createdAt: null,
        updatedAt: null,
        matched: true,
        catalogId:
          i < 100 ? `13000000_${String(i).padStart(12, "0")}` : null,
        source: "private_weread",
      });
    }
    const out = buildRelatedBookExclusions(notes);
    expect(out).toHaveLength(100);
  });

  it("8) dedupes duplicate catalogIds", () => {
    const notes: WereadPrivateNoteItem[] = [
      {
        type: "highlight",
        text: "synthetic",
        comment: null,
        createdAt: null,
        updatedAt: null,
        matched: true,
        catalogId: "13000000_000000000001",
        source: "private_weread",
      },
      {
        type: "thought",
        text: "synthetic 2",
        comment: null,
        createdAt: null,
        updatedAt: null,
        matched: true,
        catalogId: "13000000_000000000001",
        source: "private_weread",
      },
    ];
    const out = buildRelatedBookExclusions(notes);
    expect(out).toEqual(["13000000_000000000001"]);
  });

  it("ignores malformed catalogIds", () => {
    const notes: WereadPrivateNoteItem[] = [
      {
        type: "highlight",
        text: "synthetic",
        comment: null,
        createdAt: null,
        updatedAt: null,
        matched: true,
        catalogId: "bad",
        source: "private_weread",
      },
    ];
    expect(buildRelatedBookExclusions(notes)).toEqual([]);
  });
});

describe("validateRelatedBookEligibility", () => {
  it("returns not eligible when summary is missing", () => {
    const out = validateRelatedBookEligibility({ summary: null, itemsCount: 1 });
    expect(out.eligible).toBe(false);
  });

  it("returns not eligible when no notes are loaded", () => {
    const out = validateRelatedBookEligibility({
      summary: makeSummary({ themes: [{ title: "synthetic", summary: "x", evidenceCount: 1 }] }),
      itemsCount: 0,
    });
    expect(out.eligible).toBe(false);
  });

  it("returns eligible when summary has themes and notes are loaded", () => {
    const out = validateRelatedBookEligibility({
      summary: makeSummary({ themes: [{ title: "synthetic", summary: "x", evidenceCount: 1 }] }),
      itemsCount: 5,
    });
    expect(out.eligible).toBe(true);
  });
});

describe("formatRelatedBookMeta", () => {
  it("renders counts only (no theme text leakage)", () => {
    const out = formatRelatedBookMeta({
      seedsUsed: 2,
      candidatesConsidered: 12,
      returned: 6,
      excluded: 0,
    });
    expect(out).toBe("种子 2 / 候选 12 / 返回 6");
  });
});

describe("getRelatedBookReason", () => {
  it("9) maps matched seed ids to readable theme titles", () => {
    const summary = makeSummary({
      themes: [
        { title: "合成主题甲", summary: "synthetic", evidenceCount: 1 },
        { title: "合成主题乙", summary: "synthetic", evidenceCount: 1 },
      ],
    });
    const item: WereadRelatedBookItem = {
      catalogId: "13000000_000000000001",
      title: "合成书名",
      matchedSeedIds: ["theme-0", "theme-1"],
    };
    const out = getRelatedBookReason(item, summary);
    expect(out).toContain("合成主题甲");
    expect(out).toContain("合成主题乙");
  });

  it("falls back to a generic reason when ids do not match", () => {
    const out = getRelatedBookReason(
      { catalogId: "13000000_000000000001", title: "x", matchedSeedIds: [] },
      makeSummary()
    );
    expect(out).toBe("命中主题候选");
  });
});

describe("mergeRelatedBookResults", () => {
  it("merges new items avoiding duplicate catalogIds", () => {
    const a: WereadRelatedBookItem[] = [
      { catalogId: "13000000_000000000001", title: "A", matchedSeedIds: [] },
    ];
    const b: WereadRelatedBookItem[] = [
      { catalogId: "13000000_000000000001", title: "A (dup)", matchedSeedIds: [] },
      { catalogId: "13000000_000000000002", title: "B", matchedSeedIds: [] },
    ];
    const merged = mergeRelatedBookResults(a, b);
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe("A");
  });
});

describe("privacy redaction smoke", () => {
  it("10) does not include overview / keyPoints / notes / q / token / private IDs in seeds", () => {
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        overview: "LEAK_OVERVIEW_PRIVATE",
        keyPoints: ["LEAK_KEYPOINT_PRIVATE"],
        reviewQuestions: ["LEAK_QUESTION_PRIVATE"],
        // Use a non-leaky theme title so the assertion can detect a real leak
        // through the *other* fields, not by chaining off the theme text.
        themes: [{ title: "合成主题", summary: "synthetic", evidenceCount: 1 }],
      }),
    });
    const serialized = JSON.stringify(result.seeds);
    expect(serialized).not.toContain("LEAK_OVERVIEW_PRIVATE");
    expect(serialized).not.toContain("LEAK_KEYPOINT_PRIVATE");
    expect(serialized).not.toContain("LEAK_QUESTION_PRIVATE");
    expect(serialized).not.toMatch(/\bq\b/);
    expect(serialized).not.toContain("LEAK-private-note-text");
  });

  it("11) does not include private ids in the seeds payload", () => {
    const result = buildRelatedBookSeeds({
      summary: makeSummary({
        themes: [
          {
            title: "合成主题-private-id-test",
            summary: "synthetic",
            evidenceCount: 1,
          },
        ],
      }),
    });
    const serialized = JSON.stringify(result.seeds);
    expect(serialized).not.toMatch(/wereadBookId|noteId|highlightId|chapterTitle/);
    expect(serialized).not.toMatch(/[0-9]+_[0-9]{12}/);
  });
});
