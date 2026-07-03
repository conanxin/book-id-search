import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("summarize-match-review CLI integration", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const summarizer = path.join(repoRoot, "scripts", "weread", "summarize-match-review.ts");

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-summary-"));
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function runCli(reviewPath: string, confirmedPath?: string): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const args = [summarizer, "--review", reviewPath];
    if (confirmedPath) args.push("--confirmed", confirmedPath);
    const r = spawnSync(tsxBin, args, { cwd: repoRoot, encoding: "utf8" });
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  it("PASS: summarizes review queue and confirmed output without leaking titles", () => {
    const review = path.join(tmpDir, "review.json");
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
          candidates: [
            {
              catalogId: "cat_1",
              ssid: "ssid1",
              dxid: "dxid1",
              isbn: "9787111111111",
              title: "Catalog Title",
              author: "Catalog Author",
              matchMethod: "isbn",
              matchConfidence: "high",
              reason: "",
            },
          ],
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
          confidence: "medium",
          reason: "",
          candidates: [
            {
              catalogId: "cat_2",
              ssid: "ssid2",
              dxid: "dxid2",
              isbn: null,
              title: "Catalog Title 2",
              author: "Catalog Author 2",
              matchMethod: "title_similarity",
              matchConfidence: "medium",
              reason: "",
            },
          ],
          notes: "",
        },
        {
          reviewId: "r3",
          wereadBookId: "wr_secret_3",
          wereadTitle: "SECRET_TITLE_3",
          wereadAuthor: "SECRET_AUTHOR_3",
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
    const confirmed = path.join(tmpDir, "confirmed.json");
    fs.writeFileSync(
      confirmed,
      JSON.stringify([
        {
          wereadBookId: "wr_secret_1",
          catalogId: "cat_1",
          ssid: "ssid1",
          dxid: "dxid1",
          isbn: "9787111111111",
          matchMethod: "isbn",
          matchConfidence: "high",
          decisionSource: "manual",
          confirmedAt: "2026-07-03T00:00:00Z",
          confirmedBy: "local-user",
        },
      ]),
    );
    const result = runCli(review, confirmed);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=PASS/);
    expect(result.stdout).toMatch(/total=3/);
    expect(result.stdout).toMatch(/accepted=1/);
    expect(result.stdout).toMatch(/pending=1/);
    expect(result.stdout).toMatch(/needs_manual_search=1/);
    expect(result.stdout).toMatch(/confirmed=1/);
    expect(result.stdout).not.toContain("SECRET_TITLE_1");
    expect(result.stdout).not.toContain("wr_secret_1");
  });

  it("PASS: missing confirmed file is allowed", () => {
    const review = path.join(tmpDir, "review2.json");
    fs.writeFileSync(review, JSON.stringify([]));
    const result = runCli(review, path.join(tmpDir, "nonexistent.json"));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/confirmed=0/);
  });
});
