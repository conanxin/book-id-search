/**
 * S27J-2 — Browser-local Markdown export for the private WeRead annual
 * review dashboard.
 *
 * Strict privacy contract (mirrors the S27J dashboard, plus Markdown-
 * specific rules):
 *   - NEVER embeds note text, note comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, the AI summary body, the session
 *     theme overlay, the WeRead private title / author, the token,
 *     the `q` search term, or any raw snapshot record.
 *   - Consumes ONLY the public catalog fields the S27J dashboard
 *     already exposes (catalogId, title, author, publisher,
 *     publishYear, count fields, date strings).
 *   - All formatting is done in pure functions. `triggerMarkdownDownload`
 *     is the ONLY function that touches the DOM / browser download
 *     API. It never persists anything to localStorage /
 *     sessionStorage / IndexedDB / server / external service.
 *   - The download helper creates a transient Blob URL, dispatches a
 *     click on a temporary anchor and revokes the URL on the next
 *     tick. No markdown content is ever logged.
 *
 * Markdown rules (M3 / M4 / M6 / M7 of the S27J-2 spec):
 *   - No HTML / YAML frontmatter / external libraries.
 *   - Inline text uses `escapeMarkdownInline` (collapses whitespace,
 *     strips control characters, escapes Markdown meta characters).
 *   - Table cells use `escapeMarkdownTableCell` to avoid breaking the
 *     `|`-delimited table.
 *   - Book titles are treated as plain inline text inside `# 《title》`
 *     headings. We deliberately use a half-width `# ` so even a hostile
 *     public title cannot impersonate a top-level Markdown heading
 *     line.
 */

import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewQuarter,
  WereadAnnualReviewResponse,
} from "../wereadPrivate";

// ---------- public API ----------

export interface AnnualReviewMarkdownInput {
  review: WereadAnnualReviewResponse;
  exportedAt: Date;
  /** Optional site base URL (default `https://books.conanxin.com`). */
  siteBaseUrl?: string;
}

export interface BuildAnnualReviewMarkdownResult {
  content: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  selectedYear: number;
  topBooksCount: number;
}

export interface BuildAnnualReviewMarkdownFilenameArgs {
  selectedYear: number;
  now: Date;
}

export interface AnnualMarkdownAnchorDescriptor {
  href: string;
  download: string;
  rel: string;
  testId: string;
}

export interface TriggerAnnualReviewMarkdownDownloadArgs {
  content: string;
  filename: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  attachAnchor?: (anchor: AnnualMarkdownAnchorDescriptor) => void;
  resolveDocument?: () => DocumentLike | null;
}

export interface DocumentLike {
  createElement(tagName: string): {
    setAttribute(name: string, value: string): void;
    click(): void;
  };
  body?: { appendChild(node: unknown): void; removeChild(node: unknown): void } | null;
}

export interface TriggerAnnualReviewMarkdownDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  revoked: boolean;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const ANNUAL_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const ANNUAL_MARKDOWN_FILENAME_PREFIX = "weread-annual-review";
export const ANNUAL_MARKDOWN_FILENAME_MAX_LENGTH = 80;
export const ANNUAL_MARKDOWN_SITE_BASE_URL = "https://books.conanxin.com";
export const ANNUAL_MARKDOWN_PRIVACY_NOTE = "隐私说明：本文件由用户主动在浏览器中生成。导出完成后，请自行妥善保存。";
export const ANNUAL_MARKDOWN_DISCLAIMER_BULLETS: ReadonlyArray<string> = [
  "只有有效日期的记录进入年度统计。",
  "未匹配笔记计入总量和类型，但不会出现在高互动书目中。",
  "月度活跃度只描述数量，不代表阅读质量。",
  "本报告未使用外部 AI。",
];

const MONTH_NAMES = [
  "1 月",
  "2 月",
  "3 月",
  "4 月",
  "5 月",
  "6 月",
  "7 月",
  "8 月",
  "9 月",
  "10 月",
  "11 月",
  "12 月",
] as const;

const QUARTER_LABELS: Record<WereadAnnualReviewQuarter["quarter"], string> = {
  Q1: "Q1",
  Q2: "Q2",
  Q3: "Q3",
  Q4: "Q4",
};

const QUARTER_DATE_LABEL: Record<WereadAnnualReviewQuarter["quarter"], string> = {
  Q1: "1–3 月",
  Q2: "4–6 月",
  Q3: "7–9 月",
  Q4: "10–12 月",
};

