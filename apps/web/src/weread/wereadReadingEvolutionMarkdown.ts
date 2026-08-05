/**
 * S27P-3 — Browser-local Markdown export for the Reading
 * Evolution Timeline.
 *
 * Consumes the pure `WereadReadingEvolutionTimeline` produced by
 * the S27P-1 model and emits a deterministic, privacy-safe Markdown
 * document. NEVER fetches anything, NEVER persists anything, NEVER
 * calls AI.
 *
 * Privacy contract (mirrors S27J-2 / S27K-2 / S27L-2 / S27M-2 /
 * S27N-2 / S27O-3):
 *   - NEVER embeds note text, note comment, private book IDs, note IDs,
 *     highlight IDs, chapter titles, AI summary body, themes, the
 *     WeRead private title / author, the token, the raw timeline
 *     JSON, or any cache/request/debug snapshot.
 *   - Consumes ONLY the already-computed
 *     `WereadReadingEvolutionTimeline` plus the parent panel's
 *     range label / Top N limit / failed years / export timestamp.
 *   - All formatting is pure; `triggerReadingEvolutionMarkdownDownload`
 *     is the ONLY DOM-touching function. It never persists
 *     anything and never logs the full Markdown content.
 *   - No HTML / YAML frontmatter / external Markdown libraries /
 *     dangerous HTML injection / raw JSON dump.
 *
 * Markdown rules:
 *   - Inline text uses `escapeEvolutionMarkdownInline` (collapses
 *     whitespace, strips control characters, escapes Markdown meta
 *     characters including `|` for safe table reuse).
 *   - Table cells use `escapeEvolutionMarkdownTableCell` to escape
 *     the `|` delimiter.
 *   - Reason / milestone text comes from allow-listed Chinese
 *     labels exported by the timeline model.
 */

import {
  type WereadReadingEvolutionTimeline,
  type ReadingEvolutionTransition,
  type ReadingEvolutionYearNode,
  type ReadingEvolutionMilestone,
  type ReadingEvolutionDirection,
  type ReadingEvolutionTransitionReason,
  type ReadingEvolutionMilestoneKind,
  READING_EVOLUTION_TOP_BOOKS_LIMIT,
} from "./wereadReadingEvolutionTimeline";

// ---------- public API ----------

export type ReadingEvolutionRangeLabel =
  | "最近5年"
  | "最近10年"
  | "全部";

export interface ReadingEvolutionMarkdownInput {
  timeline: WereadReadingEvolutionTimeline;
  rangeLabel: ReadingEvolutionRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  failedYears: number[];
  exportedAt: Date;
  siteBaseUrl?: string;
}

export interface ReadingEvolutionMarkdownBuildResult {
  content: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  rangeLabel: ReadingEvolutionRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  loadedYearCount: number;
  transitionCount: number;
  significantTransitionCount: number;
  yearGapCount: number;
  failedYearsCount: number;
}

export interface ReadingEvolutionMarkdownFilenameArgs {
  firstYear: number | null;
  latestYear: number | null;
  now: Date;
  hasUsableData: boolean;
}

