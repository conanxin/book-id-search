/**
 * S26D: Private WeRead overlay data loader.
 *
 * Read-only access to private-data/weread:
 * - snapshots/latest/weread-books.snapshot.json
 * - snapshots/latest/weread-notes.snapshot.json
 * - derived/latest/weread-matches.confirmed.json
 *
 * Exposes summary counts and per-catalogId status WITHOUT leaking:
 * - wereadBookId
 * - title / author
 * - note text / comment
 * - raw records
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- types ----------
export type MatchMethod = "isbn" | "title_author" | "title_similarity" | "manual";
export type MatchConfidence = "high" | "medium" | "low";
export type DecisionSource = "auto_seed" | "manual" | "auto_high_confidence";

export type WereadBook = {
  wereadBookId: string;
  isbn: string | null;
  title: string;
  author: string;
  readingStatus?: string | null;
  progress?: number | null;
  lastReadAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
};

export type WereadNote = {
  wereadBookId: string;
  type?: "note" | "highlight" | "thought" | "review" | "unknown";
  note?: string | null;
  comment?: string | null;
  chapterTitle?: string | null;
  [key: string]: unknown;
};

export type ConfirmedMatch = {
  wereadBookId: string;
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
  decisionSource: DecisionSource;
};

export type WereadOverlayData = {
  dataAvailable: boolean;
  books: Map<string, WereadBook>;
  notesByBook: Map<string, WereadNote[]>;
  confirmedByCatalogId: Map<string, ConfirmedMatch>;
  generatedAt?: string;
};

export type WereadNotesCountSummary = {
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  hasNotes: boolean;
};

export type WereadSummary = {
  enabled: true;
  dataAvailable: boolean;
  booksCount: number;
  notesCount: number;
  confirmedMatchesCount: number;
  confirmedWithNotesCount?: number;
  confirmedWithHighlightsCount?: number;
  totalConfirmedNoteRecords?: number;
  generatedAt?: string;
};

export type WereadStatus = {
  matched: boolean;
  catalogId: string;
  weread?: {
    readingStatus?: string | null;
    progress?: number | null;
    noteCount?: number;
    highlightCount?: number;
    matchedRecordsCount?: number;
    notesSummary?: WereadNotesCountSummary;
    lastReadAt?: string | null;
    updatedAt?: string | null;
    matchMethod?: string;
    matchConfidence?: string;
    decisionSource?: string;
  };
};

// ---------- cache ----------
const cache: {
  data: WereadOverlayData | null;
  loadedAt: number;
  ttlMs: number;
} = {
  data: null,
  loadedAt: 0,
  ttlMs: 60_000,
};

function loadJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadWereadOverlay(dataDir: string): WereadOverlayData {
  const now = Date.now();
  if (cache.data && cache.loadedAt + cache.ttlMs > now) {
    return cache.data;
  }

  const booksPath = path.join(dataDir, "snapshots", "latest", "weread-books.snapshot.json");
  const notesPath = path.join(dataDir, "snapshots", "latest", "weread-notes.snapshot.json");
  const confirmedPath = path.join(dataDir, "derived", "latest", "weread-matches.confirmed.json");

  const books: WereadBook[] = loadJsonFile<WereadBook[]>(booksPath) ?? [];
  const notes: WereadNote[] = loadJsonFile<WereadNote[]>(notesPath) ?? [];
  const confirmed: ConfirmedMatch[] = loadJsonFile<ConfirmedMatch[]>(confirmedPath) ?? [];

  const booksMap = new Map<string, WereadBook>();
  for (const book of books) {
    if (book?.wereadBookId) booksMap.set(book.wereadBookId, book);
  }

  const notesMap = new Map<string, WereadNote[]>();
  for (const note of notes) {
    if (!note?.wereadBookId) continue;
    const arr = notesMap.get(note.wereadBookId) ?? [];
    arr.push(note);
    notesMap.set(note.wereadBookId, arr);
  }

  const confirmedByCatalogId = new Map<string, ConfirmedMatch>();
  for (const match of confirmed) {
    if (match?.catalogId) confirmedByCatalogId.set(match.catalogId, match);
  }

  const data: WereadOverlayData = {
    dataAvailable: books.length > 0 || notes.length > 0 || confirmed.length > 0,
    books: booksMap,
    notesByBook: notesMap,
    confirmedByCatalogId,
    generatedAt: new Date().toISOString(),
  };

  cache.data = data;
  cache.loadedAt = now;
  return data;
}

export function clearWereadOverlayCache(): void {
  cache.data = null;
  cache.loadedAt = 0;
}

export function setWereadOverlayCacheTtl(ttlMs: number): void {
  cache.ttlMs = ttlMs;
}

function countNotesByType(notes: WereadNote[] | undefined): { noteCount: number; highlightCount: number } {
  let noteCount = 0;
  let highlightCount = 0;
  if (!notes) return { noteCount, highlightCount };
  for (const n of notes) {
    if (n.type === "highlight") highlightCount += 1;
    else noteCount += 1;
  }
  return { noteCount, highlightCount };
}

function buildNotesCountSummary(notes: WereadNote[] | undefined): WereadNotesCountSummary {
  const summary = {
    total: 0,
    highlights: 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    hasNotes: false,
  };
  if (!notes) return summary;
  for (const n of notes) {
    summary.total += 1;
    switch (n.type) {
      case "highlight":
        summary.highlights += 1;
        break;
      case "thought":
        summary.thoughts += 1;
        break;
      case "review":
        summary.reviews += 1;
        break;
      default:
        summary.unknown += 1;
    }
  }
  summary.hasNotes = summary.total > 0;
  return summary;
}

export function getWereadSummary(data: WereadOverlayData): WereadSummary {
  let confirmedWithNotesCount = 0;
  let confirmedWithHighlightsCount = 0;
  let totalConfirmedNoteRecords = 0;
  for (const match of data.confirmedByCatalogId.values()) {
    const bookNotes = data.notesByBook.get(match.wereadBookId) ?? [];
    const summary = buildNotesCountSummary(bookNotes);
    if (summary.total > 0) confirmedWithNotesCount += 1;
    if (summary.highlights > 0) confirmedWithHighlightsCount += 1;
    totalConfirmedNoteRecords += summary.total;
  }

  return {
    enabled: true,
    dataAvailable: data.dataAvailable,
    booksCount: data.books.size,
    notesCount: Array.from(data.notesByBook.values()).reduce((acc, arr) => acc + arr.length, 0),
    confirmedMatchesCount: data.confirmedByCatalogId.size,
    confirmedWithNotesCount,
    confirmedWithHighlightsCount,
    totalConfirmedNoteRecords,
    generatedAt: data.generatedAt,
  };
}

export function getWereadStatusByCatalogId(data: WereadOverlayData, catalogId: string): WereadStatus {
  const matches = getConfirmedMatchesByCatalogId(data, catalogId);
  if (matches.length === 0) {
    return { matched: false, catalogId };
  }
  const primary = matches[0];
  const book = data.books.get(primary.wereadBookId);
  const allNotes = matches
    .flatMap((m) => data.notesByBook.get(m.wereadBookId) ?? [])
    .filter((n) => n != null);
  const { noteCount, highlightCount } = countNotesByType(allNotes);
  const notesSummary = buildNotesCountSummary(allNotes);

  return {
    matched: true,
    catalogId,
    weread: {
      readingStatus: book?.readingStatus ?? null,
      progress: typeof book?.progress === "number" ? book.progress : null,
      noteCount,
      highlightCount,
      matchedRecordsCount: matches.length,
      notesSummary,
      lastReadAt: book?.lastReadAt ?? null,
      updatedAt: book?.updatedAt ?? null,
      matchMethod: primary.matchMethod,
      matchConfidence: primary.matchConfidence,
      decisionSource: primary.decisionSource,
    },
  };
}

function getConfirmedMatchesByCatalogId(data: WereadOverlayData, catalogId: string): ConfirmedMatch[] {
  const matches: ConfirmedMatch[] = [];
  for (const match of data.confirmedByCatalogId.values()) {
    if (match.catalogId === catalogId) matches.push(match);
  }
  return matches;
}

export function getWereadOverlayDataDir(): string {
  return process.env.WEREAD_PRIVATE_DATA_DIR ?? "/app/private-data/weread";
}

export function getWereadStatusesByCatalogIds(
  data: WereadOverlayData,
  catalogIds: string[]
): Record<string, WereadStatus> {
  const results: Record<string, WereadStatus> = {};
  const seen = new Set<string>();
  for (const catalogId of catalogIds) {
    if (seen.has(catalogId)) continue;
    seen.add(catalogId);
    results[catalogId] = getWereadStatusByCatalogId(data, catalogId);
  }
  return results;
}

// ---------- notes trend ----------

export type WereadTrendPoint = {
  date: string;
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
};

export type WereadTrendWindow = {
  total: number;
  activeDays: number;
  activeBooks: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  daily?: WereadTrendPoint[];
};

export type WereadTrends = {
  generatedAt: string;
  windows: {
    days7: WereadTrendWindow;
    days30: WereadTrendWindow;
    days90: WereadTrendWindow;
    allTime: Omit<WereadTrendWindow, "daily">;
  };
  confirmedOnly: Omit<WereadTrendWindow, "daily" | "activeDays">;
  coverage: {
    notesWithDate: number;
    notesWithoutDate: number;
    dateCoverageRatio: number;
  };
};

type NoteDateInfo = {
  dateStr: string;
  ts: number;
  valid: boolean;
};

function parseNoteDate(note: WereadNote): NoteDateInfo {
  const raw = note.createdAt ?? note.updatedAt;
  if (!raw) return { dateStr: "", ts: 0, valid: false };

  let ts: number;
  if (typeof raw === "number") {
    ts = raw;
  } else if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      ts = parsed;
    } else {
      const d = new Date(raw);
      if (Number.isFinite(d.getTime())) {
        ts = d.getTime() / 1000;
      } else {
        return { dateStr: "", ts: 0, valid: false };
      }
    }
  } else {
    return { dateStr: "", ts: 0, valid: false };
  }

  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return { dateStr: "", ts: 0, valid: false };

  const dateStr = d.toISOString().slice(0, 10);
  return { dateStr, ts, valid: true };
}

function aggregateTypeCounts(notes: WereadNote[]): {
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
} {
  let highlights = 0, thoughts = 0, reviews = 0, unknown = 0;
  for (const n of notes) {
    switch (n.type) {
      case "highlight":
        highlights += 1;
        break;
      case "thought":
        thoughts += 1;
        break;
      case "review":
        reviews += 1;
        break;
      default:
        unknown += 1;
    }
  }
  return { highlights, thoughts, reviews, unknown };
}

function buildWindow(
  notes: WereadNote[],
  cutoffTs: number,
  includeDaily: boolean
): WereadTrendWindow {
  const filtered = notes.filter((n) => {
    const dateInfo = parseNoteDate(n);
    return dateInfo.valid && dateInfo.ts >= cutoffTs;
  });

  const { highlights, thoughts, reviews, unknown } = aggregateTypeCounts(filtered);

  const dailyPoints: WereadTrendPoint[] = [];
  if (includeDaily) {
    const byDate = new Map<string, { total: number; highlights: number; thoughts: number; reviews: number; unknown: number }>();
    for (const n of filtered) {
      const { dateStr } = parseNoteDate(n);
      const existing = byDate.get(dateStr) ?? { total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0 };
      existing.total += 1;
      switch (n.type) {
        case "highlight":
          existing.highlights += 1;
          break;
        case "thought":
          existing.thoughts += 1;
          break;
        case "review":
          existing.reviews += 1;
          break;
        default:
          existing.unknown += 1;
      }
      byDate.set(dateStr, existing);
    }

    for (const [date, counts] of byDate.entries()) {
      dailyPoints.push({ date, ...counts });
    }
    dailyPoints.sort((a, b) => a.date.localeCompare(b.date));
  }

  const activeBooks = new Set(filtered.map((n) => n.wereadBookId).filter(Boolean)).size;
  const activeDays = includeDaily ? dailyPoints.length : new Set(filtered.map((n) => parseNoteDate(n).dateStr).filter(Boolean)).size;

  return {
    total: filtered.length,
    activeDays,
    activeBooks,
    highlights,
    thoughts,
    reviews,
    unknown,
    daily: includeDaily ? dailyPoints : undefined,
  };
}

export function buildNotesTrend(
  notes: WereadNote[],
  confirmedMatches: ConfirmedMatch[]
): WereadTrends {
  const now = Date.now();
  const nowTs = now / 1000;

  const allNotes = notes ?? [];

  let notesWithDate = 0;
  let notesWithoutDate = 0;
  for (const n of allNotes) {
    if (parseNoteDate(n).valid) notesWithDate += 1;
    else notesWithoutDate += 1;
  }

  const days7 = buildWindow(allNotes, nowTs - 7 * 86400, true);
  const days30 = buildWindow(allNotes, nowTs - 30 * 86400, true);
  const days90 = buildWindow(allNotes, nowTs - 90 * 86400, true);
  const allTime = buildWindow(allNotes, 0, false);

  const confirmedBookIds = new Set(confirmedMatches.map((m) => m.wereadBookId).filter(Boolean));
  const confirmedNotes = allNotes.filter((n) => confirmedBookIds.has(n.wereadBookId));
  const confirmedCounts = aggregateTypeCounts(confirmedNotes);

  return {
    generatedAt: new Date(now).toISOString(),
    windows: {
      days7,
      days30,
      days90,
      allTime: {
        total: allTime.total,
        activeDays: allTime.activeDays,
        activeBooks: allTime.activeBooks,
        highlights: allTime.highlights,
        thoughts: allTime.thoughts,
        reviews: allTime.reviews,
        unknown: allTime.unknown,
      },
    },
    confirmedOnly: {
      total: confirmedNotes.length,
      activeBooks: new Set(confirmedNotes.map((n) => n.wereadBookId).filter(Boolean)).size,
      ...confirmedCounts,
    },
    coverage: {
      notesWithDate,
      notesWithoutDate,
      dateCoverageRatio: allNotes.length > 0 ? Number((notesWithDate / allNotes.length).toFixed(4)) : 0,
    },
  };
}
