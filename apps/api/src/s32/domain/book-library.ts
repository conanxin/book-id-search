export interface BookNoteRevisionSummary {
  revisionId: string;
  revisionNo: number;
  createdAt: string;
}

export interface BookNoteRevision extends BookNoteRevisionSummary {
  title: string;
  content: string;
}

export interface BookNote {
  noteId: string;
  title: string;
  content: string;
  currentRevisionId: string;
  revisionNo: number;
  createdAt: string;
  updatedAt: string;
  revisions: BookNoteRevisionSummary[];
}

export interface BookResource {
  resourceId: string;
  label: string;
  url: string;
  format: string;
  versionLabel: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookWorkspace {
  bookId: string;
  saved: boolean;
  editionId: string | null;
  introduction: string;
  version: number;
  updatedAt: string | null;
  notes: BookNote[];
  resources: BookResource[];
}

export type LibrarySearchMatch =
  | { kind: "introduction"; excerpt: string }
  | { kind: "note"; noteId: string; noteTitle: string; excerpt: string };

export interface LibraryBookSummary {
  bookId: string;
  editionId: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  introductionExcerpt: string;
  noteCount: number;
  resourceCount: number;
  updatedAt: string;
  searchMatch?: LibrarySearchMatch | null;
}

export interface LibraryListInput {
  page: number;
  limit: number;
  q: string;
  filter: "all" | "introduction" | "notes" | "resources";
}

export interface LibraryPage {
  items: LibraryBookSummary[];
  total: number;
  page: number;
  limit: number;
}

export type BookResourceInput = Pick<BookResource, "label" | "url" | "format" | "versionLabel" | "notes">;
export type BookNoteInput = Pick<BookNote, "title" | "content">;
export interface LibraryProfileInput { introduction?: string; baseVersion?: number }

export class LibraryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LibraryError";
  }
}

function invalid(): never { throw new LibraryError("LIBRARY_INVALID_INPUT"); }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) invalid();
  // PostgreSQL text cannot represent NUL or unmatched UTF-16 surrogates.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
  }
  const normalized = value.replace(/\r\n?/g, "\n");
  if (required && !normalized.trim()) invalid();
  return normalized;
}

export function libraryBookId(value: unknown): string {
  return text(value, 500, true).trim();
}

export function libraryUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}

export function readLibraryProfile(value: unknown): LibraryProfileInput {
  const body = object(value);
  if (body.baseVersion !== undefined && (!Number.isSafeInteger(body.baseVersion) || Number(body.baseVersion) < 0)) invalid();
  if (body.introduction === undefined) return {};
  return { introduction: text(body.introduction, 50_000), baseVersion: Number(body.baseVersion ?? 0) };
}

export function readLibraryNote(value: unknown): BookNoteInput {
  const body = object(value);
  return { title: text(body.title, 200, true).trim(), content: text(body.content, 50_000, true) };
}

export function readLibraryNoteUpdate(value: unknown): BookNoteInput & { baseRevisionId: string } {
  const body = object(value);
  return { ...readLibraryNote(body), baseRevisionId: libraryUuid(body.baseRevisionId) };
}

export function readLibraryResource(value: unknown): BookResourceInput {
  const body = object(value);
  const url = text(body.url, 4_000, true).trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { return invalid(); }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || /[\r\n]/.test(url)) invalid();
  return {
    label: text(body.label, 200, true).trim(), url,
    format: text(body.format ?? "", 100).trim(),
    versionLabel: text(body.versionLabel ?? "", 200).trim(),
    notes: text(body.notes ?? "", 4_000),
  };
}

export function readLibraryList(value: unknown): LibraryListInput {
  const query = object(value);
  const integer = (raw: unknown, fallback: number, max: number) => {
    if (raw === undefined) return fallback;
    if ((typeof raw !== "string" && typeof raw !== "number") || !/^\d+$/.test(String(raw))) invalid();
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < 1 || number > max) invalid();
    return number;
  };
  const filter = query.filter ?? "all";
  if (filter !== "all" && filter !== "introduction" && filter !== "notes" && filter !== "resources") invalid();
  return { page: integer(query.page, 1, 1_000_000), limit: integer(query.limit, 24, 100), q: text(query.q ?? "", 200).trim(), filter };
}

export function emptyBookWorkspace(bookId: string): BookWorkspace {
  return { bookId, saved: false, editionId: null, introduction: "", version: 0, updatedAt: null, notes: [], resources: [] };
}
