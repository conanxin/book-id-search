/**
 * S27O-3 — Browser-local Markdown export for the dual-period
 * reading comparison panel.
 *
 * Privacy contract (mirrors S27J-2 / S27K-2 / S27L-2 / S27M-2 /
 * S27N-2):
 *   - NEVER embeds note text, note comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, AI summary body, themes, the
 *     WeRead private title / author, the token, the raw comparison
 *     result JSON, or any cache/request/debug snapshot.
 *   - Consumes ONLY the already-computed
 *     `DualPeriodComparisonResult` plus the parent dashboard's
 *     range label / Top N limit / export timestamp.
 *   - All formatting is pure; `triggerDualPeriodMarkdownDownload`
 *     is the ONLY DOM-touching function. It never persists
 *     anything and never logs the full Markdown content.
 *   - No HTML / YAML frontmatter / external Markdown libraries /
 *     `dangerouslySetInnerHTML` / raw JSON dump.
 *
 * Markdown rules:
 *   - Inline text uses `escapeDualMarkdownInline` (collapses
 *     whitespace, strips control characters, escapes Markdown meta
 *     characters including `|` for safe table reuse).
 *   - Table cells use `escapeDualMarkdownTableCell` to escape the
 *     `|` delimiter.
 *   - Direction / delta text comes from allow-listed Chinese labels
 *     exported by the model layer.
 */

import {
  DUAL_PERIOD_DIRECTION_LABELS,
  type DualPeriodComparisonResult,
  type MetricDelta,
  type MetricDeltaDirection,
  type ReadingPeriod,
} from "./wereadDualPeriodComparison";

// ---------- public API ----------

export type DualPeriodRangeLabel =
  | "最近5年"
  | "最近10年"
  | "全部";

export interface DualPeriodMarkdownInput {
  result: DualPeriodComparisonResult;
  rangeLabel: DualPeriodRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  exportedAt: Date;
  siteBaseUrl?: string;
}

export interface DualPeriodMarkdownBuildResult {
  content: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  rangeLabel: DualPeriodRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  periodAYearCount: number;
  periodBYearCount: number;
  comparablePairs: number;
  continuedCount: number;
  enteredCount: number;
  leftCount: number;
}

export interface DualPeriodMarkdownFilenameArgs {
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
  now: Date;
  hasUsableData: boolean;
}

export interface DualPeriodMarkdownAnchorDescriptor {
  href: string;
  download: string;
  rel: string;
  testId: string;
}

export interface DocumentLike {
  createElement: (tag: string) => HTMLElementLike;
  body?: {
    appendChild: (el: HTMLElementLike) => void;
    removeChild: (el: HTMLElementLike) => void;
  } | null;
}

export interface HTMLElementLike {
  setAttribute: (name: string, value: string) => void;
  click: () => void;
}

export interface TriggerDualPeriodMarkdownDownloadArgs {
  content: string;
  filename: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  attachAnchor?: (anchor: DualPeriodMarkdownAnchorDescriptor) => void;
  resolveDocument?: () => DocumentLike | null;
}

export interface TriggerDualPeriodMarkdownDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const DUAL_PERIOD_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const DUAL_PERIOD_MARKDOWN_SITE_BASE_URL =
  "https://books.conanxin.com";
export const DUAL_PERIOD_MARKDOWN_FILENAME_PREFIX =
  "weread-dual-comparison";
export const DUAL_PERIOD_MARKDOWN_FILENAME_MAX_LENGTH = 80;

export const DUAL_PERIOD_MARKDOWN_PRIVACY_NOTE =
  "隐私说明：本文件由用户主动在当前浏览器中生成，包含公共书目信息和个人阅读统计，请自行妥善保存。";

export const DUAL_PERIOD_MARKDOWN_INTERPRETATION_NOTE =
  "解释边界：双时间段比较只描述两个时间窗的阅读统计与榜单重合差异，不代表兴趣、内在状态、能力或阅读质量发生变化。";

