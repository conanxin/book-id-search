/**
 * S27K-2 — Browser-local Markdown export for the private WeRead
 * "year-over-year reading comparison" panel.
 *
 * Strict privacy contract (mirrors S27K / S27J-2):
 *   - NEVER embeds note text, note comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, the AI summary body, the session
 *     theme overlay, the WeRead private title / author, the token,
 *     the `q` search term, or any raw snapshot record.
 *   - Consumes ONLY the structured `WereadYearComparison` payload
 *     already produced by the S27K model. The Markdown exporter
 *     reads public catalog fields (catalogId, title, author,
 *     publisher, publishYear) and computed counts/deltas.
 *   - All formatting is done in pure functions. `triggerYearComparisonMarkdownDownload`
 *     is the ONLY function that touches the DOM / browser download
 *     API. It never persists anything to localStorage /
 *     sessionStorage / IndexedDB / server / external service.
 *   - The download helper creates a transient Blob URL, dispatches a
 *     click on a temporary anchor and revokes the URL on the next
 *     tick. No markdown content is ever logged.
 *
 * Markdown rules (mirroring S27J-2):
 *   - No HTML / YAML frontmatter / external libraries.
 *   - Inline text uses `escapeComparisonMarkdownInline` (collapses
 *     whitespace, strips control characters, escapes Markdown meta
 *     characters).
 *   - Table cells use `escapeComparisonMarkdownTableCell` to avoid
 *     breaking the `|`-delimited table.
 *   - Book titles are treated as plain inline text inside
 *     `# 《title》` headings. We deliberately use a half-width `# `
 *     so even a hostile public title cannot impersonate a top-level
 *     Markdown heading line.
 *   - catalogId is the ONLY identifier we ever embed, and only as
 *     part of the public `/books/<catalogId>` URL.
 */

import type { WereadYearComparison } from "./wereadYearComparisonModel";

// ---------- public API ----------

export type YearComparisonMarkdownInput = {
  comparison: WereadYearComparison;
  topBooksLimit: 6 | 12 | 18;
  exportedAt: Date;
  /** Optional site base URL (default `https://books.conanxin.com`). */
  siteBaseUrl?: string;
};

export interface BuildYearComparisonMarkdownResult {
  content: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  baseYear: number;
  targetYear: number;
  topBooksLimit: number;
}

export interface BuildYearComparisonMarkdownFilenameArgs {
  baseYear: number;
  targetYear: number;
  now: Date;
}

export interface YearComparisonMarkdownAnchorDescriptor {
  href: string;
  download: string;
  rel: string;
  testId: string;
}

export interface TriggerYearComparisonMarkdownDownloadArgs {
  content: string;
  filename: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  attachAnchor?: (anchor: YearComparisonMarkdownAnchorDescriptor) => void;
  resolveDocument?: () => DocumentLike | null;
}

export interface DocumentLike {
  createElement(tagName: string): {
    setAttribute(name: string, value: string): void;
    click(): void;
  };
  body?: { appendChild(node: unknown): void; removeChild(node: unknown): void } | null;
}

export interface TriggerYearComparisonMarkdownDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  revoked: boolean;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const YEAR_COMPARISON_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX = "weread-year-comparison";
export const YEAR_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH = 80;
export const YEAR_COMPARISON_MARKDOWN_SITE_BASE_URL = "https://books.conanxin.com";
export const YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE =
  "隐私说明：本文件由用户主动在浏览器中生成。文件包含公共书目信息和个人阅读统计，请自行妥善保管。";
export const YEAR_COMPARISON_MARKDOWN_INTERPRETATION_NOTE =
  "解释边界：以下结果只描述阅读记录数量和公共书目榜单变化，不代表阅读质量、兴趣、心理状态或开始/停止阅读。";
export const YEAR_COMPARISON_MARKDOWN_ENTERED_NOTE =
  "本分组只表示书目进入当前 Top N 榜单，不表示该书首次开始阅读。";
export const YEAR_COMPARISON_MARKDOWN_LEFT_NOTE =
  "本分组只表示书目未进入当前 Top N 榜单，不表示已经停止阅读。";
