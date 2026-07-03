import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReviewItem } from "./build-match-review.ts";

describe("build-match-review pure helpers", () => {
  it("builds pending review item from generated match with candidates", () => {
    const item = buildReviewItem(
      {
        wereadBookId: "wr_abc",
        title: "示例A",
        author: "作者A",
        candidates: [
          {
            catalogId: "cat_123",
            ssid: "ssid123",
            dxid: "dxid123",
            isbn: "9787111111111",
            title: "示例A",
            author: "作者A",
            matchMethod: "isbn",
            matchConfidence: "high",
            reason: "ISBN exact match",
          },
        ],
      },
      0,
      5,
      false,
    );
    expect(item.status).toBe("pending");
    expect(item.confidence).toBe("high");
    expect(item.candidates).toHaveLength(1);
    expect(item.selectedCatalogId).toBeNull();
  });

  it("marks no-candidate items as needs_manual_search", () => {
    const item = buildReviewItem(
      {
        wereadBookId: "wr_none",
        title: "示例B",
        author: "作者B",
        candidates: [],
      },
      1,
      5,
      false,
    );
    expect(item.status).toBe("needs_manual_search");
    expect(item.confidence).toBe("none");
    expect(item.candidates).toHaveLength(0);
  });

  it("auto-accepts high ISBN when enabled", () => {
    const item = buildReviewItem(
      {
        wereadBookId: "wr_auto",
        title: "示例C",
        author: "作者C",
        candidates: [
          {
            catalogId: "cat_auto",
            ssid: "ssid_auto",
            dxid: "dxid_auto",
            isbn: "9787222222222",
            title: "示例C",
            author: "作者C",
            matchMethod: "isbn",
            matchConfidence: "high",
            reason: "ISBN exact match",
          },
        ],
      },
      2,
      5,
      true,
    );
    expect(item.status).toBe("accepted");
    expect(item.decisionSource).toBe("auto_seed");
    expect(item.selectedCatalogId).toBe("cat_auto");
    expect(item.selectedCandidateIndex).toBe(0);
  });

  it("caps candidates to maxCandidates", () => {
    const item = buildReviewItem(
      {
        wereadBookId: "wr_many",
        title: "示例D",
        author: "作者D",
        candidates: Array.from({ length: 10 }, (_, i) => ({
          catalogId: `cat_${i}`,
          ssid: `ssid_${i}`,
          dxid: `dxid_${i}`,
          isbn: null,
          title: `示例D${i}`,
          author: `作者D${i}`,
          matchMethod: "title_similarity" as const,
          matchConfidence: "low" as const,
          reason: "similarity",
        })),
      },
      3,
      3,
      false,
    );
    expect(item.candidates).toHaveLength(3);
  });
});

describe("build-match-review CLI integration", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const builder = path.join(repoRoot, "scripts", "weread", "build-match-review.ts");

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-review-"));
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function runCli(matchesPath: string, outPath: string, extra: string[] = []): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const r = spawnSync(
      tsxBin,
      [builder, "--matches", matchesPath, "--out", outPath, "--summary", `${outPath}.summary.json`, ...extra],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  it("BLOCKED_ALREADY_EXISTS when output exists and no --overwrite", () => {
    const matches = path.join(tmpDir, "m1.json");
    fs.writeFileSync(matches, JSON.stringify([]));
    const out = path.join(tmpDir, "out1.json");
    fs.writeFileSync(out, "{}");
    const result = runCli(matches, out, []); // default, no overwrite
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/BLOCKED_ALREADY_EXISTS/);
  });

  it("PASS: builds review queue from generated matches without leaking titles", () => {
    const matches = path.join(tmpDir, "m2.json");
    fs.writeFileSync(
      matches,
      JSON.stringify([
        {
          wereadBookId: "wr_secret_aaa",
          title: "SECRET_TITLE",
          author: "SECRET_AUTHOR",
          candidates: [
            {
              catalogId: "cat_123",
              ssid: "ssid123",
              dxid: "dxid123",
              isbn: "9787111111111",
              title: "CATALOG_TITLE",
              author: "CATALOG_AUTHOR",
              matchMethod: "isbn",
              matchConfidence: "high",
              reason: "ISBN exact match",
            },
          ],
        },
        {
          wereadBookId: "wr_secret_bbb",
          title: "TITLE_B",
          author: "AUTHOR_B",
          candidates: [],
        },
      ]),
    );
    const out = path.join(tmpDir, "out2.json");
    const result = runCli(matches, out);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STATUS=PASS/);
    expect(result.stdout).toMatch(/total=2/);
    expect(result.stdout).toMatch(/pending=1/);
    expect(result.stdout).toMatch(/needs_manual_search=1/);
    expect(result.stdout).not.toContain("SECRET_TITLE");
    expect(result.stdout).not.toContain("SECRET_AUTHOR");
    expect(result.stdout).not.toContain("wr_secret_aaa");

    const queue = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(queue).toHaveLength(2);
    expect(queue[0].status).toBe("pending");
    expect(queue[0].confidence).toBe("high");
    expect(queue[1].status).toBe("needs_manual_search");
    expect(queue[1].confidence).toBe("none");
  });
});