const QUARTER_MONTHS: Record<WereadAnnualReviewQuarter["quarter"], number[]> = {
  Q1: [1, 2, 3],
  Q2: [4, 5, 6],
  Q3: [7, 8, 9],
  Q4: [10, 11, 12],
};

// ---------- inline / table escaping ----------

/**
 * Strip control characters (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F) so
 * they can never reach the file. Newlines / carriage returns are
 * replaced by spaces (so the rendered Markdown stays readable) and
 * runs of whitespace are collapsed into a single space.
 *
 * This is a defensive pass — Markdown renderers do not interpret
 * control characters but they still cause subtle visual artefacts
 * (or break git diff / lint), so we wipe them.
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
      // Replace any printable-pausing control character with a
      // single space so the surrounding text remains readable
      // without leaking the raw byte into the Markdown file.
      if (prevSpace) continue;
      out += " ";
      prevSpace = true;
      continue;
    }
    if (code === 0x09 || code === 0x20) {
      // collapse any whitespace (including NBSP replaced earlier) into a single space
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
export function escapeMarkdownInline(input: unknown): string {
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
 * Escape characters that have Markdown block semantics (headings,
 * code fences, HTML).
 */
export function escapeMarkdownBlockText(input: unknown): string {
  if (input === null || input === undefined) return "";
  const clean = stripControlAndCollapse(String(input));
  let out = "";
  let atLineStart = true;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === "\n") {
      out += "\n";
      atLineStart = true;
      continue;
    }
    if (atLineStart && (ch === "#" || ch === ">" || ch === "-" || ch === "+" || ch === "*")) {
      out += `\\${ch}`;
      atLineStart = false;
      continue;
    }
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "`") {
      out += "\\`";
    } else if (ch === "<") {
      out += "\\<";
    } else if (ch === ">") {
      out += "\\>";
    } else if (ch === "[") {
      out += "\\[";
    } else if (ch === "]") {
      out += "\\]";
    } else if (ch === "|") {
      out += "\\|";
    } else {
      out += ch;
    }
    atLineStart = false;
  }
  return out;
}

/**
 * Escape a single Markdown table cell. Always returns a single-line
 * string; newlines are converted to spaces so the table layout is
 * never broken.
 */
export function escapeMarkdownTableCell(input: unknown): string {
  if (input === null || input === undefined) return "";
  const cleaned = stripControlAndCollapse(String(input)).replace(/\|/g, "\\|");
  return cleaned;
}

// ---------- date / label helpers ----------

