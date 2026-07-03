import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { execSync } from "node:child_process";

const runRepair = (args: string) => {
  return execSync(`./node_modules/.bin/tsx scripts/weread/repair-confirmed-match-review.ts ${args}`, {
    cwd: "/opt/book-id-search",
    encoding: "utf8",
    env: { ...process.env, NO_PROXY: "*", no_proxy: "*" },
  });
};

function makeReview(
  overrides: Partial<Record<string, unknown>> = {},
  base: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    reviewId: "rev-1",
    wereadBookId: "weread-1",
    wereadTitle: "Title A",
    wereadAuthor: "Author A",
    status: "accepted",
    decisionSource: "auto_high_confidence",
    selectedCatalogId: "13000000_000000000001",
    selectedCandidateIndex: 0,
    confidence: "high",
    reason: "auto accepted",
    candidates: [
      {
        catalogId: "13000000_000000000001",
        ssid: "13000000",
        dxid: "000000000001",
        isbn: "9780000000000",
        title: "Title A",
        author: "Author A",
        matchMethod: "title_author",
        matchConfidence: "high",
        reason: "strict match",
      },
    ],
    notes: "",
    ...base,
    ...overrides,
  };
}

describe("repair-confirmed-match-review", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-repair-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepted line_<number> with valid alternative is repaired to pending", () => {
    const reviewPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      reviewPath,
      JSON.stringify([
        makeReview({
          selectedCatalogId: "line_12345678",
          selectedCandidateIndex: 0,
          candidates: [
            {
              catalogId: "line_12345678",
              ssid: "13000000",
              dxid: "",
              isbn: "",
              title: "Title A",
              author: "Author A",
              matchMethod: "title_author",
              matchConfidence: "high",
              reason: "strict match",
            },
            {
              catalogId: "13000000_000000000002",
              ssid: "13000000",
              dxid: "000000000002",
              isbn: "9780000000001",
              title: "Title A",
              author: "Author A",
              matchMethod: "title_similarity",
              matchConfidence: "medium",
              reason: "similar title",
            },
          ],
        }),
      ])
    );

    const stdout = runRepair(`--review ${reviewPath} --summary ${summaryPath}`);
    expect(stdout).toContain("STATUS=PASS");
    expect(stdout).toContain("repaired=1");
    expect(stdout).toContain("setPending=1");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    expect(summary.repaired).toBe(1);

    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    expect(review[0].status).toBe("pending");
    expect(review[0].selectedCatalogId).toBeNull();
    expect(review[0].selectedCandidateIndex).toBeNull();
  });

  it("accepted line_<number> with no valid alternative is repaired to needs_manual_search", () => {
    const reviewPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      reviewPath,
      JSON.stringify([
        makeReview({
          selectedCatalogId: "line_12345678",
          selectedCandidateIndex: 0,
          candidates: [
            {
              catalogId: "line_12345678",
              ssid: "13000000",
              dxid: "",
              isbn: "",
              title: "Title A",
              author: "Author A",
              matchMethod: "title_author",
              matchConfidence: "high",
              reason: "strict match",
            },
          ],
        }),
      ])
    );

    const stdout = runRepair(`--review ${reviewPath} --summary ${summaryPath}`);
    expect(stdout).toContain("setNeedsManualSearch=1");
    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    expect(review[0].status).toBe("needs_manual_search");
  });

  it("valid accepted remains unchanged", () => {
    const reviewPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview()]));

    const stdout = runRepair(`--review ${reviewPath} --summary ${summaryPath}`);
    expect(stdout).toContain("alreadyValidAccepted=1");
    expect(stdout).toContain("repaired=0");
    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    expect(review[0].status).toBe("accepted");
    expect(review[0].selectedCatalogId).toBe("13000000_000000000001");
  });

  it("pending remains unchanged", () => {
    const reviewPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview({ status: "pending" })]));

    const stdout = runRepair(`--review ${reviewPath} --summary ${summaryPath}`);
    expect(stdout).toContain("notAccepted=1");
    expect(stdout).toContain("repaired=0");
    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    expect(review[0].status).toBe("pending");
  });

  it("stdout does not leak wereadBookId or catalogId", () => {
    const reviewPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      reviewPath,
      JSON.stringify([
        makeReview({
          wereadBookId: "secret-weread-123",
          selectedCatalogId: "line_99999999",
          selectedCandidateIndex: 0,
          candidates: [
            {
              catalogId: "line_99999999",
              ssid: "13000000",
              dxid: "",
              isbn: "",
              title: "Title A",
              author: "Author A",
              matchMethod: "title_author",
              matchConfidence: "high",
              reason: "strict match",
            },
          ],
        }),
      ])
    );

    const stdout = runRepair(`--review ${reviewPath} --summary ${summaryPath}`);
    expect(stdout).not.toContain("secret-weread-123");
    expect(stdout).not.toContain("line_99999999");
    expect(stdout).not.toContain("Title A");
  });

  it("summary only contains counts", () => {
    const reviewPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      reviewPath,
      JSON.stringify([
        makeReview({
          wereadBookId: "secret-weread-123",
          selectedCatalogId: "line_99999999",
          selectedCandidateIndex: 0,
          candidates: [
            {
              catalogId: "line_99999999",
              ssid: "13000000",
              dxid: "",
              isbn: "",
              title: "Title A",
              author: "Author A",
              matchMethod: "title_author",
              matchConfidence: "high",
              reason: "strict match",
            },
          ],
        }),
      ])
    );

    runRepair(`--review ${reviewPath} --summary ${summaryPath}`);
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const summaryStr = JSON.stringify(summary);
    expect(summaryStr).not.toContain("secret-weread-123");
    expect(summaryStr).not.toContain("line_99999999");
    expect(summaryStr).toContain("repaired");
    expect(summaryStr).toContain("setPending");
  });
});
