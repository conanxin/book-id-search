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
  type?: "note" | "highlight" | "thought" | "review";
  note?: string | null;
  comment?: string | null;
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

export type WereadSummary = {
  enabled: true;
  dataAvailable: boolean;
  booksCount: number;
  notesCount: number;
  confirmedMatchesCount: number;
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

export function getWereadSummary(data: WereadOverlayData): WereadSummary {
  return {
    enabled: true,
    dataAvailable: data.dataAvailable,
    booksCount: data.books.size,
    notesCount: Array.from(data.notesByBook.values()).reduce((acc, arr) => acc + arr.length, 0),
    confirmedMatchesCount: data.confirmedByCatalogId.size,
    generatedAt: data.generatedAt,
  };
}

export function getWereadStatusByCatalogId(data: WereadOverlayData, catalogId: string): WereadStatus {
  const match = data.confirmedByCatalogId.get(catalogId);
  if (!match) {
    return { matched: false, catalogId };
  }
  const book = data.books.get(match.wereadBookId);
  const notes = data.notesByBook.get(match.wereadBookId) ?? [];
  const { noteCount, highlightCount } = countNotesByType(notes);
  return {
    matched: true,
    catalogId,
    weread: {
      readingStatus: book?.readingStatus ?? null,
      progress: typeof book?.progress === "number" ? book.progress : null,
      noteCount,
      highlightCount,
      lastReadAt: book?.lastReadAt ?? null,
      updatedAt: book?.updatedAt ?? null,
      matchMethod: match.matchMethod,
      matchConfidence: match.matchConfidence,
      decisionSource: match.decisionSource,
    },
  };
}

export function getWereadOverlayDataDir(): string {
  return process.env.WEREAD_PRIVATE_DATA_DIR ?? "/app/private-data/weread";
}
