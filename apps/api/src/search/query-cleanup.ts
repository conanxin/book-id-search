// ------------------------------------------------------------------
// Query cleanup (S24-1).
// ------------------------------------------------------------------
// Pure helpers. No I/O, no Meili access. Used by /api/search (and
// optionally by /api/ai/search-intent) to strip Chinese "operation
// words" (查一下 / 帮我找 / 有没有 / ...), generic bibliographic
// nouns (的书 / 书籍 / 资料 / ...), and connective filler (关于 /
// 这类 / ...) before sending the query to Meilisearch.
//
// Why this exists:
//   "查一下北京旅游的书" should hit "北京旅游" guides, not the
//   "查斯特菲尔德伯爵家训" row (which currently happens because the
//   single-character "查" in "查询" + "查找" + Meili typo-tolerance
//   fuzzy-matches the leading "查" of the latter title). Stripping
//   the operation word kills the spurious hit.
//
// Identifier safety:
//   The cleanup ONLY runs when `detectedType` is "text" or
//   "numeric". ISBN / SSID / DXID queries are returned as-is,
//   because the rules below would also eat "X" in ISBN-10 check
//   digits or short-numeric forms that look like 短语 tokens.
//
// Empty / whitespace fallback:
//   If the cleanup removes everything, we fall back to the
//   `original` (post-trim) so the user still gets a result rather
//   than a 400 / 500.
//
// Anti-corruption:
//   - Never deletes identifiers
//   - Never deletes ISBN-10 trailing 'X' (kept by virtue of
//     identifier short-circuit)
//   - Never deletes a single Chinese char (would over-eat titles
//     like "查")
//   - Never replaces the original — `cleaned` is a *separate*
//     string, callers decide whether/how to merge with the
//     original.

import type { QueryType } from "./normalize.js";

export interface CleanedQuery {
  original: string;
  cleaned: string;
  /** Phrases that were stripped, in source order. Useful for UI. */
  removedPhrases: string[];
  /** Whether the cleaned string differs from the trimmed original. */
  changed: boolean;
  cleanupConfidence: "none" | "low" | "medium" | "high";
}

/**
 * Chinese operation phrases that should be stripped from natural
 * language queries. Order matters: longer phrases first so a
 * longest-match scan catches "帮我找一本" before "帮我找".
 *
 * Adding a new phrase: append to this list AND to the test cases in
 * `apps/api/src/search/query-cleanup.test.ts` (or the
 * `scripts/search-quality-cases.ts` regression). Do not add bare
 * single Chinese characters — they over-eat real titles.
 */
const OPERATION_PHRASES: string[] = [
  "请帮我找",
  "请帮我查",
  "请帮我",
  "请查",
  "请找",
  "帮忙找一下",
  "帮忙找一本",
  "帮忙找",
  "帮我找一本",
  "帮我找一下",
  "帮我找",
  "帮我查一下",
  "帮我查",
  "我想找",
  "我想看",
  "我想看一本",
  "想找一本",
  "想看一本",
  "找一本",
  "找一下",
  "查一下",
  "查一查",
  "查查",
  "有没有",
  "查询",
  "搜索",
  "这本",
  "这个",
  "这些",
  "那本",
  "一下",
  "一下儿",
];

/**
 * Generic bibliographic nouns / discourse nouns. These almost
 * never carry search intent on their own. Keep this list narrow
 * — over-eager noun stripping hurts recall.
 */
const GENERIC_BOOK_NOUNS: string[] = [
  "相关图书",
  "相关书",
  "相关的书",
  "这类的书",
  "这类的图书",
  "类似的图书",
  "类似的书",
  "这方面的书",
  "这方面的图书",
  "方面",
  "类型",
  "这类",
  "类似",
  "相关",
  "书籍",
  "图书",
  "的书",
  "的书呢",
  "的书啊",
  "书呢",
  "书啊",
  "的书吧",
  "资料",
  "推荐",
  "文献",
  "材料",
];

/**
 * Connective / preposition phrases that introduce the actual
 * subject. Keep these in their own list because they only appear
 * as a leading prefix ("关于 X 的书") and not inside a title.
 */
const CONNECTIVE_PHRASES: string[] = [
  "关于",
  "有关",
  "请",  // polite request particle, leading only
];

/**
 * Strips a single Chinese phrase (must be a contiguous substring
 * of `text`) and trims the gap. The leading/trailing gap of
 * ASCII whitespace and the Chinese particle 的 / 啊 / 呢 / 吧 is
 * collapsed to a single space.
 */
function stripPhrase(text: string, phrase: string): string {
  if (!text.includes(phrase)) return text;
  return text.split(phrase).join(" ");
}

/**
 * Strip whitespace + Chinese particles around a removed span.
 * Returns the joined-with-space result, then re-normalizes
 * whitespace so we don't end up with " " padding or "   " runs.
 */
function compactSpaces(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, " ")   // any whitespace including ideographic space
    .replace(/^[的了吗呢吧啊呀哦哇\s]+/u, "")
    .replace(/[的了吗呢吧啊呀哦哇\s]+$/u, "")
    .trim();
}

/**
 * Main entry. Returns the original, the cleaned, the phrases that
 * were removed, whether anything changed, and a confidence bucket.
 *
 * Confidence is based on the count of removed phrases and how much
 * of the original was removed (in characters):
 *   - none  : nothing removed
 *   - low   : 1-2 short phrases removed, or < 30% of original length
 *   - medium: 3+ phrases removed, or 30-60% of original length
 *   - high  : 60%+ of original length removed (likely the user gave
 *             us only a "search wrapper" string)
 */
