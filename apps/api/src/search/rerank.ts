// ------------------------------------------------------------------
// Local rerank layer (S19-4 / S19-C2 / S19-C3).
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

import { type MatchInfo } from "./match.js";

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

/**
 * Rerank in place. Returns the same array reference, sorted.
 * Stable: hits with identical priority + status + score preserve their
 * original order.
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

/** Decide how many extra hits to ask Meili for. Pure `limit*3`, capped at 100. */
export function rerankFetchSize(limit: number): number {
  return Math.min(Math.max(limit * 3, 1), 100);
}