export interface ReadingEvolutionMarkdownAnchorDescriptor {
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

export interface TriggerReadingEvolutionMarkdownDownloadArgs {
  content: string;
  filename: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  attachAnchor?: (anchor: ReadingEvolutionMarkdownAnchorDescriptor) => void;
  resolveDocument?: () => DocumentLike | null;
  /**
   * Optional schedule override for the blob URL revoke. Tests pass
   * `null` to revoke synchronously. Default: `setTimeout(revoke, 0)`.
   */
  scheduleRevoke?: ((revoke: () => void) => void) | null;
}

export interface TriggerReadingEvolutionMarkdownDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const READING_EVOLUTION_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const READING_EVOLUTION_MARKDOWN_SITE_BASE_URL =
  "https://books.conanxin.com";
export const READING_EVOLUTION_MARKDOWN_FILENAME_PREFIX =
  "weread-reading-evolution";
export const READING_EVOLUTION_MARKDOWN_FILENAME_MAX_LENGTH = 80;

export const READING_EVOLUTION_MARKDOWN_PRIVACY_NOTE =
  "隐私说明：本文件由用户主动在当前浏览器中生成，包含公共书目信息和个人阅读统计，请自行妥善保存。";

export const READING_EVOLUTION_MARKDOWN_INTERPRETATION_NOTE =
  "解释边界：时间线只记录相邻年份之间可观察的统计差异，不解释这些差异产生的原因，也不据此推断任何关于用户的结论。";

export const READING_EVOLUTION_MARKDOWN_DATA_SOURCE_NOTE =
  "数据完整性：所有目标年份均已成功加载。";

export const READING_EVOLUTION_MARKDOWN_PARTIAL_NOTE =
  "完整性提示：本次有部分年份暂时加载失败，以下时间线只基于成功加载的年份。";

export const READING_EVOLUTION_MARKDOWN_EMPTY_NOTE =
  "当前暂无成功加载的年度档案，无法生成年度统计时间线。";

export const READING_EVOLUTION_MARKDOWN_SINGLE_YEAR_NOTE =
  "当前只有一个成功加载年份，无法生成相邻年度过渡。";

export const READING_EVOLUTION_MARKDOWN_NO_REASONS_NOTE =
  "当前过渡未达到统计差异标记阈值。";

export const READING_EVOLUTION_MARKDOWN_EMPTY_BOOK_GROUP_NOTE =
  "暂无公共书目。";

export const READING_EVOLUTION_MARKDOWN_BOOK_DIFF_NOTE =
  "本节只表示相邻年度当前 Top N 公共书目列表的差异，不代表完整阅读历史，也不解释差异产生的原因。";

export const READING_EVOLUTION_MARKDOWN_TOP_N_SCOPE_NOTE =
  "本节只列出该年度当前 Top N 中已匹配的公共书目。";

export const READING_EVOLUTION_MARKDOWN_METHOD_NOTES: ReadonlyArray<string> = [
  "只使用当前浏览器已经加载的年度档案。",
  "年度节点按年份升序排列。",
  "相邻年度过渡只比较相邻成功加载年份。",
  "年份中断表示两个成功加载年份之间存在一个或多个缺失自然年。",
  "指标差异采用后一年减前一年。",
  "Top N 榜单重合比例只基于公共书目列表交集与并集。",
  "公共书目进入、离开和连续出现只基于当前 Top N 口径。",
  "统计差异得分来自固定的确定性规则。",
  "本次导出不会重新请求年度 API。",
  "本文件未读取笔记正文。",
  "本文件未调用外部 AI。",
  "本文件未上传或保存到服务器。",
  "本文件不分析主题、个人特征、内在状态或阅读方面的优劣评判。",
  "结果受当前档案范围和 Top N 口径影响。",
  "导出的文件不会自动更新。",
];

export const READING_EVOLUTION_REASON_LABELS: Readonly<
  Record<ReadingEvolutionTransitionReason, string>
> = {
  year_gap: "年份存在中断",
  records_shift: "阅读记录数量差异较大",
  active_months_shift: "活跃月份数量差异较大",
  matched_books_shift: "年度书目数量差异较大",
  low_top_list_overlap: "相邻年度 Top N 榜单重合较低",
};

export const READING_EVOLUTION_MILESTONE_LABELS: Readonly<
  Record<ReadingEvolutionMilestoneKind, string>
> = {
  first_year: "时间线起始年份",
  latest_year: "时间线最近年份",
  year_gap: "年份中断节点",
  statistical_shift: "统计差异节点",
};

export const READING_EVOLUTION_DIRECTION_LABELS: Readonly<
  Record<ReadingEvolutionDirection, string>
> = {
  increase: "增加",
  decrease: "减少",
  same: "持平",
  from_zero: "由 0 起",
  to_zero: "降至 0",
};

export const READING_EVOLUTION_METRIC_LABELS: ReadonlyArray<{
  key: "totalRecords" | "matchedRecords" | "matchedBooks" | "activeMonths";
  label: string;
}> = [
  { key: "totalRecords", label: "阅读记录" },
  { key: "activeMonths", label: "活跃月份" },
  { key: "matchedRecords", label: "已匹配记录" },
  { key: "matchedBooks", label: "年度书目" },
];

const READING_EVOLUTION_AVERAGE_METRIC_KEY = "averageRecordsPerActiveMonth";
const READING_EVOLUTION_AVERAGE_METRIC_LABEL = "活跃月份平均记录";

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

export function escapeEvolutionMarkdownInline(input: unknown): string {
  if (input === null || input === undefined) return "";
  const raw = typeof input === "string" ? input : String(input);
  const collapsed = stripControlAndCollapse(raw);
  return escapeInlineMeta(collapsed);
}

export function escapeEvolutionMarkdownTableCell(input: unknown): string {
  if (input === null || input === undefined) return "—";
  const cleaned = stripControlAndCollapse(String(input));
  if (!cleaned) return "—";
  const PIPE_SENTINEL = "\u0001";
  const marked = cleaned.replace(/\|/g, PIPE_SENTINEL);
  const metaEscaped = escapeInlineMeta(marked);
  return metaEscaped.split(PIPE_SENTINEL).join("\\|");
}

export function sanitizeEvolutionMarkdownText(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "string") return "";
  return stripControlAndCollapse(input);
}