export function cleanNaturalLanguageQuery(
  query: string,
  detectedType: QueryType,
): CleanedQuery {
  const original = (query ?? "").toString();
  const trimmed = original.trim();
  const removedPhrases: string[] = [];

  if (!trimmed) {
    return {
      original,
      cleaned: "",
      removedPhrases,
      changed: false,
      cleanupConfidence: "none",
    };
  }

  // Identifier queries are returned untouched.
  if (detectedType === "isbn" || detectedType === "ssid" || detectedType === "dxid") {
    return {
      original,
      cleaned: trimmed,
      removedPhrases,
      changed: false,
      cleanupConfidence: "none",
    };
  }

  let working = trimmed;

  // Strip operation phrases. Two-pass sort to make the order
  // deterministic and produce the cleanest residue:
  //   1. Longer phrases first ("帮我找一本" wins over "帮我找")
  //   2. Within the same length, phrases that START with "请"
  //      come first ("请帮我查" wins over "帮我查一下") so the
  //      polite particle gets eaten in the same pass.
  const opsSorted = [...OPERATION_PHRASES].sort((a, b) => {
    // Effective length: a "请"-leading phrase is treated as if it
    // were 1 char longer, so it gets to match first and consume
    // the polite "请" in the same pass. E.g. "请帮我查" (4) sorts
    // as 5, beating "帮我查一下" (5) which sorts as 5.
    const aLen = a.length + (a.startsWith("请") ? 1 : 0);
    const bLen = b.length + (b.startsWith("请") ? 1 : 0);
    if (bLen !== aLen) return bLen - aLen;
    return 0;
  });
  for (const phrase of opsSorted) {
    if (working.includes(phrase)) {
      working = compactSpaces(stripPhrase(working, phrase));
      removedPhrases.push(phrase);
    }
  }

  // Strip connective phrases only at the start of the string.
  // "关于 / 有关" mid-title is rare; we anchor to start to avoid
  // eating title content like "建筑有关法规". "请" is a polite
  // particle and we only strip it at the start if the very next
  // char is a known request verb (帮 / 查 / 找 / 给), to avoid
  // eating real titles like "请回答1988" / "请柬".
  const REQUEST_VERBS = /^[帮查找给]/;
  for (const phrase of CONNECTIVE_PHRASES) {
    if (working.startsWith(phrase)) {
      if (phrase === "请") {
        // Strict: only strip "请" if the request verb is right
        // after, or after a 1-char "您" honorific.
        const rest = working.slice(1);
        if (!REQUEST_VERBS.test(rest) && !rest.startsWith("您")) {
          continue;
        }
      }
      working = compactSpaces(working.slice(phrase.length));
      removedPhrases.push(phrase);
    }
  }

  // Strip generic book nouns. Iterate a few times so e.g. "的书
  // 资料" both get caught when adjacent, and so order doesn't
  // matter.
  let prev = "";
  let safety = 0;
  while (prev !== working && safety < 8) {
    prev = working;
    safety += 1;
    let removedThisRound = false;
    for (const noun of GENERIC_BOOK_NOUNS) {
      if (working.includes(noun)) {
        working = compactSpaces(stripPhrase(working, noun));
        removedPhrases.push(noun);
        removedThisRound = true;
      }
    }
    if (!removedThisRound) break;
  }

  // Strip any leftover leading/trailing 的/了 and any remaining
  // trailing bare 1-character "书" that was a generic suffix
  // (only when there's content before it).
  working = working
    .replace(/^[的了\s]+/u, "")
    .replace(/[的了\s]+$/u, "")
    // Trailing bare "书" after at least 2 Chinese chars: common
    // generic suffix. Carefully NOT triggered in the middle of a
    // longer phrase because regex is anchored to end.
    .replace(/([\u4e00-\u9fa5]{2,})书$/u, "$1");

  const cleaned = compactSpaces(working);

  // Re-strip any leftover bare "书" that the generic pass missed
  // (e.g. "披肩 书" after removing a "推荐" suffix left a
  // space). Only the trailing 1-char "书" case.
  const cleanedWithBookSuffixStripped = cleaned.replace(
    /([\u4e00-\u9fa5])\s+书$/u,
    "$1",
  );
  if (cleanedWithBookSuffixStripped !== cleaned) {
    removedPhrases.push("书(generic suffix)");
  }

  // Fallback: if cleanup nuked everything, return the trimmed
  // original so we don't 400 / return an empty page.
  const finalCleaned = cleanedWithBookSuffixStripped || trimmed;

  const changed = finalCleaned !== trimmed;

  // Confidence bucket.
  const originalLen = trimmed.length;
  const removedChars = originalLen - finalCleaned.length;
  const ratio = originalLen > 0 ? removedChars / originalLen : 0;
  let cleanupConfidence: CleanedQuery["cleanupConfidence"] = "none";
  if (changed) {
    if (removedPhrases.length >= 3 || ratio >= 0.6) cleanupConfidence = "high";
    else if (removedPhrases.length >= 2 || ratio >= 0.3) cleanupConfidence = "medium";
    else cleanupConfidence = "low";
  }

  return {
    original,
    cleaned: finalCleaned,
    removedPhrases,
    changed,
    cleanupConfidence,
  };
}
