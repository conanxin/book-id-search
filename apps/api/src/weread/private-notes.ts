/**
 * S27C: Private WeRead notes loader.
 * S27D: Added optional full-text search over note text/comment (q).
 *
 * Reads normalized note snapshots from private-data/weread and exposes
 * paginated, filtered note ITEMS for the private token endpoint.
 *
 * Strict privacy contract for the response shape (WereadPrivateNoteItem):
 * - type:                "highlight" | "thought" | "review" | "unknown"
 * - text:                note / highlight text  (allowed in private endpoint)
 * - comment:             user's own annotation (allowed in private endpoint)
 * - createdAt:           epoch seconds → ISO string (nullable)
 * - updatedAt:           epoch seconds → ISO string (nullable)
 * - matched:             true if wereadBookId was joined to a confirmed catalogId
 * - catalogId:           public catalog id (only when matched === true)
 * - source:              "private_weread"
 *
 * NEVER returned:
 * - wereadBookId         (internal WeRead book id)
 * - noteId / highlightId (internal WeRead note ids)
 * - chapterTitle        (internal WeRead chapter heading)
 * - title / author       (private WeRead metadata; matched catalog id is enough)
 *
 * Search rules (S27D):
 * - q is optional, case-insensitive substring search.
 * - Searches only note.text and note.comment; never wereadBookId / noteId /
 *   highlightId / chapterTitle / title / author.
 * - Multi-term: whitespace split, OR semantics (any term matches).
 * - Max length enforced at route layer (100 chars). When q is provided and
 *   non-empty (after trim), items are ranked by a local relevance score;
 *   equal scores fall back to the requested sort.
 * - searchInfo returns counts only — NEVER the raw q or terms.
 * - q is never logged or echoed in error messages.
 */
import fs from "node:fs";
import path from "node:path";

// ---------- public types ----------

export type WereadNoteTypeRaw = "highlight" | "thought" | "review" | "unknown";

export type WereadPrivateNoteItem = {
  type: WereadNoteTypeRaw;
  text: string;
  comment: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  matched: boolean;
  catalogId: string | null;
  source: "private_weread";
};

export type WereadNotesTypeFilter = "all" | "highlight" | "thought" | "review";
export type WereadNotesDaysFilter = "7" | "30" | "90" | "all";
export type WereadNotesSort = "newest" | "oldest";

export type WereadNotesQuery = {
  type: WereadNotesTypeFilter;
  days: WereadNotesDaysFilter;
  matchedOnly: boolean;
  hasComment?: boolean;
  limit: number;
  offset: number;
  sort: WereadNotesSort;
  /** S27D: optional full-text query (max length enforced at route layer). */
  q?: string;
};

export type WereadNotesPageInfo = {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

export type WereadNotesSummary = {
  totalAfterFilter: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matchedCount: number;
  unmatchedCount: number;
};

/**
 * S27D: search telemetry. Returned only when a search is active. Intentionally
 * omits the raw `q` and the individual terms so that even the response payload
 * never echoes the user's search query.
 */
export type WereadNotesSearchInfo = {
  enabled: boolean;
  queryLength: number;
  termsCount: number;
  matchedCount: number;
};

export type WereadNotesQueryResult = {
  items: WereadPrivateNoteItem[];
  pageInfo: WereadNotesPageInfo;
  summary: WereadNotesSummary;
  searchInfo?: WereadNotesSearchInfo;
};

export type WereadPrivateNoteRaw = {
  wereadBookId?: unknown;
  type?: unknown;
  text?: unknown;
  note?: unknown;
  comment?: unknown;
  chapterTitle?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type WereadPrivateConfirmedMatch = {
  wereadBookId?: unknown;
  catalogId?: unknown;
};

export type PrivateNotesData = {
  notes: WereadPrivateNoteRaw[];
  wereadBookIdToCatalogId: Map<string, string>;
};

// ---------- file loading ----------

function loadJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadPrivateNotesData(dataDir: string): PrivateNotesData {
  const notesPath = path.join(dataDir, "snapshots", "latest", "weread-notes.snapshot.json");
  const confirmedPath = path.join(dataDir, "derived", "latest", "weread-matches.confirmed.json");

  const rawNotes = loadJsonFile<unknown>(notesPath);
  const rawConfirmed = loadJsonFile<unknown>(confirmedPath);

  const notes: WereadPrivateNoteRaw[] = Array.isArray(rawNotes) ? (rawNotes as WereadPrivateNoteRaw[]) : [];
  const confirmedArr: WereadPrivateConfirmedMatch[] = Array.isArray(rawConfirmed)
    ? (rawConfirmed as WereadPrivateConfirmedMatch[])
    : [];

  const wereadBookIdToCatalogId = new Map<string, string>();
  for (const m of confirmedArr) {
    if (
      m &&
      typeof m.wereadBookId === "string" &&
      typeof m.catalogId === "string" &&
      /^[0-9]+_[0-9]{12}$/.test(m.catalogId)
    ) {
      wereadBookIdToCatalogId.set(m.wereadBookId, m.catalogId);
    }
  }

  return { notes, wereadBookIdToCatalogId };
}

// ---------- sanitization ----------

const VALID_TYPES = new Set<string>(["highlight", "thought", "review"]);

function sanitizeType(raw: unknown): WereadNoteTypeRaw {
  return typeof raw === "string" && VALID_TYPES.has(raw) ? (raw as WereadNoteTypeRaw) : "unknown";
}

function sanitizeText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return "";
}

/**
 * Pull the body text from a normalized note, trying the canonical field first
 * and then several legacy / variant field names. Returns "" if none of them
 * are present. The API contract is that this becomes the public `text` field.
 */
function extractNoteText(raw: WereadPrivateNoteRaw): string {
  const candidates: unknown[] = [
    raw.text,
    raw.note,
    (raw as Record<string, unknown>).markedText,
    (raw as Record<string, unknown>).content,
    (raw as Record<string, unknown>).abstract,
  ];
  for (const c of candidates) {
    const sanitized = sanitizeText(c);
    if (sanitized.length > 0) return sanitized;
  }
  return "";
}

/**
 * Pull the user comment / annotation from a normalized note, trying several
 * field names that have appeared across snapshot schema versions.
 */
function extractNoteComment(raw: WereadPrivateNoteRaw): unknown {
  return raw.comment ?? (raw as Record<string, unknown>).thought ?? (raw as Record<string, unknown>).review ?? null;
}

function sanitizeComment(raw: unknown): string | null {
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  return null;
}

function epochToIsoString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    // already ISO-like or epoch string
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      if (!Number.isNaN(n) && n > 0) {
        const ms = value.length <= 10 ? n * 1000 : n;
        return new Date(ms).toISOString();
      }
      return null;
    }
    // trust it as an ISO-ish string
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

