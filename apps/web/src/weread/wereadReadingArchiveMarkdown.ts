/**
 * S27L-2 — Browser-local Markdown export for the private WeRead
 * "long-term reading archive" workspace.
 *
 * Strict privacy contract (mirrors S27J-2 / S27K-2):
 *   - NEVER embeds note text, note comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, the AI summary body, the session
 *     theme overlay, the WeRead private title / author, the token,
 *     the `q` search term, or any raw snapshot record.
 *   - Consumes ONLY the structured `WereadReadingArchive` payload
 *     already produced by the S27L model. The Markdown exporter
 *     reads public catalog fields (catalogId, title, author,
 *     publisher, publishYear) and computed counts.
 *   - All formatting is done in pure functions.
 *     `triggerReadingArchiveMarkdownDownload` is the ONLY function
 *     that touches the DOM / browser download API. It never
 *     persists anything to localStorage / sessionStorage / IndexedDB
 *     / server / external service.
 *   - The download helper creates a transient Blob URL, dispatches a
 *     click on a temporary anchor and revokes the URL on the next
 *     tick. No markdown content is ever logged.
 *
 * Markdown rules (mirroring S27J-2 / S27K-2):
 *   - No HTML / YAML frontmatter / external libraries.
 *   - Inline text uses `escapeArchiveMarkdownInline` (collapses
 *     whitespace, strips control characters, escapes Markdown meta
 *     characters).
 *   - Table cells use `escapeArchiveMarkdownTableCell` to avoid
 *     breaking the `|`-delimited table.
 *   - Book titles are treated as plain inline text inside
 *     `《title》` markers. We deliberately use a half-width `# `
 *     only on real headings so a hostile public title cannot
 *     impersonate a top-level Markdown heading line.
 *   - catalogId is the ONLY identifier we ever embed, and only as
 *     part of the public `/books/<catalogId>` URL.
 */

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
  ReadingArchiveYearLink,
  ReadingArchiveOverview,
} from "./wereadReadingArchiveModel";

// ---------- public API ----------

export type ReadingArchiveRangeLabel = "最近5年" | "最近10年" | "全部";

export type ReadingArchiveMarkdownInput = {
  archive: WereadReadingArchive;
  rangeLabel: ReadingArchiveRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  /** Years that failed to load. Empty array if all OK. */
  failedYears: number[];
  exportedAt: Date;
  /** Optional site base URL (default `https://books.conanxin.com`). */
  siteBaseUrl?: string;
};

export interface BuildReadingArchiveMarkdownResult {
  content: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  rangeLabel: ReadingArchiveRangeLabel;
  topBooksLimit: number;
  yearCount: number;
  failedYearCount: number;
}

export interface BuildReadingArchiveMarkdownFilenameArgs {
  firstYear: number | null;
  latestYear: number | null;
  now: Date;
}

export interface ReadingArchiveMarkdownAnchorDescriptor {
  href: string;
  download: string;
  rel: string;
  testId: string;
}

export interface DocumentLike {
  createElement: (tag: string) => HTMLElementLike;
  body?: { appendChild: (el: HTMLElementLike) => void; removeChild: (el: HTMLElementLike) => void } | null;
}

export interface HTMLElementLike {
  setAttribute: (name: string, value: string) => void;
  click: () => void;
}

export interface TriggerReadingArchiveMarkdownDownloadArgs {
  content: string;
  filename: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  attachAnchor?: (anchor: ReadingArchiveMarkdownAnchorDescriptor) => void;
  resolveDocument?: () => DocumentLike | null;
}

export interface TriggerReadingArchiveMarkdownDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const READING_ARCHIVE_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const READING_ARCHIVE_MARKDOWN_SITE_BASE_URL =
  "https://books.conanxin.com";
export const READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX = "weread-reading-archive";
export const READING_ARCHIVE_MARKDOWN_FILENAME_MAX_LENGTH = 80;