export const YEAR_COMPARISON_MARKDOWN_DISCLAIMER_BULLETS: ReadonlyArray<string> = [
  "比较范围为两个自然年。",
  "只有有效日期记录进入年度统计。",
  "高互动书目变化受当前 Top N 范围影响。",
  "榜单进入或离开不表示开始或停止阅读。",
  "本报告未使用外部 AI。",
  "本报告未分析阅读主题、阅读质量或个人特征。",
];

const FORBIDDEN_TABLE_ROW_SPLIT_PATTERN = /\|/;
const FORBIDDEN_NA_LITERAL = "null";

// ---------- inline / table escaping ----------

/**
 * Strip control characters (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F) so
 * they can never reach the file. Newlines / carriage returns are
 * replaced by spaces so the rendered Markdown stays on a single
 * line, and runs of whitespace are collapsed into a single space.
 */
function stripControlAndCollapse(input: string): string {
  let out = "";
  let prevSpace = false;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    const isNewline = code === 0x0a || code === 0x0d;
    const isControl =
      (code <= 0x08 && !isNewline) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    if (isNewline) {
      if (prevSpace) continue;
      out += " ";
      prevSpace = true;
      continue;
    }
    if (isControl) {
      if (prevSpace) continue;
      out += " ";
      prevSpace = true;
      continue;
    }
    if (code === 0x09 || code === 0x20) {
      if (prevSpace) continue;
      out += " ";
      prevSpace = true;
      continue;
    }
    out += input[i];
    prevSpace = false;
  }
  return out;
}

/**
 * Escape characters that have Markdown semantics when used inside
 * inline text. We escape the full set requested by the spec, plus
 * backticks (to be safe against accidental code spans).
 */
export function escapeComparisonMarkdownInline(input: unknown): string {
  if (input === null || input === undefined) return "";
  const clean = stripControlAndCollapse(String(input));
  let out = "";
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case "*":
        out += "\\*";
        break;
      case "_":
        out += "\\_";
        break;
      case "`":
        out += "\\`";
        break;
      case "[":
        out += "\\[";
        break;
      case "]":
        out += "\\]";
        break;
      case "<":
        out += "\\<";
        break;
      case ">":
        out += "\\>";
        break;
      case "#":
        out += "\\#";
        break;
      case "|":
        out += "\\|";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/**
 * Escape a single Markdown table cell. Always returns a single-line
 * string; newlines are converted to spaces so the table layout is
 * never broken.
 */
export function escapeComparisonMarkdownTableCell(input: unknown): string {
  if (input === null || input === undefined) return "";
  const cleaned = stripControlAndCollapse(String(input));
  let out = "";
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === "\\") out += "\\\\";
    else if (ch === "|") out += "\\|";
    else if (ch === "<") out += "\\<";
    else if (ch === ">") out += "\\>";
    else out += ch;
  }
  return out;
}

// ---------- date / label helpers ----------

