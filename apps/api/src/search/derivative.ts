// ------------------------------------------------------------------
// Derivative work detection (S28-R2).
// ------------------------------------------------------------------
// Pure helpers used by the exact_title tie-break in `rerank.ts`.
// Identifies obviously-derivative works (脚本化、改编、缩写、评注 等)
// so they can be ordered BELOW clean editions of the same title.
//
// Out of scope (NOT detected as derivative — these are legitimate
// editions of the original work, not derivative works):
//   - 译 / 译者 / 翻译 / 译本   (translations)
//   - 注释 / 注解              (annotations — see also 评注 below)
//   - 序 / 跋 / 后记 / 代序 /  (prefaces / / postscript)
// 前言 / 导读 vs 评注 — we treat 导读 as derivative (study-guide style)
// while leaving 序/跋/前言 untouched. The list is intentionally narrow.

const DERIVATIVE_TOKENS: readonly string[] = [
  "编剧",
  "改编",
  "改编本",
  "导读",
  "评注",
  "缩写",
  "缩编",
  "简写",
  "选编",
];

export interface DerivativeCheckable {
  // S28-R2I: add the index signature so any RerankHit (which has
  // `[key: string]: unknown`) is structurally assignable. Without
  // this, tsc reports TS2559 ("no properties in common") because
  // the explicit properties (title/author) don't overlap with
  // RerankHit's explicit properties (match/parseStatus/_rankingScore).
  [key: string]: unknown;
  title?: unknown;
  author?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Returns `true` when the hit's title or author contains any
 * obviously-derivative marker from `DERIVATIVE_TOKENS`.
 *
 * Defensive: never throws on missing/non-string fields; missing
 * title/author are treated as empty. Translations (译/译者/翻译/译本)
 * are NOT flagged — those are legitimate editions of the original
 * work, not derivative works.
 */
export function isDerivative(hit: DerivativeCheckable): boolean {
  const text = `${asString(hit.title)} ${asString(hit.author)}`;
  for (const token of DERIVATIVE_TOKENS) {
    if (text.includes(token)) return true;
  }
  return false;
}

/**
 * Returns the matched derivative tokens (empty array if none).
 * Useful for tests and for surfacing in the explainable ranking block.
 */
export function derivativeTokens(hit: DerivativeCheckable): string[] {
  const text = `${asString(hit.title)} ${asString(hit.author)}`;
  const matches: string[] = [];
  for (const token of DERIVATIVE_TOKENS) {
    if (text.includes(token)) matches.push(token);
  }
  return matches;
}