export const DUAL_PERIOD_MARKDOWN_DATA_SOURCE_NOTE =
  "数据完整性：所有目标年份均已成功加载。";

export const DUAL_PERIOD_MARKDOWN_PARTIAL_NOTE =
  "完整性提示：本次有部分年份暂时加载失败，比较只基于成功加载的年份。";

export const DUAL_PERIOD_MARKDOWN_EMPTY_NOTE =
  "当前两个时间段都没有数据。";

export const DUAL_PERIOD_MARKDOWN_SINGLE_YEAR_NOTE =
  "当前两个时间段只有一个年份，部分比较指标不可用。";

export const DUAL_PERIOD_MARKDOWN_FROM_ZERO_NOTE =
  "由 0 起：A 时段无数据，B 时段从零开始。";

export const DUAL_PERIOD_MARKDOWN_TO_ZERO_NOTE =
  "降至 0：A 时段有数据，B 时段归零。";

export const DUAL_PERIOD_MARKDOWN_NO_RECURRING_NOTE =
  "当前两个时间段没有共同上榜的书目。";

export const DUAL_PERIOD_MARKDOWN_NO_ENTERED_NOTE =
  "时间段 B 没有新上榜的书目。";

export const DUAL_PERIOD_MARKDOWN_NO_LEFT_NOTE =
  "时间段 A 没有仅在 A 出现的上榜书目。";

export const DUAL_PERIOD_MARKDOWN_NO_OVERLAP_NOTE =
  "当前时间段没有足够年份生成榜单重合。";

export const DUAL_PERIOD_MARKDOWN_METHOD_NOTES: ReadonlyArray<string> = [
  "只使用当前浏览器已经加载的长期档案。",
  "两个时间段均由用户自行选择或由快速预设生成。",
  "非法年份会向最近合法年份收敛；颠倒会自动交换。",
  "指标差异基于两段时间窗内的年度数据求和与平均。",
  "recurring books 只基于当前 Top N 榜单内的书目交集。",
  "榜单重合比例仅表示公共书目列表交集比例。",
  "差异为描述性结果，不涉及个人特征、内在状态或阅读质量推断。",
  "本文件不读取笔记正文，不调用 AI，不上传服务器。",
  "本文件不修改 archive reducer / cache / retry 语义。",
  "本文件不会写入浏览器本地存储或 URL。",
  "刷新页面后，时间段选择恢复默认。",
  "结果受当前长期档案范围和 Top N 口径影响。",
];

export const DUAL_PERIOD_METRIC_LABELS: ReadonlyArray<{
  key: "totalRecords" | "activeMonths" | "matchedRecords" | "matchedBooks" | "averageRecords";
  label: string;
}> = [
  { key: "totalRecords", label: "阅读记录" },
  { key: "activeMonths", label: "活跃月份" },
  { key: "matchedRecords", label: "已匹配记录" },
  { key: "matchedBooks", label: "年度书目" },
  { key: "averageRecords", label: "年均记录" },
];

// ---------- escaping / formatting ----------

const INLINE_META_CHARS = ["\\", "*", "_", "[", "]", "<", ">", "#", "`", "~", "|"];

function stripControlAndCollapse(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
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
      continue;
    }
    out += ch;
  }
  return out;
}

export function escapeDualMarkdownInline(input: unknown): string {
  if (input === null || input === undefined) return "";
  const raw = typeof input === "string" ? input : String(input);
  const collapsed = stripControlAndCollapse(raw);
  return escapeInlineMeta(collapsed);
}

export function escapeDualMarkdownTableCell(input: unknown): string {
  if (input === null || input === undefined) return "—";
  const cleaned = stripControlAndCollapse(String(input));
  if (!cleaned) return "—";
  const PIPE_SENTINEL = "\u0001";
  const marked = cleaned.replace(/\|/g, PIPE_SENTINEL);
  const metaEscaped = escapeInlineMeta(marked);
  return metaEscaped.split(PIPE_SENTINEL).join("\\|");
}