export const READING_ARCHIVE_MARKDOWN_PRIVACY_NOTE =
  "隐私说明：本文件由用户主动在当前浏览器中生成，包含公共书目信息和个人阅读统计，请自行妥善保存。";

export const READING_ARCHIVE_MARKDOWN_INTERPRETATION_NOTE =
  "口径说明：多年书目和年度榜单重合只基于当前各年度 Top N 榜单，不代表全部阅读历史、长期兴趣、偏好、开始阅读或停止阅读。";

export const READING_ARCHIVE_MARKDOWN_COMPLETENESS_NOTE =
  "完整性提示：本次有 N 个年份暂时加载失败，以下档案仅基于成功加载的年份生成。";

export const READING_ARCHIVE_MARKDOWN_DATA_INTEGRITY_NOTE =
  "数据完整性：所有目标年份均已成功加载。";

// ---------- escaping / formatting ----------

const INLINE_META_CHARS = ["\\", "*", "_", "[", "]", "<", ">", "#", "`", "~"];
const TABLE_PIPE = "|";

function stripControlAndCollapse(input: string): string {
  // Strip ASCII control characters (incl. \r, \n, \t, NUL) and
  // collapse all whitespace runs to a single space.
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // Collapse any whitespace or control character into a single
    // space token (or drop entirely if already preceded by a space).
    if (code <= 0x20 || code === 0x7f) {
      if (out.length > 0 && out.charAt(out.length - 1) !== " ") out += " ";
      continue;
    }
    out += input[i];
  }
  return out.trim();
}

