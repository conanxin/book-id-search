import { describe, expect, it } from "vitest";
import { cleanNaturalLanguageQuery } from "./query-cleanup.js";

describe("cleanNaturalLanguageQuery (S24-1)", () => {
  describe("identifier queries are returned untouched", () => {
    it("ISBN-13 (978-7-5384-5525-0) is preserved as-is", () => {
      const r = cleanNaturalLanguageQuery("978-7-5384-5525-0", "isbn");
      expect(r.cleaned).toBe("978-7-5384-5525-0");
      expect(r.removedPhrases).toEqual([]);
      expect(r.changed).toBe(false);
      expect(r.cleanupConfidence).toBe("none");
    });

    it("SSID (13000000) is preserved as-is", () => {
      const r = cleanNaturalLanguageQuery("13000000", "ssid");
      expect(r.cleaned).toBe("13000000");
      expect(r.removedPhrases).toEqual([]);
      expect(r.changed).toBe(false);
    });

    it("DXID (000008232537) is preserved as-is", () => {
      const r = cleanNaturalLanguageQuery("000008232537", "dxid");
      expect(r.cleaned).toBe("000008232537");
      expect(r.removedPhrases).toEqual([]);
      expect(r.changed).toBe(false);
    });

    it("ISBN-10 (7300000000) is preserved as-is", () => {
      const r = cleanNaturalLanguageQuery("7300000000", "isbn");
      expect(r.cleaned).toBe("7300000000");
      expect(r.removedPhrases).toEqual([]);
      expect(r.changed).toBe(false);
    });
  });

  describe("operation phrases are stripped", () => {
    it("'查一下北京旅游的书' -> '北京旅游'", () => {
      const r = cleanNaturalLanguageQuery("查一下北京旅游的书", "text");
      expect(r.cleaned).toBe("北京旅游");
      expect(r.removedPhrases).toContain("查一下");
      expect(r.removedPhrases).toContain("的书");
      expect(r.changed).toBe(true);
      expect(r.cleanupConfidence).not.toBe("none");
    });

    it("'帮我找一本鲁迅相关图书' -> '鲁迅'", () => {
      const r = cleanNaturalLanguageQuery("帮我找一本鲁迅相关图书", "text");
      expect(r.cleaned).toBe("鲁迅");
      expect(r.removedPhrases).toContain("帮我找一本");
      expect(r.removedPhrases).toContain("相关图书");
    });

    it("'有没有关于辽代佛塔的书' -> '辽代佛塔'", () => {
      const r = cleanNaturalLanguageQuery("有没有关于辽代佛塔的书", "text");
      expect(r.cleaned).toBe("辽代佛塔");
      expect(r.removedPhrases).toContain("有没有");
      expect(r.removedPhrases).toContain("关于");
      expect(r.removedPhrases).toContain("的书");
    });

    it("longest match wins: '帮我找一本' is preferred over '帮我找'", () => {
      const r = cleanNaturalLanguageQuery("帮我找一本披肩书", "text");
      expect(r.cleaned).toBe("披肩");
      // Either '帮我找一本' or '帮我找' should be in removedPhrases
      // (longest-first sort), but the result cleaned string is what
      // matters.
      expect(r.removedPhrases.some((p) => p.startsWith("帮我"))).toBe(true);
    });

    it("'请帮我查一下这本汉语词典' -> '汉语词典'", () => {
      const r = cleanNaturalLanguageQuery("请帮我查一下这本汉语词典", "text");
      expect(r.cleaned).toBe("汉语词典");
    });

    it("'想找一本北京旅游指南' -> '北京旅游指南'", () => {
      const r = cleanNaturalLanguageQuery("想找一本北京旅游指南", "text");
      expect(r.cleaned).toBe("北京旅游指南");
    });
  });

  describe("generic book nouns are stripped", () => {
    it("strips 的书", () => {
      const r = cleanNaturalLanguageQuery("披肩的书", "text");
      expect(r.cleaned).toBe("披肩");
      expect(r.removedPhrases).toContain("的书");
    });

    it("strips 资料", () => {
      const r = cleanNaturalLanguageQuery("辽代佛塔资料", "text");
      expect(r.cleaned).toBe("辽代佛塔");
    });

    it("strips 推荐", () => {
      const r = cleanNaturalLanguageQuery("鲁迅文集推荐", "text");
      expect(r.cleaned).toBe("鲁迅文集");
    });

    it("strips multiple generic nouns in one pass", () => {
      const r = cleanNaturalLanguageQuery("披肩这类书推荐", "text");
      expect(r.cleaned).toBe("披肩");
      expect(r.removedPhrases).toContain("这类");
    });
  });

  describe("entity preservation", () => {
    it("does not delete the leading '查' of a real title", () => {
      // The whole string is the title and there is no operation
      // phrase wrapper. The single character "查" should not be
      // eaten because we don't strip single chars.
      const r = cleanNaturalLanguageQuery("查斯特菲尔德伯爵家训", "text");
      expect(r.cleaned).toBe("查斯特菲尔德伯爵家训");
    });

    it("preserves entity words inside a wrapped query", () => {
      const r = cleanNaturalLanguageQuery("查一下查斯特菲尔德的书", "text");
      // "查一下" is the operation, but the title starts with "查" —
      // we must keep that "查".
      expect(r.cleaned).toBe("查斯特菲尔德");
    });

    it("preserves multi-character author names", () => {
      const r = cleanNaturalLanguageQuery("帮我找一本鲁迅的书", "text");
      expect(r.cleaned).toBe("鲁迅");
    });
  });

  describe("whitespace and edge cases", () => {
    it("empty string returns cleaned=''", () => {
      const r = cleanNaturalLanguageQuery("", "text");
      expect(r.cleaned).toBe("");
      expect(r.removedPhrases).toEqual([]);
      expect(r.changed).toBe(false);
    });

    it("whitespace-only returns cleaned=''", () => {
      const r = cleanNaturalLanguageQuery("   ", "text");
      expect(r.cleaned).toBe("");
    });

    it("compressed whitespace stays compressed", () => {
      const r = cleanNaturalLanguageQuery("  北京   旅游  ", "text");
      expect(r.cleaned).toBe("北京 旅游");
    });

    it("cleanup-everything falls back to trimmed original", () => {
      // Pure operation phrase with no subject. We don't want to
      // return an empty page; the user gets the original back.
      const r = cleanNaturalLanguageQuery("查一下", "text");
      expect(r.cleaned).toBe("查一下");
    });

    it("numeric query (year) is treated as text and not eaten", () => {
      const r = cleanNaturalLanguageQuery("2024", "numeric");
      expect(r.cleaned).toBe("2024");
    });
  });

  describe("confidence bucket", () => {
    it("'none' when nothing was removed", () => {
      const r = cleanNaturalLanguageQuery("北京旅游指南", "text");
      expect(r.changed).toBe(false);
      expect(r.cleanupConfidence).toBe("none");
    });

    it("'high' when 60%+ of original was removed", () => {
      const r = cleanNaturalLanguageQuery("请帮我查一下这本书的推荐", "text");
      // 60%+ stripped (only "推荐" remains, and "推荐" is in
      // GENERIC_BOOK_NOUNS so it gets stripped too — at which
      // point the cleanup-everything fallback returns the trimmed
      // original. To assert 'high' we need *some* residue. Use a
      // longer input.)
      const r2 = cleanNaturalLanguageQuery("请帮我查一下这本辽代建筑研究的资料", "text");
      // Should keep "辽代建筑研究" after stripping.
      expect(r2.cleaned).toBe("辽代建筑研究");
      // Original "请帮我查一下这本辽代建筑研究的资料" = 17 chars.
      // "辽代建筑研究" = 6 chars. Removed = 11 / 17 = 65% → high.
      expect(r2.cleanupConfidence).toBe("high");
      // Suppress the unused r warning.
      void r;
    });
  });
});
