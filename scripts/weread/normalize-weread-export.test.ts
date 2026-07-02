import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyFileRole,
  inferNoteType,
  normalizeBook,
  normalizeIsbn,
  normalizeNote,
  normalizeProgress,
  normalizeStatus,
} from "./normalize-weread-export.ts";

describe("normalize-weread-export pure helpers", () => {
  describe("normalizeProgress", () => {
    it("keeps 0..100 values as integers", () => {
      expect(normalizeProgress(0)).toBe(0);
      expect(normalizeProgress(50)).toBe(50);
      expect(normalizeProgress(100)).toBe(100);
      expect(normalizeProgress(33.7)).toBe(34);
    });

    it("scales 0..1 to 0..100", () => {
      expect(normalizeProgress(0)).toBe(0);
      expect(normalizeProgress(0.5)).toBe(50);
      expect(normalizeProgress(0.42)).toBe(42);
      expect(normalizeProgress(1)).toBe(100);
    });

    it("clamps out-of-range values", () => {
      expect(normalizeProgress(-5)).toBe(0);
      expect(normalizeProgress(150)).toBe(100);
    });

    it("returns null for null input", () => {
      expect(normalizeProgress(null)).toBeNull();
    });
  });

  describe("normalizeStatus", () => {
    it("maps raw status strings to S26A enum", () => {
      expect(normalizeStatus("reading")).toBe("reading");
      expect(normalizeStatus("finished")).toBe("finished");
      expect(normalizeStatus("abandoned")).toBe("abandoned");
      expect(normalizeStatus("not_started")).toBe("not_started");
      expect(normalizeStatus("done")).toBe("finished");
      expect(normalizeStatus("dropped")).toBe("abandoned");
    });

    it("handles numeric encodings 0..3", () => {
      expect(normalizeStatus("0")).toBe("not_started");
      expect(normalizeStatus("1")).toBe("reading");
      expect(normalizeStatus("2")).toBe("finished");
      expect(normalizeStatus("3")).toBe("abandoned");
    });

    it("falls back to 'unknown' for unrecognized values", () => {
      expect(normalizeStatus("random_thing")).toBe("unknown");
      expect(normalizeStatus(null)).toBe("unknown");
    });
  });

  describe("normalizeIsbn", () => {
    it("strips dashes/spaces and uppercases", () => {
      expect(normalizeIsbn("978-7-111-11111-1")).toBe("9787111111111");
      expect(normalizeIsbn(" 978 7 111 11111 1 ")).toBe("9787111111111");
    });

    it("returns null for too-short strings", () => {
      expect(normalizeIsbn("12345")).toBeNull();
      expect(normalizeIsbn(null)).toBeNull();
    });
  });

  describe("classifyFileRole", () => {
    it("classifies bookshelf / books / shelf as 'books'", () => {
      for (const f of ["bookshelf.json", "books.json", "weread-books.json", "shelf.json"]) {
        expect(classifyFileRole(f)).toBe("books");
      }
    });

    it("classifies notes / highlights / thoughts / reviews as 'notes'", () => {
      for (const f of ["notes.json", "highlights.json", "thoughts.json", "reviews.json"]) {
        expect(classifyFileRole(f)).toBe("notes");
      }
    });

    it("returns 'skipped' for unrecognized files", () => {
      expect(classifyFileRole("stats.json")).toBe("skipped");
      expect(classifyFileRole("user-profile.json")).toBe("skipped");
    });
  });

  describe("inferNoteType", () => {
    it("uses explicit type field when present", () => {
      expect(inferNoteType({ type: "thought" }, "notes.json")).toBe("thought");
      expect(inferNoteType({ type: "review" }, "notes.json")).toBe("review");
      expect(inferNoteType({ type: "highlight" }, "notes.json")).toBe("highlight");
    });

    it("falls back to filename for generic notes.json", () => {
      expect(inferNoteType({}, "notes.json")).toBe("highlight");
      expect(inferNoteType({}, "highlights.json")).toBe("highlight");
      expect(inferNoteType({}, "thoughts.json")).toBe("thought");
      expect(inferNoteType({}, "reviews.json")).toBe("review");
    });
  });

  describe("normalizeBook", () => {
    it("normalizes a typical raw bookshelf entry", () => {
      const r = normalizeBook({
        bookId: "wr_real_123",
        title: "示例书",
        author: "示例作者",
        isbn: "978-7-111-11111-1",
        category: "示例/文学",
        cover: "https://example/cover.jpg",
        rating: 4.5,
        status: "reading",
        progress: 42,
        noteCount: 3,
        highlightCount: 7,
        lastReadAt: "2026-05-01T10:00:00.000Z",
        updatedAt: "2026-05-01T10:00:00.000Z",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.wereadBookId).toBe("wr_real_123");
      expect(r.value.title).toBe("示例书");
      expect(r.value.isbn).toBe("9787111111111");
      expect(r.value.readingStatus).toBe("reading");
      expect(r.value.progress).toBe(42);
      expect(r.value.noteCount).toBe(3);
    });

    it("scales 0..1 progress to 0..100", () => {
      const r = normalizeBook({
        bookId: "x",
        title: "示例",
        author: "示例",
        progress: 0.42,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.progress).toBe(42);
    });

    it("uses fallback key names (book_id, name, writer)", () => {
      const r = normalizeBook({
        book_id: "x",
        name: "示例",
        writer: "作者",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.wereadBookId).toBe("x");
      expect(r.value.title).toBe("示例");
      expect(r.value.author).toBe("作者");
    });

    it("rejects records missing bookId", () => {
      const r = normalizeBook({ title: "示例", author: "示例" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("missing_bookId");
    });

    it("rejects records missing title", () => {
      const r = normalizeBook({ bookId: "x" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("missing_title");
    });

    it("preserves 'unknown' for unrecognized status", () => {
      const r = normalizeBook({
        bookId: "x",
        title: "示例",
        author: "作者",
        status: "kinda_done",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.readingStatus).toBe("unknown");
    });
  });

  describe("normalizeNote", () => {
    it("normalizes a typical highlight", () => {
      const r = normalizeNote(
        {
          bookId: "wr_real_123",
          id: "h1",
          type: "highlight",
          chapterTitle: "示例章节",
          text: "示例文本",
          comment: "示例评论",
          createdAt: "2026-04-20T09:00:00.000Z",
        },
        "highlights.json",
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.wereadBookId).toBe("wr_real_123");
      expect(r.value.noteId).toBe("h1");
      expect(r.value.type).toBe("highlight");
    });

    it("rejects records missing text", () => {
      const r = normalizeNote(
        { bookId: "x", id: "n1" },
        "notes.json",
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("missing_text");
    });

    it("rejects records missing noteId", () => {
      const r = normalizeNote(
        { bookId: "x", text: "示例" },
        "notes.json",
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("missing_noteId");
    });
  });
});

describe("normalize-weread-export CLI integration", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const normalizer = path.join(
    repoRoot,
    "scripts",
    "weread",
    "normalize-weread-export.ts",
  );

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-normalize-"));
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function runCli(rawDir: string, outDir: string): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const r = spawnSync(
      tsxBin,
      [normalizer, "--raw-dir", rawDir, "--out-dir", outDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  it("BLOCKED_FOR_RAW_EXPORT on missing directory", () => {
    const outDir = path.join(tmpDir, "out1");
    const result = runCli(path.join(tmpDir, "no-such-dir"), outDir);
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/STATUS=BLOCKED_FOR_RAW_EXPORT/);
  });

  it("BLOCKED_FOR_RAW_EXPORT on empty directory", () => {
    const emptyRaw = path.join(tmpDir, "empty-raw");
    fs.mkdirSync(emptyRaw, { recursive: true });
    const outDir = path.join(tmpDir, "out2");
    const result = runCli(emptyRaw, outDir);
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/STATUS=BLOCKED_FOR_RAW_EXPORT/);
  });

  it("PASS: synthesizes books/notes from realistic-shaped raw, never logs content", () => {
    const rawDir = path.join(tmpDir, "raw-good");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, "bookshelf.json"),
      JSON.stringify([
        { bookId: "wr_secret_aaa", title: "示例A", author: "作者A", isbn: "978-7-111-11111-1", status: "reading", progress: 0.42 },
        { bookId: "wr_secret_bbb", title: "示例B", author: "作者B", isbn: "978-7-222-22222-2", status: "finished", progress: 100 },
        { bookId: "wr_secret_ccc", title: "示例C", author: "作者C", status: "not_started" }, // missing isbn
      ]),
    );
    fs.writeFileSync(
      path.join(rawDir, "highlights.json"),
      JSON.stringify([
        { bookId: "wr_secret_aaa", id: "h1", type: "highlight", text: "EXAMPLE_HIGHLIGHT_TEXT_NEVER_LEAKED" },
      ]),
    );
    const outDir = path.join(tmpDir, "out-good");
    const result = runCli(rawDir, outDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=PASS/);
    expect(result.stdout).toMatch(/booksCount=3/);
    expect(result.stdout).toMatch(/notesCount=1/);
    expect(result.stdout).toMatch(/matchesCount=0/);
    // CRITICAL: actual raw text must never appear in stdout.
    expect(result.stdout).not.toContain("EXAMPLE_HIGHLIGHT_TEXT_NEVER_LEAKED");
    expect(result.stdout).not.toContain("wr_secret_aaa");
    expect(result.stdout).not.toContain("wr_secret_bbb");
    expect(result.stdout).not.toContain("wr_secret_ccc");

    // Snapshot files exist and are well-formed.
    const books = JSON.parse(fs.readFileSync(path.join(outDir, "weread-books.snapshot.json"), "utf8"));
    const notes = JSON.parse(fs.readFileSync(path.join(outDir, "weread-notes.snapshot.json"), "utf8"));
    const matches = JSON.parse(fs.readFileSync(path.join(outDir, "weread-matches.snapshot.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));

    expect(books).toHaveLength(3);
    expect(books[0].wereadBookId).toBe("wr_secret_aaa");
    expect(books[0].readingStatus).toBe("reading");
    expect(books[0].progress).toBe(42); // 0.42 scaled to 42
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe("highlight");
    expect(matches).toEqual([]);
    expect(manifest.booksCount).toBe(3);
    expect(manifest.notesCount).toBe(1);
  });

  it("WARN: skips records missing title/bookId without leaking content", () => {
    const rawDir = path.join(tmpDir, "raw-skip");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, "bookshelf.json"),
      JSON.stringify([
        { bookId: "wr_keep_1", title: "示例KEEP", author: "A" },
        { bookId: "wr_skip_no_title", author: "A" }, // missing title
        { title: "示例SKIP_NO_BOOKID", author: "A" }, // missing bookId
        { bookId: "wr_secret_ddd", title: "示例LEAKED_CONTENT_HERE", author: "A" },
      ]),
    );
    const outDir = path.join(tmpDir, "out-skip");
    const result = runCli(rawDir, outDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=WARN/);
    expect(result.stdout).toMatch(/totalAccepted=2/);
    expect(result.stdout).toMatch(/totalSkipped=2/);
    expect(result.stdout).toMatch(/skip.missing_title=1/);
    expect(result.stdout).toMatch(/skip.missing_bookId=1/);
    // No real ids or content should appear in stdout.
    expect(result.stdout).not.toContain("示例KEEP");
    expect(result.stdout).not.toContain("示例LEAKED_CONTENT_HERE");
    expect(result.stdout).not.toContain("wr_keep_1");
    expect(result.stdout).not.toContain("wr_secret_ddd");

    const books = JSON.parse(fs.readFileSync(path.join(outDir, "weread-books.snapshot.json"), "utf8"));
    expect(books).toHaveLength(2);
    expect(books.map((b: { wereadBookId: string }) => b.wereadBookId)).toEqual(["wr_keep_1", "wr_secret_ddd"]);
  });
});