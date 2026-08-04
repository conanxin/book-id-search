/**
 * S27M-2 — Browser-local Markdown export for the WeRead reading-era
 * segmentation panel.
 *
 * Privacy contract:
 *   - NEVER embeds note text, note comment, markedText, wereadBookId,
 *     noteId, highlightId, chapterTitle, AI summary body, themes,
 *     token, q, Authorization, API key, private API URL, cache/request
 *     snapshot, or raw archive/era JSON.
 *   - Consumes only the already-computed `WereadReadingEraResult` and
 *     the public catalog fields it carries (title, author, publisher,
 *     publishYear, catalogId).
 *   - The only download-side browser API is the transient Blob URL on
 *     a temporary `<a download>` element; no localStorage,
 *     sessionStorage, IndexedDB, or server write.
 *   - No YAML frontmatter, no HTML, no Markdown third-party library,
 *     no dangerouslySetInnerHTML, no raw JSON dump.
 *
 * All formatting is pure. `triggerReadingEraMarkdownDownload` is the
 * only DOM-touching function; it revokes the Blob URL immediately and
 * never logs the full Markdown content.
 */

import type {
  ReadingEra,
  ReadingEraBoundary,
  ReadingEraSegmentationMode,
  WereadReadingEraResult,
} from "./wereadReadingEraModel";

// ---------- public API ----------

export type ReadingEraRangeLabel = "最近5年" | "最近10年" | "全部";
export type ReadingEraTopBooksLimit = 6 | 12 | 18;

export interface ReadingEraMarkdownInput {
  result: WereadReadingEraResult;
  rangeLabel: ReadingEraRangeLabel;
  topBooksLimit: ReadingEraTopBooksLimit;
  failedYears: number[];
  exportedAt: Date;
  siteBaseUrl?: string;
}

export interface ReadingEraMarkdownBuildResult {
  content: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  rangeLabel: ReadingEraRangeLabel;
  topBooksLimit: ReadingEraTopBooksLimit;
  eraCount: number;
  failedYearCount: number;
}

export interface ReadingEraMarkdownFilenameArgs {
  mode: ReadingEraSegmentationMode;
  firstYear: number | null;
  latestYear: number | null;
  now: Date;
}