export function formatComparisonMarkdownDate(input: Date): string {
  if (!(input instanceof Date) || !Number.isFinite(input.getTime())) return "";
  const y = input.getFullYear();
  const m = String(input.getMonth() + 1).padStart(2, "0");
  const d = String(input.getDate()).padStart(2, "0");
  const hh = String(input.getHours()).padStart(2, "0");
  const mm = String(input.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * Pretty-print a comparison value. Numbers are formatted with
 * Chinese grouping, with sign attached to non-zero values. Falls
 * back to `0` for NaN / Infinity.
 */
export function formatComparisonValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return rounded.toLocaleString("zh-CN");
}

/**
 * Pretty-print a signed delta. Positive numbers get `+`, negative
 * keep the minus sign (rendered as `−` per project convention),
 * zero is `0`. NaN / Infinity fall back to `0`.
 */
export function formatComparisonChange(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  if (rounded > 0) return `+${rounded.toLocaleString("zh-CN")}`;
  return `−${Math.abs(rounded).toLocaleString("zh-CN")}`;
}

/**
 * Pretty-print a percentage cell. Renders `-100%` when going from a
 * positive base to zero, `由 0 开始` when going from zero to a
 * positive target, `0%` for identical values. Anything non-finite
 * becomes `0%`.
 */
export function formatComparisonPercentChange(args: {
  baseValue: number;
  targetValue: number;
}): string {
  const base = Number(args.baseValue);
  const target = Number(args.targetValue);
  if (!Number.isFinite(base) || !Number.isFinite(target)) return "0%";
  if (base === 0 && target === 0) return "0%";
  if (base === 0 && target > 0) return "由 0 开始";
  if (base > 0 && target === 0) return "-100%";
  const pct = ((target - base) / base) * 100;
  if (!Number.isFinite(pct)) return "0%";
  if (pct === 0) return "0%";
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  const body = Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
  return pct > 0 ? `+${body}` : `−${body}`;
}

// ---------- builders ----------

/**
 * Build the full Markdown document for the supplied comparison.
 *
 * - Pure function: takes a `Date` so tests can pin the timestamp.
 * - Never reads AI summary, related-books, notes payload or the raw
 *   WeRead title/author.
 * - When both years are empty (no metrics, no books), the document
 *   still includes the zero-valued metric table, the zero-valued 12
 *   month comparison, the four zero-valued quarters, and the three
 *   empty book-change groups. No fake ranks or numbers are emitted.
 */
export function buildYearComparisonMarkdown(
  input: YearComparisonMarkdownInput
): BuildYearComparisonMarkdownResult {
  const comparison = input.comparison;
  if (!comparison) throw new Error("comparison is missing");
  const baseYear = comparison.baseYear;
  const targetYear = comparison.targetYear;
  if (!Number.isInteger(baseYear) || baseYear < 1900 || baseYear > 9999) {
    throw new Error(`baseYear ${baseYear} is not a 4-digit year`);
  }
  if (!Number.isInteger(targetYear) || targetYear < 1900 || targetYear > 9999) {
    throw new Error(`targetYear ${targetYear} is not a 4-digit year`);
  }
  if (![6, 12, 18].includes(input.topBooksLimit)) {
    throw new Error(`topBooksLimit ${input.topBooksLimit} is not 6/12/18`);
  }
  const exportedAt = input.exportedAt instanceof Date ? input.exportedAt : new Date();
  const siteBaseUrl = input.siteBaseUrl ?? YEAR_COMPARISON_MARKDOWN_SITE_BASE_URL;

  const lines: string[] = [];

  // Title
  lines.push(`# ${baseYear}—${targetYear} 年阅读对比`);
  lines.push("");

  // Meta bullets
  lines.push(`- 基准年度：${baseYear}`);
  lines.push(`- 目标年度：${targetYear}`);
  lines.push(`- 高互动书目范围：Top ${input.topBooksLimit}`);
  lines.push("- 导出时间：" + (formatComparisonMarkdownDate(exportedAt) || "—"));
  lines.push("- 数据来源：微信读书私有年度聚合数据");
  lines.push("- 生成方式：book-id-search 浏览器本地生成");
  lines.push("- 保存状态：未上传服务器");
  lines.push("");
  // Privacy / interpretation notices
  lines.push(`> ${YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE}`);
  lines.push("");
  lines.push(`> ${YEAR_COMPARISON_MARKDOWN_INTERPRETATION_NOTE}`);
  lines.push("");

  // Core metrics
  lines.push("## 核心指标");
  lines.push("");
  lines.push("| 指标 | " + baseYear + " | " + targetYear + " | 变化 | 百分比 |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const metric of comparison.metrics) {
    lines.push(
      `| ${escapeComparisonMarkdownTableCell(metric.label)} | ${formatComparisonValue(metric.baseValue)} | ${formatComparisonValue(metric.targetValue)} | ${formatComparisonChange(metric.delta)} | ${escapeComparisonMarkdownTableCell(formatPercentCell(metric))} |`
    );
  }
  lines.push("");

  // 12-month comparison
  lines.push("## 12 个月对比");
  lines.push("");
  lines.push(`| 月份 | ${baseYear}记录 | ${targetYear}记录 | 差值 | ${baseYear}书目 | ${targetYear}书目 |`);
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const m of comparison.months) {
    lines.push(
      `| ${escapeComparisonMarkdownTableCell(m.label)} | ${formatComparisonValue(m.baseTotal)} | ${formatComparisonValue(m.targetTotal)} | ${formatComparisonChange(m.delta)} | ${formatComparisonValue(m.baseBookCount)} | ${formatComparisonValue(m.targetBookCount)} |`
    );
  }
  lines.push("");

  // Quarter comparison
  lines.push("## 季度对比");
  lines.push("");
  for (const q of comparison.quarters) {
    lines.push(`### ${q.quarter}`);
    lines.push("");
    lines.push(`- ${baseYear} 阅读记录：${formatComparisonValue(q.baseTotal)}`);
    lines.push(`- ${targetYear} 阅读记录：${formatComparisonValue(q.targetTotal)}`);
    lines.push(`- 变化：${formatComparisonChange(q.delta)}`);
    lines.push(`- ${baseYear} 活跃月份：${formatComparisonValue(q.baseActiveMonths)}`);
    lines.push(`- ${targetYear} 活跃月份：${formatComparisonValue(q.targetActiveMonths)}`);
    lines.push(`- ${baseYear} 书目：${formatComparisonValue(q.baseBookCount)}`);
    lines.push(`- ${targetYear} 书目：${formatComparisonValue(q.targetBookCount)}`);
    lines.push("");
  }

  // Continuing books
  lines.push("## 连续进入两年高互动书目榜");
  lines.push("");
  if (comparison.continuingBooks.length === 0) {
    lines.push("无连续进入两年高互动书目榜的书目。");
    lines.push("");
  } else {
    for (let i = 0; i < comparison.continuingBooks.length; i += 1) {
      const book = comparison.continuingBooks[i];
      const safeTitle = escapeComparisonMarkdownInline(book.title || `书目 ${book.catalogId}`);
      lines.push(`### ${i + 1}. 《${safeTitle}》`);
      lines.push("");
      const author = trimToString(book.author);
      if (author) {
        lines.push(`- 作者：${escapeComparisonMarkdownInline(author)}`);
      } else {
        lines.push("- 作者：—");
      }
      lines.push(`- ${baseYear} 排名：第 ${formatComparisonValue(book.baseRank ?? 0)}`);
      lines.push(`- ${targetYear} 排名：第 ${formatComparisonValue(book.targetRank ?? 0)}`);
      lines.push(`- 排名变化：${formatRankChangeLabel(book.rankChange)}`);
      lines.push(`- ${baseYear} 阅读记录：${formatComparisonValue(book.baseNoteCount)}`);
      lines.push(`- ${targetYear} 阅读记录：${formatComparisonValue(book.targetNoteCount)}`);
      lines.push(`- 书目页面：${siteBaseUrl}/books/${book.catalogId}`);
      lines.push("");
    }
  }

  // Entered books
  lines.push("## 进入目标年度高互动书目榜");
  lines.push("");
  lines.push(`> ${YEAR_COMPARISON_MARKDOWN_ENTERED_NOTE}`);
  lines.push("");
  if (comparison.enteredBooks.length === 0) {
    lines.push("无新进入目标年度高互动书目榜的书目。");
    lines.push("");
  } else {
    for (let i = 0; i < comparison.enteredBooks.length; i += 1) {
      const book = comparison.enteredBooks[i];
      const safeTitle = escapeComparisonMarkdownInline(book.title || `书目 ${book.catalogId}`);
      lines.push(`### ${i + 1}. 《${safeTitle}》`);
      lines.push("");
      const author = trimToString(book.author);
      if (author) {
        lines.push(`- 作者：${escapeComparisonMarkdownInline(author)}`);
      } else {
        lines.push("- 作者：—");
      }
      lines.push(`- ${baseYear} 排名：—`);
      lines.push(`- ${targetYear} 排名：第 ${formatComparisonValue(book.targetRank ?? 0)}`);
      lines.push(`- 排名变化：—`);
      lines.push(`- ${baseYear} 阅读记录：${formatComparisonValue(book.baseNoteCount)}`);
      lines.push(`- ${targetYear} 阅读记录：${formatComparisonValue(book.targetNoteCount)}`);
      lines.push(`- 书目页面：${siteBaseUrl}/books/${book.catalogId}`);
      lines.push("");
    }
  }

  // Left books
  lines.push("## 未进入目标年度高互动书目榜");
  lines.push("");
  lines.push(`> ${YEAR_COMPARISON_MARKDOWN_LEFT_NOTE}`);
  lines.push("");
  if (comparison.leftBooks.length === 0) {
    lines.push("无未进入目标年度高互动书目榜的书目。");
    lines.push("");
  } else {
    for (let i = 0; i < comparison.leftBooks.length; i += 1) {
      const book = comparison.leftBooks[i];
      const safeTitle = escapeComparisonMarkdownInline(book.title || `书目 ${book.catalogId}`);
      lines.push(`### ${i + 1}. 《${safeTitle}》`);
      lines.push("");
      const author = trimToString(book.author);
      if (author) {
        lines.push(`- 作者：${escapeComparisonMarkdownInline(author)}`);
      } else {
        lines.push("- 作者：—");
      }
      lines.push(`- ${baseYear} 排名：第 ${formatComparisonValue(book.baseRank ?? 0)}`);
      lines.push(`- ${targetYear} 排名：—`);
      lines.push(`- 排名变化：—`);
      lines.push(`- ${baseYear} 阅读记录：${formatComparisonValue(book.baseNoteCount)}`);
      lines.push(`- ${targetYear} 阅读记录：${formatComparisonValue(book.targetNoteCount)}`);
      lines.push(`- 书目页面：${siteBaseUrl}/books/${book.catalogId}`);
      lines.push("");
    }
  }

  // Descriptive summaries
  lines.push("## 描述性变化摘要");
  lines.push("");
  if (comparison.summaries.length === 0) {
    lines.push("当前对比未生成新的描述性摘要。");
    lines.push("");
  } else {
    for (const line of comparison.summaries) {
      lines.push(`- ${escapeComparisonMarkdownInline(line)}`);
    }
    lines.push("");
  }

  // Notes
  lines.push("## 说明");
  lines.push("");
  for (const note of YEAR_COMPARISON_MARKDOWN_DISCLAIMER_BULLETS) {
    lines.push(`- ${escapeComparisonMarkdownInline(note)}`);
  }
  lines.push("");

  const content = lines.join("\n");
  const filename = buildYearComparisonMarkdownFilename({
    baseYear,
    targetYear,
    now: exportedAt,
  });
  return {
    content,
    filename,
    mimeType: YEAR_COMPARISON_MARKDOWN_MIME,
    byteLength: byteLengthUtf8(content),
    baseYear,
    targetYear,
    topBooksLimit: input.topBooksLimit,
  };
}

