// ------------------------------------------------------------------
// matchReason: explains WHY a result was returned.
// ------------------------------------------------------------------
// Pure function on (hit, normalizedQuery). The output is JSON-friendly
// so it can be surfaced directly in API responses and rendered in the
// front-end without further transformation.

export type MatchType =
  | "exact_identifier"
  | "exact_isbn"
  | "exact_ssid"
  | "exact_dxid"
  | "exact_title"
  | "title"
  | "author"
  | "publisher"
  | "mixed"
  | "unknown";

export interface MatchInfo {
  type: MatchType;
  label: string;
  /** Local score in [0, 1]. Higher = more confident match. */
  score: number;
  /** Fields that contributed to the match. */
  fields: string[];
}

export interface MatchableBook {
  id?: unknown;
  ssid?: unknown;
  dxid?: unknown;
  isbn?: unknown;
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
}

const LABEL_BY_TYPE: Record<MatchType, string> = {
  exact_identifier: "精确匹配",
  exact_isbn: "ISBN 精确匹配",
  exact_ssid: "SSID 精确匹配",
  exact_dxid: "DXID 精确匹配",
  exact_title: "书名完全匹配",
  title: "书名命中",
  author: "作者命中",
  publisher: "出版社命中",
  mixed: "综合匹配",
  unknown: "未知匹配",
};

function asString(v: unknown): string {
  if (typeof v !== "string") return "";
  return v;
}

function asToken(v: unknown): string {
  return asString(v).replace(/[\s-]+/g, "").toUpperCase();
}

function normalizeText(v: unknown): string {
  return asString(v).replace(/\s+/g, " ").trim();
}

function isPresent(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Classify a single hit against the original (non-normalized) query
 * plus the normalized query and detected type. The function is
 * defensive: any missing/empty field just won't match, never throws.
 */
export function classifyHit(
  hit: MatchableBook,
  originalQuery: string,
  normalizedQuery: string,
  detectedType: "isbn" | "ssid" | "dxid" | "numeric" | "text" | "empty"
): MatchInfo {
  const orig = originalQuery.trim();
  const norm = normalizedQuery.trim();
  const fields: string[] = [];

  // ---- Exact identifier matches (highest priority) ----
  // We compare normalized tokens to allow hyphen/space-stripped ISBN
  // queries to still hit the book whose isbn is the un-hyphenated form.
  const normToken = norm.replace(/[\s-]+/g, "").toUpperCase();

  // ISBN exact: query type is isbn (or numeric ISBN-13 / ISBN-10) and
  // the document's isbn normalizes to the same token. This is the
  // *exact* branch — partial ISBN hits fall through to unknown/mixed.
  if (isPresent(hit.isbn) && normToken) {
    const isbnToken = asToken(hit.isbn);
    if (isbnToken && isbnToken === normToken) {
      return {
        type: "exact_isbn",
        label: LABEL_BY_TYPE.exact_isbn,
        score: 1,
        fields: ["isbn"],
      };
    }
  }

  // SSID exact: only when the query is recognized as an SSID or the
  // 8-digit token matches an SSID exactly. We always require len==8.
  if (isPresent(hit.ssid) && normToken && normToken.length === 8 && /^[0-9]+$/.test(normToken)) {
    const ssidToken = asToken(hit.ssid);
    if (ssidToken && ssidToken === normToken) {
      return {
        type: "exact_ssid",
        label: LABEL_BY_TYPE.exact_ssid,
        score: 1,
        fields: ["ssid"],
      };
    }
  }

  // DXID exact: 12-digit numeric with leading zeros preserved.
  if (isPresent(hit.dxid) && normToken && normToken.length === 12 && /^[0-9]+$/.test(normToken)) {
    const dxidToken = asToken(hit.dxid);
    if (dxidToken && dxidToken === normToken) {
      return {
        type: "exact_dxid",
        label: LABEL_BY_TYPE.exact_dxid,
        score: 1,
        fields: ["dxid"],
      };
    }
  }

  // Identifier-type query that didn't hit any of the above = unknown.
  if (detectedType === "isbn" || detectedType === "ssid" || detectedType === "dxid") {
    return {
      type: "unknown",
      label: LABEL_BY_TYPE.unknown,
      score: 0,
      fields: [],
    };
  }

  // ---- Title / author / publisher text matches ----
  // Use the *original* query (with spacing preserved) for text matching
  // so that a 4-char Chinese fragment can be compared to a longer title
  // substring without being conflated by normalization.
  const title = normalizeText(hit.title);
  const author = normalizeText(hit.author);
  const publisher = normalizeText(hit.publisher);
  const queryText = normalizeText(orig);
  const queryLower = queryText.toLowerCase();

  if (queryText) {
    if (title && title === queryText) {
      return {
        type: "exact_title",
        label: LABEL_BY_TYPE.exact_title,
        score: 0.95,
        fields: ["title"],
      };
    }
    if (title && title.toLowerCase().includes(queryLower)) {
      fields.push("title");
    }
    if (author && author.toLowerCase().includes(queryLower)) {
      fields.push("author");
    }
    if (publisher && publisher.toLowerCase().includes(queryLower)) {
      fields.push("publisher");
    }
  }

  if (fields.length === 0) {
    return { type: "unknown", label: LABEL_BY_TYPE.unknown, score: 0, fields: [] };
  }
  if (fields.length > 1) {
    return {
      type: "mixed",
      label: LABEL_BY_TYPE.mixed,
      score: 0.6,
      fields,
    };
  }
  // Single-field hit. Use the dedicated label.
  const only = fields[0] as "title" | "author" | "publisher";
  const type = only as MatchType;
  const score = only === "title" ? 0.8 : only === "author" ? 0.7 : 0.5;
  return {
    type,
    label: LABEL_BY_TYPE[type],
    score,
    fields,
  };
}

/**
 * Defensive exact-match predicate. Returns true only when `match` is a
 * well-formed MatchInfo whose `type` is one of the exact_* values.
 * Never throws — null / undefined / malformed input returns false.
 *
 * NOTE: this helper is the single source of truth for "is this an exact
 * hit?" — both classifyHit consumers and the rerank layer route through
 * here so behavior stays consistent.
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