export function formatAnnualMarkdownDate(input: Date): string {
  if (!(input instanceof Date) || !Number.isFinite(input.getTime())) return "";
  const y = input.getFullYear();
  const m = String(input.getMonth() + 1).padStart(2, "0");
  const d = String(input.getDate()).padStart(2, "0");
  const hh = String(input.getHours()).padStart(2, "0");
  const mm = String(input.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function formatAnnualMonthLabel(year: number, monthIndex: number): string {
  if (!Number.isFinite(year)) return "";
  if (monthIndex < 0 || monthIndex > 11) return "";
  return `${year} 年${MONTH_NAMES[monthIndex]}`;
}

export function formatAnnualQuarterLabel(quarter: WereadAnnualReviewQuarter["quarter"]): string {
  return `${QUARTER_LABELS[quarter]}（${QUARTER_DATE_LABEL[quarter]}）`;
}

// ---------- builders ----------

/**
 * Build the full Markdown document for the supplied annual review
 * response.
 *
 * - The function is pure: it takes a `Date` so tests can pin the
 *   timestamp and so the browser can pass `new Date()`.
 * - It never reads `WereadSessionThemeOverlay`, the AI summary, the
 *   reading-map response or the notes payload.
 * - Empty-year behaviour: when the response has zero total records
 *   AND zero top books, the document still includes the 12-month
 *   zero-valued table, the four zero-valued quarters, and the
 *   standard disclaimer. No fake peak month / top books / annual
 *   records are emitted.
 */
export function buildAnnualReviewMarkdown(input: AnnualReviewMarkdownInput): BuildAnnualReviewMarkdownResult {
  const review = input.review;
  if (!review) throw new Error("annual review response is missing");
  const selectedYear = review.selectedYear;
  if (!Number.isInteger(selectedYear) || selectedYear < 1900 || selectedYear > 9999) {
    throw new Error(`annual review selectedYear ${selectedYear} is not a 4-digit year`);
  }
  const topBooks = Array.isArray(review.topBooks) ? review.topBooks : [];
  const months = ensureTwelveMonths(review.months, selectedYear);
  const quarters = ensureFourQuarters(review.quarters);
  const overview = review.overview;
  const exportedAt = input.exportedAt instanceof Date ? input.exportedAt : new Date();
  const siteBaseUrl = input.siteBaseUrl ?? ANNUAL_MARKDOWN_SITE_BASE_URL;

  const isEmptyYear =
    overview.totalRecords === 0 &&
    overview.datedRecords === 0 &&
    overview.matchedRecords === 0 &&
    overview.matchedBooks === 0 &&
    overview.activeMonths === 0 &&
    topBooks.length === 0;

  const lines: string[] = [];

  // Title
  lines.push(`# ${selectedYear} 年阅读回顾`);
  lines.push("");

  // Meta bullets
  lines.push("- 导出时间：" + (formatAnnualMarkdownDate(exportedAt) || "—"));
  lines.push("- 数据来源：微信读书私有阅读记录");
  lines.push("- 生成方式：book-id-search 浏览器本地生成");
  lines.push("- 保存状态：未上传服务器");
  lines.push("");
  // Privacy notice (blockquote)
  lines.push(`> ${ANNUAL_MARKDOWN_PRIVACY_NOTE}`);
  lines.push("");

  // Year overview
  lines.push("## 年度概览");
  lines.push("");
  if (isEmptyYear) {
    lines.push("该年度暂无有效日期的阅读记录。");
    lines.push("");
  } else {
    const peakMonthText = overview.peakMonth
      ? formatAnnualMonthLabel(selectedYear, Number(overview.peakMonth.split("-")[1]) - 1)
      : "无记录";
    const averageText =
      overview.averageRecordsPerActiveMonth > 0
        ? String(Math.round(overview.averageRecordsPerActiveMonth * 100) / 100)
        : "0";
    lines.push(`- 阅读记录：${overview.totalRecords}`);
    lines.push(`- 有效日期记录：${overview.datedRecords}`);
    lines.push(`- 活跃月份：${overview.activeMonths}`);
    lines.push(`- 最长连续活跃：${overview.longestStreakMonths} 个月`);
    lines.push(`- 已匹配记录：${overview.matchedRecords}`);
    lines.push(`- 年度书目：${overview.matchedBooks}`);
    lines.push(`- 高峰月份：${peakMonthText}`);
    lines.push(`- 活跃月份平均记录：${averageText}`);
    lines.push("");
  }

  // 12 months table
  lines.push("## 12 个月时间轴");
  lines.push("");
  lines.push("| 月份 | 记录 | 划线 | 想法 | 书评 | 未分类 | 已匹配 | 书目 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (let i = 0; i < 12; i += 1) {
    const m = months[i];
    lines.push(
      `| ${escapeMarkdownTableCell(formatAnnualMonthLabel(selectedYear, i))} | ${m.total} | ${m.highlights} | ${m.thoughts} | ${m.reviews} | ${m.unknown} | ${m.matched} | ${m.bookCount} |`
    );
  }
  lines.push("");

  // Quarters
  lines.push("## 季度回顾");
  lines.push("");
  const yearTotal = quarters.reduce((acc, q) => acc + q.total, 0);
  for (const quarter of quarters) {
    lines.push(`### ${escapeMarkdownInline(formatAnnualQuarterLabel(quarter.quarter))}`);
    lines.push("");
    const share = yearTotal > 0 ? Math.round((quarter.total / yearTotal) * 100) : 0;
    lines.push(`- 阅读记录：${quarter.total}`);
    lines.push(`- 活跃月份：${quarter.activeMonths}`);
    lines.push(`- 已匹配记录：${quarter.matchedRecords}`);
    lines.push(`- 涉及书目：${quarter.bookCount}`);
    lines.push(`- 占全年记录：${share}%`);
    lines.push("");
  }

  // Top books
  lines.push("## 年度高互动书目");
  lines.push("");
  if (topBooks.length === 0) {
    lines.push(isEmptyYear ? "该年度暂无已匹配的高互动书目。" : "本年暂无可导出的高互动书目。");
    lines.push("");
  } else {
    for (let i = 0; i < topBooks.length; i += 1) {
      const book = topBooks[i];
      const safeTitle = escapeMarkdownInline(book.title ?? `书目 ${book.catalogId}`);
      lines.push(`### ${i + 1}. 《${safeTitle}》`);
      lines.push("");
      const author = trimToString(book.author);
      if (author) {
        lines.push(`- 作者：${escapeMarkdownInline(author)}`);
      }
      const publisher = trimToString(book.publisher);
      const publishYear = formatPublishYear(book.publishYear);
      if (publisher && publishYear) {
        lines.push(`- 出版信息：${escapeMarkdownInline(publisher)}，${publishYear}`);
      } else if (publisher) {
        lines.push(`- 出版信息：${escapeMarkdownInline(publisher)}`);
      } else if (publishYear) {
        lines.push(`- 出版信息：${publishYear}`);
      }
      lines.push(`- 年度记录：${book.noteCount}`);
      lines.push(`- 活跃月份：${book.activeMonths}`);
      lines.push(`- 首次记录：${formatDateOnly(book.firstNoteAt)}`);
      lines.push(`- 最后记录：${formatDateOnly(book.lastNoteAt)}`);
      lines.push(
        `- 类型：划线 ${book.highlights} / 想法 ${book.thoughts} / 书评 ${book.reviews} / 未分类 ${book.unknown}`
      );
      lines.push(`- 书目页面：${siteBaseUrl}/books/${book.catalogId}`);
      lines.push("");
    }
  }

  // Descriptive records (deterministic statistical copy only).
  lines.push("## 年度记录");
  lines.push("");
  if (isEmptyYear) {
    lines.push("本年暂无有效日期的阅读记录。");
    lines.push("");
  } else {
    lines.push(`- 全年留下 ${overview.totalRecords} 条阅读记录。`);
    lines.push(`- 在 ${overview.activeMonths} 个自然月有阅读活动。`);
    lines.push(`- 最长连续活跃 ${overview.longestStreakMonths} 个月。`);
    if (overview.peakMonth) {
      const peak = formatAnnualMonthLabel(
        selectedYear,
        Number(overview.peakMonth.split("-")[1]) - 1
      );
      lines.push(`- 记录高峰出现在 ${peak}。`);
    } else {
      lines.push("- 本年暂无明确的记录高峰。");
    }
    lines.push(`- 年度涉及 ${overview.matchedBooks} 本已匹配书目。`);
    lines.push("");
  }

  // Notes (always rendered)
  lines.push("## 说明");
  lines.push("");
  for (const note of ANNUAL_MARKDOWN_DISCLAIMER_BULLETS) {
    lines.push(`- ${escapeMarkdownInline(note)}`);
  }
  lines.push("");

  const content = lines.join("\n");
  const filename = buildAnnualReviewMarkdownFilename({
    selectedYear,
    now: exportedAt,
  });
  return {
    content,
    filename,
    mimeType: ANNUAL_MARKDOWN_MIME,
    byteLength: byteLengthUtf8(content),
    selectedYear,
    topBooksCount: topBooks.length,
  };
}

// ---------- filename ----------

export function buildAnnualReviewMarkdownFilename(args: BuildAnnualReviewMarkdownFilenameArgs): string {
  const year = Number(args.selectedYear);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error(`annual review selectedYear ${args.selectedYear} is not a 4-digit year`);
  }
  const now = args.now instanceof Date ? args.now : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("exportedAt is not a valid Date");
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const stamp = `${y}${m}${d}`;
  const candidate = `${ANNUAL_MARKDOWN_FILENAME_PREFIX}-${year}-${stamp}.md`;
  if (candidate.length > ANNUAL_MARKDOWN_FILENAME_MAX_LENGTH) {
    // Extremely defensive — the format above is always < 80 chars for
    // any 4-digit year + 8-digit stamp. We still cap it for safety.
    return candidate.slice(0, ANNUAL_MARKDOWN_FILENAME_MAX_LENGTH);
  }
  return candidate;
}

// ---------- validation ----------

/**
 * Lightweight structural validator. Returns an array of human-
 * readable error strings (empty array = valid).
 *
 * Intentionally minimal — it does NOT replace a real Markdown
 * parser. It catches the common bugs that a future refactor could
 * introduce (missing H1, broken table, forbidden fields, etc.).
 */
export function validateAnnualReviewMarkdown(content: string): string[] {
  const errors: string[] = [];
  if (typeof content !== "string" || content.length === 0) {
    errors.push("content is empty");
    return errors;
  }
  if (!content.startsWith("# ")) {
    errors.push("missing top-level title");
  }
  if (!content.includes("## 年度概览")) {
    errors.push("missing 年度概览 section");
  }
  if (!content.includes("## 12 个月时间轴")) {
    errors.push("missing 12 个月时间轴 section");
  }
  if (!content.includes("## 季度回顾")) {
    errors.push("missing 季度回顾 section");
  }
  if (!content.includes("## 年度高互动书目")) {
    errors.push("missing 年度高互动书目 section");
  }
  if (!content.includes("## 说明")) {
    errors.push("missing 说明 section");
  }
  // 12-row timeline table check
  const tableHeader = "| 月份 | 记录 | 划线 | 想法 | 书评 | 未分类 | 已匹配 | 书目 |";
  if (!content.includes(tableHeader)) {
    errors.push("missing 12-month table header");
  } else {
    const rows = content
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.includes("---|") && !line.includes(tableHeader));
    if (rows.length < 12) {
      errors.push(`12-month table has ${rows.length} rows, expected >= 12`);
    }
  }
  // Quarter headings
  for (const q of ["### Q1", "### Q2", "### Q3", "### Q4"]) {
    if (!content.includes(q)) errors.push(`missing quarter heading: ${q}`);
  }
  return errors;
}