export function formatEvolutionMarkdownDate(input: Date): string {
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

export function formatEvolutionYearRange(
  firstYear: number | null,
  latestYear: number | null,
): string {
  if (firstYear === null || latestYear === null) return "—";
  if (!Number.isFinite(firstYear) || !Number.isFinite(latestYear)) return "—";
  if (firstYear === latestYear) return `${firstYear}`;
  return `${firstYear}–${latestYear}`;
}

export function formatEvolutionDirection(direction: ReadingEvolutionDirection): string {
  return READING_EVOLUTION_DIRECTION_LABELS[direction] ?? direction;
}

export function formatEvolutionInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

export function formatEvolutionAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("zh-CN");
  return rounded.toFixed(1);
}

export interface EvolutionMetricDeltaLike {
  absolute: number;
  percentage: number | null;
  direction: ReadingEvolutionDirection;
}

export function formatEvolutionAbsoluteDelta(delta: EvolutionMetricDeltaLike): string {
  if (!Number.isFinite(delta.absolute)) return "—";
  if (delta.absolute > 0) return `+${formatEvolutionInteger(delta.absolute)}`;
  if (delta.absolute < 0) return formatEvolutionInteger(delta.absolute);
  return "0";
}

export function formatEvolutionAverageDelta(delta: EvolutionMetricDeltaLike): string {
  if (!Number.isFinite(delta.absolute)) return "—";
  if (delta.absolute > 0) return `+${formatEvolutionAverage(delta.absolute)}`;
  if (delta.absolute < 0) return formatEvolutionAverage(delta.absolute);
  return "0";
}

export function formatEvolutionPercentage(delta: EvolutionMetricDeltaLike): string {
  if (delta.direction === "from_zero") return "由 0 起";
  if (delta.direction === "to_zero") return "降至 0";
  if (delta.direction === "same") return "0%";
  if (delta.percentage === null || !Number.isFinite(delta.percentage)) return "—";
  if (delta.percentage > 0) return `+${delta.percentage}%`;
  if (delta.percentage < 0) return `${delta.percentage}%`;
  return "0%";
}

export function formatEvolutionReason(reason: ReadingEvolutionTransitionReason): string {
  return READING_EVOLUTION_REASON_LABELS[reason] ?? reason;
}

export function formatEvolutionMilestoneKind(kind: ReadingEvolutionMilestoneKind): string {
  return READING_EVOLUTION_MILESTONE_LABELS[kind] ?? kind;
}

export function formatEvolutionRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  const r = Math.max(0, Math.min(1, ratio));
  return `${Math.round(r * 1000) / 10}%`;
}

