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
