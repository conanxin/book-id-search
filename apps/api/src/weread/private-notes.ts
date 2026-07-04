/**
 * S27C: Private WeRead notes loader.
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

export type WereadNotesQueryResult = {
  items: WereadPrivateNoteItem[];
  pageInfo: WereadNotesPageInfo;
  summary: WereadNotesSummary;
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

  return { type, days, matchedOnly, hasComment, limit, offset, sort };
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

  // Sort by createdAt then updatedAt then arrival order
  filtered.sort((a, b) => {
    const aMs = dateMs(a.createdAt) || dateMs(a.updatedAt);
    const bMs = dateMs(b.createdAt) || dateMs(b.updatedAt);
    return normalized.sort === "newest" ? bMs - aMs : aMs - bMs;
  });

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
  };
}