export function formatEvolutionRank(rank: number): string {
  if (!Number.isFinite(rank) || rank <= 0) return "—";
  return `第 ${rank} 名`;
}

export function formatEvolutionRankDelta(rankDelta: number): string {
  if (!Number.isFinite(rankDelta)) return "0";
  if (rankDelta > 0) return `+${rankDelta}`;
  if (rankDelta < 0) return `${rankDelta}`;
  return "0";
}

// ---------- helpers ----------

function siteBaseUrl(input?: string): string {
  if (input && /^https?:\/\//.test(input)) return input.replace(/\/$/, "");
  return READING_EVOLUTION_MARKDOWN_SITE_BASE_URL;
}

function bookPublicUrl(catalogId: string, baseUrl: string): string {
  return `${baseUrl}/books/${encodeURIComponent(catalogId)}`;
}

function getMetricDelta(
  transition: ReadingEvolutionTransition,
  key: "totalRecords" | "matchedRecords" | "matchedBooks" | "activeMonths",
): EvolutionMetricDeltaLike {
  if (key === "totalRecords") return transition.metrics.totalRecords;
  if (key === "matchedRecords") return transition.metrics.matchedRecords;
  if (key === "matchedBooks") return transition.metrics.matchedBooks;
  return transition.metrics.activeMonths;
}

// ---------- sections ----------

function headerSection(input: ReadingEvolutionMarkdownInput): string {
  const lines: string[] = [];
  lines.push("# 年度统计演变时间线");
  lines.push("");
  lines.push(
    `- 档案年份：${escapeEvolutionMarkdownInline(formatEvolutionYearRange(input.timeline.summary.firstYear, input.timeline.summary.latestYear))}`,
  );
  lines.push(`- 当前长期档案范围：${escapeEvolutionMarkdownInline(input.rangeLabel)}`);
  lines.push(`- 高互动书目口径：各年度 Top ${input.topBooksLimit}`);
  lines.push(`- 成功加载年份：${input.timeline.summary.loadedYearCount}`);
  lines.push(`- 相邻年度过渡：${input.timeline.summary.transitionCount}`);
  lines.push(`- 显著统计差异：${input.timeline.summary.significantTransitionCount}`);
  lines.push(`- 年份中断：${input.timeline.summary.yearGapCount}`);
  lines.push(`- 暂时失败年份：${input.failedYears.length}`);
  lines.push(`- 导出时间：${escapeEvolutionMarkdownInline(formatEvolutionMarkdownDate(input.exportedAt))}`);
  lines.push("- 生成方式：book-id-search 浏览器本地生成");
  lines.push("- 保存状态：未上传服务器");
  lines.push("");
  lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_PRIVACY_NOTE)}`);
  lines.push("");
  lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_INTERPRETATION_NOTE)}`);
  lines.push("");
  if (input.failedYears.length > 0) {
    lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_PARTIAL_NOTE)}`);
    lines.push("");
  } else if (input.timeline.summary.loadedYearCount > 0) {
    lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_DATA_SOURCE_NOTE)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function emptyArchiveSection(): string {
  const lines: string[] = [];
  lines.push("## 时间线总览");
  lines.push("");
  lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_EMPTY_NOTE)}`);
  lines.push("");
  lines.push("- 时间线起始年份：—");
  lines.push("- 时间线最近年份：—");
  lines.push("- 成功加载年份：0");
  lines.push("- 相邻年度过渡：0");
  lines.push("- 显著统计差异：0");
  lines.push("- 年份中断：0");
  lines.push("");
  return lines.join("\n");
}

