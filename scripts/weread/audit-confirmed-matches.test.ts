import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { execSync } from "node:child_process";

const runAudit = (args: string) => {
  return execSync(`./node_modules/.bin/tsx scripts/weread/audit-confirmed-matches.ts ${args}`, {
    cwd: "/opt/book-id-search",
    encoding: "utf8",
    env: { ...process.env, NO_PROXY: "*", no_proxy: "*" },
  });
};

function makeConfirmed(
  overrides: Partial<Record<string, unknown>> = {},
  base: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    wereadBookId: "weread-1",
    catalogId: "13000000_000000000001",
    ssid: "13000000",
    dxid: "000000000001",
    isbn: "9780000000000",
    matchMethod: "title_author",
    matchConfidence: "high",
    decisionSource: "auto_high_confidence",
    confirmedAt: "2026-07-03T00:00:00.000Z",
    confirmedBy: "local-user",
    ...base,
    ...overrides,
  };
}

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

describe("audit-confirmed-matches", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-audit-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clean confirmed PASS", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(confirmedPath, JSON.stringify([makeConfirmed()]));
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview()]));

    const stdout = runAudit(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    expect(stdout).toContain("STATUS=PASS");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    expect(summary.confirmedEntries).toBe(1);
    expect(summary.invalidRows).toBe(0);
    expect(summary.duplicateCatalogIdGroups).toBe(0);
  });

  it("duplicate catalogId WARN", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([
        makeConfirmed({ wereadBookId: "weread-1", catalogId: "13000000_000000000001" }),
        makeConfirmed({ wereadBookId: "weread-2", catalogId: "13000000_000000000001" }),
      ])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview(), makeReview({ reviewId: "rev-2", wereadBookId: "weread-2" })]));

    const stdout = runAudit(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    expect(stdout).toContain("STATUS=WARN");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    expect(summary.duplicateCatalogIdGroups).toBe(1);
    expect(summary.duplicateCatalogIdEntries).toBe(2);
  });

  it("duplicate wereadBookId BLOCKED", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([
        makeConfirmed({ wereadBookId: "weread-1", catalogId: "13000000_000000000001" }),
        makeConfirmed({ wereadBookId: "weread-1", catalogId: "13000000_000000000002" }),
      ])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview()]));

    expect(() =>
      runAudit(
        `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
      )
    ).toThrow();
  });

  it("invalid matchMethod BLOCKED", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([makeConfirmed({ matchMethod: "bad_method" })])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview()]));

    expect(() =>
      runAudit(
        `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
      )
    ).toThrow();
  });

  it("invalid matchConfidence BLOCKED", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([makeConfirmed({ matchConfidence: "ultra" })])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview()]));

    expect(() =>
      runAudit(
        `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
      )
    ).toThrow();
  });

  it("review queue mismatch WARN", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([makeConfirmed({ wereadBookId: "missing-id" })])
    );
    fs.writeFileSync(reviewPath, JSON.stringify([makeReview()]));

    const stdout = runAudit(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    expect(stdout).toContain("STATUS=WARN");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    expect(summary.reviewConsistencyWarnings).toBe(1);
  });

  it("stdout does not leak wereadBookId or catalogId", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([makeConfirmed({ wereadBookId: "secret-weread-123", catalogId: "99999999_999999999999" })])
    );
    fs.writeFileSync(
      reviewPath,
      JSON.stringify([makeReview({ wereadBookId: "secret-weread-123", selectedCatalogId: "99999999_999999999999" })])
    );

    const stdout = runAudit(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    expect(stdout).not.toContain("secret-weread-123");
    expect(stdout).not.toContain("99999999_999999999999");
    expect(stdout).not.toContain("Title A");
    expect(stdout).not.toContain("Author A");
  });

  it("summary only contains counts", () => {
    const confirmedPath = path.join(tmpDir, "confirmed.json");
    const reviewPath = path.join(tmpDir, "review.json");
    const outPath = path.join(tmpDir, "audit.json");
    const summaryPath = path.join(tmpDir, "summary.json");
    fs.writeFileSync(
      confirmedPath,
      JSON.stringify([makeConfirmed({ wereadBookId: "secret-weread-123", catalogId: "99999999_999999999999" })])
    );
    fs.writeFileSync(
      reviewPath,
      JSON.stringify([makeReview({ wereadBookId: "secret-weread-123", selectedCatalogId: "99999999_999999999999" })])
    );

    runAudit(
      `--confirmed ${confirmedPath} --review ${reviewPath} --out ${outPath} --summary ${summaryPath}`
    );
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const summaryStr = JSON.stringify(summary);
    expect(summaryStr).not.toContain("secret-weread-123");
    expect(summaryStr).not.toContain("99999999_999999999999");
    expect(summaryStr).toContain("confirmedEntries");
    expect(summaryStr).toContain("duplicateCatalogIdGroups");
  });
});