function dateMs(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// ---------- query ----------

function matchesTypeFilter(typeFilter: WereadNotesTypeFilter, itemType: WereadNoteTypeRaw): boolean {
  if (typeFilter === "all") return true;
  return itemType === typeFilter;
}

const DAYS_WINDOW_MS: Record<Exclude<WereadNotesDaysFilter, "all">, number> = {
  "7": 7 * 24 * 60 * 60 * 1000,
  "30": 30 * 24 * 60 * 60 * 1000,
  "90": 90 * 24 * 60 * 60 * 1000,
};

// ---------- S27D: full-text search helpers ----------

/**
 * Split a search string into individual terms (whitespace-separated) and
 * lowercase each term. Returns an empty array if the input has no usable terms.
 */
function splitSearchTerms(q: string): string[] {
  if (typeof q !== "string") return [];
  return q
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Score a single note against the parsed search terms. Higher = more relevant.
 *
 * - +40 if the full original (trimmed) q appears in text
 * - +30 if the full q appears in comment
 * - +10 per term matched in text (substring, case-insensitive)
 * - +8  per term matched in comment
 *
 * Returns 0 when no term matches. The function never logs or echoes q.
 */
function scoreNoteSearch(text: string, comment: string | null, terms: string[], fullQuery: string): number {
  if (terms.length === 0) return 0;
  const lowerText = typeof text === "string" ? text.toLowerCase() : "";
  const lowerComment = typeof comment === "string" ? comment.toLowerCase() : "";
  const lowerFull = fullQuery.toLowerCase();

  let score = 0;
  if (lowerFull.length > 0) {
    if (lowerText.includes(lowerFull)) score += 40;
    if (lowerComment && lowerComment.includes(lowerFull)) score += 30;
  }
  for (const term of terms) {
    if (lowerText.includes(term)) score += 10;
    if (lowerComment && lowerComment.includes(term)) score += 8;
  }
  return score;
}

export function normalizeNotesQuery(input: Partial<WereadNotesQuery> | undefined): WereadNotesQuery {
  const rawType = input?.type ?? "all";
  const type: WereadNotesTypeFilter = ["all", "highlight", "thought", "review"].includes(rawType)
    ? (rawType as WereadNotesTypeFilter)
    : "all";

  const rawDays = input?.days ?? "all";
  const days: WereadNotesDaysFilter = ["7", "30", "90", "all"].includes(rawDays)
    ? (rawDays as WereadNotesDaysFilter)
    : "all";

  const matchedOnly = input?.matchedOnly === true;

  const hasComment = typeof input?.hasComment === "boolean" ? input.hasComment : undefined;

  const rawLimit = typeof input?.limit === "number" ? input.limit : 50;
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50));

  const rawOffset = typeof input?.offset === "number" ? input.offset : 0;
  const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);

  const rawSort = input?.sort ?? "newest";
  const sort: WereadNotesSort = rawSort === "oldest" ? "oldest" : "newest";

  // S27D: search query — trimmed, must be a string if provided. The length
  // cap is enforced by the route layer; here we only ensure it's a sane string.
  let q: string | undefined;
  if (typeof input?.q === "string") {
    const trimmed = input.q.trim();
    if (trimmed.length > 0) q = trimmed;
  }

  return { type, days, matchedOnly, hasComment, limit, offset, sort, q };
}

