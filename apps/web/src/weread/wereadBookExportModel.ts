import type { WereadPrivateNoteItem } from "../wereadPrivate";

export const WEREAD_BOOK_EXPORT_LIMITS = {
  /** Filename max length after sanitisation (UTF-16 code units). */
  MAX_FILENAME_LENGTH: 80,
  /** Markdown truncation threshold for the safety banner. */
  TRUNCATION_SAFETY_LIMIT: 2000,
  /** Max body text length per single note inside the Markdown. */
  MAX_BODY_TEXT_LENGTH: 4000,
} as const;

/**
 * S27F: Public-book metadata that is safe to embed in the exported Markdown.
 * Comes from the public catalog (`/books/:id`), never from WeRead's raw
 * private fields.
 */
export interface WereadBookExportMeta {
  catalogId: string;
  title: string;
  author: string;
}

export interface WereadBookExportOptions {
  meta: WereadBookExportMeta;
  items: WereadPrivateNoteItem[];
  total?: number;
  truncated?: boolean;
  generatedAt?: Date;
}

export interface WereadBookExportResult {
  markdown: string;
  filename: string;
  grouped: Record<"highlight" | "thought" | "review" | "unknown", WereadPrivateNoteItem[]>;
}

const FORBIDDEN_FILENAME_PATTERN = /[\/\\:\*\?"<>\|\x00-\x1f=]/g;
const WHITESPACE_PATTERN = /\s+/g;
const HEADING_INJECTION_PATTERN = /^\s{0,3}(#{1,6}\s)/;

/**
 * Sanitise a filename candidate.
 *  - removes path separators, control chars, and Markdown-special characters
 *  - collapses whitespace
 *  - truncates to MAX_FILENAME_LENGTH UTF-16 units
 *  - strips trailing dots / spaces (Windows-illegal)
 *  - rejects empty / `..`-only names
 *
 * The returned value never contains the catalogId, token, search query, or
 * any private IDs.
 */
export function safeExportFilename(input: string): string {
  let out = String(input ?? "");
  out = out.replace(FORBIDDEN_FILENAME_PATTERN, "");
  out = out.replace(WHITESPACE_PATTERN, " ").trim();
  if (out === "" || out === "." || out === "..") return "weread-book-export";
  out = Array.from(out).slice(0, WEREAD_BOOK_EXPORT_LIMITS.MAX_FILENAME_LENGTH).join("");
  out = out.replace(/[.\s]+$/, "");
  if (out === "" || out === "." || out === "..") return "weread-book-export";
  return out;
}

/**
 * Build a Markdown file name for a per-book export.
 * Format: `weread-book-<catalogId>-<safeTitleOrFallback>.md`.
 * catalogId is sanitised (digits + underscore only) and the rest is sanitised.
 */
export function buildWereadBookExportFilename(meta: WereadBookExportMeta): string {
  const cat = meta.catalogId.replace(/[^0-9_]/g, "");
  const titleFallback = meta.title.trim() || meta.catalogId;
  const safeTitle = safeExportFilename(titleFallback);
  const head = cat.length > 0 ? `weread-book-${cat}-${safeTitle}` : `weread-book-${safeTitle}`;
  const filename = `${head}.md`;
  // Last-resort length clamp
  if (filename.length > WEREAD_BOOK_EXPORT_LIMITS.MAX_FILENAME_LENGTH + 30) {
    return filename.slice(0, WEREAD_BOOK_EXPORT_LIMITS.MAX_FILENAME_LENGTH + 30);
  }
  return filename;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return "—";
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function escapeHeading(text: string): string {
  // Strip leading `#` so user note text can't pretend to be a heading.
  return text.replace(HEADING_INJECTION_PATTERN, "");
}

function escapeMarkdown(text: string): string {
  // Convert newlines to `<br>` is NOT used; we keep Markdown structure intact.
  // We only escape raw `#` at line start to prevent heading injection.
  return text.split("\n").map((line) => escapeHeading(line)).join("\n");
}

function truncateBody(text: string): string {
  if (text.length <= WEREAD_BOOK_EXPORT_LIMITS.MAX_BODY_TEXT_LENGTH) return text;
  return text.slice(0, WEREAD_BOOK_EXPORT_LIMITS.MAX_BODY_TEXT_LENGTH) + "…";
}

function sortItemsByDate(items: WereadPrivateNoteItem[]): WereadPrivateNoteItem[] {
  return [...items].sort((a, b) => {
    const aMs = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bMs = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    // newest first; unknown (0) goes last
    return bMs - aMs;
  });
}

function groupItems(items: WereadPrivateNoteItem[]) {
  const groups: Record<"highlight" | "thought" | "review" | "unknown", WereadPrivateNoteItem[]> = {
    highlight: [],
    thought: [],
    review: [],
    unknown: [],
  };
  for (const it of items) {
    if (groups[it.type]) groups[it.type].push(it);
    else groups.unknown.push(it);
  }
  return groups;
}

const TYPE_LABEL: Record<"highlight" | "thought" | "review" | "unknown", string> = {
  highlight: "划线",
  thought: "想法",
  review: "书评",
  unknown: "未分类",
};

/**
 * Build a Markdown export for a single public book.
 *
 *  - title / author always come from `meta` (public catalog). Never use the
 *    WeRead raw title/author fields.
 *  - markdown is rendered as plain text via line concatenation; no HTML
 *    injection, no dangerouslySetInnerHTML.
 *  - text and comment are escaped to neutralise heading-injection patterns
 *    (leading `#`) but newlines and Markdown emphasis are preserved.
 *  - identical notes are NOT deduplicated (legitimate duplicate highlights).
 *  - when items is empty, throws — callers should refuse to export empty
 *    books.
 */
export function buildWereadBookMarkdown(options: WereadBookExportOptions): string {
  const { meta, items, total, truncated, generatedAt } = options;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("没有可导出的笔记。");
  }

  const sorted = sortItemsByDate(items);
  const grouped = groupItems(sorted);
  const ts = generatedAt ?? new Date();
  const tsIso = ts.toISOString();
  const totalReported = typeof total === "number" ? total : items.length;

  const lines: string[] = [];
  lines.push(`# ${escapeHeading(meta.title || "未命名书目")}`);
  lines.push("");
  lines.push(`> 作者: ${escapeHeading(meta.author || "—")}`);
  lines.push(`> 书目 ID: ${meta.catalogId}`);
  lines.push(`> 生成时间: ${tsIso}`);
  lines.push(`> 本次导出笔记: ${items.length} 条 (服务侧报告共 ${totalReported} 条)`);
  if (truncated) {
    lines.push(`> 达到 ${WEREAD_BOOK_EXPORT_LIMITS.TRUNCATION_SAFETY_LIMIT} 条安全上限，文件可能不完整。`);
  }
  lines.push("");
  lines.push(`> 本文件由当前浏览器的 private token 会话导出，书名与作者仅来自公共书目库 (book-id-search)。不会发送给 MiniMax，也不会写入 Meilisearch 或公开搜索。`);
  lines.push("");

  // Summary counts
  lines.push("## 摘要");
  lines.push("");
  lines.push(`- 划线: ${grouped.highlight.length}`);
  lines.push(`- 想法: ${grouped.thought.length}`);
  lines.push(`- 书评: ${grouped.review.length}`);
  lines.push(`- 未分类: ${grouped.unknown.length}`);
  lines.push("");

  const renderGroup = (key: keyof typeof grouped, heading: string) => {
    const arr = grouped[key];
    if (arr.length === 0) return;
    lines.push(`## ${heading} (${arr.length})`);
    lines.push("");
    for (const it of arr) {
      const date = formatDate(it.createdAt ?? it.updatedAt);
      lines.push(`### ${TYPE_LABEL[key]} · ${date}`);
      lines.push("");
      if (it.text && it.text.trim().length > 0) {
        lines.push(truncateBody(escapeMarkdown(it.text)));
        lines.push("");
      }
      if (it.comment && it.comment.trim().length > 0) {
        lines.push(`> 我的想法：${truncateBody(escapeMarkdown(it.comment))}`);
        lines.push("");
      }
    }
  };

  renderGroup("highlight", "划线");
  renderGroup("thought", "想法");
  renderGroup("review", "书评");
  renderGroup("unknown", "未分类");

  return lines.join("\n");
}

/**
 * Convenience wrapper that returns both markdown and filename.
 */
export function buildWereadBookExport(options: WereadBookExportOptions): WereadBookExportResult {
  const markdown = buildWereadBookMarkdown(options);
  const filename = buildWereadBookExportFilename(options.meta);
  const grouped = groupItems(sortItemsByDate(options.items));
  return { markdown, filename, grouped };
}