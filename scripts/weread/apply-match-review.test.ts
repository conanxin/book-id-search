import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAcceptedItem } from "./apply-match-review.ts";

function makeCandidate(
  overrides: Partial<{ catalogId: string; matchMethod: "isbn" | "title_author" | "title_similarity"; matchConfidence: "high" | "medium" | "low" }> = {},
) {
  return {
    catalogId: overrides.catalogId ?? "cat_123",
    ssid: "ssid123",
    dxid: "dxid123",
    isbn: "9787111111111" as string | null,
    title: "Catalog Title",
    author: "Catalog Author",
    matchMethod: (overrides.matchMethod ?? "isbn") as "isbn" | "title_author" | "title_similarity",
    matchConfidence: (overrides.matchConfidence ?? "high") as "high" | "medium" | "low",
    reason: "reason",
  };
}

describe("apply-match-review pure helpers", () => {
  it("validates accepted item by selectedCandidateIndex", () => {
    const confirmed = validateAcceptedItem(
      {
        reviewId: "r1",
        wereadBookId: "wr_1",
        wereadTitle: "Title",
        wereadAuthor: "Author",
        status: "accepted",
        decisionSource: "manual",
        selectedCatalogId: "cat_123",
        selectedCandidateIndex: 0,
        confidence: "high",
        reason: "",
        candidates: [makeCandidate()],
        notes: "",
      },
      0,
    );
    expect(confirmed.catalogId).toBe("cat_123");
    expect(confirmed.decisionSource).toBe("manual");
  });

  it("validates accepted item by selectedCatalogId when index invalid", () => {
    const confirmed = validateAcceptedItem(
      {
        reviewId: "r2",
        wereadBookId: "wr_2",
        wereadTitle: "Title",
        wereadAuthor: "Author",
        status: "accepted",
        decisionSource: "manual",
        selectedCatalogId: "cat_456",
        selectedCandidateIndex: null,
        confidence: "medium",
        reason: "",
        candidates: [makeCandidate({ catalogId: "cat_456", matchConfidence: "medium" })],
        notes: "",
      },
      0,
    );
    expect(confirmed.catalogId).toBe("cat_456");
    expect(confirmed.matchConfidence).toBe("medium");
  });

  it("throws when selectedCandidateIndex points to different catalogId", () => {
    expect(() =>
      validateAcceptedItem(
        {
          reviewId: "r3",
          wereadBookId: "wr_3",
          wereadTitle: "Title",
          wereadAuthor: "Author",
          status: "accepted",
          decisionSource: "manual",
          selectedCatalogId: "cat_999",
          selectedCandidateIndex: 0,
          confidence: "high",
          reason: "",
          candidates: [makeCandidate()],
          notes: "",
        },
        0,
      ),
    ).toThrow();
  });

  it("throws when selectedCatalogId not found", () => {
    expect(() =>
      validateAcceptedItem(
        {
          reviewId: "r4",
          wereadBookId: "wr_4",
          wereadTitle: "Title",
          wereadAuthor: "Author",
          status: "accepted",
          decisionSource: "manual",
          selectedCatalogId: "cat_missing",
          selectedCandidateIndex: null,
          confidence: "high",
          reason: "",
          candidates: [makeCandidate()],
          notes: "",
        },
        0,
      ),
    ).toThrow();
  });
});

describe("apply-match-review CLI integration", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const applier = path.join(repoRoot, "scripts", "weread", "apply-match-review.ts");

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-apply-"));
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function runCli(reviewPath: string, outPath: string, summaryPath: string): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const r = spawnSync(
      tsxBin,
      [applier, "--review", reviewPath, "--out", outPath, "--summary", summaryPath],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  it("PASS: accepted items become confirmed; pending/rejected/needs_manual_search ignored", () => {
    const review = path.join(tmpDir, "review1.json");
    fs.writeFileSync(
      review,
      JSON.stringify([
        {
          reviewId: "r1",
          wereadBookId: "wr_secret_1",
          wereadTitle: "SECRET_TITLE_1",
          wereadAuthor: "SECRET_AUTHOR_1",
          status: "accepted",
          decisionSource: "manual",
          selectedCatalogId: "cat_1",
          selectedCandidateIndex: 0,
          confidence: "high",
          reason: "",
          candidates: [makeCandidate({ catalogId: "cat_1" })],
          notes: "",
        },
        {
          reviewId: "r2",
          wereadBookId: "wr_secret_2",
          wereadTitle: "SECRET_TITLE_2",
          wereadAuthor: "SECRET_AUTHOR_2",
          status: "pending",
          decisionSource: "manual",
          selectedCatalogId: null,
          selectedCandidateIndex: null,
          confidence: "high",
          reason: "",
          candidates: [makeCandidate({ catalogId: "cat_2" })],
          notes: "",
        },
        {
          reviewId: "r3",
          wereadBookId: "wr_secret_3",
          wereadTitle: "SECRET_TITLE_3",
          wereadAuthor: "SECRET_AUTHOR_3",
          status: "rejected",
          decisionSource: "manual",
          selectedCatalogId: null,
          selectedCandidateIndex: null,
          confidence: "low",
          reason: "",
          candidates: [],
          notes: "",
        },
        {
          reviewId: "r4",
          wereadBookId: "wr_secret_4",
          wereadTitle: "SECRET_TITLE_4",
          wereadAuthor: "SECRET_AUTHOR_4",
          status: "needs_manual_search",
          decisionSource: "manual",
          selectedCatalogId: null,
          selectedCandidateIndex: null,
          confidence: "none",
          reason: "",
          candidates: [],
          notes: "",
        },
      ]),
    );
    const out = path.join(tmpDir, "out1.json");
    const summary = path.join(tmpDir, "summary1.json");
    const result = runCli(review, out, summary);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=PASS/);
    expect(result.stdout).toMatch(/confirmed=1/);
    expect(result.stdout).toMatch(/pending=1/);
    expect(result.stdout).toMatch(/rejected=1/);
    expect(result.stdout).toMatch(/needs_manual_search=1/);
    expect(result.stdout).not.toContain("SECRET_TITLE_1");
    expect(result.stdout).not.toContain("wr_secret_1");

    const confirmed = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].wereadBookId).toBe("wr_secret_1");
  });

  it("FAIL on duplicate wereadBookId in accepted items", () => {
    const review = path.join(tmpDir, "review2.json");
    fs.writeFileSync(
      review,
      JSON.stringify([
        {
          reviewId: "r1",
          wereadBookId: "wr_dup",
          wereadTitle: "Title",
          wereadAuthor: "Author",
          status: "accepted",
          decisionSource: "manual",
          selectedCatalogId: "cat_1",
          selectedCandidateIndex: 0,
          confidence: "high",
          reason: "",
          candidates: [makeCandidate({ catalogId: "cat_1" })],
          notes: "",
        },
        {
          reviewId: "r2",
          wereadBookId: "wr_dup",
          wereadTitle: "Title",
          wereadAuthor: "Author",
          status: "accepted",
          decisionSource: "manual",
          selectedCatalogId: "cat_2",
          selectedCandidateIndex: 0,
          confidence: "high",
          reason: "",
          candidates: [makeCandidate({ catalogId: "cat_2" })],
          notes: "",
        },
      ]),
    );
    const result = runCli(review, path.join(tmpDir, "out2.json"), path.join(tmpDir, "summary2.json"));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/FAIL/);
  });
});