export interface ReadingEraMarkdownAnchorDescriptor {
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

export interface TriggerReadingEraMarkdownDownloadArgs {
  content: string;
  filename: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  attachAnchor?: (anchor: ReadingEraMarkdownAnchorDescriptor) => void;
  resolveDocument?: () => DocumentLike | null;
}

export interface TriggerReadingEraMarkdownDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const READING_ERA_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const READING_ERA_MARKDOWN_SITE_BASE_URL = "https://books.conanxin.com";
export const READING_ERA_MARKDOWN_FILENAME_PREFIX = "weread-reading-eras";
export const READING_ERA_MARKDOWN_FILENAME_MAX_LENGTH = 80;

export const READING_ERA_MARKDOWN_PRIVACY_NOTE =
  "隐私说明：本文件由用户主动在当前浏览器中生成，包含公共书目信息和个人阅读统计，请自行妥善保存。";

export const READING_ERA_MARKDOWN_INTERPRETATION_NOTE =
  "解释边界：阶段只依据记录数量、活跃月份、年份中断和当前 Top N 榜单重合进行描述性分组，不代表兴趣、能力或阅读质量发生变化。";

export const READING_ERA_MARKDOWN_COMPLETENESS_NOTE =
  "完整性提示：本次有 N 个年份暂时加载失败，阶段划分只基于成功加载的年份。";

export const READING_ERA_MARKDOWN_DATA_INTEGRITY_NOTE =
  "数据完整性：所有目标年份均已成功加载。";

export const READING_ERA_MARKDOWN_EMPTY_NOTE =
  "当前暂无成功加载的年度数据，无法生成阅读阶段。";

export const READING_ERA_MARKDOWN_SINGLE_YEAR_NOTE =
  "当前只有一个成功加载年份，无法比较相邻年份。";

export const READING_ERA_MARKDOWN_RECURRING_SCOPE_NOTE =
  "本节只统计该阶段内至少两个年份进入当前 Top N 榜单的公共书目，不代表完整阅读历史或长期偏好。";

export const READING_ERA_MARKDOWN_NO_RECURRING_NOTE =
  "当前 Top N 口径下，本阶段暂无跨多个年份重复进入榜单的公共书目。";

export const READING_ERA_MARKDOWN_NO_BOUNDARY_NOTE =
  "当前模式下，成功加载的年份被归入同一个阶段。";

export const READING_ERA_MARKDOWN_METHOD_NOTES = [
  "只比较相邻年份。",
  "年份中断必定形成边界。",
  "阅读记录变化需要同时满足比例和绝对差阈值。",
  "活跃月份变化只依据月份数量差。",
  "Top N 变化只依据公共书目榜单重合率。",
  "自动阶段模式中，非年份中断原因的总分达到阈值才分段。",
  "仅按年份中断模式忽略其他统计变化。",
  "单一年份阶段可能依据确定性规则与相邻阶段合并。",
  "阶段结果受当前年份范围和 Top N 口径影响。",
  "本文件不分析主题、类别、个人内在状态、兴趣或阅读质量。",
  "本文件未读取笔记正文。",
  "本文件未调用外部 AI。",
  "本文件未上传或保存到服务器。",
];

export const READING_ERA_BOUNDARY_REASON_LABELS: Readonly<
  Record<string, string>
> = {
  year_gap: "年份存在中断",
  activity_shift: "阅读记录数量变化较大",
  active_month_shift: "活跃月份数量变化较大",
  top_list_shift: "相邻年度 Top N 榜单重合较低",
};

export const READING_ERA_MODE_LABELS: Readonly<Record<ReadingEraSegmentationMode, string>> = {
  automatic: "自动阶段",
  gaps_only: "仅按年份中断",
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

export function escapeReadingEraMarkdownInline(input: unknown): string {
  if (input === null || input === undefined) return "";
  return escapeInlineMeta(stripControlAndCollapse(String(input)));
}

export function escapeReadingEraMarkdownTableCell(input: unknown): string {
  if (input === null || input === undefined) return "—";
  const cleaned = stripControlAndCollapse(String(input));
  if (!cleaned) return "—";
  const PIPE_SENTINEL = "\u0001";
  const marked = cleaned.replace(/\|/g, PIPE_SENTINEL);
  const metaEscaped = escapeInlineMeta(marked);
  return metaEscaped.split(PIPE_SENTINEL).join("\\|");
}

export function sanitizeReadingEraMarkdownText(input: unknown): string {
  return escapeReadingEraMarkdownInline(input);
}

export function formatReadingEraMarkdownDate(input: Date): string {
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) return "—";
  const y = input.getFullYear();
  const m = String(input.getMonth() + 1).padStart(2, "0");
  const d = String(input.getDate()).padStart(2, "0");
  const hh = String(input.getHours()).padStart(2, "0");
  const mm = String(input.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function formatReadingEraYearRange(firstYear: number | null, latestYear: number | null): string {
  if (firstYear === null || latestYear === null) return "暂无年份";
  if (firstYear === latestYear) return `${firstYear}—${latestYear}`;
  return `${firstYear}—${latestYear}`;
}

export function formatReadingEraMode(mode: ReadingEraSegmentationMode): string {
  return READING_ERA_MODE_LABELS[mode] ?? "自动阶段";
}

export function formatReadingEraBoundaryReasons(boundary: ReadingEraBoundary): string {
  const labels = boundary.reasons
    .map((reason) => READING_ERA_BOUNDARY_REASON_LABELS[reason])
    .filter(Boolean);
  if (labels.length === 0) return "统计发生变化";
  return labels.join("；");
}

export function formatReadingEraTopNLabel(limit: ReadingEraTopBooksLimit): string {
  return `各年度 Top ${limit}`;
}

export function formatReadingEraRangeLabel(label: ReadingEraRangeLabel): string {
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

export function formatReadingEraYearPlain(year: number | null): string {
  if (year === null || !Number.isFinite(year)) return "—";
  return String(year);
}

export function formatReadingEraInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

export function formatReadingEraAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

export function formatReadingEraPeakYear(year: number | null, records: number): string {
  if (year === null || !Number.isFinite(records)) return "—";
  return `${formatReadingEraYearPlain(year)}（${formatReadingEraInteger(records)}）`;
}

export function formatReadingEraRank(rank: number): string {
  if (!Number.isFinite(rank) || rank < 1) return "—";
  return `第 ${rank}`;
}

// ---------- content construction ----------

function siteBaseUrl(input?: string): string {
  if (typeof input === "string" && input.trim()) return input.trim().replace(/\/$/, "");
  return READING_ERA_MARKDOWN_SITE_BASE_URL;
}

function bookPublicUrl(catalogId: string, baseUrl: string): string {
  return `${baseUrl}/books/${encodeURIComponent(catalogId)}`;
}

function headerSection(input: ReadingEraMarkdownInput): string {
  const result = input.result;
  const years = result.eras.flatMap((e) => e.years);
  const firstYear = years.length ? Math.min(...years) : null;
  const latestYear = years.length ? Math.max(...years) : null;
  const failedCount = input.failedYears.length;
  const successCount = result.meta.yearsUsed;

  const lines: string[] = [];
  lines.push("# 阅读阶段档案");
  lines.push("");
  lines.push(`- 档案年份：${formatReadingEraYearRange(firstYear, latestYear)}`);
  lines.push(`- 当前长期档案范围：${formatReadingEraRangeLabel(input.rangeLabel)}`);
  lines.push(`- 高互动书目口径：${formatReadingEraTopNLabel(input.topBooksLimit)}`);
  lines.push(`- 阶段划分模式：${formatReadingEraMode(result.meta.mode)}`);
  lines.push(`- 成功加载年份：${successCount}`);
  lines.push(`- 暂时失败年份：${failedCount}`);
  lines.push(`- 阶段数量：${result.eras.length}`);
  lines.push(`- 导出时间：${formatReadingEraMarkdownDate(input.exportedAt)}`);
  lines.push(`- 生成方式：book-id-search 浏览器本地生成`);
  lines.push(`- 保存状态：未上传服务器`);
  lines.push("");
  lines.push(`> ${READING_ERA_MARKDOWN_PRIVACY_NOTE}`);
  lines.push("");
  lines.push(`> ${READING_ERA_MARKDOWN_INTERPRETATION_NOTE}`);
  lines.push("");

  if (failedCount > 0) {
    lines.push(
      `> ${READING_ERA_MARKDOWN_COMPLETENESS_NOTE.replace("N", String(failedCount))}`,
    );
    lines.push("");
  } else if (successCount > 0) {
    lines.push(`> ${READING_ERA_MARKDOWN_DATA_INTEGRITY_NOTE}`);
    lines.push("");
  }

  return lines.join("\n");
}

function overviewSection(result: WereadReadingEraResult): string {
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 阶段总览");
  lines.push("--------------------------------------------------");
  lines.push("");

  if (result.eras.length === 0) {
    lines.push(READING_ERA_MARKDOWN_EMPTY_NOTE);
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| 阶段 | 年份 | 年份数 | 阅读记录 | 活跃月份 | 年均记录 | 高峰年份 |");
  lines.push("|---:|---|---:|---:|---:|---:|---|");
  result.eras.forEach((era, idx) => {
    const yearsStr =
      era.startYear === era.endYear
        ? `${era.startYear}`
        : `${era.startYear}—${era.endYear}`;
    lines.push(
      [
        `阶段 ${idx + 1}`,
        escapeReadingEraMarkdownTableCell(yearsStr),
        escapeReadingEraMarkdownTableCell(String(era.years.length)),
        escapeReadingEraMarkdownTableCell(formatReadingEraInteger(era.totalRecords)),
        escapeReadingEraMarkdownTableCell(formatReadingEraInteger(era.totalActiveMonths)),
        escapeReadingEraMarkdownTableCell(formatReadingEraAverage(era.averageRecordsPerYear)),
        escapeReadingEraMarkdownTableCell(formatReadingEraPeakYear(era.peakYear, era.peakYearRecords)),
      ].join("|"),
    );
  });
  lines.push("");
  return lines.join("\n");
}

function detailSection(result: WereadReadingEraResult, siteBase: string): string {
  const lines: string[] = [];

  if (result.eras.length === 0) {
    return lines.join("\n");
  }

  lines.push("--------------------------------------------------");
  lines.push("## 阶段详情");
  lines.push("--------------------------------------------------");
  lines.push("");

  if (result.eras.length === 1 && result.meta.yearsUsed === 1) {
    const era = result.eras[0];
    lines.push(`### 阶段 1：${formatReadingEraYearPlain(era.startYear)}年`);
    lines.push("");
    lines.push(`- 包含年份：${formatReadingEraYearPlain(era.startYear)}`);
    lines.push(`- 年份数量：${formatReadingEraInteger(era.years.length)}`);
    lines.push(`- 阅读记录合计：${formatReadingEraInteger(era.totalRecords)}`);
    lines.push(`- 活跃月份合计：${formatReadingEraInteger(era.totalActiveMonths)}`);
    lines.push(`- 年均记录：${formatReadingEraAverage(era.averageRecordsPerYear)}`);
    lines.push(`- 高峰年份：${formatReadingEraPeakYear(era.peakYear, era.peakYearRecords)}`);
    lines.push("");
    lines.push(`> ${READING_ERA_MARKDOWN_SINGLE_YEAR_NOTE}`);
    lines.push("");
  } else {
    result.eras.forEach((era, idx) => {
      const yearsStr =
        era.startYear === era.endYear
          ? `${formatReadingEraYearPlain(era.startYear)}年`
          : `${formatReadingEraYearPlain(era.startYear)}—${formatReadingEraYearPlain(era.endYear)}年`;
      lines.push(`### 阶段 ${idx + 1}：${yearsStr}`);
      lines.push("");
      lines.push(`- 包含年份：${era.years.map(formatReadingEraYearPlain).join("、")}`);
      lines.push(`- 年份数量：${formatReadingEraInteger(era.years.length)}`);
      lines.push(`- 阅读记录合计：${formatReadingEraInteger(era.totalRecords)}`);
      lines.push(`- 活跃月份合计：${formatReadingEraInteger(era.totalActiveMonths)}`);
      lines.push(`- 年均记录：${formatReadingEraAverage(era.averageRecordsPerYear)}`);
      lines.push(`- 高峰年份：${formatReadingEraPeakYear(era.peakYear, era.peakYearRecords)}`);
      lines.push("");

      if (idx > 0) {
        const boundary = era.boundaryBefore;
        if (boundary) {
          lines.push("#### 与上一阶段的分界");
          lines.push("");
          lines.push(`- 分界位置：${formatReadingEraYearPlain(boundary.afterYear)} → ${formatReadingEraYearPlain(boundary.beforeYear)}`);
          lines.push(`- 分界得分：${formatReadingEraInteger(boundary.score)}`);
          lines.push(`- 分界依据：`);
          lines.push(
            formatReadingEraBoundaryReasons(boundary)
              .split("；")
              .map((line) => `  - ${line}`)
              .join("\n"),
          );
          lines.push("");
        }
      }

      lines.push(`--------------------------------------------------`);
      lines.push(`### 阶段内重复进入 Top N 的书目`);
      lines.push(`--------------------------------------------------`);
      lines.push("");
      lines.push(`> ${READING_ERA_MARKDOWN_RECURRING_SCOPE_NOTE}`);
      lines.push("");

      if (era.recurringBooks.length === 0) {
        lines.push(READING_ERA_MARKDOWN_NO_RECURRING_NOTE);
        lines.push("");
      } else {
        era.recurringBooks.forEach((book, bidx) => {
          const author = book.author ? String(book.author) : "";
          const publisher = book.publisher ? String(book.publisher) : "";
          const publishYear = book.publishYear ? String(book.publishYear) : "";
          const pubParts = [publisher, publishYear].filter(Boolean);
          const publicationInfo = pubParts.join("，") || "";
          const years = Array.from(book.years).sort((a, b) => a - b);
          const bestRank = book.bestRank;
          const latestYear = book.latestYear;

          lines.push(`#### ${bidx + 1}. 《${escapeReadingEraMarkdownInline(book.title)}》`);
          lines.push("");
          if (author) lines.push(`- 作者：${escapeReadingEraMarkdownInline(author)}`);
          if (publicationInfo) lines.push(`- 出版信息：${escapeReadingEraMarkdownInline(publicationInfo)}`);
          lines.push(`- 进入榜单年份：${years.map(formatReadingEraYearPlain).join("、")}`);
          lines.push(`- 进入榜单次数：${formatReadingEraInteger(years.length)} 年`);
          lines.push(`- 最佳排名：${formatReadingEraRank(bestRank)}`);
          lines.push(`- 最新上榜年份：${formatReadingEraYearPlain(latestYear)}`);
          lines.push(`- 书目页面：${bookPublicUrl(book.catalogId, siteBase)}`);
          lines.push("");
        });
      }
    });
  }

  return lines.join("\n");
}

function boundarySection(result: WereadReadingEraResult): string {
  const lines: string[] = [];
  lines.push("--------------------------------------------------");
  lines.push("## 阶段边界一览");
  lines.push("--------------------------------------------------");
  lines.push("");

  if (result.boundaries.length === 0) {
    lines.push(READING_ERA_MARKDOWN_NO_BOUNDARY_NOTE);
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| 分界 | 得分 | 分界依据 |");
  lines.push("|---|---:|---|");
  result.boundaries.forEach((boundary) => {
    lines.push(
      [
        `${formatReadingEraYearPlain(boundary.afterYear)} → ${formatReadingEraYearPlain(boundary.beforeYear)}`,
        escapeReadingEraMarkdownTableCell(String(boundary.score)),
        escapeReadingEraMarkdownTableCell(formatReadingEraBoundaryReasons(boundary)),
      ].join("|"),
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
  READING_ERA_MARKDOWN_METHOD_NOTES.forEach((note) => {
    lines.push(`- ${note}`);
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the full Markdown content and metadata for the reading-era export.
 */
export function buildReadingEraMarkdown(
  input: ReadingEraMarkdownInput,
): ReadingEraMarkdownBuildResult {
  const base = siteBaseUrl(input.siteBaseUrl);
  const content =
    headerSection(input) +
    overviewSection(input.result) +
    detailSection(input.result, base) +
    boundarySection(input.result) +
    methodSection();

  const years = input.result.eras.flatMap((e) => e.years);
  const firstYear = years.length ? Math.min(...years) : null;
  const latestYear = years.length ? Math.max(...years) : null;
  const filename = buildReadingEraMarkdownFilename({
    mode: input.result.meta.mode,
    firstYear,
    latestYear,
    now: input.exportedAt,
  });

  const encoder = new TextEncoder();
  const byteLength = encoder.encode(content).length;

  return {
    content,
    filename,
    mimeType: READING_ERA_MARKDOWN_MIME,
    byteLength,
    rangeLabel: input.rangeLabel,
    topBooksLimit: input.topBooksLimit,
    eraCount: input.result.eras.length,
    failedYearCount: input.failedYears.length,
  };
}

/**
 * Deterministic filename: ASCII only, ≤80 chars, no book titles,
 * authors, catalogIds or private data.
 */
export function buildReadingEraMarkdownFilename(
  args: ReadingEraMarkdownFilenameArgs,
): string {
  const modePart = args.mode === "gaps_only" ? "gaps-only" : "automatic";
  const datePart = formatDatePart(args.now);

  if (args.firstYear === null || args.latestYear === null) {
    const name = `${READING_ERA_MARKDOWN_FILENAME_PREFIX}-${modePart}-empty-${datePart}.md`;
    return name.slice(0, READING_ERA_MARKDOWN_FILENAME_MAX_LENGTH);
  }

  const name = `${READING_ERA_MARKDOWN_FILENAME_PREFIX}-${modePart}-${args.firstYear}-to-${args.latestYear}-${datePart}.md`;
  return name.slice(0, READING_ERA_MARKDOWN_FILENAME_MAX_LENGTH);
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
 * psychological-inference vocabulary.
 */
export function validateReadingEraMarkdown(
  result: ReadingEraMarkdownBuildResult,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof result.content !== "string" || result.content.length === 0) {
    errors.push("content missing");
  }
  if (result.byteLength <= 0) errors.push("byteLength missing");
  if (result.mimeType !== READING_ERA_MARKDOWN_MIME) errors.push("mimeType wrong");
  if (!result.filename.endsWith(".md")) errors.push("filename not .md");
  if (result.filename.length > READING_ERA_MARKDOWN_FILENAME_MAX_LENGTH) {
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
      "{",
      "}",
    ];
    for (const token of forbidden) {
      if (lower.includes(token)) errors.push(`forbidden token: ${token}`);
    }

    const psych = [
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
    for (const token of psych) {
      if (result.content.includes(token)) errors.push(`psychological inference: ${token}`);
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
export function triggerReadingEraMarkdownDownload(
  args: TriggerReadingEraMarkdownDownloadArgs,
): TriggerReadingEraMarkdownDownloadResult {
  const content = args.content;
  const filename = args.filename;
  const mimeType = READING_ERA_MARKDOWN_MIME;
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
  const anchor: ReadingEraMarkdownAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener noreferrer",
    testId: "weread-reading-era-export-anchor",
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

  // Always revoke the URL on the next tick so the temporary blob can
  // be garbage-collected, even if the click didn't actually start a
  // download (e.g. in some headless environments).
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