export function queryPrivateNotes(data: PrivateNotesData, query: WereadNotesQuery): WereadNotesQueryResult {
  const normalized = normalizeNotesQuery(query);

  const now = Date.now();

  // Phase 1: sanitize + filter (without pagination)
  const filtered: WereadPrivateNoteItem[] = [];
  for (const raw of data.notes) {
    if (!raw || typeof raw !== "object") continue;
    const wereadBookId = typeof raw.wereadBookId === "string" ? raw.wereadBookId : null;
    if (!wereadBookId) continue;

    const itemType = sanitizeType(raw.type);
    if (!matchesTypeFilter(normalized.type, itemType)) continue;

    const text = extractNoteText(raw);
    const commentRaw = extractNoteComment(raw);
    const comment = sanitizeComment(commentRaw);

    // Allow thought/review records to display via their comment if text is empty.
    if (!text && !(comment && (itemType === "thought" || itemType === "review"))) {
      // drop empty bodies (UI will show fallback only if there's at least a comment)
      if (!comment) continue;
    }
    if (!text && !comment) continue;
    if (normalized.hasComment === true && !comment) continue;
    if (normalized.hasComment === false && comment) continue;

    const createdIso = epochToIsoString(raw.createdAt);
    const updatedIso = epochToIsoString(raw.updatedAt);

    if (normalized.days !== "all") {
      const anchor = dateMs(createdIso) || dateMs(updatedIso);
      if (anchor === 0) continue; // no date → exclude for windowed filters
      const cutoff = now - DAYS_WINDOW_MS[normalized.days];
      if (anchor < cutoff) continue;
    }

    const catalogId = data.wereadBookIdToCatalogId.get(wereadBookId) ?? null;
    const matched = catalogId !== null;
    if (normalized.matchedOnly && !matched) continue;

    const item: WereadPrivateNoteItem = {
      type: itemType,
      text,
      comment,
      createdAt: createdIso,
      updatedAt: updatedIso,
      matched,
      catalogId: normalized.matchedOnly || matched ? catalogId : null,
      source: "private_weread",
    };
    filtered.push(item);
  }

  // S27D: apply optional full-text search over text/comment only.
  // Search is case-insensitive substring, OR across whitespace-split terms.
  // searchTerms is computed once and never logged or echoed in the response.
  let searchInfo: WereadNotesSearchInfo | undefined;
  let searchTerms: string[] = [];
  let searchFullQ = "";
  if (normalized.q) {
    searchFullQ = normalized.q;
    searchTerms = splitSearchTerms(normalized.q);
    if (searchTerms.length > 0) {
      const scored: { item: WereadPrivateNoteItem; score: number }[] = [];
      for (const item of filtered) {
        const score = scoreNoteSearch(item.text, item.comment, searchTerms, searchFullQ);
        if (score > 0) scored.push({ item, score });
      }
      // Replace filtered in place — relevance-ranked, then by requested sort.
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aMs = dateMs(a.item.createdAt) || dateMs(a.item.updatedAt);
        const bMs = dateMs(b.item.createdAt) || dateMs(b.item.updatedAt);
        return normalized.sort === "newest" ? bMs - aMs : aMs - bMs;
      });
      filtered.length = 0;
      for (const s of scored) filtered.push(s.item);
      searchInfo = {
        enabled: true,
        // Length only — never echo the raw q.
        queryLength: searchFullQ.length,
        termsCount: searchTerms.length,
        matchedCount: scored.length,
      };
    } else {
      // After trim/split, no usable terms: behave as if no search was requested.
      searchInfo = {
        enabled: true,
        queryLength: searchFullQ.length,
        termsCount: 0,
        matchedCount: filtered.length,
      };
    }
  }

  // Sort by createdAt then updatedAt then arrival order (only when search
  // did NOT already re-sort by relevance).
  if (!searchInfo || !normalized.q || searchTerms.length === 0) {
    filtered.sort((a, b) => {
      const aMs = dateMs(a.createdAt) || dateMs(a.updatedAt);
      const bMs = dateMs(b.createdAt) || dateMs(b.updatedAt);
      return normalized.sort === "newest" ? bMs - aMs : aMs - bMs;
    });
  }

  // Summary counts based on the full filtered list (before pagination)
  const summary: WereadNotesSummary = {
    totalAfterFilter: filtered.length,
    highlights: 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matchedCount: 0,
    unmatchedCount: 0,
  };
  for (const it of filtered) {
    if (it.type === "highlight") summary.highlights += 1;
    else if (it.type === "thought") summary.thoughts += 1;
    else if (it.type === "review") summary.reviews += 1;
    else summary.unknown += 1;
    if (it.matched) summary.matchedCount += 1;
    else summary.unmatchedCount += 1;
  }

  // Pagination
  const total = filtered.length;
  const offset = normalized.offset;
  const limit = normalized.limit;
  const items = filtered.slice(offset, offset + limit);

  return {
    items,
    pageInfo: {
      limit,
      offset,
      total,
      hasMore: offset + items.length < total,
    },
    summary,
    searchInfo,
  };
}