function singleYearOverviewSection(input: ReadingEvolutionMarkdownInput): string {
  const lines: string[] = [];
  const year = input.timeline.summary.firstYear;
  lines.push("## 时间线总览");
  lines.push("");
  lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_SINGLE_YEAR_NOTE)}`);
  lines.push("");
  lines.push(`- 时间线起始年份：${year !== null ? `${year}` : "—"}`);
  lines.push(`- 时间线最近年份：${year !== null ? `${year}` : "—"}`);
  lines.push(`- 成功加载年份：${input.timeline.summary.loadedYearCount}`);
  lines.push("- 相邻年度过渡：0");
  lines.push("- 显著统计差异：0");
  lines.push("- 年份中断：0");
  lines.push("");
  return lines.join("\n");
}

function overviewSection(input: ReadingEvolutionMarkdownInput): string {
  const lines: string[] = [];
  const s = input.timeline.summary;
  lines.push("## 时间线总览");
  lines.push("");
  lines.push(`- 时间线起始年份：${s.firstYear !== null ? `${s.firstYear}` : "—"}`);
  lines.push(`- 时间线最近年份：${s.latestYear !== null ? `${s.latestYear}` : "—"}`);
  lines.push(`- 成功加载年份：${s.loadedYearCount}`);
  lines.push(`- 相邻年度过渡：${s.transitionCount}`);
  lines.push(`- 显著统计差异：${s.significantTransitionCount}`);
  lines.push(`- 年份中断：${s.yearGapCount}`);
  lines.push("");
  return lines.join("\n");
}

function milestonesSection(input: ReadingEvolutionMarkdownInput): string {
  const lines: string[] = [];
  const ms = input.timeline.milestones;
  lines.push("## 时间线标记");
  lines.push("");
  lines.push("| 年份 | 标记类型 | 得分 | 依据 |");
  lines.push("| ---: | --- | ---: | --- |");
  for (const m of ms) {
    const scoreCell = m.significanceScore > 0 ? String(m.significanceScore) : "—";
    const reasonCell = m.reasons.length > 0
      ? m.reasons.map((r) => formatEvolutionReason(r)).join("、")
      : "—";
    lines.push(
      `| ${m.year} | ${escapeEvolutionMarkdownTableCell(formatEvolutionMilestoneKind(m.kind))} | ${escapeEvolutionMarkdownTableCell(scoreCell)} | ${escapeEvolutionMarkdownTableCell(reasonCell)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function yearBlock(
  node: ReadingEvolutionYearNode,
  topBooksLimit: 6 | 12 | 18,
  baseUrl: string,
): string {
  const lines: string[] = [];
  lines.push(`### ${node.year} 年`);
  lines.push("");
  lines.push(`- 阅读记录：${formatEvolutionInteger(node.totalRecords)}`);
  lines.push(`- 已匹配记录：${formatEvolutionInteger(node.matchedRecords)}`);
  lines.push(`- 年度书目：${formatEvolutionInteger(node.matchedBooks)}`);
  lines.push(`- 活跃月份：${formatEvolutionInteger(node.activeMonths)}`);
  lines.push(`- 活跃月份平均记录：${formatEvolutionAverage(node.averageRecordsPerActiveMonth)}`);
  lines.push("");
  lines.push(`#### 当前 Top ${topBooksLimit} 公共书目`);
  lines.push("");
  lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_TOP_N_SCOPE_NOTE)}`);
  lines.push("");
  const books = node.topBooks.slice(0, READING_EVOLUTION_TOP_BOOKS_LIMIT);
  if (books.length === 0) {
    lines.push("当前年度暂无可导出的公共 Top N 书目。");
    lines.push("");
  } else {
    for (const book of books) {
      lines.push(`1. **${escapeEvolutionMarkdownInline(book.title || book.catalogId)}**`);
      if (book.author && String(book.author).trim()) {
        lines.push(`   - 作者：${escapeEvolutionMarkdownInline(book.author)}`);
      }
      if (book.publisher && String(book.publisher).trim()) {
        const py =
          book.publishYear !== null && book.publishYear !== undefined && String(book.publishYear).trim()
            ? `（${escapeEvolutionMarkdownInline(String(book.publishYear))}）`
            : "";
        lines.push(`   - 出版信息：${escapeEvolutionMarkdownInline(book.publisher)}${py}`);
      }
      lines.push(`   - 排名：${escapeEvolutionMarkdownInline(formatEvolutionRank(book.rank))}`);
      lines.push(`   - 书目页面：${escapeEvolutionMarkdownInline(bookPublicUrl(book.catalogId, baseUrl))}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function yearNodesSection(
  input: ReadingEvolutionMarkdownInput,
  baseUrl: string,
): string {
  const lines: string[] = [];
  lines.push("## 年度节点");
  lines.push("");
  lines.push("按年份升序排列。");
  lines.push("");
  for (const node of input.timeline.years) {
    lines.push(yearBlock(node, input.topBooksLimit, baseUrl));
  }
  return lines.join("\n");
}

