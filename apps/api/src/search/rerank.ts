// ------------------------------------------------------------------
// Local rerank layer (S19-4 / S19-C2 / S19-C3 / S24-3).
// ------------------------------------------------------------------
// The goal is to surface "this is why this row came first" without
// touching Meilisearch's index settings. We over-fetch from Meili,
// compute a small local score for each hit, sort, then slice the page.
//
// Ordering priorities (highest first):
//   1. exact ISBN / SSID / DXID / exact_identifier
//   2. exact title
//   3. title hit
//   4. author hit
//   5. publisher hit
//   6. mixed
//   7. unknown
// Then within the same priority bucket:
//   - parseStatus: ok > weak > failed
//   - local match score (higher = better)
//   - Meili's _rankingScore as a secondary tiebreaker so we don't
//     shuffle Meili's own ordering more than necessary.
//
// S24-3 also exposes `rankSearchResults(hits, context)` which adds
// intent-aware rerank + an explainable `ranking` block per item,
// suitable for surfacing in the front-end.

import { type MatchInfo } from "./match.js";
import type { IntentProfile } from "./intent-profile.js";
import type { QueryType } from "./normalize.js";

export interface RerankHit {
  match: MatchInfo | null | undefined;
  parseStatus?: "ok" | "weak" | "failed" | string;
  _rankingScore?: number;
  [key: string]: unknown;
}

export type ExactMatchType =
  | "exact_identifier"
  | "exact_isbn"
  | "exact_ssid"
  | "exact_dxid"
  | "exact_title";

/**
 * Context passed to `rankSearchResults`. The rerank layer uses
 * the cleaned query + intent profile to compute a per-item score
 * and an evidence trail that explains why this row came first.
 */
export interface RerankContext {
  originalQuery: string;
  normalizedQuery: string;
  cleanedQuery: string;
  /** Tokenized terms from the cleaned query. Empty for identifier
   *  queries. */
  queryTerms: string[];
  detectedType: QueryType;
  intentProfile: IntentProfile;
}

export interface RankingEvidence {
  /** Final local score. Higher = better. May be negative for
   *  heavily-penalized rows. */
  score: number;
  /** Field names that contributed positively. */
  fieldHits: string[];
  /** Whether the cleanedQuery is a substring of the title. */
  phraseMatch: boolean;
  /** Intent-positive terms found in the title. */
  intentBoosts: string[];
  /** Intent-negative terms found in the title. */
  intentPenalties: string[];
  /** Human-readable explanation strings. Surfaced to the UI. */
  evidence: string[];
}

export interface RankedHit extends RerankHit {
  ranking: RankingEvidence;
}

const PARSE_STATUS_RANK: Record<string, number> = {
  ok: 3,
  weak: 2,
  failed: 1,
};

function priorityFor(match: MatchInfo | null | undefined): number {
  const t = match?.type;
  if (t === "exact_isbn" || t === "exact_ssid" || t === "exact_dxid" || t === "exact_identifier") {
    return 100;
  }
  if (t === "exact_title") return 90;
  if (t === "title") return 80;
  if (t === "author") return 70;
  if (t === "publisher") return 60;
  if (t === "mixed") return 50;
  return 0;
}

/**
 * Defensive exact-match predicate. Returns true only when `match` is a
 * well-formed MatchInfo whose `type` is one of the exact_* values.
 * Never throws — null / undefined / malformed input returns false.
 *
 * Used by the exact-identifier branch in handleSearch to confirm an
 * exact hit before short-circuiting, and by the rerank priority sort.
 */
export function isExactMatchType(match: MatchInfo | null | undefined): boolean {
  if (!match || typeof match.type !== "string") return false;
  const t: string = match.type;
  return (
    t === "exact_identifier" ||
    t === "exact_isbn" ||
    t === "exact_ssid" ||
    t === "exact_dxid" ||
    t === "exact_title"
  );
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function contains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.includes(needle);
}

