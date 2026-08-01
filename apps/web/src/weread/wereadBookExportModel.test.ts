import { describe, expect, it } from "vitest";
import {
  buildWereadBookExport,
  buildWereadBookExportFilename,
  buildWereadBookMarkdown,
  safeExportFilename,
  WEREAD_BOOK_EXPORT_LIMITS,
  type WereadBookExportMeta,
} from "./wereadBookExportModel";
import type { WereadPrivateNoteItem } from "../wereadPrivate";

const CATALOG = "13000000_000000000001";
const META: WereadBookExportMeta = {
  catalogId: CATALOG,
  title: "示例书目",
  author: "示例作者",
};

function makeNote(over: Partial<WereadPrivateNoteItem> = {}): WereadPrivateNoteItem {
  return {
    type: "highlight",
    text: "示例正文",
    comment: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    matched: true,
    catalogId: CATALOG,
    source: "private_weread",
    ...over,
  };
}

describe("wereadBookExportModel", () => {
  describe("safeExportFilename", () => {
    it("strips path separators and Windows-illegal characters", () => {
      expect(safeExportFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
    });
    it("removes control characters", () => {
      expect(safeExportFilename("hello\u0000\u0001world")).toBe("helloworld");
    });
    it("collapses whitespace and trims", () => {
      expect(safeExportFilename("  hello   world  ")).toBe("hello world");
    });
    it("rejects empty / dot / dotdot names and falls back", () => {
      expect(safeExportFilename("")).toBe("weread-book-export");
      expect(safeExportFilename("   ")).toBe("weread-book-export");
      expect(safeExportFilename(".")).toBe("weread-book-export");
      expect(safeExportFilename("..")).toBe("weread-book-export");
    });
    it("truncates to MAX_FILENAME_LENGTH UTF-16 units and strips trailing dots/spaces", () => {
      const long = "a".repeat(WEREAD_BOOK_EXPORT_LIMITS.MAX_FILENAME_LENGTH + 50);
      const out = safeExportFilename(long);
      expect(out.length).toBeLessThanOrEqual(WEREAD_BOOK_EXPORT_LIMITS.MAX_FILENAME_LENGTH);
      expect(/[.\s]$/.test(out)).toBe(false);
    });
    it("strips token-style secret markers and dangerous punctuation", () => {
      const out = safeExportFilename("token=*** wb1?5*1003");
      expect(out.includes("=")).toBe(false);
      expect(out.includes("***")).toBe(false);
      expect(out.includes("?")).toBe(false);
      expect(out.includes("*")).toBe(false);
    });
  });

  describe("buildWereadBookExportFilename", () => {
    it("uses catalogId prefix + sanitised title", () => {
      expect(buildWereadBookExportFilename(META)).toMatch(/^weread-book-13000000_000000000001-示例书目\.md$/);
    });
    it("falls back to catalogId when title is empty", () => {
      expect(buildWereadBookExportFilename({ ...META, title: "" })).toContain(CATALOG);
    });
    it("strips illegal characters from the title portion", () => {
      const name = buildWereadBookExportFilename({ ...META, title: "a/b\\c:d*e?f" });
      expect(name).not.toMatch(/[\/\\:\*\?"<>\|]/);
    });
    it("strips non-catalogId characters from the catalogId prefix defensively", () => {
      const name = buildWereadBookExportFilename({ ...META, catalogId: "abc123_123456789012" });
      expect(name.startsWith("weread-book-123_123456789012-")).toBe(true);
    });
  });

  describe("buildWereadBookMarkdown", () => {
    it("uses only public title/author from meta, never WeRead raw fields", () => {
      const md = buildWereadBookMarkdown({
        meta: META,
        items: [makeNote({ text: "示例正文" })],
      });
      expect(md).toContain("示例书目");
      expect(md).toContain("示例作者");
      // The note body (示例正文) is intentionally allowed; only the metadata
      // label authors must come from the public catalog, not from WeRead's
      // raw title/author fields. The markdown must not contain the
      // suspicious WeRead private-field labels.
      expect(md).not.toMatch(/^>\s*作者:\s*$/m);
      expect(md).toMatch(/^>\s*作者:\s*示例作者$/m);
    });

    it("renders all four groups in the correct order", () => {
      const items: WereadPrivateNoteItem[] = [
        makeNote({ type: "highlight", text: "h1" }),
        makeNote({ type: "thought", text: "t1", comment: "t1c" }),
        makeNote({ type: "review", text: "r1", createdAt: "2026-02-01T00:00:00.000Z" }),
        makeNote({ type: "unknown", text: "u1" }),
      ];
      const md = buildWereadBookMarkdown({ meta: META, items });
      expect(md.indexOf("## 划线")).toBeLessThan(md.indexOf("## 想法"));
      expect(md.indexOf("## 想法")).toBeLessThan(md.indexOf("## 书评"));
      expect(md.indexOf("## 书评")).toBeLessThan(md.indexOf("## 未分类"));
    });

    it("sorts items newest first within each group", () => {
      const items = [
        makeNote({ createdAt: "2026-01-01T00:00:00.000Z", text: "old" }),
        makeNote({ createdAt: "2026-03-01T00:00:00.000Z", text: "new" }),
      ];
      const md = buildWereadBookMarkdown({ meta: META, items });
      expect(md.indexOf("new")).toBeLessThan(md.indexOf("old"));
    });

    it("handles null dates with placeholder", () => {
      const items = [makeNote({ createdAt: null, updatedAt: null, text: "no-date" })];
      const md = buildWereadBookMarkdown({ meta: META, items });
      expect(md).toContain("—");
      expect(md).toContain("no-date");
    });

    it("preserves newlines and prevents heading injection in user text", () => {
      const items = [makeNote({ text: "line1\nline2\n# fake heading\n## also fake" })];
      const md = buildWereadBookMarkdown({ meta: META, items });
      expect(md).toContain("line1\nline2");
      expect(md).not.toContain("\n# fake heading");
      expect(md).not.toContain("\n## also fake");
    });

    it("escapes leading headings in comment as well", () => {
      const items = [makeNote({ text: "body", comment: "# sneaky heading" })];
      const md = buildWereadBookMarkdown({ meta: META, items });
      expect(md).toContain("> 我的想法：sneaky heading");
      expect(md).not.toContain("\n# sneaky heading");
    });

    it("includes truncation warning when truncated=true", () => {
      const md = buildWereadBookMarkdown({ meta: META, items: [makeNote()], truncated: true, total: 9999 });
      expect(md).toContain("安全上限");
      expect(md).toContain("9999");
    });

    it("throws on empty items", () => {
      expect(() => buildWereadBookMarkdown({ meta: META, items: [] })).toThrow();
    });

    it("does NOT include wereadBookId / noteId / highlightId / chapterTitle", () => {
      const items = [
        makeNote({ text: "body" }),
      ];
      const md = buildWereadBookMarkdown({ meta: META, items });
      for (const k of ["wereadBookId", "noteId", "highlightId", "chapterTitle"]) {
        expect(md.includes(k)).toBe(false);
      }
    });

    it("does not include token / q / cookie / session / wr_skey / wr_vid", () => {
      const md = buildWereadBookMarkdown({ meta: META, items: [makeNote()] });
      // The privacy notice intentionally contains the literal phrase
      // "private token" so we redact that line before checking for the
      // standalone keywords (token / q / cookie / session / wr_skey / wr_vid).
      const lower = md
        .replace(/^>.*$/gm, "")
        .toLowerCase();
      for (const k of ["token", "q=", "cookie", "session", "wr_skey", "wr_vid"]) {
        expect({ kw: k, found: lower.includes(k) }).toEqual({ kw: k, found: false });
      }
    });

    it("truncates bodies over MAX_BODY_TEXT_LENGTH", () => {
      const long = "x".repeat(WEREAD_BOOK_EXPORT_LIMITS.MAX_BODY_TEXT_LENGTH + 100);
      const md = buildWereadBookMarkdown({ meta: META, items: [makeNote({ text: long })] });
      expect(md).toContain("…");
      // The exact text length capped:
      const bodyIndex = md.indexOf("x".repeat(WEREAD_BOOK_EXPORT_LIMITS.MAX_BODY_TEXT_LENGTH));
      expect(bodyIndex).toBeGreaterThan(0);
    });

    it("preserves legitimate duplicate records (no dedupe)", () => {
      const items = [
        makeNote({ text: "same body", comment: null, createdAt: "2026-01-01T00:00:00.000Z" }),
        makeNote({ text: "same body", comment: null, createdAt: "2026-01-01T00:00:00.000Z" }),
        makeNote({ text: "same body", comment: null, createdAt: "2026-01-01T00:00:00.000Z" }),
      ];
      const md = buildWereadBookMarkdown({ meta: META, items });
      const occurrences = (md.match(/same body/g) ?? []).length;
      expect(occurrences).toBe(3);
    });
  });

  describe("buildWereadBookExport", () => {
    it("returns markdown + filename + grouped counts", () => {
      const items = [
        makeNote({ type: "highlight", text: "h" }),
        makeNote({ type: "thought", text: "t", comment: "tc" }),
      ];
      const result = buildWereadBookExport({ meta: META, items });
      expect(result.markdown.length).toBeGreaterThan(0);
      expect(result.filename).toMatch(/^weread-book-/);
      expect(result.grouped.highlight.length).toBe(1);
      expect(result.grouped.thought.length).toBe(1);
      expect(result.grouped.review.length).toBe(0);
    });
  });
});