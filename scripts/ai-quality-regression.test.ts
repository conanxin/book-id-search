import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Tests for the AI quality regression runner.
 *
 * These tests check structural correctness, not live AI behavior.
 * Live behavior is exercised by `pnpm ai:quality` against the real API.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(ROOT, "scripts/ai-quality-regression.ts");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");
describe("ai-quality-regression.ts", () => {
  it("script file exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("script file does not contain hardcoded keys", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });

  it("runner accepts --public-url flag", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--public-url");
  });

  it("runner accepts --max-ai-calls flag", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--max-ai-calls");
  });

  it("runner accepts --case flag for filtering", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--case");
  });

  it("runner accepts --mode smoke", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--mode");
    expect(content).toContain("smoke");
  });

  it("runner accepts --json and --markdown output paths", () => {
    const content = execSync(`cat ${SCRIPT}`, { encoding: "utf8" });
    expect(content).toContain("--json");
    expect(content).toContain("--markdown");
  });

  it("package.json registers ai:quality script", () => {
    const pkg = JSON.parse(execSync(`cat ${ROOT}/package.json`, { encoding: "utf8" }));
    expect(pkg.scripts["ai:quality"]).toBeTruthy();
  });

  it("tsx binary is available locally", () => {
    expect(existsSync(TSX)).toBe(true);
  });
});

/**
 * S23.1 — unit tests for the negative-limitation forbidden-claim
 * classifier. These exercise `findForbiddenClaimHits` directly, without
 * hitting the live AI endpoint, so they're fast and deterministic.
 *
 * The classifier is called from the `no-forbidden-claims` check; it
 * must let legitimate negative/limitation phrasing through (so the
 * `insight-complete-book` and `insight-weak-missing-isbn` cases pass
 * again), while still flagging positive unsupported full-text claims
 * (e.g. "本书详细介绍了...").
 */
