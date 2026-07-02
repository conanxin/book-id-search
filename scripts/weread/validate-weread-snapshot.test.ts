import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALLOWED_MATCH_CONFIDENCES,
  ALLOWED_MATCH_METHODS,
  ALLOWED_NOTE_TYPES,
  ALLOWED_READING_STATUSES,
  validateBooks,
  validateNotes,
  validateMatches,
} from "./validate-weread-snapshot.ts";

describe("validateBooks", () => {
  it("passes on a well-formed bookshelf entry", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_sample_001",
        title: "示例建筑史",
        author: "示例作者 A",
        isbn: "9787000000001",
        category: "示例",
        cover: null,
        rating: 4.5,
        readingStatus: "finished",
        progress: 100,
        noteCount: 2,
        highlightCount: 3,
        lastReadAt: "2026-05-01T10:00:00.000Z",
        updatedAt: "2026-05-01T10:00:00.000Z",
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.count).toBe(1);
  });

  it("fails when title is missing", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_sample_002",
        title: "",
        author: "示例作者",
        readingStatus: "reading",
        progress: 50,
      },
    ]);
    expect(result.errors.some((e) => e.includes("title must be a non-empty string"))).toBe(true);
  });

  it("fails when title is not a string", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_sample_003",
        title: 123,
        author: "示例作者",
        readingStatus: "reading",
        progress: 50,
      },
    ]);
    expect(result.errors.some((e) => e.includes("title must be a non-empty string"))).toBe(true);
  });

  it("fails when wereadBookId is missing", () => {
    const result = validateBooks([
      {
        title: "示例",
        author: "示例",
        readingStatus: "reading",
        progress: 50,
      },
    ]);
    expect(result.errors.some((e) => e.includes("wereadBookId must be a non-empty string"))).toBe(true);
  });

  it("fails when progress is out of bounds (negative)", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_x",
        title: "示例",
        author: "示例",
        readingStatus: "reading",
        progress: -1,
      },
    ]);
    expect(result.errors.some((e) => e.includes("progress must be a number 0..100"))).toBe(true);
  });

  it("fails when progress is out of bounds (>100)", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_x",
        title: "示例",
        author: "示例",
        readingStatus: "reading",
        progress: 150,
      },
    ]);
    expect(result.errors.some((e) => e.includes("progress must be a number 0..100"))).toBe(true);
  });

  it("accepts progress=null as 'unknown'", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_x",
        title: "示例",
        author: "示例",
        readingStatus: "unknown",
        progress: null,
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("fails on unknown readingStatus", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_x",
        title: "示例",
        author: "示例",
        readingStatus: "kinda_done",
        progress: 50,
      },
    ]);
    expect(
      result.errors.some(
        (e) => e.includes("readingStatus must be one of") && e.includes("kinda_done"),
      ),
    ).toBe(true);
  });

  it("warns (not fails) when rating is outside 0..5", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_x",
        title: "示例",
        author: "示例",
        readingStatus: "finished",
        progress: 100,
        rating: 7,
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("rating is outside 0..5"))).toBe(true);
  });

  it("covers every allowed readingStatus value", () => {
    for (const status of ALLOWED_READING_STATUSES) {
      const result = validateBooks([
        {
          wereadBookId: "wr_x",
          title: "示例",
          author: "示例",
          readingStatus: status,
          progress: 0,
        },
      ]);
      expect(result.errors).toEqual([]);
    }
  });

  it("fails when noteCount is negative", () => {
    const result = validateBooks([
      {
        wereadBookId: "wr_x",
        title: "示例",
        author: "示例",
        readingStatus: "reading",
        progress: 1,
        noteCount: -2,
      },
    ]);
    expect(result.errors.some((e) => e.includes("noteCount must be a non-negative number"))).toBe(true);
  });
});

