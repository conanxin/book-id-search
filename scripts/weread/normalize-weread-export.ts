#!/usr/bin/env tsx
/**
 * S26B: WeRead raw export → S26A snapshot normalizer.
 *
 * Reads JSON exports from --raw-dir (typically the output of the WeRead
 * Skill) and produces three S26A-schema files in --out-dir:
 *
 *   - weread-books.snapshot.json
 *   - weread-notes.snapshot.json
 *   - weread-matches.snapshot.json   (initially [] unless pre-existing)
 *
 * Plus a manifest.json summarizing what was processed, including a
 * per-file field coverage so S26B can flag whether the WeRead Skill's
 * actual export shape diverges from the schema documented in
 * docs/WEREAD_INTEGRATION.md.
 *
 * Safety contract (mirrors the S26A hard rules):
 *   - No string content (titles, note text, comments) is ever written to
 *     stdout. Only counts, file names, and field-coverage percentages.
 *   - Skipped records are reported by count and reason, never by data.
 *   - Output goes to private-data/weread/snapshots/latest/ which is
 *     covered by .gitignore (`private-data/**`).
 *   - If the input directory is missing or empty, exits with
 *     STATUS=BLOCKED_FOR_RAW_EXPORT and exit code 1.
 *
 * Usage:
 *   pnpm weread:normalize
 *   tsx scripts/weread/normalize-weread-export.ts \
 *     --raw-dir private-data/weread/raw/latest \
 *     --out-dir private-data/weread/snapshots/latest
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------- constants ----------
const READING_STATUS_MAP: Record<string, string> = {
  // raw value -> S26A enum
  "0": "not_started",
  "1": "reading",
  "2": "finished",
  "3": "abandoned",
  not_started: "not_started",
  notstarted: "not_started",
  unread: "not_started",
  want_to_read: "not_started",
  wanttoread: "not_started",
  reading: "reading",
  in_progress: "reading",
  inprogress: "reading",
  reading_now: "reading",
  finished: "finished",
  done: "finished",
  read: "finished",
  completed: "finished",
  abandoned: "abandoned",
  dropped: "abandoned",
  gave_up: "abandoned",
  gaveup: "abandoned",
};

const NOTE_TYPE_FROM_FILENAME: Record<string, string> = {
  highlights: "highlight",
  highlight: "highlight",
  thoughts: "thought",
  thought: "thought",
  reviews: "review",
  review: "review",
  notes: "highlight", // generic "notes" file → highlight by default
};

// ---------- types ----------
type RawRecord = Record<string, unknown> | null;

type NormalizedBook = {
  wereadBookId: string;
  title: string;
  author: string;
  isbn: string | null;
  category: string | null;
  cover: string | null;
  rating: number | null;
  readingStatus: string;
  progress: number | null;
  noteCount: number;
  highlightCount: number;
  lastReadAt: string | null;
  updatedAt: string | null;
};

type NormalizedNote = {
  wereadBookId: string;
  noteId: string;
  type: string;
  chapterTitle: string | null;
  text: string;
  comment: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type FileOutcome = {
  file: string;
  role: "books" | "notes" | "skipped" | "unknown";
  inputRecords: number;
  accepted: number;
  skipped: number;
  skipReasons: Record<string, number>;
  fieldCoverage: Record<string, number>;
};

type Manifest = {
  generatedAt: string;
  rawDir: string;
  outDir: string;
  totalFiles: number;
  totalInputRecords: number;
  totalAccepted: number;
  totalSkipped: number;
  booksCount: number;
  notesCount: number;
  matchesCount: number;
  fieldCoverage: Record<string, number>;
  files: FileOutcome[];
  warnings: string[];
};

// ---------- field extraction ----------
function pickString(
  rec: RawRecord,
  keys: string[],
): string | null {
  if (rec === null) return null;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function pickNumber(rec: RawRecord, keys: string[]): number | null {
  if (rec === null) return null;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickArrayLength(rec: RawRecord, keys: string[]): number {
  if (rec === null) return 0;
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

// Normalize progress to 0..100
function normalizeProgress(raw: number | null): number | null {
  if (raw === null) return null;
  // 0..1 → 0..100
  if (raw > 0 && raw <= 1) return Math.round(raw * 100);
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return Math.round(raw);
}

function normalizeStatus(raw: string | number | null): string {
  if (raw === null) return "unknown";
  const key = String(raw).trim().toLowerCase();
  return READING_STATUS_MAP[key] ?? "unknown";
}

function normalizeIsbn(raw: string | number | null): string | null {
  if (raw === null) return null;
  const s = String(raw).replace(/[^0-9Xx]/g, "");
  return s.length >= 10 ? s.toUpperCase() : null;
}

// ---------- record normalization ----------
type SkipResult = { ok: false; reason: string } | { ok: true; value: NormalizedBook };

function normalizeBook(rec: RawRecord): SkipResult {
  if (rec === null) return { ok: false, reason: "null_record" };

  const wereadBookId = pickString(rec, [
    "wereadBookId",
    "weread_book_id",
    "bookId",
    "book_id",
    "id",
  ]);
  if (!wereadBookId) return { ok: false, reason: "missing_bookId" };

  const title = pickString(rec, ["title", "bookTitle", "name"]);
  if (!title) return { ok: false, reason: "missing_title" };

  const author = pickString(rec, ["author", "authorName", "writer"]) ?? "";

  const isbnRaw = pickString(rec, ["isbn", "ISBN", "isbn13", "isbn10"]);
  const isbn = normalizeIsbn(isbnRaw);

  const category = pickString(rec, ["category", "categories", "genre"]);
  const cover = pickString(rec, ["cover", "coverUrl", "image"]);
  const rating = pickNumber(rec, ["rating", "score"]);
  const readingStatus = normalizeStatus(
    pickString(rec, ["readingStatus", "status", "state"]) as string | null,
  );
  const progress = normalizeProgress(
    pickNumber(rec, ["progress", "readingProgress", "percent", "reading_progress"]),
  );
  const noteCount = pickArrayLength(rec, ["notes", "thoughts", "noteList"])
    || pickNumber(rec, ["noteCount", "notesCount", "thoughtCount"])
    || 0;
  const highlightCount = pickArrayLength(rec, ["highlights", "bookmarks", "highlightList"])
    || pickNumber(rec, ["highlightCount", "bookmarkCount"])
    || 0;
  const lastReadAt = pickString(rec, ["lastReadAt", "readUpdateTime", "updatedTime"]);
  const updatedAt = pickString(rec, ["updatedAt", "updateTime"]);

  return {
    ok: true,
    value: {
      wereadBookId,
      title,
      author,
      isbn,
      category,
      cover,
      rating,
      readingStatus,
      progress,
      noteCount,
      highlightCount,
      lastReadAt,
      updatedAt,
    },
  };
}

type NoteSkipResult = { ok: false; reason: string } | { ok: true; value: NormalizedNote };

function inferNoteType(rec: RawRecord, fileName: string): string {
  // Explicit type field takes priority
  const t = pickString(rec, ["type", "noteType", "kind"]);
  if (t) {
    const lower = t.toLowerCase();
    if (lower === "highlight" || lower === "thought" || lower === "review") return lower;
  }
  // Fall back to filename
  const base = path.basename(fileName, ".json").toLowerCase();
  return NOTE_TYPE_FROM_FILENAME[base] ?? "highlight";
}

function normalizeNote(rec: RawRecord, fileName: string): NoteSkipResult {
  if (rec === null) return { ok: false, reason: "null_record" };

  const wereadBookId = pickString(rec, [
    "wereadBookId",
    "weread_book_id",
    "bookId",
    "book_id",
  ]);
  if (!wereadBookId) return { ok: false, reason: "missing_bookId" };

  const noteId = pickString(rec, ["noteId", "id", "reviewId", "highlightId"]);
  if (!noteId) return { ok: false, reason: "missing_noteId" };

  const text = pickString(rec, ["text", "content", "abstract", "markedText"]);
  if (!text) return { ok: false, reason: "missing_text" };

  const type = inferNoteType(rec, fileName);
  const chapterTitle = pickString(rec, ["chapterTitle", "chapter", "chapterName"]);
  const comment = pickString(rec, ["comment", "note", "review", "thought"]);
  const createdAt = pickString(rec, ["createdAt", "createTime"]);
  const updatedAt = pickString(rec, ["updatedAt", "updateTime"]);

  return {
    ok: true,
    value: {
      wereadBookId,
      noteId,
      type,
      chapterTitle,
      text,
      comment,
      createdAt,
      updatedAt,
    },
  };
}

// ---------- file role detection ----------
function classifyFileRole(fileName: string): "books" | "notes" | "skipped" {
  const base = path.basename(fileName, ".json").toLowerCase();
  if (
    base === "bookshelf" ||
    base === "books" ||
    base === "weread-books" ||
    base === "shelf" ||
    base === "book-details" ||
    base === "book-details-all"
  ) {
    return "books";
  }
  if (
    base === "notes" ||
    base === "highlights" ||
    base === "thoughts" ||
    base === "reviews" ||
    base === "weread-notes" ||
    base === "highlight" ||
    base === "thought" ||
    base === "review"
  ) {
    return "notes";
  }
  // stats.json etc.
  return "skipped";
}

// ---------- file IO ----------
function readJsonArray(filePath: string): { ok: true; data: unknown[] } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { ok: true, data: parsed };
    // Accept single object as a 1-element array.
    if (parsed !== null && typeof parsed === "object") {
      return { ok: true, data: [parsed] };
    }
    return { ok: false, error: `top-level value of type ${typeof parsed} is not a record` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------- main ----------
function main(): void {
  // args
  const get = (key: string, fallback: string): string => {
    const i = process.argv.indexOf(key);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const rawDir = path.resolve(get("--raw-dir", "private-data/weread/raw/latest"));
  const outDir = path.resolve(get("--out-dir", "private-data/weread/snapshots/latest"));

  if (!fs.existsSync(rawDir) || !fs.statSync(rawDir).isDirectory()) {
    console.error(`[weread:normalize] raw directory not found: ${rawDir}`);
    console.error(`[weread:normalize] STATUS=BLOCKED_FOR_RAW_EXPORT`);
    process.exit(1);
  }

  const rawFiles = fs
    .readdirSync(rawDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => e.name)
    .sort();

  if (rawFiles.length === 0) {
    console.error(`[weread:normalize] no JSON files in ${rawDir}`);
    console.error(`[weread:normalize] STATUS=BLOCKED_FOR_RAW_EXPORT`);
    process.exit(1);
  }

  // Ensure outDir exists (we know it's under private-data/, so gitignored).
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const booksOut: NormalizedBook[] = [];
  const notesOut: NormalizedNote[] = [];
  let matchesOut: unknown[] = []; // matches start empty
  const fileOutcomes: FileOutcome[] = [];
  const warnings: string[] = [];
  const aggregateSkip: Record<string, number> = {};
  const aggregateCoverage: Record<string, number> = {};
  const aggregateOccurrences: Record<string, number> = {};
  const aggregateRecords = { total: 0, totalAccepted: 0, totalSkipped: 0 };

  for (const fileName of rawFiles) {
    const fullPath = path.join(rawDir, fileName);
    const role = classifyFileRole(fileName);
    const result = readJsonArray(fullPath);

    if (!result.ok) {
      warnings.push(`${fileName}: ${result.error}`);
      fileOutcomes.push({
        file: fileName,
        role: "skipped",
        inputRecords: 0,
        accepted: 0,
        skipped: 0,
        skipReasons: { unreadable: 1 },
        fieldCoverage: {},
      });
      continue;
    }

    if (role === "skipped") {
      fileOutcomes.push({
        file: fileName,
        role: "skipped",
        inputRecords: result.data.length,
        accepted: 0,
        skipped: 0,
        skipReasons: { unknown_role: 1 },
        fieldCoverage: {},
      });
      continue;
    }

    const fileSkips: Record<string, number> = {};
    const fileCoverage: Record<string, number> = {};
    let accepted = 0;
    let skipped = 0;

    if (role === "books") {
      for (const raw of result.data) {
        aggregateRecords.total += 1;
        const r = normalizeBook(raw as RawRecord);
        if (r.ok) {
          booksOut.push(r.value);
          accepted += 1;
          aggregateRecords.totalAccepted += 1;
        } else {
          skipped += 1;
          aggregateRecords.totalSkipped += 1;
          fileSkips[r.reason] = (fileSkips[r.reason] ?? 0) + 1;
          aggregateSkip[r.reason] = (aggregateSkip[r.reason] ?? 0) + 1;
        }
        // Track coverage of any keys present (without logging values).
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
          for (const k of Object.keys(raw as Record<string, unknown>)) {
            aggregateOccurrences[k] = (aggregateOccurrences[k] ?? 0) + 1;
          }
        }
      }
    } else if (role === "notes") {
      for (const raw of result.data) {
        aggregateRecords.total += 1;
        const r = normalizeNote(raw as RawRecord, fileName);
        if (r.ok) {
          notesOut.push(r.value);
          accepted += 1;
          aggregateRecords.totalAccepted += 1;
        } else {
          skipped += 1;
          aggregateRecords.totalSkipped += 1;
          fileSkips[r.reason] = (fileSkips[r.reason] ?? 0) + 1;
          aggregateSkip[r.reason] = (aggregateSkip[r.reason] ?? 0) + 1;
        }
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
          for (const k of Object.keys(raw as Record<string, unknown>)) {
            aggregateOccurrences[k] = (aggregateOccurrences[k] ?? 0) + 1;
          }
        }
      }
    }

    // Per-file coverage % (rough: accepted / input)
    fileCoverage.acceptanceRate =
      result.data.length > 0
        ? Math.round((accepted / result.data.length) * 10000) / 100
        : 0;

    fileOutcomes.push({
      file: fileName,
      role,
      inputRecords: result.data.length,
      accepted,
      skipped,
      skipReasons: fileSkips,
      fieldCoverage: fileCoverage,
    });
  }

  // Aggregate coverage: for each observed raw key, what % of records had it.
  if (aggregateRecords.total > 0) {
    for (const [k, occ] of Object.entries(aggregateOccurrences)) {
      aggregateCoverage[k] = Math.round((occ / aggregateRecords.total) * 10000) / 100;
    }
  }

  // Write outputs (private-data/, gitignored).
  const booksPath = path.join(outDir, "weread-books.snapshot.json");
  const notesPath = path.join(outDir, "weread-notes.snapshot.json");
  const matchesPath = path.join(outDir, "weread-matches.snapshot.json");
  const manifestPath = path.join(outDir, "manifest.json");

  fs.writeFileSync(booksPath, JSON.stringify(booksOut, null, 2) + "\n");
  fs.writeFileSync(notesPath, JSON.stringify(notesOut, null, 2) + "\n");
  fs.writeFileSync(matchesPath, JSON.stringify(matchesOut, null, 2) + "\n");

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    rawDir: path.relative(process.cwd(), rawDir),
    outDir: path.relative(process.cwd(), outDir),
    totalFiles: rawFiles.length,
    totalInputRecords: aggregateRecords.total,
    totalAccepted: aggregateRecords.totalAccepted,
    totalSkipped: aggregateRecords.totalSkipped,
    booksCount: booksOut.length,
    notesCount: notesOut.length,
    matchesCount: matchesOut.length,
    fieldCoverage: aggregateCoverage,
    files: fileOutcomes,
    warnings,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // ---------- stdout: counts only ----------
  console.log(`[weread:normalize] rawDir=${path.relative(process.cwd(), rawDir)}`);
  console.log(`[weread:normalize] outDir=${path.relative(process.cwd(), outDir)}`);
  console.log(`[weread:normalize] totalFiles=${rawFiles.length}`);
  console.log(`[weread:normalize] totalInputRecords=${aggregateRecords.total}`);
  console.log(`[weread:normalize] totalAccepted=${aggregateRecords.totalAccepted}`);
  console.log(`[weread:normalize] totalSkipped=${aggregateRecords.totalSkipped}`);
  console.log(`[weread:normalize] booksCount=${booksOut.length}`);
  console.log(`[weread:normalize] notesCount=${notesOut.length}`);
  console.log(`[weread:normalize] matchesCount=0`);
  for (const f of fileOutcomes) {
    if (f.role === "skipped") continue;
    console.log(
      `  - ${f.file}: role=${f.role} input=${f.inputRecords} accepted=${f.accepted} skipped=${f.skipped}`,
    );
    for (const [reason, count] of Object.entries(f.skipReasons)) {
      console.log(`    ! skip.${reason}=${count}`);
    }
  }
  if (warnings.length > 0) for (const w of warnings) console.log(`  ! ${w}`);

  const status =
    aggregateRecords.totalSkipped > 0
      ? aggregateRecords.totalAccepted > 0
        ? "WARN"
        : "FAIL"
      : "PASS";
  console.log(`[weread:normalize] STATUS=${status}`);

  if (status === "FAIL") process.exit(1);
}

// Only auto-invoke when this is the CLI entry point.
const isCliEntry =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCliEntry) {
  main();
}

// ---------- exports for tests ----------
export {
  normalizeBook,
  normalizeNote,
  normalizeProgress,
  normalizeStatus,
  normalizeIsbn,
  classifyFileRole,
  inferNoteType,
  pickString,
  pickNumber,
  pickArrayLength,
};
export type { NormalizedBook, NormalizedNote, FileOutcome, Manifest, RawRecord };