/**
 * Compute the S24-3 ranking block for a single hit. Pure function
 * over the hit's `title / author / publisher / parseStatus /
 * match` and the context's `cleanedQuery / queryTerms /
 * intentProfile`. Returns an explainable `RankingEvidence` object
 * that the front-end can render as a chip / tooltip.
 */
export function computeRanking(
  hit: RerankHit,
  context: RerankContext,
): RankingEvidence {
  const title = asString(hit.title);
  const author = asString(hit.author);
  const publisher = asString(hit.publisher);
  const parseStatus = asString(hit.parseStatus);
  const match = hit.match;

  const fieldHits: string[] = [];
  const evidence: string[] = [];
  const intentBoosts: string[] = [];
  const intentPenalties: string[] = [];

  let score = 0;

  // 1. Exact identifier (handled by the caller via match.type
  //    priority, but we add a small +1000 here so the ranking
  //    block explains the same decision the priority sort made).
  if (isExactMatchType(match)) {
    score += 1000;
    fieldHits.push(match?.type ?? "exact_identifier");
    evidence.push("标识符精确匹配");
  }

  // 2. Exact title.
  if (match?.type === "exact_title") {
    score += 500;
    fieldHits.push("title");
    evidence.push("书名完全一致");
  }

  // 3. Phrase match: cleanedQuery is a substring of the title.
  const cleaned = context.cleanedQuery;
  const phraseMatch = cleaned.length >= 2 && contains(title, cleaned);
  if (phraseMatch) {
    score += 120;
    fieldHits.push("title(phrase)");
    evidence.push(`书名完整包含「${cleaned}」`);
  }

  // 4. All major terms in title.
  const majorTerms = context.queryTerms.filter((t) => t.length >= 2);
  if (majorTerms.length > 0) {
    const allInTitle = majorTerms.every((t) => contains(title, t));
    if (allInTitle) {
      score += 80;
      fieldHits.push("title(major-terms)");
      evidence.push("书名包含全部主要词");
    } else {
      // 5. Any major term in title.
      const anyInTitle = majorTerms.some((t) => contains(title, t));
      if (anyInTitle) {
        score += 40;
        fieldHits.push("title(some-terms)");
        evidence.push("书名包含部分主要词");
      }
    }
  }

  // 6. Author term match.
  if (majorTerms.length > 0 && majorTerms.some((t) => contains(author, t))) {
    score += 35;
    fieldHits.push("author");
    evidence.push("作者命中");
  }

  // 7. Publisher term match.
  if (majorTerms.length > 0 && majorTerms.some((t) => contains(publisher, t))) {
    score += 25;
    fieldHits.push("publisher");
    evidence.push("出版社命中");
  }

  // 8. parseStatus: ok +20, weak +5, failed -30.
  if (parseStatus === "ok") {
    score += 20;
    evidence.push("记录完整（ok）");
  } else if (parseStatus === "weak") {
    score += 5;
    evidence.push("记录弱解析（weak）");
  } else if (parseStatus === "failed") {
    score -= 30;
    evidence.push("记录解析失败（failed）");
  }

  // 9. Intent positive terms in title.
  for (const term of context.intentProfile.positiveTerms) {
    if (term && contains(title, term)) {
      score += 20;
      intentBoosts.push(term);
      fieldHits.push(`intent(+${term})`);
    }
  }
  if (intentBoosts.length > 0) {
    evidence.push(`已加权：${context.intentProfile.label}类（${intentBoosts.join("、")}）`);
  }

  // 10. Intent negative terms in title.
  for (const term of context.intentProfile.negativeTerms) {
    if (term && contains(title, term)) {
      score -= 15;
      intentPenalties.push(term);
      fieldHits.push(`intent(-${term})`);
    }
  }
  if (intentPenalties.length > 0) {
    evidence.push(`已降权：${context.intentProfile.label}类排除词（${intentPenalties.join("、")}）`);
  }

  // 11. Single-character-only match penalty.
  //     Catches cases like "查" matching "查斯特菲尔德" — the title
  //     has the user's cleaned term only as a single-character
  //     substring and nothing else matches. This is the S24 fix for
  //     the "查一下北京旅游的书" -> "查斯特菲尔德伯爵家训" bug.
  if (cleaned.length === 1 && contains(title, cleaned) && majorTerms.length === 0) {
    // Only when cleaned is a single char AND there are no major
    // terms to anchor on. (When the user typed just "查", a title
    // starting with "查" is a weak signal at best.)
    if (!intentBoosts.length) {
      score -= 50;
      evidence.push("单字匹配降权（避免误命中）");
    }
  }

  // 12. Very weak title match with irrelevant author/publisher.
  //     Title contains 0 major terms AND author/publisher are
  //     also irrelevant. Heavy penalty to push the row down.
  if (
    majorTerms.length > 0 &&
    !majorTerms.some((t) => contains(title, t)) &&
    !majorTerms.some((t) => contains(author, t)) &&
    !majorTerms.some((t) => contains(publisher, t))
  ) {
    score -= 20;
    evidence.push("标题、作者、出版社均无相关词");
  }

  return {
    score,
    fieldHits,
    phraseMatch,
    intentBoosts,
    intentPenalties,
    evidence,
  };
}