function formatPercentCell(metric: WereadYearComparison["metrics"][number]): string {
  // The from_zero / to_zero directions take precedence over the
  // numeric `percentChange` so we always render the documented
  // baseline string ("由 0 开始" / "-100%") even if a future refactor
  // accidentally leaves a number on `percentChange`.
  if (metric.direction === "from_zero") {
    return "由 0 开始";
  }
  if (metric.direction === "to_zero") {
    return "-100%";
  }
  if (metric.percentChange === null || metric.percentChange === undefined) {
    return "—";
  }
  if (!Number.isFinite(metric.percentChange)) return "0%";
  if (metric.percentChange === 0) return "0%";
  const abs = Math.abs(metric.percentChange);
  const rounded = Math.round(abs * 10) / 10;
  const body = Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
  return metric.percentChange > 0 ? `+${body}` : `−${body}`;
}

function formatRankChangeLabel(rankChange: number | null): string {
  if (rankChange === null || rankChange === undefined) return "—";
  if (!Number.isFinite(rankChange)) return "—";
  const rounded = Math.round(rankChange);
  if (rounded === 0) return "持平";
  if (rounded > 0) return `上升 ${rounded} 位`;
  return `下降 ${Math.abs(rounded)} 位`;
}

// ---------- filename ----------

export function buildYearComparisonMarkdownFilename(
  args: BuildYearComparisonMarkdownFilenameArgs
): string {
  const base = Number(args.baseYear);
  const target = Number(args.targetYear);
  if (!Number.isInteger(base) || base < 1900 || base > 9999) {
    throw new Error(`baseYear ${args.baseYear} is not a 4-digit year`);
  }
  if (!Number.isInteger(target) || target < 1900 || target > 9999) {
    throw new Error(`targetYear ${args.targetYear} is not a 4-digit year`);
  }
  const now = args.now instanceof Date ? args.now : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("exportedAt is not a valid Date");
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const stamp = `${y}${m}${d}`;
  const candidate = `${YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX}-${base}-vs-${target}-${stamp}.md`;
  if (candidate.length > YEAR_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH) {
    return candidate.slice(0, YEAR_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH);
  }
  return candidate;
}

