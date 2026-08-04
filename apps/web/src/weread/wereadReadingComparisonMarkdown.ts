/**
 * S27N-2 — Browser-local Markdown export for the long-term reading
 * comparison filters panel.
 *
 * Privacy contract (mirrors S27J-2 / S27K-2 / S27L-2 / S27M-2):
 *   - NEVER embeds note text, note comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, AI summary body, session theme
 *     overlay, the WeRead private title / author, the token,
 *     the `q` search term, the raw comparison result JSON, or
 *     any cache/request/debug snapshot.
 *   - Consumes ONLY the already-computed `ReadingComparisonResult`
 *     plus the parent dashboard's range label / Top N limit /
 *     failed-years list / export timestamp.
 *   - All formatting is pure; `triggerReadingComparisonMarkdownDownload`
 *     is the ONLY DOM-touching function. It never persists
 *     anything and never logs the full Markdown content.
 *   - No HTML / YAML frontmatter / external Markdown libraries /
 *     `dangerouslySetInnerHTML` / raw JSON dump.
 *
 * Markdown rules:
 *   - Inline text uses `escapeReadingComparisonMarkdownInline`
 *     (collapses whitespace, strips control characters, escapes
 *     Markdown meta characters including `|` for safe table reuse).
 *   - Table cells use
 *     `escapeReadingComparisonMarkdownTableCell` to escape the
 *     `|` delimiter.
 *   - Boundary / exclusion / overlap reason text comes from
 *     allow-listed Chinese labels exported by the model layer.
 */

import {
  READING_COMPARISON_REASON_LABELS,
  READING_COMPARISON_OVERLAP_LABELS,
  classifyOverlapRatio,
  type ReadingComparisonResult,
  type ReadingComparisonExcludedYearReason,
  type ReadingComparisonOverlapFilter,
  type ReadingComparisonFilters,
} from "./wereadReadingComparisonFilters";

// ---------- public API ----------

export type ReadingComparisonRangeLabel = "最近5年" | "最近10年" | "全部";
export type ReadingComparisonTopBooksLimit = 6 | 12 | 18;

export interface ReadingComparisonMarkdownInput {
  result: ReadingComparisonResult;
  rangeLabel: ReadingComparisonRangeLabel;
  topBooksLimit: ReadingComparisonTopBooksLimit;
  failedYears: number[];
  exportedAt: Date;
  siteBaseUrl?: string;
}

export interface ReadingComparisonMarkdownBuildResult {
  content: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  rangeLabel: ReadingComparisonRangeLabel;
  topBooksLimit: ReadingComparisonTopBooksLimit;
  eraCount: number;
  includedYearCount: number;
  excludedYearCount: number;
  failedYearCount: number;
}

export interface ReadingComparisonMarkdownFilenameArgs {
  firstYear: number | null;
  latestYear: number | null;
  now: Date;
}