/**
 * Rerank + attach explainable ranking block. Returns a NEW array
 * (does not mutate the input). Items are sorted by:
 *   1. priority (exact > title > author > publisher > mixed > unknown)
 *   2. parseStatus (ok > weak > failed)
 *   3. ranking.score (higher = better)
 *   4. _rankingScore from Meili (tiebreaker)
 *   5. original index (stable)
 */
export function rankSearchResults(
  hits: RerankHit[],
  context: RerankContext,
): RankedHit[] {
  const indexed = hits.map((hit, idx) => {
    const priority = priorityFor(hit.match);
    const parseRank = PARSE_STATUS_RANK[String(hit.parseStatus ?? "")] ?? 0;
    const ranking = computeRanking(hit, context);
    const remote = typeof hit._rankingScore === "number" ? hit._rankingScore : 0;
    return { hit, idx, priority, parseRank, ranking, remote };
  });

  indexed.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.parseRank !== b.parseRank) return b.parseRank - a.parseRank;
    if (a.ranking.score !== b.ranking.score) return b.ranking.score - a.ranking.score;
    if (a.remote !== b.remote) return b.remote - a.remote;
    return a.idx - b.idx;
  });

  return indexed.map((entry) => ({
    ...entry.hit,
    ranking: entry.ranking,
  })) as RankedHit[];
}

/**
 * Legacy rerank: keep the S19 signature working for callers that
 * don't yet know about intent / ranking evidence. Returns the
 * same array reference, sorted.
 *
 * New code should use `rankSearchResults` instead.
 */
export function rerank(hits: RerankHit[]): RerankHit[] {
  const indexed = hits.map((hit, idx) => {
    const priority = priorityFor(hit.match);
    const parseRank = PARSE_STATUS_RANK[String(hit.parseStatus ?? "")] ?? 0;
    const local = hit.match && typeof hit.match.score === "number" ? hit.match.score : 0;
    const remote = typeof hit._rankingScore === "number" ? hit._rankingScore : 0;
    return { hit, idx, priority, parseRank, local, remote };
  });
  indexed.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.parseRank !== b.parseRank) return b.parseRank - a.parseRank;
    if (a.local !== b.local) return b.local - a.local;
    if (a.remote !== b.remote) return b.remote - a.remote;
    return a.idx - b.idx;
  });
  for (let i = 0; i < indexed.length; i += 1) {
    hits[i] = indexed[i].hit;
  }
  return hits;
}

/** Decide how many extra hits to ask Meili for. Pure `limit*3`, capped at 100.
 *  S24-4 raises this to `limit*5`, capped at 120, but the new
 *  function lives in `index.ts` so the rerank module stays
 *  transport-only. */
export function rerankFetchSize(limit: number): number {
  return Math.min(Math.max(limit * 3, 1), 100);
}