// ---------- validation ----------

/**
 * Lightweight structural validator. Returns an array of human-
 * readable error strings (empty array = valid). It is intentionally
 * minimal — it catches the common bugs a future refactor could
 * introduce (missing H1, broken table, forbidden fields, etc.).
 */
export function validateYearComparisonMarkdown(content: string): string[] {
  const errors: string[] = [];
  if (typeof content !== "string" || content.length === 0) {
    errors.push("content is empty");
    return errors;
  }
  const titlePattern = /^# \d{4}—\d{4} 年阅读对比/m;
  if (!titlePattern.test(content)) {
    errors.push("missing top-level title in expected format 'YYYY—YYYY 年阅读对比'");
  }
  if (!content.includes("## 核心指标")) {
    errors.push("missing 核心指标 section");
  }
  if (!content.includes("## 12 个月对比")) {
    errors.push("missing 12 个月对比 section");
  }
  if (!content.includes("## 季度对比")) {
    errors.push("missing 季度对比 section");
  }
  if (!content.includes("## 连续进入两年高互动书目榜")) {
    errors.push("missing continuing books section");
  }
  if (!content.includes("## 进入目标年度高互动书目榜")) {
    errors.push("missing entered books section");
  }
  if (!content.includes("## 未进入目标年度高互动书目榜")) {
    errors.push("missing left books section");
  }
  if (!content.includes("## 描述性变化摘要")) {
    errors.push("missing summaries section");
  }
  if (!content.includes("## 说明")) {
    errors.push("missing 说明 section");
  }
  if (!content.includes(YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE)) {
    errors.push("missing privacy notice blockquote");
  }
  if (!content.includes(YEAR_COMPARISON_MARKDOWN_INTERPRETATION_NOTE)) {
    errors.push("missing interpretation boundary notice");
  }
  if (!content.includes(YEAR_COMPARISON_MARKDOWN_ENTERED_NOTE)) {
    errors.push("missing entered-books disclaimer");
  }
  if (!content.includes(YEAR_COMPARISON_MARKDOWN_LEFT_NOTE)) {
    errors.push("missing left-books disclaimer");
  }
  // 12-row month table check (header + separator + 12 rows).
  const monthHeaderPattern = /\|\s*月份\s*\|\s*\d{4}记录\s*\|\s*\d{4}记录\s*\|\s*差值\s*\|\s*\d{4}书目\s*\|\s*\d{4}书目\s*\|/;
  if (!monthHeaderPattern.test(content)) {
    errors.push("missing 12-month comparison table header");
  } else {
    const rows = content
      .split("\n")
      .filter((line) => FORBIDDEN_TABLE_ROW_SPLIT_PATTERN.test(line));
    const monthRowRegex = /^\|\s*\d{1,2}月\s*\|/;
    const monthRows = rows.filter((line) => monthRowRegex.test(line));
    if (monthRows.length < 12) {
      errors.push(`12-month comparison table has ${monthRows.length} rows, expected 12`);
    }
  }
  // Quarter headings in order
  const idxQ1 = content.indexOf("### Q1");
  const idxQ2 = content.indexOf("### Q2");
  const idxQ3 = content.indexOf("### Q3");
  const idxQ4 = content.indexOf("### Q4");
  if (idxQ1 < 0 || idxQ2 < 0 || idxQ3 < 0 || idxQ4 < 0) {
    errors.push("missing one or more quarter headings");
  } else if (!(idxQ1 < idxQ2 && idxQ2 < idxQ3 && idxQ3 < idxQ4)) {
    errors.push("quarter headings are not in Q1..Q4 order");
  }
  // Forbidden literal / leakage checks (defence in depth — the model
  // never emits these, but we still surface them so a future
  // refactor cannot accidentally regress the contract). The
  // ASCII "-100%" string is intentionally NOT banned because the
  // to_zero rule per the S27K-2 spec requires us to emit "-100%"
  // when a positive base moved to a zero target.
  for (const banned of [
    "NaN",
    "Infinity",
    "FORBIDDEN_NOTE_TEXT",
    "FORBIDDEN_NOTE_COMMENT",
    "FORBIDDEN_OVERVIEW",
    "FORBIDDEN_PRIVATE_ID",
    "FORBIDDEN_TOKEN",
  ]) {
    if (content.includes(banned)) {
      errors.push(`forbidden literal in markdown: ${banned}`);
    }
  }
  if (content.toLowerCase().includes(FORBIDDEN_NA_LITERAL)) {
    // 'null' can occur in code blocks only — defensive check.
    const idx = content.toLowerCase().indexOf(FORBIDDEN_NA_LITERAL);
    if (idx >= 0) {
      errors.push(`forbidden literal "null" at offset ${idx}`);
    }
  }
  return errors;
}