describe("findForbiddenClaimHits (S23.1)", () => {
  // Import via dynamic import because the source is TS and the test
  // runner uses vitest's own transform path for it.
  const importClassifier = async () => {
    const mod = await import("./ai-quality-regression.ts");
    return mod.findForbiddenClaimHits as (
      text: string,
      terms: string[],
    ) => { positive: string[]; negated: string[] };
  };

  const TERMS = [
    "本书详细介绍",
    "本书详细介绍了",
    "本书详细讲述",
    "本书讲述了",
    "本书通过详细",
    "本书通过",
    "本书深入",
    "书中详细",
    "内容简介",
    "内容详尽",
    "读者评价",
    "作者生平",
    "书中指出",
    "获得奖项",
    "获奖情况",
    "销量",
    "影响力",
    "被翻译成",
  ];

  describe("allowed: negative / limitation phrasing", () => {
    const allowed = [
      "但本书未提供目录或内容简介",
      "缺少作者背景和内容简介等辅助验证信息",
      "由于没有图书全文，不能判断具体章节内容",
      "仅基于书目信息，不代表图书全文内容",
      "未获得目录，建议核对原始记录",
      "未提供ISBN，无法核对版本",
      "没有完整的读者评价可以参考",
      "目录缺失，建议结合原始记录核对",
      "以下分析仅基于书目信息，不涉及图书全文",
      "由于没有作者生平等辅助信息，只能基于书目字段做有限判断",
      "由于无法判断具体章节内容，trustAssessment.level = low",
      "未参考任何外部评价、目录或读者评论",
      "书中无完整内容简介，仅根据标题与版本信息做有限判断",
    ];

    for (const sentence of allowed) {
      it(`PASS: ${sentence}`, async () => {
        const f = await importClassifier();
        const { positive, negated } = f(JSON.stringify({ x: sentence }), TERMS);
        expect(positive).toEqual([]);
        // At least one term should be classified as negated, OR the
        // sentence contains no forbidden terms (a few of these are
        // meta-caveats that don't include any book-content term).
        // Either way positive must be empty.
        expect(positive.length).toBe(0);
        // We expect most of these to actually trigger at least one
        // negated term — make that the common case (>= 70% of the
        // allowed sentences should have negated > 0). We don't
        // strictly assert it for every sentence because some
        // sentences (e.g. "由于没有图书全文…") may not include any
        // configured forbidden term verbatim.
        if (negated.length === 0) {
          // OK: no configured term appears, so trivially passes.
        }
      });
    }
  });

  describe("forbidden: positive full-text claims", () => {
    // Each test sentence is constructed so that it includes a
    // verbatim positive-claim phrase from the configured `TERMS`
    // list. (The regression only flags configured terms, so a
    // sentence like "目录显示本书包括材料准备" would not be flagged
    // by `findForbiddenClaimHits` because neither "目录显示" nor
    // "包括" is in TERMS. We test the mechanism, not the spec list
    // of example phrases — those are covered indirectly by
    // `FORBIDDEN_FULL_CONTENT_PHRASES` in the sanitizer.)
    const forbidden = [
      "本书详细介绍了披肩制作流程",      // hits "本书详细介绍了"
      "本书深入分析了辽代金银器的艺术特征", // hits "本书深入"
      "本书通过详细讲解每一步",          // hits "本书通过详细", "本书通过"
      "内容详尽，适合作为入门教材",       // hits "内容详尽"
      "获奖情况丰富",                    // hits "获奖情况"
      "本书获得奖项",                    // direct hit on "获得奖项"
      "本书讲述了作者的创作灵感",        // hits "本书讲述了"
      "书中详细描绘了辽代生活",         // hits "书中详细"
      "书中指出该方法适合初学者",        // hits "书中指出"
      "读者评价认为本书非常实用",        // hits "读者评价"  (positive verb "认为" in sentence)
      "被翻译成多国语言",                // hits "被翻译成"
    ];

    for (const sentence of forbidden) {
      it(`FAIL: ${sentence}`, async () => {
        const f = await importClassifier();
        const { positive, negated } = f(
          JSON.stringify({ x: sentence }),
          TERMS,
        );
        // At least one of the configured terms must be flagged as
        // positive (not negated). This is the "case should FAIL"
        // condition.
        expect(positive.length).toBeGreaterThan(0);
        // And those positive terms should NOT be in the negated list.
        for (const p of positive) {
          expect(negated).not.toContain(p);
        }
      });
    }
  });

  describe("edge cases", () => {
    it("returns empty positive/negated for empty text", async () => {
      const f = await importClassifier();
      expect(f("", TERMS)).toEqual({ positive: [], negated: [] });
    });

    it("returns empty positive/negated for empty terms list", async () => {
      const f = await importClassifier();
      expect(f("some text 内容简介 here", [])).toEqual({
        positive: [],
        negated: [],
      });
    });

    it("does not flag terms that don't appear in the text", async () => {
      const f = await importClassifier();
      const { positive, negated } = f(
        JSON.stringify({ x: "一本普通的编织书" }),
        TERMS,
      );
      expect(positive).toEqual([]);
      expect(negated).toEqual([]);
    });

    it("does not over-negate: positive phrase embedded in a caveat still FAILs", async () => {
      const f = await importClassifier();
      // "本书详细介绍了披肩制作流程" embedded inside a meta-caveat
      // sentence should still be flagged. (Rule C allows book-content
      // terms; positive full-text phrases like "本书详细介绍了" are
      // not in the meta-limitation cue set, so they should still
      // surface as positive.)
      const { positive } = f(
        JSON.stringify({
          scopeNote: "以下分析仅基于书目信息，不代表图书全文内容",
          shortSummary: "本书详细介绍了披肩制作流程",
        }),
        TERMS,
      );
      expect(positive).toContain("本书详细介绍了");
    });

    it("handles long gap between negator and term (12-char window)", async () => {
      const f = await importClassifier();
      // Negator 0–12 chars before term should be negated. Exactly 12
      // chars is the upper bound; 13 chars should NOT be negated.
      // Use a clearly-countable ASCII gap so the test doesn't
      // miscount Chinese characters.
      const within = "未提供abcdefghijkl内容简介"; // 12 ASCII chars between negator and term
      const beyond = "未提供abcdefghijklm内容简介"; // 13 ASCII chars
      expect(
        f(JSON.stringify({ x: within }), ["内容简介"]).positive,
      ).toEqual([]);
      expect(
        f(JSON.stringify({ x: within }), ["内容简介"]).negated,
      ).toContain("内容简介");
      // 13 chars exceeds the window — should be flagged positive.
      expect(
        f(JSON.stringify({ x: beyond }), ["内容简介"]).positive,
      ).toContain("内容简介");
    });

    it("Rule A catches '但本书未提供目录或内容简介' (12 chars gap)", async () => {
      const f = await importClassifier();
      const text = "但本书未提供目录或内容简介";
      const { positive, negated } = f(JSON.stringify({ x: text }), [
        "内容简介",
        "目录",
      ]);
      expect(positive).toEqual([]);
      expect(negated).toContain("内容简介");
    });

    it("Rule A catches '缺少作者背景和内容简介等辅助验证信息' (7 chars gap)", async () => {
      const f = await importClassifier();
      const text = "缺少作者背景和内容简介等辅助验证信息";
      const { positive, negated } = f(JSON.stringify({ x: text }), [
        "内容简介",
        "作者生平",
      ]);
      expect(positive).toEqual([]);
      expect(negated).toContain("内容简介");
    });
  });
});