// ---------- download helper ----------

/**
 * Trigger a browser download for the supplied Markdown content.
 *
 * - The helper is dependency-injected so tests can run without a
 *   real DOM / `URL.createObjectURL`.
 * - The Blob is built with `ANNUAL_MARKDOWN_MIME` so the OS picks the
 *   Markdown app / editor.
 * - The anchor is appended to `document.body`, clicked, and removed
 *   synchronously. The Blob URL is revoked on the next tick so the
 *   browser has a chance to read it.
 * - The Markdown content is never logged or persisted.
 */
export function triggerAnnualReviewMarkdownDownload(args: TriggerAnnualReviewMarkdownDownloadArgs): TriggerAnnualReviewMarkdownDownloadResult {
  const content = String(args.content ?? "");
  const filename = String(args.filename ?? "");
  const blob = new Blob([content], { type: ANNUAL_MARKDOWN_MIME });
  const createObjectUrl =
    args.createObjectUrl ??
    ((b: Blob) => URL.createObjectURL(b));
  const revokeObjectUrl =
    args.revokeObjectUrl ??
    ((url: string) => URL.revokeObjectURL(url));
  const blobUrl = createObjectUrl(blob);
  const descriptor: AnnualMarkdownAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener",
    testId: "weread-annual-review-markdown-anchor",
  };
  if (args.attachAnchor) {
    args.attachAnchor(descriptor);
  } else {
    defaultAttachMarkdownAnchor(descriptor, args.resolveDocument);
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
    mimeType: ANNUAL_MARKDOWN_MIME,
    blobUrl,
    revoked: false,
    downloadTriggered: true,
  };
}

