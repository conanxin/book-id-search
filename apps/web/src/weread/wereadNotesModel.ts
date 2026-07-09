/**
 * S27C: WeRead notes library view-model.
 *
 * Pure functions for formatting and exporting private notes data. These
 * functions NEVER receive raw private IDs — they only operate on the
 * shape returned by /api/private/weread/notes (no wereadBookId /
 * noteId / highlightId / chapterTitle / title / author).
 */
import type {
  WereadNotesQuery,
  WereadPrivateNoteItem,
  WereadNotesLibrarySummary,
  WereadNotesDaysFilter,
  WereadNotesSort,
  WereadNoteTypeFilter,
} from "../wereadPrivate";

// ---------- labels ----------

export function formatNoteTypeLabel(type: WereadPrivateNoteItem["type"]): string {
  switch (type) {
    case "highlight":
      return "划线";
    case "thought":
      return "想法";
    case "review":
      return "书评";
    case "unknown":
    default:
      return "未分类";
  }
}

export function formatDaysLabel(days: WereadNotesDaysFilter): string {
  switch (days) {
    case "7":
      return "近 7 天";
    case "30":
      return "近 30 天";
    case "90":
      return "近 90 天";
    case "all":
    default:
      return "全部时间";
  }
}

export function formatSortLabel(sort: WereadNotesSort): string {
  return sort === "newest" ? "最新优先" : "最早优先";
}

export function getFilterLabel(filter: WereadNoteTypeFilter): string {
  switch (filter) {
    case "all":
      return "全部";
    case "highlight":
      return "划线";
    case "thought":
      return "想法";
    case "review":
      return "书评";
  }
}

// ---------- note display normalization ----------

export interface WereadNoteDisplayParts {
  bodyText: string;
  commentText: string | null;
  isEmpty: boolean;
}

/**
 * Normalize a note for rendering. Trims whitespace, treats comment-only notes
 * (where text is empty but the user's annotation has content) as displayable,
 * and reports whether the note is fully empty so the UI can show a fallback.
 *
 * NEVER echoes any private IDs (which are already excluded by the API layer).
 */
export function getNoteDisplayParts(item: WereadPrivateNoteItem): WereadNoteDisplayParts {
  const bodyText = typeof item.text === "string" ? item.text.trim() : "";
  const commentText =
    typeof item.comment === "string" && item.comment.trim().length > 0 ? item.comment.trim() : null;
  const isEmpty = bodyText.length === 0 && commentText === null;
  return { bodyText, commentText, isEmpty };
}

export function formatNoteDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- preview / truncate ----------

