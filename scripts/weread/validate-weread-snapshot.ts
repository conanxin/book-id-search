#!/usr/bin/env tsx
/**
 * S26A WeRead snapshot validator.
 *
 * Validates the shape of normalized WeRead snapshot JSON files (bookshelf,
 * notes, matches). Reads three files from a single directory:
 *
 *   - weread-books.snapshot.json
 *   - weread-notes.snapshot.json
 *   - weread-matches.snapshot.json
 *
 * Rules (see docs/WEREAD_INTEGRATION.md §3 for full schema):
 *
 *   - books entry must have wereadBookId, title (non-empty strings)
 *   - books.author must be a string (may be empty when unknown)
 *   - books.progress if present must be 0..100
 *   - books.readingStatus must be in {unknown, not_started, reading, finished, abandoned}
 *   - books.isbn / cover / rating / lastReadAt / updatedAt / category may be null
 *
 *   - notes entry must have wereadBookId, noteId, type, text
 *   - notes.type must be in {highlight, thought, review}
 *
 *   - matches entry must have wereadBookId, catalogId, ssid, dxid, matchMethod,
 *     matchConfidence
 *   - matches.matchMethod must be in
 *     {isbn, title_author, title_similarity, manual}
 *   - matches.matchConfidence must be in {high, medium, low}
 *
 * No network. No API keys. No Meilisearch. Default --dir points at
 * samples/weread (which is the synthetic fixture). Real private snapshots are
 * expected to live under private-data/weread/snapshots/<timestamp>/ and will
 * be skipped by `git status` because of the new gitignore rule.
 *
 * Usage:
 *   pnpm weread:validate
 *   tsx scripts/weread/validate-weread-snapshot.ts --dir samples/weread
 *   tsx scripts/weread/validate-weread-snapshot.ts \
 *       --dir private-data/weread/snapshots/latest
 *
 * Exit codes:
 *   0 = PASS or WARN
 *   1 = FAIL (schema violations, unreadable input)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- types ----------
type ReadingStatus =
  | "unknown"
  | "not_started"
  | "reading"
  | "finished"
  | "abandoned";

type NoteType = "highlight" | "thought" | "review";

type MatchMethod =
  | "isbn"
  | "title_author"
  | "title_similarity"
  | "manual";

type MatchConfidence = "high" | "medium" | "low";

interface WereadBookEntry {
  wereadBookId?: unknown;
  title?: unknown;
  author?: unknown;
  isbn?: unknown;
  category?: unknown;
  cover?: unknown;
  rating?: unknown;
  readingStatus?: unknown;
  progress?: unknown;
  noteCount?: unknown;
  highlightCount?: unknown;
  lastReadAt?: unknown;
  updatedAt?: unknown;
}

interface WereadNoteEntry {
  wereadBookId?: unknown;
  noteId?: unknown;
  type?: unknown;
  chapterTitle?: unknown;
  text?: unknown;
  comment?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface WereadMatchEntry {
  wereadBookId?: unknown;
  catalogId?: unknown;
  ssid?: unknown;
  dxid?: unknown;
  isbn?: unknown;
  matchMethod?: unknown;
  matchConfidence?: unknown;
  titleSimilarity?: unknown;
  authorSimilarity?: unknown;
  confirmedByUser?: unknown;
}

interface ValidationResult {
  file: string;
  count: number;
  errors: string[];
  warnings: string[];
}

interface OverallResult {
  status: "PASS" | "WARN" | "FAIL";
  dir: string;
  books: ValidationResult;
  notes: ValidationResult;
  matches: ValidationResult;
}

// ---------- enums ----------
const READING_STATUSES = [
  "unknown",
  "not_started",
  "reading",
  "finished",
  "abandoned",
] as const;

const NOTE_TYPES = ["highlight", "thought", "review"] as const;

const MATCH_METHODS = [
  "isbn",
  "title_author",
  "title_similarity",
  "manual",
] as const;

const MATCH_CONFIDENCES = ["high", "medium", "low"] as const;

export const ALLOWED_READING_STATUSES: readonly string[] = READING_STATUSES;
export const ALLOWED_NOTE_TYPES: readonly string[] = NOTE_TYPES;
export const ALLOWED_MATCH_METHODS: readonly string[] = MATCH_METHODS;
export const ALLOWED_MATCH_CONFIDENCES: readonly string[] = MATCH_CONFIDENCES;
export type { ValidationResult, OverallResult };
export { validateBooks, validateNotes, validateMatches };

// ---------- file resolution ----------
// Snapshot files normally end in `.snapshot.json`, but the public sample fixtures
// in samples/weread/ ship as `.sample.json` so the names read clearly as
// synthetic placeholders. Accept either suffix so the same validator works for
// both.
const SNAPSHOT_SUFFIXES = [".snapshot.json", ".sample.json"] as const;

type ResolveResult = {
  data: WereadBookEntry[] | WereadNoteEntry[] | WereadMatchEntry[] | null;
  error: string | null;
  warning: string | null;
};

function resolveFile(
  dir: string,
  baseName: string,
  atLeastOneFileFound: boolean,
): ResolveResult {
  let full: string | null = null;
  for (const suffix of SNAPSHOT_SUFFIXES) {
    const candidate = path.join(dir, `${baseName}${suffix}`);
    if (fs.existsSync(candidate)) {
      full = candidate;
      break;
    }
  }
  if (full === null) {
    return {
      data: null,
      error: atLeastOneFileFound ? null : `missing file: ${baseName}`,
      warning: atLeastOneFileFound ? `missing file: ${baseName}` : null,
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(full, "utf8");
  } catch (err) {
    return {
      data: null,
      error: `unreadable file: ${full} (${(err as Error).message})`,
      warning: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      data: null,
      error: `invalid JSON in ${full} (${(err as Error).message})`,
      warning: null,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      data: null,
      error: `${full} must be a JSON array, got ${typeof parsed}`,
      warning: null,
    };
  }
  return { data: parsed as WereadBookEntry[], error: null, warning: null };
}

// ---------- per-file validators ----------
function validateBooks(entries: WereadBookEntry[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  entries.forEach((entry, idx) => {
    const where = `books[${idx}]`;
    if (typeof entry.wereadBookId !== "string" || entry.wereadBookId.length === 0) {
      errors.push(`${where}.wereadBookId must be a non-empty string`);
    }
    if (typeof entry.title !== "string" || entry.title.length === 0) {
      errors.push(`${where}.title must be a non-empty string`);
    }
    if (typeof entry.author !== "string") {
      errors.push(`${where}.author must be a string (use "" when unknown)`);
    }
    if (entry.isbn !== null && entry.isbn !== undefined && typeof entry.isbn !== "string") {
      errors.push(`${where}.isbn must be string|null when present`);
    }
    if (
      entry.readingStatus !== undefined &&
      !READING_STATUSES.includes(entry.readingStatus as ReadingStatus)
    ) {
      errors.push(
        `${where}.readingStatus must be one of ${READING_STATUSES.join("|")}, got ${JSON.stringify(entry.readingStatus)}`,
      );
    }
    if (entry.progress !== null && entry.progress !== undefined) {
      if (typeof entry.progress !== "number" || entry.progress < 0 || entry.progress > 100) {
        errors.push(`${where}.progress must be a number 0..100 or null`);
      }
    }
    if (entry.rating !== null && entry.rating !== undefined) {
      if (typeof entry.rating !== "number" || entry.rating < 0 || entry.rating > 5) {
        warnings.push(`${where}.rating is outside 0..5 (${entry.rating})`);
      }
    }
    if (entry.noteCount !== undefined && (typeof entry.noteCount !== "number" || entry.noteCount < 0)) {
      errors.push(`${where}.noteCount must be a non-negative number`);
    }
    if (
      entry.highlightCount !== undefined &&
      (typeof entry.highlightCount !== "number" || entry.highlightCount < 0)
    ) {
      errors.push(`${where}.highlightCount must be a non-negative number`);
    }
  });
  return { file: "weread-books.snapshot.json", count: entries.length, errors, warnings };
}

function validateNotes(entries: WereadNoteEntry[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  entries.forEach((entry, idx) => {
    const where = `notes[${idx}]`;
    if (typeof entry.wereadBookId !== "string" || entry.wereadBookId.length === 0) {
      errors.push(`${where}.wereadBookId must be a non-empty string`);
    }
    if (typeof entry.noteId !== "string" || entry.noteId.length === 0) {
      errors.push(`${where}.noteId must be a non-empty string`);
    }
    if (!NOTE_TYPES.includes(entry.type as NoteType)) {
      errors.push(`${where}.type must be one of ${NOTE_TYPES.join("|")}, got ${JSON.stringify(entry.type)}`);
    }
    if (typeof entry.text !== "string" || entry.text.length === 0) {
      errors.push(`${where}.text must be a non-empty string`);
    }
    if (entry.chapterTitle !== null && entry.chapterTitle !== undefined && typeof entry.chapterTitle !== "string") {
      errors.push(`${where}.chapterTitle must be string|null when present`);
    }
  });
  return { file: "weread-notes.snapshot.json", count: entries.length, errors, warnings };
}

function validateMatches(entries: WereadMatchEntry[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  entries.forEach((entry, idx) => {
    const where = `matches[${idx}]`;
    if (typeof entry.wereadBookId !== "string" || entry.wereadBookId.length === 0) {
      errors.push(`${where}.wereadBookId must be a non-empty string`);
    }
    for (const field of ["catalogId", "ssid", "dxid"] as const) {
      if (typeof entry[field] !== "string" || (entry[field] as string).length === 0) {
        errors.push(`${where}.${field} must be a non-empty string`);
      }
    }
    if (!MATCH_METHODS.includes(entry.matchMethod as MatchMethod)) {
      errors.push(
        `${where}.matchMethod must be one of ${MATCH_METHODS.join("|")}, got ${JSON.stringify(entry.matchMethod)}`,
      );
    }
    if (!MATCH_CONFIDENCES.includes(entry.matchConfidence as MatchConfidence)) {
      errors.push(
        `${where}.matchConfidence must be one of ${MATCH_CONFIDENCES.join("|")}, got ${JSON.stringify(entry.matchConfidence)}`,
      );
    }
    if (entry.isbn !== null && entry.isbn !== undefined && typeof entry.isbn !== "string") {
      errors.push(`${where}.isbn must be string|null when present`);
    }
    if (
      entry.titleSimilarity !== null &&
      entry.titleSimilarity !== undefined &&
      (typeof entry.titleSimilarity !== "number" ||
        entry.titleSimilarity < 0 ||
        entry.titleSimilarity > 1)
    ) {
      warnings.push(`${where}.titleSimilarity outside 0..1 (${entry.titleSimilarity})`);
    }
    if (
      entry.authorSimilarity !== null &&
      entry.authorSimilarity !== undefined &&
      (typeof entry.authorSimilarity !== "number" ||
        entry.authorSimilarity < 0 ||
        entry.authorSimilarity > 1)
    ) {
      warnings.push(`${where}.authorSimilarity outside 0..1 (${entry.authorSimilarity})`);
    }
    if (entry.confirmedByUser === true) {
      warnings.push(`${where}.confirmedByUser is true — auto-generated matches should stay false`);
    }
  });
  return { file: "weread-matches.snapshot.json", count: entries.length, errors, warnings };
}

// ---------- arg parsing ----------
function parseArgs(argv: string[]): { dir: string } {
  const idx = argv.indexOf("--dir");
  const dir = idx >= 0 ? argv[idx + 1] : "samples/weread";
  if (!dir) {
    throw new Error("--dir requires a value");
  }
  return { dir };
}

// ---------- main ----------
function main(): void {
  let args: { dir: string } = { dir: "samples/weread" };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[weread:validate] arg error: ${(err as Error).message}`);
    process.exit(1);
  }

  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`[weread:validate] directory not found: ${dir}`);
    process.exit(1);
  }

  const sharedFileErrors: string[] = [];
  const sharedFileWarnings: string[] = [];

  // First pass: check if *any* snapshot file exists.
  let anyFound = false;
  for (const baseName of ["weread-books", "weread-notes", "weread-matches"]) {
    for (const suffix of SNAPSHOT_SUFFIXES) {
      if (fs.existsSync(path.join(dir, `${baseName}${suffix}`))) {
        anyFound = true;
        break;
      }
    }
  }

  // Missing-files policy: when ALL three files are missing, this isn't a
  // snapshot directory. Treat as FAIL. When at least one file is present,
  // missing files become warnings.
  if (!anyFound) {
    console.error(
      `[weread:validate] no weread-*.snapshot.json files found under ${dir}; nothing to validate`,
    );
    process.exit(1);
  }

  // Second pass: resolve each file, applying the at-least-one-exists rule.
  const booksResult = resolveFile(dir, "weread-books", anyFound);
  const notesResult = resolveFile(dir, "weread-notes", anyFound);
  const matchesResult = resolveFile(dir, "weread-matches", anyFound);

  // Aggregate file-level errors/warnings.
  for (const r of [booksResult, notesResult, matchesResult]) {
    if (r.error) sharedFileErrors.push(r.error);
    if (r.warning) sharedFileWarnings.push(r.warning);
  }

  // Validate schema.
  const booksValidation: ValidationResult = booksResult.data
    ? validateBooks(booksResult.data)
    : { file: "weread-books", count: 0, errors: [], warnings: [] };
  const notesValidation: ValidationResult = notesResult.data
    ? validateNotes(notesResult.data)
    : { file: "weread-notes", count: 0, errors: [], warnings: [] };
  const matchesValidation: ValidationResult = matchesResult.data
    ? validateMatches(matchesResult.data)
    : { file: "weread-matches", count: 0, errors: [], warnings: [] };

  const totalErrors =
    sharedFileErrors.length +
    booksValidation.errors.length +
    notesValidation.errors.length +
    matchesValidation.errors.length;
  const totalWarnings =
    sharedFileWarnings.length +
    booksValidation.warnings.length +
    notesValidation.warnings.length +
    matchesValidation.warnings.length;

  let status: "PASS" | "WARN" | "FAIL";
  if (totalErrors > 0) status = "FAIL";
  else if (totalWarnings > 0) status = "WARN";
  else status = "PASS";

  const overall: OverallResult = {
    status,
    dir,
    books: booksValidation,
    notes: notesValidation,
    matches: matchesValidation,
  };

  console.log(`[weread:validate] dir=${dir}`);
  for (const part of [booksValidation, notesValidation, matchesValidation]) {
    console.log(
      `  ${part.file}: count=${part.count} errors=${part.errors.length} warnings=${part.warnings.length}`,
    );
  }
  if (sharedFileErrors.length > 0) {
    for (const err of sharedFileErrors) console.log(`  ! ${err}`);
  }
  if (sharedFileWarnings.length > 0) {
    for (const warn of sharedFileWarnings) console.log(`  • ${warn}`);
  }
  for (const part of [booksValidation, notesValidation, matchesValidation]) {
    for (const err of part.errors) console.log(`  ✗ ${part.file}: ${err}`);
    for (const warn of part.warnings) console.log(`  • ${part.file}: ${warn}`);
  }

  console.log(`[weread:validate] STATUS=${status}`);
  if (process.env.WEREAD_VALIDATE_JSON) {
    process.stdout.write(JSON.stringify(overall, null, 2) + "\n");
  }

  if (status === "FAIL") process.exit(1);
}

main();