export function sanitizeDualMarkdownText(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "string") return "";
  return stripControlAndCollapse(input);
}

export function formatDualMarkdownDate(input: Date): string {
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) {
    return "—";
  }
  const y = input.getFullYear();
  const m = String(input.getMonth() + 1).padStart(2, "0");
  const d = String(input.getDate()).padStart(2, "0");
  const hh = String(input.getHours()).padStart(2, "0");
  const mm = String(input.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function formatDualPeriodRange(period: ReadingPeriod): string {
  if (!Number.isFinite(period.startYear) || !Number.isFinite(period.endYear)) {
    return "—";
  }
  if (period.startYear === period.endYear) {
    return `${period.startYear} 年`;
  }
  return `${period.startYear}–${period.endYear} 年`;
}

export function formatDualDirection(direction: MetricDeltaDirection): string {
  return DUAL_PERIOD_DIRECTION_LABELS[direction] ?? direction;
}

export function formatDualInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

export function formatDualAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("zh-CN");
  return rounded.toFixed(1);
}

export function formatDualAbsoluteDelta(delta: MetricDelta): string {
  if (!Number.isFinite(delta.absolute)) return "—";
  if (delta.absolute > 0) return `+${formatDualInteger(delta.absolute)}`;
  if (delta.absolute < 0) return formatDualInteger(delta.absolute);
  return "0";
}

export function formatDualAverageDelta(delta: MetricDelta): string {
  if (!Number.isFinite(delta.absolute)) return "—";
  if (delta.absolute > 0) return `+${formatDualAverage(delta.absolute)}`;
  if (delta.absolute < 0) return formatDualAverage(delta.absolute);
  return "0";
}

export function formatDualPercentage(delta: MetricDelta): string {
  if (delta.direction === "from_zero") return "由 0 起";
  if (delta.direction === "to_zero") return "降至 0";
  if (delta.direction === "same") return "0%";
  if (delta.percentage === null || !Number.isFinite(delta.percentage)) return "—";
  if (delta.percentage > 0) return `+${delta.percentage}%`;
  if (delta.percentage < 0) return `${delta.percentage}%`;
  return "0%";
}

export function formatDualRank(rank: number): string {
  if (!Number.isFinite(rank) || rank <= 0) return "—";
  return `第 ${rank} 名`;
}

export function formatDualPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  const r = Math.max(0, Math.min(1, ratio));
  return `${Math.round(r * 1000) / 10}%`;
}

// ---------- period file label ----------

export function formatDualPeriodForFilename(period: ReadingPeriod): string {
  if (!Number.isFinite(period.startYear) || !Number.isFinite(period.endYear)) {
    return "0";
  }
  return `${period.startYear}-${period.endYear}`;
}

// ---------- sections ----------