export interface ReadingComparisonMarkdownAnchorDescriptor {
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

export interface TriggerReadingComparisonMarkdownDownloadArgs {
  content: string;
  filename: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  attachAnchor?: (anchor: ReadingComparisonMarkdownAnchorDescriptor) => void;
  resolveDocument?: () => DocumentLike | null;
}

export interface TriggerReadingComparisonMarkdownDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const READING_COMPARISON_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const READING_COMPARISON_MARKDOWN_SITE_BASE_URL =
  "https://books.conanxin.com";
export const READING_COMPARISON_MARKDOWN_FILENAME_PREFIX =
  "weread-reading-comparison";
export const READING_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH = 80;

export const READING_COMPARISON_MARKDOWN_PRIVACY_NOTE =
  "隐私说明：本文件由用户主动在当前浏览器中生成，包含公共书目信息和个人阅读统计，请自行妥善保存。";

export const READING_COMPARISON_MARKDOWN_INTERPRETATION_NOTE =
  "解释边界：筛选结果只描述哪些年份满足当前统计条件，不代表兴趣、内在状态、能力或阅读质量发生变化。";

export const READING_COMPARISON_MARKDOWN_COMPLETENESS_NOTE =
  "完整性提示：本次有 N 个年份暂时加载失败，筛选比较只基于成功加载的年份。";

export const READING_COMPARISON_MARKDOWN_DATA_INTEGRITY_NOTE =
  "数据完整性：所有目标年份均已成功加载。";

export const READING_COMPARISON_MARKDOWN_EMPTY_NOTE =
  "当前筛选条件下暂无符合条件的年份。";

export const READING_COMPARISON_MARKDOWN_SINGLE_YEAR_NOTE =
  "当前只有一个纳入年份，无法生成相邻年度榜单重合。";

export const READING_COMPARISON_MARKDOWN_NO_RECURRING_NOTE =
  "当前筛选条件下暂无重复进入榜单的公共书目。";

export const READING_COMPARISON_MARKDOWN_NO_OVERLAP_NOTE =
  "当前筛选条件下暂无符合条件的相邻年度榜单重合。";

export const READING_COMPARISON_MARKDOWN_NO_EXCLUDED_NOTE =
  "当前没有年份被筛选条件排除。";

export const READING_COMPARISON_MARKDOWN_METHOD_NOTES = [
  "只使用当前浏览器已经加载的长期档案。",
  "年份范围、最低记录数和最低活跃月份共同决定纳入年份。",
  "同一年可以同时具有多个排除原因。",
  "recurring books 只基于纳入年份和当前 Top N 榜单。",
  "榜单重合分类只基于相邻年份公共书目列表交集。",
  "当前筛选条件不会写入 URL 或浏览器存储。",
  "本次导出不会重新请求年度 API。",
  "本文件未读取笔记正文。",
  "本文件未调用外部 AI。",
  "本文件未上传或保存到服务器。",
  "本文件不分析主题、个人特征、兴趣、内在状态或阅读质量。",
  "刷新页面后，筛选条件恢复默认。",
  "结果受当前长期档案范围和 Top N 口径影响。",
];

export const READING_COMPARISON_OVERLAP_CLASS_LABELS: Readonly<
  Record<"low" | "medium" | "high", "较低" | "中等" | "较高">
> = {
  low: "较低",
  medium: "中等",
  high: "较高",
};

export const READING_COMPARISON_FILTER_VALUE_LABELS: Readonly<
  Record<ReadingComparisonOverlapFilter, string>
> = {
  all: "全部",
  low: "较低（< 0.25）",
  medium: "中等（0.25 — 0.5）",
  high: "较高（≥ 0.5）",
};

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
    } else {
      out += ch;
    }
  }
  return out;
}

export function escapeReadingComparisonMarkdownInline(input: unknown): string {
  if (input === null || input === undefined) return "";
  return escapeInlineMeta(stripControlAndCollapse(String(input)));
}

export function escapeReadingComparisonMarkdownTableCell(input: unknown): string {
  if (input === null || input === undefined) return "—";
  const cleaned = stripControlAndCollapse(String(input));
  if (!cleaned) return "—";
  const PIPE_SENTINEL = "\u0001";
  const marked = cleaned.replace(/\|/g, PIPE_SENTINEL);
  const metaEscaped = escapeInlineMeta(marked);
  return metaEscaped.split(PIPE_SENTINEL).join("\\|");
}

export function escapeReadingComparisonMarkdownTableRow(
  cells: ReadonlyArray<unknown>,
): string {
  return cells
    .map((c) => escapeReadingComparisonMarkdownTableCell(c))
    .map((s) => ` ${s} `)
    .join("|")
    .replace(/^/, "|")
    .replace(/$/, "|");
}

export function sanitizeReadingComparisonMarkdownText(input: unknown): string {
  return escapeReadingComparisonMarkdownInline(input);
}

