import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FileInventory,
  type InventoryReport,
  detectJsonType,
  inventoryFile,
  isSensitiveKey,
  summarizeRecords,
} from "./inspect-weread-raw.ts";

describe("inspect-weread-raw pure helpers", () => {
  describe("detectJsonType", () => {
    it("classifies primitives correctly", () => {
      expect(detectJsonType("hello")).toBe("string");
      expect(detectJsonType(42)).toBe("number");
      expect(detectJsonType(true)).toBe("boolean");
      expect(detectJsonType(null)).toBe("null");
    });

    it("classifies containers correctly", () => {
      expect(detectJsonType([])).toBe("array");
      expect(detectJsonType({})).toBe("object");
    });
  });

  describe("isSensitiveKey", () => {
    it("flags token / cookie / session / Bearer", () => {
      for (const k of ["token", "access_token", "session_id", "cookie", "Cookie"]) {
        expect(isSensitiveKey(k).sensitive).toBe(true);
      }
      expect(isSensitiveKey("Authorization").sensitive).toBe(true);
      expect(isSensitiveKey("BearerToken").sensitive).toBe(true);
    });

    it("flags WeRead-specific field names", () => {
      expect(isSensitiveKey("wr_vid").sensitive).toBe(true);
      expect(isSensitiveKey("wr_skey").sensitive).toBe(true);
      expect(isSensitiveKey("wr_rt").sensitive).toBe(true);
    });

    it("does not flag harmless keys", () => {
      for (const k of ["title", "author", "isbn", "progress", "noteCount"]) {
        expect(isSensitiveKey(k).sensitive).toBe(false);
      }
    });
  });

  describe("summarizeRecords", () => {
    it("computes coverage and type breakdown", () => {
      const records = [
        { title: "A", author: "B", isbn: "9787000000001" },
        { title: "C", author: null, isbn: null },
        { title: "D", author: "E" }, // isbn missing
      ];
      const { fieldSummary, topLevelKeys } = summarizeRecords(records);
      expect(topLevelKeys).toContain("title");
      expect(topLevelKeys).toContain("author");
      expect(topLevelKeys).toContain("isbn");

      const title = fieldSummary.find((f) => f.key === "title")!;
      expect(title.occurrences).toBe(3);
      expect(title.coveragePct).toBeCloseTo(100, 1);

      const isbn = fieldSummary.find((f) => f.key === "isbn")!;
      expect(isbn.occurrences).toBe(2);
      expect(isbn.coveragePct).toBeCloseTo(66.67, 1);
      expect(isbn.typeBreakdown.string).toBe(1);
      expect(isbn.typeBreakdown.null).toBe(1);
    });

    it("buckets string lengths without recording values", () => {
      const records = [
        { text: "" },
        { text: "abc" },
        { text: "this is a longer string for bucket testing purposes" },
      ];
      const { fieldSummary } = summarizeRecords(records);
      const text = fieldSummary.find((f) => f.key === "text")!;
      expect(text.stringLengthHistogram).toBeDefined();
      expect(text.stringLengthHistogram!["0"]).toBe(1);
      expect(text.stringLengthHistogram!["1-4"]).toBe(1);
      // The 56-char string should land in 17-64 bucket (or 65-256 depending on length).
      const totalBuckets = Object.values(text.stringLengthHistogram!).reduce((s, v) => s + v, 0);
      expect(totalBuckets).toBe(3);
      // Crucially, no actual text should appear in any field.
      const serialized = JSON.stringify(fieldSummary);
      expect(serialized).not.toContain("this is a longer string");
    });

    it("sorts fieldSummary by key name", () => {
      const { fieldSummary } = summarizeRecords([{ zebra: 1, alpha: 2, mango: 3 }]);
      expect(fieldSummary.map((f) => f.key)).toEqual(["alpha", "mango", "zebra"]);
    });
  });

  describe("inventoryFile", () => {
    it("returns WARN with sensitiveKeyHits on files containing token fields", () => {
      const tmp = path.join(os.tmpdir(), `inspect-test-${Date.now()}.json`);
      fs.writeFileSync(
        tmp,
        JSON.stringify([
          { title: "示例", token: "SECRET_VALUE_HERE_NEVER_LEAKED" },
          { title: "示例2", token: "ANOTHER_SECRET_VALUE" },
        ]),
      );
      try {
        const inv: FileInventory = inventoryFile(tmp);
        expect(inv.recordCount).toBe(2);
        expect(inv.sensitiveKeyHits).toContain("token");
        expect(inv.warnings.some((w) => w.includes("sensitive keys detected"))).toBe(true);
        // Critical safety invariant: no actual secret value appears anywhere.
        const serialized = JSON.stringify(inv);
        expect(serialized).not.toContain("SECRET_VALUE_HERE_NEVER_LEAKED");
        expect(serialized).not.toContain("ANOTHER_SECRET_VALUE");
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    it("handles unreadable JSON gracefully", () => {
      const tmp = path.join(os.tmpdir(), `inspect-bad-${Date.now()}.json`);
      fs.writeFileSync(tmp, "this is not json");
      try {
        const inv = inventoryFile(tmp);
        expect(inv.warnings.some((w) => w.startsWith("unreadable:"))).toBe(true);
        expect(inv.recordCount).toBe(0);
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    it("treats a single top-level object as recordCount=1", () => {
      const tmp = path.join(os.tmpdir(), `inspect-single-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify({ title: "示例", author: "示例作者" }));
      try {
        const inv = inventoryFile(tmp);
        expect(inv.topLevelType).toBe("object");
        expect(inv.recordCount).toBe(1);
        expect(inv.topLevelKeys).toEqual(["author", "title"]);
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });
});

describe("inspect-weread-raw CLI integration", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const inspector = path.join(
    repoRoot,
    "scripts",
    "weread",
    "inspect-weread-raw.ts",
  );

  let tmpDir: string;
  let auditDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-inspect-"));
    auditDir = path.join(tmpDir, "audit");
    fs.mkdirSync(auditDir, { recursive: true });
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function runCli(dir: string, extraArgs: string[] = []): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const r = spawnSync(
      tsxBin,
      [inspector, "--dir", dir, ...extraArgs],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  it("BLOCKED_FOR_RAW_EXPORT (exit 1) on an empty directory", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = runCli(emptyDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/STATUS=BLOCKED_FOR_RAW_EXPORT/);
  });

  it("BLOCKED_FOR_RAW_EXPORT (exit 1) when directory does not exist", () => {
    const result = runCli(path.join(tmpDir, "missing-dir"));
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/directory not found/);
  });

  it("PASS on a synthetic raw bookshelf and emits audit JSON/MD", () => {
    const rawDir = path.join(tmpDir, "raw-with-files");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, "bookshelf.json"),
      JSON.stringify([
        { title: "示例A", author: "示例作者 A", isbn: "9787000000001" },
        { title: "示例B", author: "示例作者 B", isbn: null },
      ]),
    );

    const jsonOut = path.join(auditDir, "inv.json");
    const mdOut = path.join(auditDir, "inv.md");
    const result = runCli(rawDir, [
      "--out-json",
      jsonOut,
      "--out-md",
      mdOut,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=PASS/);
    expect(result.stdout).toMatch(/totalFiles=1/);
    expect(result.stdout).toMatch(/totalRecords=2/);

    const report: InventoryReport = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
    expect(report.files[0].file).toBe("bookshelf.json");
    expect(report.files[0].recordCount).toBe(2);
    expect(report.files[0].topLevelKeys).toContain("title");
    expect(report.files[0].topLevelKeys).toContain("author");
    expect(report.files[0].topLevelKeys).toContain("isbn");

    const md = fs.readFileSync(mdOut, "utf8");
    expect(md).toContain("# WeRead raw inventory");
    expect(md).toContain("| key | coverage% | types |");
    // Safety: no actual sample string should appear in the audit MD.
    expect(md).not.toContain("示例A");
    expect(md).not.toContain("示例作者 A");
  });

  it("WARN when a raw file contains sensitive keys, never printing values", () => {
    const rawDir = path.join(tmpDir, "raw-sensitive");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, "session-leak.json"),
      JSON.stringify([
        { title: "示例", token: "REDACTED_TOKEN_VALUE_AAA" },
      ]),
    );

    const result = runCli(rawDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=WARN/);
    expect(result.stdout).toMatch(/sensitiveWarningsTotal=1/);
    // Critical: the value must not leak to stdout.
    expect(result.stdout).not.toContain("REDACTED_TOKEN_VALUE_AAA");
    expect(result.stdout).toMatch(/sensitive keys detected/);
  });
});