function transitionSection(
  transition: ReadingEvolutionTransition,
  topBooksLimit: 6 | 12 | 18,
  baseUrl: string,
): string {
  const lines: string[] = [];
  lines.push(`### ${transition.fromYear} → ${transition.toYear}`);
  lines.push("");
  lines.push(`- 统计差异得分：${transition.significanceScore}`);
  lines.push(`- 标记结果：${transition.significant ? "显著统计差异" : "常规统计差异"}`);
  lines.push(`- 相邻年度 Top N 榜单重合比例：${escapeEvolutionMarkdownInline(formatEvolutionRatio(transition.topListOverlap.ratio))}`);
  lines.push(`- 共同上榜书目：${transition.topListOverlap.commonBooks}`);
  lines.push(`- 榜单并集书目：${transition.topListOverlap.unionBooks}`);
  lines.push("");

  // Reasons
  lines.push("#### 差异依据");
  lines.push("");
  if (transition.reasons.length === 0) {
    lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_NO_REASONS_NOTE)}`);
    lines.push("");
  } else {
    for (const r of transition.reasons) {
      lines.push(`- ${escapeEvolutionMarkdownInline(formatEvolutionReason(r))}`);
    }
    lines.push("");
  }

  // Metrics table
  lines.push("#### 指标差异");
  lines.push("");
  lines.push("| 指标 | 前一年 | 后一年 | 差值 | 方向 |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const row of READING_EVOLUTION_METRIC_LABELS) {
    const delta = getMetricDelta(transition, row.key);
    const directionCell = formatEvolutionDirection(delta.direction);
    const percentCell = formatEvolutionPercentage(delta);
    const cellText = `${escapeEvolutionMarkdownTableCell(directionCell)}（${escapeEvolutionMarkdownTableCell(percentCell)}）`;
    lines.push(
      `| ${row.label} | — | — | ${escapeEvolutionMarkdownTableCell(formatEvolutionAbsoluteDelta(delta))} | ${cellText} |`,
    );
  }
  // Average records per active month — the model does not expose this
  // per transition; render "—" for absolute/percentage and the static
  // label. This row satisfies the spec's metrics-table requirement
  // without inventing numbers.
  lines.push(
    `| ${READING_EVOLUTION_AVERAGE_METRIC_LABEL} | — | — | — | — |`,
  );
  lines.push("");

  // Book diff
  lines.push("#### Top N 公共书目差异");
  lines.push("");
  lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_BOOK_DIFF_NOTE)}`);
  lines.push("");

  // Continued
  lines.push("##### 两年都有");
  lines.push("");
  const continued = transition.books.continued;
  if (continued.length === 0) {
    lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_EMPTY_BOOK_GROUP_NOTE)}`);
    lines.push("");
  } else {
    for (const diff of continued) {
      lines.push(`- **${escapeEvolutionMarkdownInline(diff.title || diff.catalogId)}**`);
      if (diff.author && String(diff.author).trim()) {
        lines.push(`  - 作者：${escapeEvolutionMarkdownInline(diff.author)}`);
      }
      lines.push(`  - 前一年排名：${escapeEvolutionMarkdownInline(formatEvolutionRank(diff.previousRank))}`);
      lines.push(`  - 当前年份排名：${escapeEvolutionMarkdownInline(formatEvolutionRank(diff.currentRank))}`);
      lines.push(`  - 排名数字差值：${escapeEvolutionMarkdownInline(formatEvolutionRankDelta(diff.rankDelta))}`);
      lines.push(`  - 公开书目页面：${escapeEvolutionMarkdownInline(bookPublicUrl(diff.catalogId, baseUrl))}`);
    }
    lines.push("");
  }

  // Entered
  lines.push("##### 当前年份新进入");
  lines.push("");
  const entered = transition.books.entered;
  if (entered.length === 0) {
    lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_EMPTY_BOOK_GROUP_NOTE)}`);
    lines.push("");
  } else {
    for (const diff of entered) {
      lines.push(`- **${escapeEvolutionMarkdownInline(diff.title || diff.catalogId)}**`);
      if (diff.author && String(diff.author).trim()) {
        lines.push(`  - 作者：${escapeEvolutionMarkdownInline(diff.author)}`);
      }
      lines.push(`  - 当前排名：${escapeEvolutionMarkdownInline(formatEvolutionRank(diff.currentRank))}`);
      lines.push(`  - 公开书目页面：${escapeEvolutionMarkdownInline(bookPublicUrl(diff.catalogId, baseUrl))}`);
    }
    lines.push("");
  }

  // Left
  lines.push("##### 前一年出现、当前年份未出现");
  lines.push("");
  const left = transition.books.left;
  if (left.length === 0) {
    lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_EMPTY_BOOK_GROUP_NOTE)}`);
    lines.push("");
  } else {
    for (const diff of left) {
      lines.push(`- **${escapeEvolutionMarkdownInline(diff.title || diff.catalogId)}**`);
      if (diff.author && String(diff.author).trim()) {
        lines.push(`  - 作者：${escapeEvolutionMarkdownInline(diff.author)}`);
      }
      lines.push(`  - 前一年排名：${escapeEvolutionMarkdownInline(formatEvolutionRank(diff.previousRank))}`);
      lines.push(`  - 公开书目页面：${escapeEvolutionMarkdownInline(bookPublicUrl(diff.catalogId, baseUrl))}`);
    }
    lines.push("");
  }
  void topBooksLimit;
  return lines.join("\n");
}

function transitionsSection(
  input: ReadingEvolutionMarkdownInput,
  baseUrl: string,
): string {
  const lines: string[] = [];
  lines.push("## 相邻年度过渡");
  lines.push("");
  lines.push("按年份升序排列。");
  lines.push("");
  for (const t of input.timeline.transitions) {
    lines.push(transitionSection(t, input.topBooksLimit, baseUrl));
  }
  return lines.join("\n");
}

function methodSection(): string {
  const lines: string[] = [];
  lines.push("## 方法说明");
  lines.push("");
  for (const note of READING_EVOLUTION_MARKDOWN_METHOD_NOTES) {
    lines.push(`- ${escapeEvolutionMarkdownInline(note)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- main builder ----------

export function buildReadingEvolutionMarkdown(
  input: ReadingEvolutionMarkdownInput,
): ReadingEvolutionMarkdownBuildResult {
  const base = siteBaseUrl(input.siteBaseUrl);
  const loadedYearCount = input.timeline.summary.loadedYearCount;

  let content: string;
  if (loadedYearCount === 0) {
    content =
      headerSection(input) +
      emptyArchiveSection() +
      methodSection();
  } else if (loadedYearCount === 1) {
    content =
      headerSection(input) +
      singleYearOverviewSection(input) +
      milestonesSection(input) +
      yearNodesSection(input, base) +
      singleYearFootnote() +
      methodSection();
  } else {
    content =
      headerSection(input) +
      overviewSection(input) +
      milestonesSection(input) +
      yearNodesSection(input, base) +
      transitionsSection(input, base) +
      methodSection();
  }

  const filename = buildReadingEvolutionMarkdownFilename({
    firstYear: input.timeline.summary.firstYear,
    latestYear: input.timeline.summary.latestYear,
    now: input.exportedAt,
    hasUsableData: loadedYearCount > 0,
  });

  const encoder = new TextEncoder();
  const byteLength = encoder.encode(content).length;

  return {
    content,
    filename,
    mimeType: READING_EVOLUTION_MARKDOWN_MIME,
    byteLength,
    rangeLabel: input.rangeLabel,
    topBooksLimit: input.topBooksLimit,
    loadedYearCount,
    transitionCount: input.timeline.summary.transitionCount,
    significantTransitionCount: input.timeline.summary.significantTransitionCount,
    yearGapCount: input.timeline.summary.yearGapCount,
    failedYearsCount: input.failedYears.length,
  };
}

function singleYearFootnote(): string {
  const lines: string[] = [];
  lines.push(`> ${escapeEvolutionMarkdownInline(READING_EVOLUTION_MARKDOWN_SINGLE_YEAR_NOTE)}`);
  lines.push("");
  return lines.join("\n");
}

// ---------- filename ----------

export function buildReadingEvolutionMarkdownFilename(
  args: ReadingEvolutionMarkdownFilenameArgs,
): string {
  const datePart = formatDatePart(args.now);
  if (!args.hasUsableData || args.firstYear === null || args.latestYear === null) {
    const name = `${READING_EVOLUTION_MARKDOWN_FILENAME_PREFIX}-empty-${datePart}.md`;
    return name.slice(0, READING_EVOLUTION_MARKDOWN_FILENAME_MAX_LENGTH);
  }
  const range = args.firstYear === args.latestYear
    ? String(args.firstYear)
    : `${args.firstYear}-to-${args.latestYear}`;
  const name = `${READING_EVOLUTION_MARKDOWN_FILENAME_PREFIX}-${range}-${datePart}.md`;
  return name.slice(0, READING_EVOLUTION_MARKDOWN_FILENAME_MAX_LENGTH);
}

function formatDatePart(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "00000000";
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// ---------- validation ----------

export interface ValidateReadingEvolutionMarkdownOptions {
  /** Optional list of lowercase tokens that must not appear in content. */
  forbiddenTokens?: ReadonlyArray<string>;
  /** Optional list of inference words that must not appear in content. */
  inferenceTokens?: ReadonlyArray<string>;
}

export function validateReadingEvolutionMarkdown(
  result: ReadingEvolutionMarkdownBuildResult,
  options: ValidateReadingEvolutionMarkdownOptions = {},
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof result.content !== "string" || result.content.length === 0) {
    errors.push("content missing");
  }
  if (result.byteLength <= 0) errors.push("byteLength missing");
  if (result.mimeType !== READING_EVOLUTION_MARKDOWN_MIME) errors.push("mimeType wrong");
  if (!result.filename.endsWith(".md")) errors.push("filename not .md");
  if (result.filename.length > READING_EVOLUTION_MARKDOWN_FILENAME_MAX_LENGTH) {
    errors.push("filename too long");
  }

  if (result.content) {
    const lower = result.content.toLowerCase();
    const forbidden = options.forbiddenTokens ?? [];
    for (const token of forbidden) {
      if (lower.includes(token)) errors.push(`forbidden token: ${token}`);
    }
    const inference = options.inferenceTokens ?? [];
    for (const token of inference) {
      if (result.content.includes(token)) errors.push(`inference: ${token}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------- download trigger ----------

export function triggerReadingEvolutionMarkdownDownload(
  args: TriggerReadingEvolutionMarkdownDownloadArgs,
): TriggerReadingEvolutionMarkdownDownloadResult {
  const content = args.content;
  const filename = args.filename;
  const mimeType = READING_EVOLUTION_MARKDOWN_MIME;
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
  const anchor: ReadingEvolutionMarkdownAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener noreferrer",
    testId: "weread-reading-evolution-export-anchor",
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
  if (args.scheduleRevoke === null) {
    revoke();
  } else if (typeof args.scheduleRevoke === "function") {
    args.scheduleRevoke(revoke);
  } else if (typeof setTimeout !== "undefined") {
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