export function formatReadingComparisonMarkdownDate(input: Date): string {
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) return "—";
  const y = input.getFullYear();
  const m = String(input.getMonth() + 1).padStart(2, "0");
  const d = String(input.getDate()).padStart(2, "0");
  const hh = String(input.getHours()).padStart(2, "0");
  const mm = String(input.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function formatReadingComparisonYearRange(first: number | null, latest: number | null): string {
  if (first === null || latest === null) return "暂无";
  if (first === latest) return `${first}`;
  return `${first}—${latest}`;
}

export function formatReadingComparisonOverlapFilter(f: ReadingComparisonOverlapFilter): string {
  return READING_COMPARISON_FILTER_VALUE_LABELS[f] ?? "全部";
}

export function formatReadingComparisonExcludedReasons(
  reasons: ReadonlyArray<ReadingComparisonExcludedYearReason>,
): string {
  if (reasons.length === 0) return "";
  const labels = reasons
    .map((reason) => READING_COMPARISON_REASON_LABELS[reason])
    .filter(Boolean);
  if (labels.length === 0) return "";
  return labels.join("；");
}

export function formatReadingComparisonRangeLabel(label: ReadingComparisonRangeLabel): string {
  switch (label) {
    case "最近5年":
      return "最近 5 年";
    case "最近10年":
      return "最近 10 年";
    case "全部":
      return "全部（最多 20 年）";
    default:
      return "—";
  }
}

export function formatReadingComparisonTopNLabel(limit: ReadingComparisonTopBooksLimit): string {
  return `各年度 Top ${limit}`;
}

export function formatReadingComparisonInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

export function formatReadingComparisonAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

export function formatReadingComparisonRank(rank: number): string {
  if (!Number.isFinite(rank) || rank < 1) return "—";
  return `第 ${rank}`;
}

export function formatReadingComparisonPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatReadingComparisonOverlapClassLabel(
  ratio: number,
): "较低" | "中等" | "较高" {
  const cls = classifyOverlapRatio(ratio);
  if (cls === "all") return READING_COMPARISON_OVERLAP_CLASS_LABELS.medium;
  return READING_COMPARISON_OVERLAP_CLASS_LABELS[cls];
}

export function formatReadingComparisonPeakMonth(month: string | null): string {
  if (!month) return "—";
  return escapeReadingComparisonMarkdownInline(month);
}

export function formatReadingComparisonYearPlain(year: number | null): string {
  if (year === null || !Number.isFinite(year)) return "—";
  return String(year);
}

// ---------- content construction ----------

function siteBaseUrl(input?: string): string {
  if (typeof input === "string" && input.trim()) return input.trim().replace(/\/$/, "");
  return READING_COMPARISON_MARKDOWN_SITE_BASE_URL;
}

function bookPublicUrl(catalogId: string, baseUrl: string): string {
  return `${baseUrl}/books/${encodeURIComponent(catalogId)}`;
}

function headerSection(input: ReadingComparisonMarkdownInput): string {
  const result = input.result;
  const years = result.includedYears.map((y) => y.year);
  const firstYear = years.length ? Math.min(...years) : null;
  const latestYear = years.length ? Math.max(...years) : null;
  const failedCount = input.failedYears.length;
  const includedCount = result.summary.includedYearCount;
  const excludedCount = result.summary.excludedYearCount;
  const availableCount = result.availableYears.length;

  const lines: string[] = [];
  lines.push("# 长期阅读筛选比较");
  lines.push("");
  lines.push(`- 当前长期档案范围：${formatReadingComparisonRangeLabel(input.rangeLabel)}`);
  lines.push(`- 高互动书目口径：${formatReadingComparisonTopNLabel(input.topBooksLimit)}`);
  lines.push(`- 可用年份：${availableCount}`);
  lines.push(`- 纳入年份：${includedCount}`);
  lines.push(`- 排除年份：${excludedCount}`);
  lines.push(`- 暂时失败年份：${failedCount}`);
  lines.push(
    `- 当前比较年份：${formatReadingComparisonYearRange(firstYear, latestYear)}`,
  );
  lines.push(`- 导出时间：${formatReadingComparisonMarkdownDate(input.exportedAt)}`);
  lines.push(`- 生成方式：book-id-search 浏览器本地生成`);
  lines.push(`- 保存状态：未上传服务器`);
  lines.push("");
  lines.push(`> ${READING_COMPARISON_MARKDOWN_PRIVACY_NOTE}`);
  lines.push("");
  lines.push(`> ${READING_COMPARISON_MARKDOWN_INTERPRETATION_NOTE}`);
  lines.push("");

  if (failedCount > 0) {
    lines.push(
      `> ${READING_COMPARISON_MARKDOWN_COMPLETENESS_NOTE.replace("N", String(failedCount))}`,
    );
    lines.push("");
  } else if (availableCount > 0) {
    lines.push(`> ${READING_COMPARISON_MARKDOWN_DATA_INTEGRITY_NOTE}`);
    lines.push("");
  }

  return lines.join("\n");
}

function filterCriteriaSection(filters: ReadingComparisonFilters): string {
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 当前筛选条件");
  lines.push("--------------------------------------------------");
  lines.push("");
  lines.push("| 条件 | 当前值 |");
  lines.push("|---|---|");
  lines.push(
    escapeReadingComparisonMarkdownTableRow([
      "起始年份",
      filters.startYear === null ? "不限制" : formatReadingComparisonYearPlain(filters.startYear),
    ]),
  );
  lines.push(
    escapeReadingComparisonMarkdownTableRow([
      "结束年份",
      filters.endYear === null ? "不限制" : formatReadingComparisonYearPlain(filters.endYear),
    ]),
  );
  lines.push(
    escapeReadingComparisonMarkdownTableRow([
      "最低阅读记录",
      formatReadingComparisonInteger(filters.minRecords),
    ]),
  );
  lines.push(
    escapeReadingComparisonMarkdownTableRow([
      "最低活跃月份",
      formatReadingComparisonInteger(filters.minActiveMonths),
    ]),
  );
  lines.push(
    escapeReadingComparisonMarkdownTableRow([
      "recurring 最低上榜年份",
      `${formatReadingComparisonInteger(filters.recurringMinYears)} 年`,
    ]),
  );
  lines.push(
    escapeReadingComparisonMarkdownTableRow([
      "榜单重合范围",
      formatReadingComparisonOverlapFilter(filters.overlap),
    ]),
  );
  lines.push("");
  return lines.join("\n");
}

function overviewSection(input: ReadingComparisonMarkdownInput): string {
  const result = input.result;
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 比较总览");
  lines.push("--------------------------------------------------");
  lines.push("");
  const years = result.includedYears.map((y) => y.year);
  const firstYear = years.length ? Math.min(...years) : null;
  const latestYear = years.length ? Math.max(...years) : null;

  lines.push(`- 纳入年份：${result.summary.includedYearCount}`);
  lines.push(`- 排除年份：${result.summary.excludedYearCount}`);
  lines.push(`- 阅读记录合计：${formatReadingComparisonInteger(result.summary.totalRecords)}`);
  lines.push(
    `- 活跃月份合计：${formatReadingComparisonInteger(result.summary.totalActiveMonths)}`,
  );
  lines.push(
    `- 年均记录：${formatReadingComparisonAverage(result.summary.averageRecordsPerYear)}`,
  );
  lines.push(
    `- 最早纳入年份：${formatReadingComparisonYearPlain(result.summary.earliestYear)}`,
  );
  lines.push(
    `- 最近纳入年份：${formatReadingComparisonYearPlain(result.summary.latestYear)}`,
  );
  // also reflect in-range comparison window for human scan
  lines.push(
    `- 当前比较年份：${formatReadingComparisonYearRange(firstYear, latestYear)}`,
  );
  lines.push("");
  return lines.join("\n");
}

function includedYearsSection(input: ReadingComparisonMarkdownInput): string {
  const result = input.result;
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 纳入年份指标");
  lines.push("--------------------------------------------------");
  lines.push("");

  if (result.includedYears.length === 0) {
    lines.push(READING_COMPARISON_MARKDOWN_EMPTY_NOTE);
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    "| 年份 | 阅读记录 | 有效日期记录 | 已匹配记录 | 年度书目 | 活跃月份 | 最长连续月份 | 高峰月份 | 活跃月份平均记录 |",
  );
  lines.push("|---:|---:|---:|---:|---:|---:|---:|---|---:|");
  result.includedYears.forEach((y) => {
    lines.push(
      escapeReadingComparisonMarkdownTableRow([
        formatReadingComparisonYearPlain(y.year),
        formatReadingComparisonInteger(y.totalRecords),
        formatReadingComparisonInteger(y.datedRecords),
        formatReadingComparisonInteger(y.matchedRecords),
        formatReadingComparisonInteger(y.matchedBooks),
        formatReadingComparisonInteger(y.activeMonths),
        formatReadingComparisonInteger(y.longestActiveStreak),
        formatReadingComparisonPeakMonth(y.peakMonth),
        formatReadingComparisonAverage(y.averageRecordsPerActiveMonth),
      ]),
    );
  });
  lines.push("");
  return lines.join("\n");
}

function excludedYearsSection(result: ReadingComparisonResult): string {
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 被排除年份");
  lines.push("--------------------------------------------------");
  lines.push("");

  if (result.excludedYears.length === 0) {
    lines.push(READING_COMPARISON_MARKDOWN_NO_EXCLUDED_NOTE);
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| 年份 | 排除原因 |");
  lines.push("|---:|---|");
  result.excludedYears.forEach((e) => {
    lines.push(
      escapeReadingComparisonMarkdownTableRow([
        formatReadingComparisonYearPlain(e.year),
        formatReadingComparisonExcludedReasons(e.reasons),
      ]),
    );
  });
  lines.push("");
  return lines.join("\n");
}

function recurringBooksSection(result: ReadingComparisonResult, baseUrl: string): string {
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 筛选范围内重复进入 Top N 的书目");
  lines.push("--------------------------------------------------");
  lines.push("");
  lines.push(`> ${READING_COMPARISON_MARKDOWN_NO_RECURRING_NOTE ? READING_COMPARISON_MARKDOWN_NO_RECURRING_NOTE : ""}`);
  lines.push("");

  if (result.recurringBooks.length === 0) {
    lines.push(READING_COMPARISON_MARKDOWN_NO_RECURRING_NOTE);
    lines.push("");
    return lines.join("\n");
  }

  result.recurringBooks.forEach((b, idx) => {
    const author = bookAuthorLine(b.author ?? null);
    const publisher = bookPublisherLine(b.publisher ?? null, b.publishYear ?? null);
    const yearsAsc = [...b.years].sort((a, b) => a - b);

    lines.push(`### ${idx + 1}. 《${escapeReadingComparisonMarkdownInline(b.title)}》`);
    lines.push("");
    if (author) lines.push(`- 作者：${author}`);
    if (publisher) lines.push(`- 出版信息：${publisher}`);
    lines.push(
      `- 纳入的上榜年份：${yearsAsc.map(formatReadingComparisonYearPlain).join("、")}`,
    );
    lines.push(`- 上榜年份数：${formatReadingComparisonInteger(b.yearsOnList)} 年`);
    lines.push(`- 最佳排名：${formatReadingComparisonRank(b.bestRank)}`);
    lines.push(`- 最新上榜年份：${formatReadingComparisonYearPlain(b.latestYear)}`);
    lines.push(`- 最新年份排名：${formatReadingComparisonRank(b.latestRank)}`);
    lines.push(
      `- 榜单内记录合计：${formatReadingComparisonInteger(b.totalNoteCountWithinLists)}`,
    );
    lines.push(`- 书目页面：${bookPublicUrl(b.catalogId, baseUrl)}`);
    lines.push("");
  });

  return lines.join("\n");
}

function overlapSection(result: ReadingComparisonResult): string {
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 筛选范围内相邻年度榜单重合");
  lines.push("--------------------------------------------------");
  lines.push("");

  if (result.yearLinks.length === 0) {
    lines.push(READING_COMPARISON_MARKDOWN_NO_OVERLAP_NOTE);
    lines.push("");
    if (result.includedYears.length === 1) {
      lines.push(READING_COMPARISON_MARKDOWN_SINGLE_YEAR_NOTE);
      lines.push("");
    }
    return lines.join("\n");
  }

  lines.push("| 相邻年份 | 共同上榜书目 | 榜单重合率 | 当前分类 |");
  lines.push("|---|---:|---:|---|");
  result.yearLinks.forEach((l) => {
    lines.push(
      escapeReadingComparisonMarkdownTableRow([
        `${formatReadingComparisonYearPlain(l.sourceYear)} → ${formatReadingComparisonYearPlain(l.targetYear)}`,
        formatReadingComparisonInteger(l.sharedTopBooks),
        formatReadingComparisonPercent(l.overlapRatio),
        formatReadingComparisonOverlapClassLabel(l.overlapRatio),
      ]),
    );
  });
  lines.push("");
  return lines.join("\n");
}

function methodSection(): string {
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 方法说明");
  lines.push("--------------------------------------------------");
  lines.push("");
  READING_COMPARISON_MARKDOWN_METHOD_NOTES.forEach((note) => {
    lines.push(`- ${note}`);
  });
  lines.push("");
  return lines.join("\n");
}

function bookAuthorLine(author: string | null): string {
  if (!author || !author.trim()) return "";
  return escapeReadingComparisonMarkdownInline(author);
}

function bookPublisherLine(
  publisher: string | null,
  publishYear: string | number | null,
): string {
  const parts: string[] = [];
  if (publisher && publisher.trim()) {
    parts.push(escapeReadingComparisonMarkdownInline(publisher));
  }
  if (publishYear !== null && publishYear !== undefined) {
    parts.push(escapeReadingComparisonMarkdownInline(String(publishYear)));
  }
  return parts.join("，");
}

/**
 * Build the full Markdown content for the comparison-filter export.
 */
export function buildReadingComparisonMarkdown(
  input: ReadingComparisonMarkdownInput,
): ReadingComparisonMarkdownBuildResult {
  const base = siteBaseUrl(input.siteBaseUrl);
  // Defensive sort: the model layer always returns includedYears /
  // excludedYears / yearLinks sorted ascending. The builder
  // tolerates inputs constructed by tests or future code paths.
  const normalized: ReadingComparisonResult = {
    ...input.result,
    includedYears: [...input.result.includedYears].sort((a, b) => a.year - b.year),
    excludedYears: [...input.result.excludedYears].sort((a, b) => a.year - b.year),
    yearLinks: [...input.result.yearLinks].sort((a, b) => {
      if (a.sourceYear !== b.sourceYear) return a.sourceYear - b.sourceYear;
      return a.targetYear - b.targetYear;
    }),
  };
  const normalizedInput: ReadingComparisonMarkdownInput = {
    ...input,
    result: normalized,
  };
  const content =
    headerSection(normalizedInput) +
    filterCriteriaSection(normalized.filters) +
    overviewSection(normalizedInput) +
    includedYearsSection(normalizedInput) +
    excludedYearsSection(normalized) +
    recurringBooksSection(normalized, base) +
    overlapSection(normalized) +
    methodSection();

  const years = input.result.includedYears.map((y) => y.year);
  const firstYear = years.length ? Math.min(...years) : null;
  const latestYear = years.length ? Math.max(...years) : null;
  const filename = buildReadingComparisonMarkdownFilename({
    firstYear,
    latestYear,
    now: input.exportedAt,
  });

  const encoder = new TextEncoder();
  const byteLength = encoder.encode(content).length;

  return {
    content,
    filename,
    mimeType: READING_COMPARISON_MARKDOWN_MIME,
    byteLength,
    rangeLabel: input.rangeLabel,
    topBooksLimit: input.topBooksLimit,
    eraCount: input.result.includedYears.length,
    includedYearCount: input.result.summary.includedYearCount,
    excludedYearCount: input.result.summary.excludedYearCount,
    failedYearCount: input.failedYears.length,
  };
}

/**
 * Deterministic filename: ASCII only, ≤80 chars, no book titles,
 * authors, catalogIds or private data.
 */
export function buildReadingComparisonMarkdownFilename(
  args: ReadingComparisonMarkdownFilenameArgs,
): string {
  const datePart = formatDatePart(args.now);

  if (args.firstYear === null || args.latestYear === null) {
    const name = `${READING_COMPARISON_MARKDOWN_FILENAME_PREFIX}-empty-${datePart}.md`;
    return name.slice(0, READING_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH);
  }

  const name = `${READING_COMPARISON_MARKDOWN_FILENAME_PREFIX}-${args.firstYear}-to-${args.latestYear}-${datePart}.md`;
  return name.slice(0, READING_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH);
}

function formatDatePart(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * Lightweight validation: non-empty, finite byteLength, correct MIME,
 * no forbidden substrings, no private IDs, no raw JSON dumps, no
 * inference vocabulary.
 */
export function validateReadingComparisonMarkdown(
  result: ReadingComparisonMarkdownBuildResult,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof result.content !== "string" || result.content.length === 0) {
    errors.push("content missing");
  }
  if (result.byteLength <= 0) errors.push("byteLength missing");
  if (result.mimeType !== READING_COMPARISON_MARKDOWN_MIME) errors.push("mimeType wrong");
  if (!result.filename.endsWith(".md")) errors.push("filename not .md");
  if (result.filename.length > READING_COMPARISON_MARKDOWN_FILENAME_MAX_LENGTH) {
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
      "q=",
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
    ];
    for (const token of inference) {
      if (result.content.includes(token)) errors.push(`inference: ${token}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Trigger a browser-local download of the Markdown file. Purely
 * transient: creates Blob + Object URL + `<a download>` click, then
 * revokes the URL and removes the anchor. No console logging of the
 * content. No storage writes.
 */
export function triggerReadingComparisonMarkdownDownload(
  args: TriggerReadingComparisonMarkdownDownloadArgs,
): TriggerReadingComparisonMarkdownDownloadResult {
  const content = args.content;
  const filename = args.filename;
  const mimeType = READING_COMPARISON_MARKDOWN_MIME;
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
  const anchor: ReadingComparisonMarkdownAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener noreferrer",
    testId: "weread-reading-comparison-export-anchor",
  };

  let downloadTriggered = false;

  if (args.attachAnchor) {
    args.attachAnchor(anchor);
    downloadTriggered = true;
  } else {
    const doc = args.resolveDocument?.() ??
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