function escapeInlineMeta(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (INLINE_META_CHARS.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export function escapeArchiveMarkdownInline(input: unknown): string {
  if (input === null || input === undefined) return "";
  const raw = String(input);
  return escapeInlineMeta(stripControlAndCollapse(raw));
}

export function escapeArchiveMarkdownTableCell(input: unknown): string {
  if (input === null || input === undefined) return "—";
  const rawStr = String(input);
  const cleaned = stripControlAndCollapse(rawStr);
  if (!cleaned) return "—";
  // Table cells must escape pipes (the column delimiter) and any
  // remaining inline meta characters. Pipes get a backslash escape
  // FIRST (so the meta-escape pass leaves the added backslash alone
  // by not adding `\`) — we therefore pre-mark pipes with a sentinel
  // character that the meta pass will rewrite back into `\|`.
  const PIPE_SENTINEL = "\u0001";
  let marked = cleaned.replace(/\|/g, PIPE_SENTINEL);
  const metaEscaped = escapeInlineMeta(marked);
  return metaEscaped.split(PIPE_SENTINEL).join("\\|");
}

export function sanitizeArchiveMarkdownText(input: unknown): string {
  return escapeArchiveMarkdownInline(input);
}

export function formatArchiveMarkdownDate(input: Date): string {
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) return "—";
  const y = input.getFullYear();
  const m = String(input.getMonth() + 1).padStart(2, "0");
  const d = String(input.getDate()).padStart(2, "0");
  const hh = String(input.getHours()).padStart(2, "0");
  const mm = String(input.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function formatArchiveYearRange(args: {
  firstYear: number | null;
  latestYear: number | null;
}): string {
  if (args.firstYear === null && args.latestYear === null) return "暂无年份";
  if (args.firstYear === null) return `${args.latestYear} 年`;
  if (args.latestYear === null) return `${args.firstYear} 年`;
  if (args.firstYear === args.latestYear) return `${args.firstYear} 年`;
  return `${args.firstYear}—${args.latestYear} 年`;
}

export function formatArchiveOverlapPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  const clamped = Math.max(0, Math.min(1, ratio));
  const pct = clamped * 100;
  const rounded = Math.round(pct * 10) / 10;
  if (Number.isInteger(rounded)) return `${rounded.toFixed(0)}%`;
  return `${rounded.toFixed(1)}%`;
}

export function formatArchiveAverage(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return `${rounded.toFixed(0)}`;
  return `${rounded.toFixed(1)}`;
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

function trimToString(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = String(input).trim();
  return s;
}

function publishYearLabel(input: ReadingArchiveRecurringBook["publishYear"]): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d{4}$/.test(s)) return s;
  const n = Number(s);
  if (Number.isInteger(n) && n > 0 && n < 9999) return String(n);
  return null;
}

function publisherLine(
  publisher: ReadingArchiveRecurringBook["publisher"],
  publishYear: ReadingArchiveRecurringBook["publishYear"],
): string | null {
  const p = trimToString(publisher);
  const y = publishYearLabel(publishYear);
  if (!p && !y) return null;
  if (p && y) return `${p}，${y}`;
  return p || (y as string);
}

// ---------- filename ----------

const ASCII_FILENAME_DATE = /^(\d{4})(\d{2})(\d{2})$/;

function formatAsciiDate(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return "19700101";
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function buildReadingArchiveMarkdownFilename(
  args: BuildReadingArchiveMarkdownFilenameArgs,
): string {
  const asciiDate = formatAsciiDate(args.now);
  if (
    args.firstYear === null ||
    args.latestYear === null ||
    !Number.isInteger(args.firstYear) ||
    !Number.isInteger(args.latestYear) ||
    args.firstYear < 1900 ||
    args.firstYear > 9999 ||
    args.latestYear < 1900 ||
    args.latestYear > 9999
  ) {
    const empty = `${READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX}-empty-${asciiDate}.md`;
    return empty;
  }
  const first = Math.min(args.firstYear, args.latestYear);
  const latest = Math.max(args.firstYear, args.latestYear);
  const filename = `${READING_ARCHIVE_MARKDOWN_FILENAME_PREFIX}-${first}-to-${latest}-${asciiDate}.md`;
  if (filename.length > READING_ARCHIVE_MARKDOWN_FILENAME_MAX_LENGTH) {
    // defensive: drop the prefix if a caller used a long prefix override
    return filename.slice(filename.length - READING_ARCHIVE_MARKDOWN_FILENAME_MAX_LENGTH);
  }
  return filename;
}

// ---------- build Markdown ----------

function renderOverviewLines(
  overview: ReadingArchiveOverview,
): string[] {
  const lines: string[] = [];
  lines.push("- 有记录年份：" + formatInteger(overview.yearsWithData));
  lines.push(
    "- 最早年份：" +
      (overview.firstYear !== null ? `${overview.firstYear}` : "—"),
  );
  lines.push(
    "- 最近年份：" +
      (overview.latestYear !== null ? `${overview.latestYear}` : "—"),
  );
  lines.push("- 阅读记录合计：" + formatInteger(overview.totalRecords));
  lines.push("- 活跃月份合计：" + formatInteger(overview.totalActiveMonths));
  lines.push("- 年均记录：" + formatArchiveAverage(overview.averageRecordsPerYear));
  lines.push(
    "- 最高记录年份：" +
      (overview.mostActiveYear !== null
        ? `${overview.mostActiveYear}（${formatInteger(overview.mostActiveYearRecords)} 条）`
        : "—"),
  );
  lines.push(
    "- 最长连续活跃年份：" + formatInteger(overview.longestActiveYearStreak) + " 年",
  );
  lines.push(
    "- 多年进入 Top N 榜单的书目：" + formatInteger(overview.recurringTopBooks) + " 本",
  );
  return lines;
}

function renderYearTrendTable(yearsAsc: readonly ReadingArchiveYear[]): string[] {
  const lines: string[] = [];
  lines.push("| 年份 | 阅读记录 | 有效日期记录 | 已匹配记录 | 年度书目 | 活跃月份 | 最长连续月份 | 高峰月份 | 月均记录 |");
  lines.push("|---:|---:|---:|---:|---:|---:|---:|---|---:|");
  for (const y of yearsAsc) {
    const peak = y.peakMonth ? `${y.peakMonth}` : "—";
    lines.push(
      `| ${y.year} | ${formatInteger(y.totalRecords)} | ${formatInteger(y.datedRecords)} | ${formatInteger(y.matchedRecords)} | ${formatInteger(y.matchedBooks)} | ${formatInteger(y.activeMonths)} | ${formatInteger(y.longestStreakMonths)} | ${escapeArchiveMarkdownTableCell(peak)} | ${formatArchiveAverage(y.averageRecordsPerActiveMonth)} |`,
    );
  }
  return lines;
}

function renderYearDirectory(
  yearsDesc: readonly ReadingArchiveYear[],
  siteBaseUrl: string,
): string[] {
  const lines: string[] = [];
  for (const y of yearsDesc) {
    lines.push(`### ${y.year} 年`);
    lines.push("");
    lines.push(`- 阅读记录：${formatInteger(y.totalRecords)}`);
    lines.push(`- 有效日期记录：${formatInteger(y.datedRecords)}`);
    lines.push(`- 已匹配记录：${formatInteger(y.matchedRecords)}`);
    lines.push(`- 年度书目：${formatInteger(y.matchedBooks)}`);
    lines.push(`- 活跃月份：${formatInteger(y.activeMonths)}`);
    lines.push(`- 最长连续活跃：${formatInteger(y.longestStreakMonths)} 个月`);
    if (y.peakMonth) {
      lines.push(`- 高峰月份：${y.peakMonth}`);
      lines.push(`- 高峰月份记录：${formatInteger(y.peakMonthRecords)}`);
    } else {
      lines.push("- 高峰月份：—");
    }
    lines.push(`- 活跃月份平均记录：${formatArchiveAverage(y.averageRecordsPerActiveMonth)}`);
    lines.push("- 查看方式：微信读书中心 → 年度回顾 → 选择 " + y.year + " 年");
    lines.push("");
  }
  return lines;
}

function renderRecurringBooks(
  books: readonly ReadingArchiveRecurringBook[],
  topBooksLimit: number,
  siteBaseUrl: string,
): string[] {
  const lines: string[] = [];
  lines.push(`## 多年进入 Top ${topBooksLimit} 高互动榜的书目`);
  lines.push("");
  lines.push(
    "> 本节只统计各年度当前 Top " +
      topBooksLimit +
      " 榜单中重复出现的公共书目，不代表全部阅读记录或长期偏好。",
  );
  lines.push("");
  if (books.length === 0) {
    lines.push(`当前 Top ${topBooksLimit} 口径下，暂无跨多个年份重复进入榜单的书目。`);
    lines.push("");
    return lines;
  }
  for (let i = 0; i < books.length; i += 1) {
    const b = books[i];
    const safeTitle = escapeArchiveMarkdownInline(
      b.title || `书目 ${b.catalogId}`,
    );
    lines.push(`### ${i + 1}. 《${safeTitle}》`);
    lines.push("");
    const author = trimToString(b.author);
    if (author) {
      lines.push(`- 作者：${escapeArchiveMarkdownInline(author)}`);
    } else {
      lines.push("- 作者：—");
    }
    const pub = publisherLine(b.publisher, b.publishYear);
    if (pub) {
      lines.push(`- 出版信息：${escapeArchiveMarkdownInline(pub)}`);
    }
    const yearsList = b.years && b.years.length > 0 ? b.years.join("、") : "—";
    lines.push(`- 进入榜单年份：${escapeArchiveMarkdownInline(yearsList)}`);
    lines.push(`- 进入榜单次数：${formatInteger(b.yearsOnList)} 年`);
    lines.push(`- 最佳排名：第 ${formatInteger(b.bestRank)}`);
    lines.push(`- 最新上榜年份：${formatInteger(b.latestYear)}`);
    lines.push(`- 最新年份排名：第 ${formatInteger(b.latestRank)}`);
    lines.push(`- 榜单内年度记录合计：${formatInteger(b.totalNoteCountWithinLists)}`);
    lines.push(`- 书目页面：${siteBaseUrl}/books/${b.catalogId}`);
    lines.push("");
  }
  return lines;
}

function renderYearLinks(
  yearLinks: readonly ReadingArchiveYearLink[],
): string[] {
  const lines: string[] = [];
  lines.push("## 相邻年度 Top N 榜单重合");
  lines.push("");
  lines.push(
    "> 榜单重合只表示相邻年份 Top N 公共书目列表的交集，不代表阅读兴趣稳定、变化或阅读质量。",
  );
  lines.push("");
  if (yearLinks.length === 0) {
    lines.push("当前成功加载的年度不足以生成相邻年份榜单重合。");
    lines.push("");
    return lines;
  }
  lines.push("| 相邻年份 | 共同上榜书目 | 榜单重合率 |");
  lines.push("|---|---:|---:|");
  for (const l of yearLinks) {
    lines.push(
      `| ${l.sourceYear} → ${l.targetYear} | ${formatInteger(l.sharedTopBooks)} | ${formatArchiveOverlapPercent(l.overlapRatio)} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderIntegritySection(failedYears: readonly number[]): string[] {
  const lines: string[] = [];
  lines.push("## 数据完整性");
  lines.push("");
  if (failedYears.length === 0) {
    lines.push("- 所有目标年份均已成功加载。");
  } else {
    lines.push(`- 暂时失败年份数量：${formatInteger(failedYears.length)}`);
    const sortedYears = [...failedYears].sort((a, b) => a - b);
    lines.push(
      `- 暂时失败年份：${escapeArchiveMarkdownInline(sortedYears.join("、"))}`,
    );
  }
  lines.push("");
  lines.push("## 说明");
  lines.push("");
  lines.push("- 只使用当前浏览器已经加载的年度回顾结果。");
  lines.push("- 本次导出不会重新请求年度 API。");
  lines.push("- 阅读记录合计可以跨自然年求和。");
  lines.push("- 各年度 Top N 书目受范围限制，跨年求和可能重复计数。");
  lines.push("- 多年书目和榜单重合受当前 Top N 范围影响。");
  lines.push("- 本报告未读取笔记正文。");
  lines.push("- 本报告未调用外部 AI。");
  lines.push("- 本报告未上传或保存到服务器。");
  lines.push(
    "- 本报告不分析阅读主题、兴趣、心理或阅读质量。",
  );
  return lines;
}

function renderCompletenessNote(failedYears: readonly number[]): string[] {
  if (failedYears.length === 0) {
    return [`> ${READING_ARCHIVE_MARKDOWN_DATA_INTEGRITY_NOTE}`, ""];
  }
  const note = READING_ARCHIVE_MARKDOWN_COMPLETENESS_NOTE.replace(
    "N 个",
    `${formatInteger(failedYears.length)} 个`,
  );
  return [`> ${note}`, ""];
}

/**
 * Build the full Markdown document for the supplied archive.
 *
 * - Pure function: takes a `Date` so tests can pin the timestamp.
 * - Never reads AI summary, related-books, notes payload or the raw
 *   WeRead title/author.
 * - When no years are loaded, the document still includes the meta
 *   block, the empty-overview line, the integrity section, and the
 *   explanations. No fake ranks or numbers are emitted.
 */
export function buildReadingArchiveMarkdown(
  input: ReadingArchiveMarkdownInput,
): BuildReadingArchiveMarkdownResult {
  if (!input || !input.archive) {
    throw new Error("archive is missing");
  }
  if (![6, 12, 18].includes(input.topBooksLimit)) {
    throw new Error(`topBooksLimit ${input.topBooksLimit} is not 6/12/18`);
  }
  if (
    !Array.isArray(input.failedYears) ||
    input.failedYears.some((y) => !Number.isInteger(y) || y < 1900 || y > 9999)
  ) {
    throw new Error("failedYears must be an array of 4-digit integers");
  }
  const exportedAt =
    input.exportedAt instanceof Date ? input.exportedAt : new Date();
  const siteBaseUrl =
    input.siteBaseUrl ?? READING_ARCHIVE_MARKDOWN_SITE_BASE_URL;

  const archive = input.archive;
  const lines: string[] = [];

  // Title + meta
  lines.push("# 长期阅读档案");
  lines.push("");
  const yearRange = formatArchiveYearRange({
    firstYear: archive.overview.firstYear,
    latestYear: archive.overview.latestYear,
  });
  lines.push(`- 档案年份：${escapeArchiveMarkdownInline(yearRange)}`);
  lines.push(`- 当前范围：${escapeArchiveMarkdownInline(input.rangeLabel)}`);
  lines.push(`- 高互动书目口径：各年度 Top ${input.topBooksLimit}`);
  lines.push(`- 请求年份：${formatInteger(archive.meta.requestedYears)} 个`);
  lines.push(`- 成功加载年份：${formatInteger(archive.meta.loadedYears)} 个`);
  lines.push(
    `- 暂时失败年份：${formatInteger(input.failedYears.length)} 个`,
  );
  lines.push("- 导出时间：" + (formatArchiveMarkdownDate(exportedAt) || "—"));
  lines.push("- 数据来源：微信读书私有年度聚合数据");
  lines.push("- 生成方式：book-id-search 浏览器本地生成");
  lines.push("- 保存状态：未上传服务器");
  lines.push("");

  // Notices
  lines.push(`> ${READING_ARCHIVE_MARKDOWN_PRIVACY_NOTE}`);
  lines.push("");
  lines.push(`> ${READING_ARCHIVE_MARKDOWN_INTERPRETATION_NOTE}`);
  lines.push("");
  for (const line of renderCompletenessNote(input.failedYears)) lines.push(line);

  // Overview
  lines.push("## 档案总览");
  lines.push("");
  const yearsAsc = [...archive.years].sort((a, b) => a.year - b.year);
  if (yearsAsc.length === 0) {
    lines.push("当前暂无成功加载的年度阅读档案。");
    lines.push("");
  } else {
    for (const line of renderOverviewLines(archive.overview)) lines.push(line);
    lines.push("");
  }

  // Year trend
  lines.push("## 跨年度趋势");
  lines.push("");
  if (yearsAsc.length === 0) {
    lines.push("当前暂无跨年度趋势数据。");
    lines.push("");
  } else {
    for (const line of renderYearTrendTable(yearsAsc)) lines.push(line);
    lines.push("");
  }

  // Year directory (newest first)
  lines.push("## 年度档案目录");
  lines.push("");
  if (yearsAsc.length === 0) {
    lines.push("当前暂无成功加载的年度档案目录。");
    lines.push("");
  } else {
    const yearsDesc = [...archive.years].sort((a, b) => b.year - a.year);
    for (const line of renderYearDirectory(yearsDesc, siteBaseUrl)) {
      lines.push(line);
    }
  }

  // Recurring books
  if (yearsAsc.length > 0) {
    for (const line of renderRecurringBooks(
      archive.recurringBooks,
      input.topBooksLimit,
      siteBaseUrl,
    )) {
      lines.push(line);
    }
  } else {
    lines.push(`## 多年进入 Top ${input.topBooksLimit} 高互动榜的书目`);
    lines.push("");
    lines.push(`当前 Top ${input.topBooksLimit} 口径下，暂无跨多个年份重复进入榜单的书目。`);
    lines.push("");
  }

  // Adjacent year links
  lines.push("## 相邻年度榜单重合");
  lines.push("");
  if (yearsAsc.length < 2) {
    lines.push("当前成功加载的年度不足以生成相邻年份榜单重合。");
    lines.push("");
  } else {
    for (const line of renderYearLinks(archive.yearLinks)) lines.push(line);
  }

  // Integrity + explanations
  for (const line of renderIntegritySection(input.failedYears)) lines.push(line);
  lines.push("");

  const content = lines.join("\n");
  const filename = buildReadingArchiveMarkdownFilename({
    firstYear: archive.overview.firstYear,
    latestYear: archive.overview.latestYear,
    now: exportedAt,
  });
  return {
    content,
    filename,
    mimeType: READING_ARCHIVE_MARKDOWN_MIME,
    byteLength: byteLengthUtf8(content),
    rangeLabel: input.rangeLabel,
    topBooksLimit: input.topBooksLimit,
    yearCount: archive.meta.loadedYears,
    failedYearCount: input.failedYears.length,
  };
}

// ---------- validation ----------

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "note.text", re: /note\.text/ },
  { label: "note.comment", re: /note\.comment/ },
  { label: "markedText", re: /markedText/ },
  { label: "wereadBookId", re: /wereadBookId/ },
  { label: "noteId", re: /\bnoteId\b/ },
  { label: "highlightId", re: /\bhighlightId\b/ },
  { label: "chapterTitle", re: /chapterTitle/ },
  { label: "ai summary", re: /ai[_ -]?summary|summary\.overview|summary\.keyPoints|summary\.reviewQuestions/i },
  { label: "session themes", re: /session[_ -]?theme|themes\./i },
  { label: "token", re: /\bBearer\s+[A-Za-z0-9._-]{8,}\b/ },
  { label: "q-search", re: /\bq=[A-Za-z0-9%._-]{4,}/ },
  { label: "Authorization header", re: /Authorization/i },
  { label: "AI summary body", re: /summary\.body|ai_summary_body/i },
  { label: "private API URL", re: /\/api\/private\/weread\/ai-summary|\/api\/private\/weread\/related-books/i },
];

export function validateReadingArchiveMarkdown(content: string): string[] {
  const violations: string[] = [];
  const lower = content ?? "";
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.re.test(lower)) {
      violations.push(pat.label);
    }
  }
  return violations;
}