describe("validateNotes", () => {
  it("passes on a well-formed note", () => {
    const result = validateNotes([
      {
        wereadBookId: "wr_sample_001",
        noteId: "n1",
        type: "highlight",
        chapterTitle: "示例章节",
        text: "示例文本",
        comment: null,
        createdAt: "2026-04-20T09:00:00.000Z",
        updatedAt: "2026-04-20T09:00:00.000Z",
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("fails on unknown type", () => {
    const result = validateNotes([
      {
        wereadBookId: "wr_sample_001",
        noteId: "n1",
        type: "underline",
        text: "示例文本",
      },
    ]);
    expect(result.errors.some((e) => e.includes("type must be one of"))).toBe(true);
  });

  it("covers every allowed note type", () => {
    for (const type of ALLOWED_NOTE_TYPES) {
      const result = validateNotes([
        {
          wereadBookId: "wr_x",
          noteId: "n_x",
          type,
          text: "示例文本",
        },
      ]);
      expect(result.errors).toEqual([]);
    }
  });

  it("fails when text is empty", () => {
    const result = validateNotes([
      {
        wereadBookId: "wr_sample_001",
        noteId: "n1",
        type: "highlight",
        text: "",
      },
    ]);
    expect(result.errors.some((e) => e.includes("text must be a non-empty string"))).toBe(true);
  });

  it("fails when chapterTitle is wrong type", () => {
    const result = validateNotes([
      {
        wereadBookId: "wr_sample_001",
        noteId: "n1",
        type: "highlight",
        text: "示例文本",
        chapterTitle: 42,
      },
    ]);
    expect(result.errors.some((e) => e.includes("chapterTitle must be string|null"))).toBe(true);
  });
});

describe("validateMatches", () => {
  it("passes on a well-formed match", () => {
    const result = validateMatches([
      {
        wereadBookId: "wr_sample_001",
        catalogId: "ssid_x",
        ssid: "ssid_x",
        dxid: "dxid_x",
        isbn: "9787000000001",
        matchMethod: "isbn",
        matchConfidence: "high",
        titleSimilarity: 1.0,
        authorSimilarity: 1.0,
        confirmedByUser: false,
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fails on unknown matchMethod", () => {
    const result = validateMatches([
      {
        wereadBookId: "wr_sample_001",
        catalogId: "ssid_x",
        ssid: "ssid_x",
        dxid: "dxid_x",
        matchMethod: "guessing",
        matchConfidence: "high",
      },
    ]);
    expect(result.errors.some((e) => e.includes("matchMethod must be one of"))).toBe(true);
  });

  it("fails on unknown matchConfidence", () => {
    const result = validateMatches([
      {
        wereadBookId: "wr_sample_001",
        catalogId: "ssid_x",
        ssid: "ssid_x",
        dxid: "dxid_x",
        matchMethod: "isbn",
        matchConfidence: "almost",
      },
    ]);
    expect(result.errors.some((e) => e.includes("matchConfidence must be one of"))).toBe(true);
  });

  it("warns when confirmedByUser is true on auto-generated match", () => {
    const result = validateMatches([
      {
        wereadBookId: "wr_sample_001",
        catalogId: "ssid_x",
        ssid: "ssid_x",
        dxid: "dxid_x",
        matchMethod: "isbn",
        matchConfidence: "high",
        confirmedByUser: true,
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("confirmedByUser is true"))).toBe(true);
  });

  it("warns when titleSimilarity is outside 0..1", () => {
    const result = validateMatches([
      {
        wereadBookId: "wr_sample_001",
        catalogId: "ssid_x",
        ssid: "ssid_x",
        dxid: "dxid_x",
        matchMethod: "title_similarity",
        matchConfidence: "medium",
        titleSimilarity: 1.5,
      },
    ]);
    expect(result.warnings.some((w) => w.includes("titleSimilarity outside 0..1"))).toBe(true);
  });

  it("fails when catalogId is missing", () => {
    const result = validateMatches([
      {
        wereadBookId: "wr_sample_001",
        ssid: "ssid_x",
        dxid: "dxid_x",
        matchMethod: "isbn",
        matchConfidence: "high",
      },
    ]);
    expect(result.errors.some((e) => e.includes("catalogId must be a non-empty string"))).toBe(true);
  });

  it("covers every allowed matchMethod and matchConfidence", () => {
    for (const method of ALLOWED_MATCH_METHODS) {
      for (const conf of ALLOWED_MATCH_CONFIDENCES) {
        const result = validateMatches([
          {
            wereadBookId: "wr_x",
            catalogId: "c",
            ssid: "s",
            dxid: "d",
            matchMethod: method,
            matchConfidence: conf,
          },
        ]);
        expect(result.errors).toEqual([]);
      }
    }
  });
});

describe("validate-weread-snapshot CLI integration", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const validator = path.join(
    repoRoot,
    "scripts",
    "weread",
    "validate-weread-snapshot.ts",
  );
  const samplesDir = path.join(repoRoot, "samples", "weread");

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-validate-test-"));
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function runCli(dir: string): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(tsxBin, [validator, "--dir", dir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  function writeSnapshot(name: string, body: unknown): void {
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(body, null, 2));
  }

  it("passes on the synthetic samples/weread fixture", () => {
    const result = runCli(samplesDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=PASS/);
    expect(result.stdout).toMatch(/weread-books\.snapshot\.json: count=3/);
    expect(result.stdout).toMatch(/weread-notes\.snapshot\.json: count=3/);
    expect(result.stdout).toMatch(/weread-matches\.snapshot\.json: count=3/);
  });

  it("returns WARN when at least one snapshot file is missing but others pass", () => {
      // Use the samples directory but remove one file inside a copy.
      const partialDir = path.join(tmpDir, "partial");
      fs.mkdirSync(partialDir, { recursive: true });
      // samples/weread ships as .sample.json for clarity; copy them to
      // .snapshot.json for this test so partial-directory logic runs.
      fs.copyFileSync(
        path.join(samplesDir, "weread-books.sample.json"),
        path.join(partialDir, "weread-books.snapshot.json"),
      );
      fs.copyFileSync(
        path.join(samplesDir, "weread-notes.sample.json"),
        path.join(partialDir, "weread-notes.snapshot.json"),
      );
      // deliberately omit matches
      const result = runCli(partialDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/STATUS=WARN/);
      expect(result.stdout).toMatch(/missing file: weread-matches/);
    });

    it("returns FAIL with exit code 1 when schema is violated", () => {
      writeSnapshot("weread-books.snapshot.json", [
        {
          wereadBookId: "wr_bad",
          title: "",
          author: "示例作者",
          readingStatus: "almost_done",
          progress: 200,
        },
      ]);
      writeSnapshot("weread-notes.snapshot.json", []);
      writeSnapshot("weread-matches.snapshot.json", []);

      const result = runCli(tmpDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/STATUS=FAIL/);
      expect(result.stdout).toMatch(/title must be a non-empty string/);
      expect(result.stdout).toMatch(/readingStatus must be one of/);
      expect(result.stdout).toMatch(/progress must be a number 0\.\.100/);
    });

    it("returns FAIL with exit code 1 when directory has no weread-*.snapshot.json files", () => {
      const emptyDir = path.join(tmpDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      const result = runCli(emptyDir);
      expect(result.status).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/no weread-.*files found/);
    });
});