function siteBaseUrl(input?: string): string {
  if (input && /^https?:\/\//.test(input)) return input.replace(/\/$/, "");
  return DUAL_PERIOD_MARKDOWN_SITE_BASE_URL;
}

function bookPublicUrl(catalogId: string, baseUrl: string): string {
  return `${baseUrl}/books/${encodeURIComponent(catalogId)}`;
}

function headerSection(input: DualPeriodMarkdownInput): string {
  const result = input.result;
  const lines: string[] = [];
  lines.push("# 双时间段阅读比较");
  lines.push("");
  lines.push(`- 时间段 A：${escapeDualMarkdownInline(formatDualPeriodRange(result.periodA.range))}`);
  lines.push(`- 时间段 B：${escapeDualMarkdownInline(formatDualPeriodRange(result.periodB.range))}`);
  lines.push(`- 长期档案范围：${escapeDualMarkdownInline(input.rangeLabel)}`);
  lines.push(`- Top N：${input.topBooksLimit}`);
  lines.push(`- 导出时间：${escapeDualMarkdownInline(formatDualMarkdownDate(input.exportedAt))}`);
  lines.push(`- 数据来源：${escapeDualMarkdownInline(input.result.meta.source)}`);
  lines.push("- 生成方式：浏览器本地生成");
  lines.push("");
  lines.push(`> ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_PRIVACY_NOTE)}`);
  lines.push("");
  lines.push(`> ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_INTERPRETATION_NOTE)}`);
  lines.push("");
  if (input.result.periodA.metrics.years.length === 0 && input.result.periodB.metrics.years.length === 0) {
    lines.push(`> ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_EMPTY_NOTE)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function periodOverviewSection(input: DualPeriodMarkdownInput): string {
  const a = input.result.periodA.metrics;
  const b = input.result.periodB.metrics;
  const lines: string[] = [];
  lines.push("## 时间段概览");
  lines.push("");
  lines.push("| 项目 | 时间段 A | 时间段 B |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| 年份范围 | ${escapeDualMarkdownTableCell(formatDualPeriodRange(input.result.periodA.range))} | ${escapeDualMarkdownTableCell(formatDualPeriodRange(input.result.periodB.range))} |`,
  );
  lines.push(`| 年份数量 | ${formatDualInteger(a.years.length)} | ${formatDualInteger(b.years.length)} |`);
  lines.push(`| 阅读记录 | ${formatDualInteger(a.totalRecords)} | ${formatDualInteger(b.totalRecords)} |`);
  lines.push(`| 活跃月份 | ${formatDualInteger(a.totalActiveMonths)} | ${formatDualInteger(b.totalActiveMonths)} |`);
  lines.push(`| 已匹配记录 | ${formatDualInteger(a.matchedRecords)} | ${formatDualInteger(b.matchedRecords)} |`);
  lines.push(`| 年度书目 | ${formatDualInteger(a.matchedBooks)} | ${formatDualInteger(b.matchedBooks)} |`);
  lines.push(`| 年均记录 | ${formatDualAverage(a.averageRecordsPerYear)} | ${formatDualAverage(b.averageRecordsPerYear)} |`);
  lines.push(`| 最长连续活跃年份 | ${formatDualInteger(a.longestActiveStreak)} | ${formatDualInteger(b.longestActiveStreak)} |`);
  lines.push(
    `| 最高记录年份 | ${a.peakYear !== null ? escapeDualMarkdownTableCell(`${a.peakYear} 年 (${formatDualInteger(a.peakYearRecords)} 条)`) : "—"} | ${b.peakYear !== null ? escapeDualMarkdownTableCell(`${b.peakYear} 年 (${formatDualInteger(b.peakYearRecords)} 条)`) : "—"} |`,
  );
  lines.push("");
  return lines.join("\n");
}

function metricsComparisonSection(input: DualPeriodMarkdownInput): string {
  const lines: string[] = [];
  lines.push("## 核心指标比较");
  lines.push("");
  lines.push("| 指标 | A | B | 差值 | 百分比 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of DUAL_PERIOD_METRIC_LABELS) {
    const delta = input.result.delta[row.key];
    const aValue =
      row.key === "totalRecords"
        ? input.result.periodA.metrics.totalRecords
        : row.key === "activeMonths"
          ? input.result.periodA.metrics.totalActiveMonths
          : row.key === "matchedRecords"
            ? input.result.periodA.metrics.matchedRecords
            : row.key === "matchedBooks"
              ? input.result.periodA.metrics.matchedBooks
              : input.result.periodA.metrics.averageRecordsPerYear;
    const bValue =
      row.key === "totalRecords"
        ? input.result.periodB.metrics.totalRecords
        : row.key === "activeMonths"
          ? input.result.periodB.metrics.totalActiveMonths
          : row.key === "matchedRecords"
            ? input.result.periodB.metrics.matchedRecords
            : row.key === "matchedBooks"
              ? input.result.periodB.metrics.matchedBooks
              : input.result.periodB.metrics.averageRecordsPerYear;
    const valueFormatter =
      row.key === "averageRecords" ? formatDualAverage : formatDualInteger;
    const deltaFormatter =
      row.key === "averageRecords" ? formatDualAverageDelta : formatDualAbsoluteDelta;
    lines.push(
      `| ${row.label} | ${valueFormatter(aValue)} | ${valueFormatter(bValue)} | ${deltaFormatter(delta)} | ${escapeDualMarkdownTableCell(formatDualPercentage(delta))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function deltaDirectionSection(input: DualPeriodMarkdownInput): string {
  const lines: string[] = [];
  lines.push("### 差异方向说明");
  lines.push("");
  const found: MetricDeltaDirection[] = [];
  for (const row of DUAL_PERIOD_METRIC_LABELS) {
    const d = input.result.delta[row.key].direction;
    if (!found.includes(d)) found.push(d);
  }
  if (found.includes("from_zero")) {
    lines.push(`- ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_FROM_ZERO_NOTE)}`);
  }
  if (found.includes("to_zero")) {
    lines.push(`- ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_TO_ZERO_NOTE)}`);
  }
  if (found.length === 0) {
    lines.push("- 所有核心指标方向均为持平。");
  }
  lines.push("");
  return lines.join("\n");
}

function recurringSection(input: DualPeriodMarkdownInput, baseUrl: string): string {
  const lines: string[] = [];
  const books = input.result.recurringBooks;
  const continued = books.continued;
  const entered = books.entered;
  const left = books.left;

  lines.push("## Recurring Books");
  lines.push("");
  lines.push("仅表示两个时间段 Top N 榜单中的公共书目差异。");
  lines.push("");

  // Continued
  lines.push("### 两个时间段共同出现");
  lines.push("");
  if (continued.length === 0) {
    lines.push(`> ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_NO_RECURRING_NOTE)}`);
    lines.push("");
  } else {
    for (const b of continued) {
      lines.push(...bookBlock(b, baseUrl));
    }
  }

  // Entered
  lines.push("### B 新出现");
  lines.push("");
  if (entered.length === 0) {
    lines.push(`> ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_NO_ENTERED_NOTE)}`);
    lines.push("");
  } else {
    for (const b of entered) {
      lines.push(...bookBlock(b, baseUrl));
    }
  }

  // Left
  lines.push("### A 出现但 B 未出现");
  lines.push("");
  if (left.length === 0) {
    lines.push(`> ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_NO_LEFT_NOTE)}`);
    lines.push("");
  } else {
    for (const b of left) {
      lines.push(...bookBlock(b, baseUrl));
    }
  }

  return lines.join("\n");
}

function bookBlock(
  b: import("./wereadReadingArchiveModel").ReadingArchiveRecurringBook,
  baseUrl: string,
): string[] {
  const lines: string[] = [];
  lines.push(`- **${escapeDualMarkdownInline(b.title || b.catalogId)}**`);
  if (b.author && b.author.trim()) {
    lines.push(`  - 作者：${escapeDualMarkdownInline(b.author)}`);
  }
  if (b.publisher && b.publisher.trim()) {
    const py =
      b.publishYear !== null && b.publishYear !== undefined && b.publishYear !== ""
        ? `（${escapeDualMarkdownInline(String(b.publishYear))}）`
        : "";
    lines.push(`  - 出版社：${escapeDualMarkdownInline(b.publisher)}${py}`);
  }
  lines.push(`  - 年份：${b.years.map((y) => escapeDualMarkdownInline(String(y))).join(" / ")}`);
  lines.push(`  - rank：${escapeDualMarkdownInline(formatDualRank(b.bestRank))}`);
  lines.push(`  - public URL：${escapeDualMarkdownInline(bookPublicUrl(b.catalogId, baseUrl))}`);
  return lines;
}

function overlapSection(input: DualPeriodMarkdownInput): string {
  const lines: string[] = [];
  lines.push("## Overlap");
  lines.push("");
  lines.push("榜单重合比例仅表示公共书目列表交集比例。");
  lines.push("");
  if (input.result.overlap.comparablePairs === 0) {
    lines.push(`> ${escapeDualMarkdownInline(DUAL_PERIOD_MARKDOWN_NO_OVERLAP_NOTE)}`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| 时间段 | 榜单重合比例 | 可比较年份对 |");
  lines.push("| --- | --- | --- |");
  // Use the model-level comparablePairs count for both rows combined.
  // We split the count using the period-year ratios.
  const totalYears = Math.max(
    1,
    input.result.periodA.metrics.years.length +
      input.result.periodB.metrics.years.length,
  );
  const aShare = Math.round(
    (input.result.periodA.metrics.years.length / totalYears) *
      input.result.overlap.comparablePairs,
  );
  const bShare = input.result.overlap.comparablePairs - aShare;
  lines.push(
    `| A | ${escapeDualMarkdownTableCell(formatDualPercent(input.result.overlap.average))} | ${formatDualInteger(aShare)} |`,
  );
  lines.push(
    `| B | ${escapeDualMarkdownTableCell(formatDualPercent(input.result.overlap.average))} | ${formatDualInteger(bShare)} |`,
  );
  lines.push("");
  return lines.join("\n");
}

function methodSection(): string {
  const lines: string[] = [];
  lines.push("## 方法说明");
  lines.push("");
  for (const note of DUAL_PERIOD_MARKDOWN_METHOD_NOTES) {
    lines.push(`- ${escapeDualMarkdownInline(note)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- main builder ----------

export function buildDualPeriodMarkdown(
  input: DualPeriodMarkdownInput,
): DualPeriodMarkdownBuildResult {
  const base = siteBaseUrl(input.siteBaseUrl);
  const content =
    headerSection(input) +
    periodOverviewSection(input) +
    metricsComparisonSection(input) +
    deltaDirectionSection(input) +
    recurringSection(input, base) +
    overlapSection(input) +
    methodSection();

  const hasUsableData =
    input.result.periodA.metrics.years.length > 0 &&
    input.result.periodB.metrics.years.length > 0;

  const filename = buildDualPeriodMarkdownFilename({
    periodA: input.result.periodA.range,
    periodB: input.result.periodB.range,
    now: input.exportedAt,
    hasUsableData,
  });

  const encoder = new TextEncoder();
  const byteLength = encoder.encode(content).length;

  return {
    content,
    filename,
    mimeType: DUAL_PERIOD_MARKDOWN_MIME,
    byteLength,
    rangeLabel: input.rangeLabel,
    topBooksLimit: input.topBooksLimit,
    periodAYearCount: input.result.periodA.metrics.years.length,
    periodBYearCount: input.result.periodB.metrics.years.length,
    comparablePairs: input.result.overlap.comparablePairs,
    continuedCount: input.result.recurringBooks.continued.length,
    enteredCount: input.result.recurringBooks.entered.length,
    leftCount: input.result.recurringBooks.left.length,
  };
}

// ---------- filename ----------

export function buildDualPeriodMarkdownFilename(
  args: DualPeriodMarkdownFilenameArgs,
): string {
  const datePart = formatDatePart(args.now);
  if (!args.hasUsableData) {
    const name = `${DUAL_PERIOD_MARKDOWN_FILENAME_PREFIX}-empty-${datePart}.md`;
    return name.slice(0, DUAL_PERIOD_MARKDOWN_FILENAME_MAX_LENGTH);
  }
  const aLabel = formatDualPeriodForFilename(args.periodA);
  const bLabel = formatDualPeriodForFilename(args.periodB);
  const name = `${DUAL_PERIOD_MARKDOWN_FILENAME_PREFIX}-${aLabel}-vs-${bLabel}-${datePart}.md`;
  return name.slice(0, DUAL_PERIOD_MARKDOWN_FILENAME_MAX_LENGTH);
}

function formatDatePart(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "00000000";
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// ---------- validation ----------

export function validateDualPeriodMarkdown(
  result: DualPeriodMarkdownBuildResult,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof result.content !== "string" || result.content.length === 0) {
    errors.push("content missing");
  }
  if (result.byteLength <= 0) errors.push("byteLength missing");
  if (result.mimeType !== DUAL_PERIOD_MARKDOWN_MIME) errors.push("mimeType wrong");
  if (!result.filename.endsWith(".md")) errors.push("filename not .md");
  if (result.filename.length > DUAL_PERIOD_MARKDOWN_FILENAME_MAX_LENGTH) {
    errors.push("filename too long");
  }

  if (result.content) {
    const lower = result.content.toLowerCase();
    const forbidden = [
      "note.text",
      "note.comment",
      "markedtext",
      "wereadbookid",
      "noteid",
      "highlightid",
      "chaptertitle",
      "ai summary",
      "aisummary",
      "themes",
      "authorization:",
      "api key",
      "apikey",
      "wr_skey",
      "wr_vid",
      "token=",
    ];
    for (const token of forbidden) {
      if (lower.includes(token)) errors.push(`forbidden token: ${token}`);
    }
    const inference = [
      "兴趣转变",
      "偏好改变",
      "阅读低谷",
      "阅读高峰期",
      "探索期",
      "成熟期",
      "专注力变化",
      "心态变化",
      "阅读质量提升",
      "阅读质量下降",
      "心理状态",
      "人格",
      "性格",
      "情绪",
      "焦虑",
      "懒惰",
      "提升",
      "成长",
      "退步",
    ];
    for (const token of inference) {
      if (result.content.includes(token)) errors.push(`inference: ${token}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------- download trigger ----------

export function triggerDualPeriodMarkdownDownload(
  args: TriggerDualPeriodMarkdownDownloadArgs,
): TriggerDualPeriodMarkdownDownloadResult {
  const content = args.content;
  const filename = args.filename;
  const mimeType = DUAL_PERIOD_MARKDOWN_MIME;
  const blob = new Blob([content], { type: mimeType });
  const size = blob.size;

  const createObjectUrl =
    args.createObjectUrl ??
    ((b: Blob) => {
      if (typeof URL !== "undefined" && URL.createObjectURL) {
        return URL.createObjectURL(b);
      }
      throw new Error("URL.createObjectURL not available");
    });

  const revokeObjectUrl =
    args.revokeObjectUrl ??
    ((url: string) => {
      if (typeof URL !== "undefined" && URL.revokeObjectURL) {
        URL.revokeObjectURL(url);
      }
    });

  const blobUrl = createObjectUrl(blob);
  const anchor: DualPeriodMarkdownAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener noreferrer",
    testId: "weread-dual-period-export-anchor",
  };

  let downloadTriggered = false;

  if (args.attachAnchor) {
    args.attachAnchor(anchor);
    downloadTriggered = true;
  } else {
    const doc =
      args.resolveDocument?.() ??
      (typeof document !== "undefined" ? (document as unknown as DocumentLike) : null);
    if (doc && doc.body) {
      const a = doc.createElement("a");
      a.setAttribute("href", anchor.href);
      a.setAttribute("download", anchor.download);
      a.setAttribute("rel", anchor.rel);
      a.setAttribute("data-testid", anchor.testId);
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
      downloadTriggered = true;
    }
  }

  const revoke = () => revokeObjectUrl(blobUrl);
  if (typeof setTimeout !== "undefined") {
    setTimeout(revoke, 0);
  } else {
    revoke();
  }

  return {
    filename,
    size,
    mimeType,
    blobUrl,
    downloadTriggered,
  };
}

// ---------- dual period type alias for test consumers ----------
export type { DualPeriodComparisonResult as DualPeriodMarkdownResult };
