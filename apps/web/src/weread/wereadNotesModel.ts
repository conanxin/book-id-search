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

// ---------- date formatting ----------

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