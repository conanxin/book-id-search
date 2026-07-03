import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { execSync } from "node:child_process";

const runReview = (args: string) => {
  return execSync(`./node_modules/.bin/tsx scripts/weread/build-duplicate-catalog-review.ts ${args}`, {
    cwd: "/opt/book-id-search",
    encoding: "utf8",
    env: { ...process.env, NO_PROXY: "*", no_proxy: "*" },
  });
};

describe("build-duplicate-catalog-review", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-dup-review-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects duplicate catalogId groups", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([
        { wereadBookId: "weread-1", catalogId: "13000000_000000000001", ssid: "13000000", dxid: "000000000001", isbn: "9780000000000", matchMethod: "title_author", matchConfidence: "high" },
        { wereadBookId: "weread-2", catalogId: "13000000_000000000001", ssid: "13000000", dxid: "000000000001", isbn: "9780000000000", matchMethod: "title_author", matchConfidence: "high" },
      ])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([
      { reviewId: "rev-1", wereadBookId: "weread-1", wereadTitle: "Title A", wereadAuthor: "Author A", selectedCatalogId: "13000000_000000000001", candidates: [] },
      { reviewId: "rev-2", wereadBookId: "weread-2", wereadTitle: "Title A", wereadAuthor: "Author A", selectedCatalogId: "13000000_000000000001", candidates: [] },
    ]));

    const stdout = runReview(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    expect(stdout).toContain("duplicateCatalogIdGroups=1");
    expect(stdout).toContain("duplicateCatalogIdEntries=2");
    expect(stdout).toContain("candidateDecisionNeeded=0");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    expect(summary.duplicateCatalogIdGroups).toBe(1);
    expect(summary.duplicateCatalogIdEntries).toBe(2);
    expect(summary.candidateDecisionNeeded).toBe(0);
  });

  it("empty when no duplicates", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([
        { wereadBookId: "weread-1", catalogId: "13000000_000000000001", ssid: "13000000", dxid: "000000000001", isbn: "9780000000000", matchMethod: "title_author", matchConfidence: "high" },
      ])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([
      { reviewId: "rev-1", wereadBookId: "weread-1", wereadTitle: "Title A", wereadAuthor: "Author A", selectedCatalogId: "13000000_000000000001", candidates: [] },
    ]));

    const stdout = runReview(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    expect(stdout).toContain("duplicateCatalogIdGroups=0");
    expect(stdout).toContain("duplicateCatalogIdEntries=0");
    expect(stdout).toContain("candidateDecisionNeeded=0");
  });

  it("stdout does not leak catalogId or wereadBookId", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "review.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([
        { wereadBookId: "secret-weread-1", catalogId: "99999999_999999999999", ssid: "99999999", dxid: "999999999999", isbn: "9780000000000", matchMethod: "title_author", matchConfidence: "high" },
        { wereadBookId: "secret-weread-2", catalogId: "99999999_999999999999", ssid: "99999999", dxid: "999999999999", isbn: "9780000000000", matchMethod: "title_author", matchConfidence: "high" },
      ])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([
      { reviewId: "rev-1", wereadBookId: "secret-weread-1", wereadTitle: "Secret Title", wereadAuthor: "Secret Author", selectedCatalogId: "99999999_999999999999", candidates: [] },
      { reviewId: "rev-2", wereadBookId: "secret-weread-2", wereadTitle: "Secret Title", wereadAuthor: "Secret Author", selectedCatalogId: "99999999_999999999999", candidates: [] },
    ]));

    const stdout = runReview(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    expect(stdout).not.toContain("secret-weread-1");
    expect(stdout).not.toContain("99999999_999999999999");
    expect(stdout).not.toContain("Secret Title");
    expect(stdout).not.toContain("Secret Author");
  });
});
