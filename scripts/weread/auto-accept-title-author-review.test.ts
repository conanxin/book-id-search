import { describe, expect, it } from "vitest";
import {
  authorMatches,
  isAmbiguousTopCandidates,
  isValidCatalogId,
  isValidCatalogCandidate,
  normalizeAuthor,
  normalizeTitle,
  shouldAutoAcceptTitleAuthor,
  titleMatches,
} from "./auto-accept-title-author-review.js";
import type { ReviewItem } from "./auto-accept-title-author-review.js";

function makeItem(
  status: ReviewItem["status"],
  opts: {
    wereadTitle?: string;
    wereadAuthor?: string;
    topMethod?: "title_author" | "title_similarity" | "isbn";
    topConfidence?: "high" | "medium" | "low";
    topTitle?: string;
    topAuthor?: string;
    secondMethod?: "title_author" | "title_similarity" | "isbn";
    secondConfidence?: "high" | "medium" | "low";
    secondTitle?: string;
    secondAuthor?: string;
    selectedCatalogId?: string | null;
  },
): ReviewItem {
  const cands: ReviewItem["candidates"] = [];
  const topMethod = opts.topMethod ?? "title_author";
  if (topMethod) {
    cands.push({
      catalogId: "cat-1",
      ssid: "ssid-1",
      dxid: "dxid-1",
      isbn: "9780000000000",
      title: opts.topTitle ?? "Matching Title",
      author: opts.topAuthor ?? "Author Name",
      matchMethod: topMethod as "title_author" | "title_similarity" | "isbn",
      matchConfidence: opts.topConfidence ?? "high",
      reason: "test",
    });
  }
  if (opts.secondMethod) {
    cands.push({
      catalogId: "cat-2",
      ssid: "ssid-2",
      dxid: "dxid-2",
      isbn: "9780000000001",
      title: opts.secondTitle ?? "Matching Title",
      author: opts.secondAuthor ?? "Author Name",
      matchMethod: opts.secondMethod,
      matchConfidence: opts.secondConfidence ?? "high",
      reason: "test",
    });
  }
  return {
    reviewId: "r-1",
    wereadBookId: "wb-1",
    wereadTitle: opts.wereadTitle ?? "Matching Title",
    wereadAuthor: opts.wereadAuthor ?? "Author Name",
    status,
    decisionSource: "manual",
    selectedCatalogId: opts.selectedCatalogId ?? null,
    selectedCandidateIndex: null,
    confidence: "high",
    reason: "test",
    candidates: cands,
    notes: "",
  };
}

describe("normalization", () => {
  it("strips book title punctuation and brackets", () => {
    expect(normalizeTitle("《遥远的星辰》")).toBe("遥远的星辰");
    expect(normalizeTitle("白板：")).toBe("白板");
    expect(normalizeTitle("无限的网 草间弥生自传")).toBe("无限的网草间弥生自传");
  });

  it("strips author suffixes", () => {
    expect(normalizeAuthor("罗贝托·波拉尼奥著；张慧玲译")).toBe("罗贝托波拉尼奥");
    expect(normalizeAuthor("[美]史蒂芬·平克")).toBe("美史蒂芬平克");
  });
});

describe("titleMatches", () => {
  it("accepts exact normalized titles", () => {
    expect(titleMatches("遥远的星辰", "遥远的星辰")).toBe(true);
  });
  it("accepts bracket-normalized titles", () => {
    expect(titleMatches("遥远的星辰", "《遥远的星辰》")).toBe(true);
  });
  it("accepts one as prefix with length ratio >= 0.9", () => {
    expect(titleMatches("abcdefghijklmnopqrstuvwxy", "abcdefghijklmnopqrstuvwxyz")).toBe(true);
  });
  it("rejects short mismatch", () => {
    expect(titleMatches("遥远的星辰", "遥远的")).toBe(false);
  });
  it("rejects different title", () => {
    expect(titleMatches("原则", "技术与文明")).toBe(false);
  });
});

describe("authorMatches", () => {
  it("accepts exact author", () => {
    expect(authorMatches("罗贝托·波拉尼奥", "（智利）罗贝托·波拉尼奥著；张慧玲译")).toBe(true);
  });
  it("accepts contained author", () => {
    expect(authorMatches("瑞·达利欧", "（美）瑞·达利欧（Ray Dalio）")).toBe(true);
  });
  it("rejects unrelated author", () => {
    expect(authorMatches("罗贝托·波拉尼奥", "刘易斯·芒福德")).toBe(false);
  });
});

describe("shouldAutoAcceptTitleAuthor", () => {
  it("accepts exact title_author high", () => {
    const item = makeItem("pending", {
      wereadTitle: "遥远的星辰",
      wereadAuthor: "罗贝托·波拉尼奥",
      topTitle: "遥远的星辰",
      topAuthor: "（智利）罗贝托·波拉尼奥著；张慧玲译",
    });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(true);
  });

  it("accepts punctuation-normalized title_author high", () => {
    const item = makeItem("pending", {
      wereadTitle: "技术与文明",
      wereadAuthor: "[美]刘易斯·芒福德",
      topTitle: "技术与文明",
      topAuthor: "（美）刘易斯·芒福德著；陈允明，王克仁，李华山译",
    });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(true);
  });

  it("skips title_similarity", () => {
    const item = makeItem("pending", { topMethod: "title_similarity" });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(false);
  });

  it("skips medium title_author", () => {
    const item = makeItem("pending", { topConfidence: "medium" });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(false);
  });

  it("skips ambiguous two high candidates", () => {
    const item = makeItem("pending", {
      wereadTitle: "遥远的星辰",
      topTitle: "遥远的星辰",
      secondMethod: "title_author",
      secondConfidence: "high",
      secondTitle: "遥远的星辰",
      secondAuthor: "Another Author",
    });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(false);
  });

  it("skips title mismatch", () => {
    const item = makeItem("pending", {
      wereadTitle: "遥远的星辰",
      topTitle: "原则",
    });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(false);
  });

  it("skips author mismatch", () => {
    const item = makeItem("pending", {
      wereadAuthor: "罗贝托·波拉尼奥",
      topAuthor: "刘易斯·芒福德",
    });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(false);
  });

  it("skips already accepted", () => {
    const item = makeItem("accepted", { selectedCatalogId: "existing" });
    expect(shouldAutoAcceptTitleAuthor(item)).toBe(false);
  });
});

describe("isAmbiguousTopCandidates", () => {
  it("true when top two high title_author have identical normalized title", () => {
    const item = makeItem("pending", {
      wereadTitle: "遥远的星辰",
      topTitle: "遥远的星辰",
      secondMethod: "title_author",
      secondConfidence: "high",
      secondTitle: "遥远的星辰",
      secondAuthor: "Other Author",
    });
    expect(isAmbiguousTopCandidates(item)).toBe(true);
  });

  it("false when second is medium", () => {
    const item = makeItem("pending", {
      secondMethod: "title_author",
      secondConfidence: "medium",
      secondTitle: "遥远的星辰",
    });
    expect(isAmbiguousTopCandidates(item)).toBe(false);
  });
});