export function truncateNotePreview(text: string, max = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ---------- summary formatting ----------

export interface WereadNotesSummaryView {
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
  unmatched: number;
}

export function formatNotesSummary(summary: WereadNotesLibrarySummary | null | undefined): WereadNotesSummaryView {
  const safe = (n: number | undefined): number => (typeof n === "number" && !Number.isNaN(n) ? n : 0);
  return {
    total: safe(summary?.totalAfterFilter),
    highlights: safe(summary?.highlights),
    thoughts: safe(summary?.thoughts),
    reviews: safe(summary?.reviews),
    unknown: safe(summary?.unknown),
    matched: safe(summary?.matchedCount),
    unmatched: safe(summary?.unmatchedCount),
  };
}

// ---------- markdown export ----------

const FORBIDDEN_PATTERN = /(wereadBookId|noteId|highlightId|chapterTitle)/i;

function scrubNoteText(text: string): string {
  // Defensive: strip any forbidden identifiers that might somehow slip in.
  return text.replace(FORBIDDEN_PATTERN, "[redacted]");
}

export interface BuildMarkdownExportOptions {
  query: WereadNotesQuery;
  generatedAt?: Date;
  privacyNotice?: string;
}

export function buildMarkdownExport(
  items: WereadPrivateNoteItem[],
  options: BuildMarkdownExportOptions
): string {
  const generatedAt = options.generatedAt ?? new Date();
  const dateStamp = `${generatedAt.getUTCFullYear()}${String(generatedAt.getUTCMonth() + 1).padStart(2, "0")}${String(generatedAt.getUTCDate()).padStart(2, "0")}`;

  const lines: string[] = [];
  lines.push("# 微信读书私有笔记导出");
  lines.push("");
  lines.push(
    `> 生成时间: ${generatedAt.toISOString()}  筛选: ${formatDaysLabel(options.query.days ?? "all")} / ${getFilterLabel(options.query.type ?? "all")} / ${formatSortLabel(options.query.sort ?? "newest")}`
  );
  lines.push("");
  if (options.privacyNotice) {
    lines.push(`> ${options.privacyNotice}`);
    lines.push("");
  }
  lines.push(`共 ${items.length} 条笔记`);
  lines.push("");

  for (const item of items) {
    const type = formatNoteTypeLabel(item.type);
    const date = formatNoteDate(item.createdAt ?? item.updatedAt);
    const matchedChip = item.matched && item.catalogId ? `已匹配书目 (${item.catalogId})` : "未匹配书目";
    lines.push(`## ${type} · ${date} · ${matchedChip}`);
    lines.push("");
    lines.push(scrubNoteText(item.text));
    if (item.comment && item.comment.trim().length > 0) {
      lines.push("");
      lines.push(`> 我的想法：${scrubNoteText(item.comment)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function buildMarkdownExportFilename(query: WereadNotesQuery, generatedAt?: Date): string {
  const stamp = generatedAt ?? new Date();
  const yyyy = stamp.getUTCFullYear();
  const mm = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(stamp.getUTCDate()).padStart(2, "0");
  return `weread-notes-export-${yyyy}${mm}${dd}.md`;
}

// ---------- query string helper (for react effect deps) ----------

export function notesQueryKey(query: WereadNotesQuery): string {
  return [
    query.type ?? "all",
    query.days ?? "all",
    query.matchedOnly ? "matched" : "allbooks",
    typeof query.hasComment === "boolean" ? (query.hasComment ? "withcomment" : "nocomment") : "anycomment",
    String(query.limit ?? 50),
    String(query.offset ?? 0),
    query.sort ?? "newest",
  ].join("|");
}

// ---------- S27D: full-text search helpers ----------

/**
 * Maximum query length accepted by the API. We cap locally so the UI can
 * surface a hint before round-tripping a 400.
 */
export const WEREAD_NOTE_SEARCH_MAX_LENGTH = 100;

/**
 * Normalize a raw search query: trim, cap to WEREAD_NOTE_SEARCH_MAX_LENGTH,
 * collapse internal whitespace. Returns "" for non-string / empty / whitespace-
 * only inputs — this is the "no search" sentinel everywhere downstream.
 *
 * This function NEVER logs or echoes its input.
 */
export function normalizeNoteSearchQuery(q: unknown): string {
  if (typeof q !== "string") return "";
  const trimmed = q.trim();
  if (trimmed.length === 0) return "";
  // collapse runs of whitespace
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length > WEREAD_NOTE_SEARCH_MAX_LENGTH) {
    return collapsed.slice(0, WEREAD_NOTE_SEARCH_MAX_LENGTH);
  }
  return collapsed;
}

/**
 * Split a normalized search string into individual search terms (lowercased).
 * Returns [] for an empty input.
 */
export function getNoteSearchTerms(q: string | null | undefined): string[] {
  if (typeof q !== "string") return [];
  if (q.trim().length === 0) return [];
  return q
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** True iff the query is non-empty (search is active). */
export function hasNoteSearchQuery(q: string | null | undefined): boolean {
  return typeof q === "string" && q.trim().length > 0;
}

/**
 * One rendered text segment with a flag for whether it matched the search.
 * Used by NotesLibrary.tsx to render <mark> elements via React fragments —
 * no dangerouslySetInnerHTML, so XSS is impossible regardless of note text.
 */
export interface NoteHighlightPart {
  text: string;
  matched: boolean;
}

/**
 * Split `text` into substrings, marking each as `matched` if it contains one
 * of the search terms (case-insensitive). When `q` is empty (or trimmed to
 * empty) the function returns a single un-matched part with the original
 * text — by design, not as a fallback.
 *
 * The function never uses regex with user-controlled flags, and never builds
 * HTML strings. The matched-text comparison is plain `String.prototype.includes`.
 */
export function highlightNoteTextParts(text: string, q: string | null | undefined): NoteHighlightPart[] {
  const safeText = typeof text === "string" ? text : "";
  const terms = getNoteSearchTerms(q);
  if (terms.length === 0 || safeText.length === 0) {
    return [{ text: safeText, matched: false }];
  }
  // Find every match position across all terms. We do substring matching
  // (no regex backtracking) and emit alternating matched / unmatched spans.
  const lower = safeText.toLowerCase();
  type Marker = { start: number; end: number };
  const markers: Marker[] = [];
  for (const term of terms) {
    if (term.length === 0) continue;
    let from = 0;
    while (from <= lower.length - term.length) {
      const idx = lower.indexOf(term, from);
      if (idx === -1) break;
      markers.push({ start: idx, end: idx + term.length });
      from = idx + term.length;
    }
  }
  if (markers.length === 0) return [{ text: safeText, matched: false }];
  // Sort + merge overlapping ranges.
  markers.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Marker[] = [markers[0]];
  for (let i = 1; i < markers.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = markers[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  const parts: NoteHighlightPart[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) {
      parts.push({ text: safeText.slice(cursor, m.start), matched: false });
    }
    parts.push({ text: safeText.slice(m.start, m.end), matched: true });
    cursor = m.end;
  }
  if (cursor < safeText.length) {
    parts.push({ text: safeText.slice(cursor), matched: false });
  }
  return parts;
}

/**
 * Format the server-side searchInfo for the UI. Only counts are exposed —
 * the raw query is intentionally NEVER shown in the UI summary.
 */
export interface NotesSearchInfoView {
  enabled: boolean;
  queryLength: number;
  termsCount: number;
  matchedCount: number;
}

export function formatNotesSearchInfo(
  info: { enabled?: boolean; queryLength?: number; termsCount?: number; matchedCount?: number } | null | undefined
): NotesSearchInfoView {
  const safe = (n: number | undefined): number =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const enabled = info?.enabled === true;
  return {
    enabled,
    queryLength: safe(info?.queryLength),
    termsCount: safe(info?.termsCount),
    matchedCount: safe(info?.matchedCount),
  };
}