// ---------- download helper ----------

/**
 * Trigger a browser download for the supplied Markdown content.
 *
 * - Dependency-injected so tests can run without a real DOM /
 *   `URL.createObjectURL`.
 * - The Blob is built with `YEAR_COMPARISON_MARKDOWN_MIME` so the
 *   OS picks the Markdown app / editor.
 * - The anchor is appended to `document.body`, clicked, and removed
 *   synchronously. The Blob URL is revoked on the next tick so the
 *   browser has a chance to read it.
 * - The Markdown content is never logged or persisted.
 */
export function triggerYearComparisonMarkdownDownload(
  args: TriggerYearComparisonMarkdownDownloadArgs
): TriggerYearComparisonMarkdownDownloadResult {
  const content = String(args.content ?? "");
  const filename = String(args.filename ?? "");
  const blob = new Blob([content], { type: YEAR_COMPARISON_MARKDOWN_MIME });
  const createObjectUrl =
    args.createObjectUrl ??
    ((b: Blob) => URL.createObjectURL(b));
  const revokeObjectUrl =
    args.revokeObjectUrl ??
    ((url: string) => URL.revokeObjectURL(url));
  const blobUrl = createObjectUrl(blob);
  const descriptor: YearComparisonMarkdownAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener",
    testId: "weread-year-comparison-markdown-anchor",
  };
  if (args.attachAnchor) {
    args.attachAnchor(descriptor);
  } else {
    defaultAttachAnchor(descriptor, args.resolveDocument);
  }
  setTimeout(() => {
    try {
      revokeObjectUrl(blobUrl);
    } catch {
      // ignore — revoke failures are non-fatal
    }
  }, 0);
  return {
    filename,
    size: blob.size,
    mimeType: YEAR_COMPARISON_MARKDOWN_MIME,
    blobUrl,
    revoked: false,
    downloadTriggered: true,
  };
}

function defaultAttachAnchor(
  descriptor: YearComparisonMarkdownAnchorDescriptor,
  resolveDocument?: () => DocumentLike | null
): void {
  const doc =
    resolveDocument?.() ??
    (typeof document !== "undefined" ? (document as unknown as DocumentLike) : null);
  if (!doc) return;
  const anchor = doc.createElement("a");
  anchor.setAttribute("href", descriptor.href);
  anchor.setAttribute("download", descriptor.download);
  anchor.setAttribute("data-testid", descriptor.testId);
  anchor.setAttribute("rel", descriptor.rel);
  if (doc.body) {
    doc.body.appendChild(anchor);
    anchor.click();
    doc.body.removeChild(anchor);
  } else {
    anchor.click();
  }
}

// ---------- internal helpers ----------

function trimToString(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = String(input).trim();
  return s;
}

function byteLengthUtf8(input: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input).length;
  }
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}