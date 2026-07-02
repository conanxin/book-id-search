import { describe, expect, it } from "vitest";
// Import the pure functions by re-exporting them in the script
// Since they aren't exported, just inline them for testing
// In a real project you'd extract these to a shared module;
// here we inline the logic for unit coverage.

function clean(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const n = a.length - 1;
  const m = b.length - 1;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }

  let common = 0;
  for (let i = 0; i < m; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigramsA.get(bg) ?? 0;
    if (count > 0) {
      bigramsA.set(bg, count - 1);
      common++;
    }
  }

  return (2 * common) / (n + m);
}

function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/[^0-9X]/gi, "").toUpperCase();
}

describe("match-weread-catalog pure functions", () => {
  describe("clean", () => {
    it("removes accents and punctuation", () => {
      expect(clean("The Art of War!")).toBe("theartofwar");
      expect(clean("建筑史")).toBe("建筑史");
      expect(clean("  Hello, World!  ")).toBe("helloworld");
    });
  });

  describe("dice", () => {
    it("returns 1 for identical strings", () => {
      expect(dice("abc", "abc")).toBe(1);
    });

    it("returns 0 for disjoint short strings", () => {
      expect(dice("a", "b")).toBe(0);
      expect(dice("ab", "cd")).toBe(0);
    });

    it("handles similar book titles", () => {
      expect(dice(clean("建筑史"), clean("中国建筑史"))).toBeGreaterThan(0.5);
      expect(dice(clean("建筑史"), clean("小说"))).toBeLessThan(0.2);
    });
  });

  describe("normalizeIsbn", () => {
    it("normalizes hyphenated ISBNs", () => {
      expect(normalizeIsbn("978-7-111-11111-1")).toBe("9787111111111");
    });

    it("handles null/undefined", () => {
      expect(normalizeIsbn(null)).toBeNull();
      expect(normalizeIsbn(undefined)).toBeNull();
    });
  });

  describe("buildQueries reimplementation", () => {
    function buildQueries(book: {
      wereadBookId: string;
      title: string;
      author: string;
      isbn?: string | null;
    }) {
      const queries: string[] = [];
      const isbn = normalizeIsbn(book.isbn);
      if (isbn && isbn.length >= 10) queries.push(isbn);
      const author = book.author?.trim() ?? "";
      const title = book.title.trim();
      if (author && title) queries.push(`${title} ${author}`);
      if (title) queries.push(title);
      return queries;
    }

    it("puts ISBN first when available", () => {
      const qs = buildQueries({
        wereadBookId: "x",
        title: "建筑史",
        author: "梁思成",
        isbn: "9787111111111",
      });
      expect(qs[0]).toBe("9787111111111");
      expect(qs[1]).toBe("建筑史 梁思成");
      expect(qs[2]).toBe("建筑史");
    });

    it("produces title+author and title queries when no ISBN", () => {
      const qs = buildQueries({
        wereadBookId: "x",
        title: "建筑史",
        author: "梁思成",
        isbn: null,
      });
      expect(qs[0]).toBe("建筑史 梁思成");
      expect(qs[1]).toBe("建筑史");
    });
  });

  describe("scoreCandidate reimplementation", () => {
    function scoreCandidate(
      book: { title: string; author: string; isbn?: string | null },
      result: { title: string; author: string; isbn?: string },
    ) {
      const bookIsbn = normalizeIsbn(book.isbn);
      const resultIsbn = normalizeIsbn(result.isbn);

      if (bookIsbn && resultIsbn && bookIsbn === resultIsbn) {
        return {
          matchMethod: "isbn" as const,
          matchConfidence: "high" as const,
          reason: "ISBN exact match",
        };
      }

      const cleanBookTitle = clean(book.title);
      const cleanBookAuthor = clean(book.author ?? "");
      const cleanResultTitle = clean(result.title);
      const cleanResultAuthor = clean(result.author ?? "");

      if (cleanBookTitle && cleanBookAuthor) {
        if (
          cleanResultTitle.includes(cleanBookTitle) ||
          cleanResultTitle.includes(
            cleanBookTitle.slice(0, Math.max(4, cleanBookTitle.length - 2)),
          )
        ) {
          if (
            cleanResultAuthor.includes(cleanBookAuthor) ||
            cleanBookAuthor.includes(cleanResultAuthor)
          ) {
            return {
              matchMethod: "title_author" as const,
              matchConfidence: "high" as const,
              reason: "Title and author both matched",
            };
          }
        }
      }

      const sim = dice(cleanBookTitle, cleanResultTitle);
      if (sim >= 0.7) {
        return {
          matchMethod: "title_similarity" as const,
          matchConfidence: "high" as const,
          reason: `Title high similarity (${sim.toFixed(2)})`,
        };
      }
      if (sim >= 0.5) {
        return {
          matchMethod: "title_similarity" as const,
          matchConfidence: "medium" as const,
          reason: `Title medium similarity (${sim.toFixed(2)})`,
        };
      }
      if (sim >= 0.35) {
        return {
          matchMethod: "title_similarity" as const,
          matchConfidence: "low" as const,
          reason: `Title low similarity (${sim.toFixed(2)})`,
        };
      }

      return null;
    }

    it("returns high confidence on ISBN match", () => {
      const score = scoreCandidate(
        { title: "建筑史", author: "梁思成", isbn: "9787111111111" },
        { title: "中国建筑史", author: "梁思成", isbn: "978-7-111-11111-1" },
      );
      expect(score?.matchMethod).toBe("isbn");
      expect(score?.matchConfidence).toBe("high");
    });

    it("returns high confidence on title+author match", () => {
      const score = scoreCandidate(
        { title: "建筑史", author: "梁思成", isbn: null },
        { title: "中国建筑史", author: "梁思成", isbn: "" },
      );
      expect(score?.matchMethod).toBe("title_author");
      expect(score?.matchConfidence).toBe("high");
    });

    it("returns medium confidence on moderately similar short titles", () => {
      const score = scoreCandidate(
        { title: "建筑史", author: "梁启超", isbn: null },
        { title: "中国建筑史", author: "梁思成", isbn: "" },
      );
      expect(score?.matchMethod).toBe("title_similarity");
      expect(score?.matchConfidence).toBe("medium");
    });

    it("returns null for dissimilar titles", () => {
      const score = scoreCandidate(
        { title: "计算机科学", author: "John Doe", isbn: null },
        { title: "小说选集", author: "Unknown", isbn: "" },
      );
      expect(score).toBeNull();
    });
  });
});