// ---------- download trigger ----------

export function triggerReadingArchiveMarkdownDownload(
  args: TriggerReadingArchiveMarkdownDownloadArgs,
): TriggerReadingArchiveMarkdownDownloadResult {
  const content = String(args.content ?? "");
  const filename = String(args.filename ?? "");
  if (!content) {
    throw new Error("Markdown content is empty");
  }
  if (!filename) {
    throw new Error("Markdown filename is empty");
  }
  const blob = new Blob([content], { type: READING_ARCHIVE_MARKDOWN_MIME });
  const createObjectUrl =
    args.createObjectUrl ??
    ((b: Blob) => URL.createObjectURL(b));
  const revokeObjectUrl =
    args.revokeObjectUrl ??
    ((url: string) => URL.revokeObjectURL(url));
  const blobUrl = createObjectUrl(blob);
  const descriptor: ReadingArchiveMarkdownAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener",
    testId: "weread-reading-archive-markdown-anchor",
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
    mimeType: READING_ARCHIVE_MARKDOWN_MIME,
    blobUrl,
    downloadTriggered: true,
  };
}

function defaultAttachAnchor(
  descriptor: ReadingArchiveMarkdownAnchorDescriptor,
  resolveDocument?: () => DocumentLike | null,
): void {
  const doc =
    resolveDocument?.() ??
    (typeof document !== "undefined"
      ? (document as unknown as DocumentLike)
      : null);
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

function byteLengthUtf8(input: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input).length;
  }
  // Fallback (rough estimate; not exact for non-ASCII)
  let len = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else len += 3;
  }
  return len;
}