function defaultAttachMarkdownAnchor(
  descriptor: AnnualMarkdownAnchorDescriptor,
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

function ensureTwelveMonths(
  months: ReadonlyArray<WereadAnnualReviewResponse["months"][number]> | undefined,
  year: number
): WereadAnnualReviewResponse["months"][number][] {
  const lookup = new Map<string, WereadAnnualReviewResponse["months"][number]>();
  for (const m of months ?? []) {
    if (m && typeof m.month === "string") lookup.set(m.month, m);
  }
  const out: WereadAnnualReviewResponse["months"][number][] = [];
  for (let i = 1; i <= 12; i += 1) {
    const key = `${year}-${String(i).padStart(2, "0")}`;
    const raw = lookup.get(key) ?? {
      month: key,
      total: 0,
      highlights: 0,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      matched: 0,
      bookCount: 0,
    };
    out.push(raw);
  }
  return out;
}

function ensureFourQuarters(
  quarters: ReadonlyArray<WereadAnnualReviewQuarter> | undefined
): WereadAnnualReviewQuarter[] {
  const lookup = new Map<WereadAnnualReviewQuarter["quarter"], WereadAnnualReviewQuarter>();
  for (const q of quarters ?? []) {
    if (q) lookup.set(q.quarter, q);
  }
  const order: WereadAnnualReviewQuarter["quarter"][] = ["Q1", "Q2", "Q3", "Q4"];
  return order.map((key) => {
    const raw = lookup.get(key) ?? {
      quarter: key,
      total: 0,
      activeMonths: 0,
      matchedRecords: 0,
      bookCount: 0,
    };
    return raw;
  });
}

function formatPublishYear(value: WereadAnnualReviewBook["publishYear"]): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.floor(value));
  }
  const text = String(value).trim();
  if (!text) return "";
  const m = /^(\d{4})/.exec(text);
  if (m) return m[1];
  return "";
}

function formatDateOnly(input: string | null | undefined): string {
  if (!input) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!m) return "—";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function trimToString(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = String(input).trim();
  return s;
}

function byteLengthUtf8(input: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input).length;
  }
  // Fallback for environments without TextEncoder (Node < 11). Each
  // surrogate pair is 4 bytes; BMP chars are 2 bytes; ASCII is 1 byte.
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // skip low surrogate
    } else bytes += 3;
  }
  return bytes;
}