/**
 * S27R-3A — Browser-local Reading Data Repair Plan Markdown export.
 *
 * Pure-frontend, no network, no AI, no persistence. Produces a
 * deterministic, sanitised Markdown document from a
 * `WereadReadingDataRepairPlan` snapshot plus an `exportedAt`
 * Date. Also owns the browser-only download trigger (Blob +
 * object URL + temp anchor + revoke).
 *
 * Privacy contract (re-checked by tests):
 *   - Never includes Recommendation ID / Issue ID.
 *   - Never includes `actual` / `expected` / `title` / `author` /
 *     `catalogId` / note text / comments / private IDs.
 *   - Never includes the raw audit or the raw plan JSON.
 *   - Never calls fetch, never writes localStorage / sessionStorage
 *     / IndexedDB, never mutates the URL bar.
 *   - Never uses dangerouslySetInnerHTML or innerHTML.
 *   - Never makes user-evaluation claims (no scoring / no rating /
 *     no behavioural judgement).
 *
 * Determinism: every section is built from the input argument by
 * a pure function. Repeated calls with the same input produce the
 * same Markdown bytes (only `exportedAt` is used to format the
 * timestamp in the metadata section).
 *
 * The `satisfies Record<...>` clauses on the label maps below
 * are compile-time guards: any drift in the model union types
 * surfaces immediately as a TypeScript error.
 *
 * No Markdown library is used; only inline string assembly with
 * explicit escaping for headers, table cells, and code spans.
 */

import type {
  ReadingDataRepairAction,
  ReadingDataRepairCapability,
  ReadingDataRepairGuidanceKey,
  ReadingDataRepairPriority,
  ReadingDataRepairRecommendation,
  ReadingDataRepairRecommendationGroup,
  WereadReadingDataRepairPlan,
} from "./wereadReadingDataRepairRecommendations";

import type { ReadingDataQualityIssueCode, ReadingDataQualityScope } from "./wereadReadingDataQualityAudit";

// ---------- input ----------

export interface ReadingDataRepairMarkdownInput {
  plan: WereadReadingDataRepairPlan;
  exportedAt: Date;
}

// ---------- exhaustive label tables ----------

const PRIORITY_LABELS = {
  high: "优先检查",
  medium: "建议检查",
  low: "当前条件有限",
  informational: "信息说明",
} satisfies Record<ReadingDataRepairPriority, string>;

const PRIORITY_ORDER: readonly ReadingDataRepairPriority[] = [
  "high",
  "medium",
  "low",
  "informational",
];

const ACTION_LABELS = {
  retry_failed_year: "重试暂时失败年份",
  reload_year: "重新加载目标年份",
  inspect_source_data: "核对档案来源数据",
  review_metric_relationship: "核对年度指标关系",
  review_top_book_metadata: "核对 Top N 公共元数据",
  review_year_link: "核对相邻年度链接",
  review_recurring_aggregation: "核对多年重复书目聚合",
  unsupported_with_current_fields: "当前字段不足以独立核对",
  no_action_required: "当前无需操作",
} satisfies Record<ReadingDataRepairAction, string>;

const ACTION_ORDER: readonly ReadingDataRepairAction[] = [
  "retry_failed_year",
  "reload_year",
  "inspect_source_data",
  "review_metric_relationship",
  "review_top_book_metadata",
  "review_year_link",
  "review_recurring_aggregation",
  "unsupported_with_current_fields",
  "no_action_required",
];

const CAPABILITY_ORDER: readonly ReadingDataRepairCapability[] = [
  "user_retry",
  "user_reload",
  "manual_review",
  "information_only",
  "unsupported",
];

const CAPABILITY_LABELS = {
  user_retry: "可由现有重试入口处理",
  user_reload: "可通过重新加载处理",
  manual_review: "需要人工核对",
  information_only: "仅供说明",
  unsupported: "当前模型字段不足",
} satisfies Record<ReadingDataRepairCapability, string>;

const GUIDANCE_LABELS = {
  retry_failed_years: "使用长期档案现有重试入口处理暂时失败年份",
  reload_archive_year: "重新加载对应目标年份后再次检查",
  inspect_archive_source: "核对档案来源和当前聚合结果是否一致",
  review_year_metric_consistency: "核对同一年度各统计字段之间的数值关系",
  review_top_book_public_metadata: "核对当前 Top N 公共元数据、排名和重复情况",
  review_adjacent_year_links: "核对相邻成功年份之间的链接聚合",
  review_recurring_aggregation: "核对多年重复书目聚合字段之间的一致性",
  current_fields_insufficient: "当前字段不足，无法独立完成该项核对",
  no_action: "当前无需额外处理",
} satisfies Record<ReadingDataRepairGuidanceKey, string>;

const SCOPE_LABELS = {
  archive: "档案",
  coverage: "年份覆盖",
  year: "年度指标",
  top_book: "Top N",
  year_link: "相邻年度链接",
  recurring_book: "多年上榜",
} satisfies Record<ReadingDataQualityScope, string>;

const ISSUE_CODE_LABELS = {
  // coverage
  empty_archive: "空档案",
  partial_archive: "档案部分加载",
  target_year_unaccounted: "目标年份未闭合",
  loaded_failed_conflict: "加载与失败年份冲突",
  duplicate_loaded_year: "重复加载年份",
  invalid_year: "非法年份",
  // year
  non_finite_metric: "年度指标非有限值",
  negative_metric: "年度指标为负",
  dated_records_exceed_total: "有效日期记录超过总记录",
  matched_records_exceed_total: "已匹配记录超过总记录",
  matched_books_exceed_matched_records: "已匹配书目超过已匹配记录",
  active_months_out_of_range: "活跃月份数越界",
  streak_months_out_of_range: "连续月份数越界",
  streak_exceeds_active_months: "连续月份数超过活跃月份",
  peak_month_year_mismatch: "高峰月份与年份不匹配",
  // top_book
  top_books_exceed_limit: "Top N 书目超过上限",
  top_book_missing_catalog: "Top N 书目缺少 catalog",
  top_book_duplicate_catalog: "Top N 书目 catalog 重复",
  top_book_missing_title: "Top N 书目缺少 title",
  top_book_invalid_rank: "Top N 书目 rank 非法",
  top_book_duplicate_rank: "Top N 书目 rank 重复",
  top_book_records_exceed_year_total: "Top N 记录超过年度 total",
  top_book_order_mismatch: "Top N 排序与指标不一致",
  // year_link
  year_link_unknown_year: "YearLink 涉及未加载年份",
  year_link_invalid_order: "YearLink 年份顺序非法",
  year_link_duplicate_pair: "YearLink pair 重复",
  year_link_invalid_counts: "YearLink 计数非法",
  year_link_ratio_out_of_range: "YearLink ratio 越界",
  year_link_ratio_mismatch: "YearLink ratio 与 common/union 不一致",
  missing_year_link: "相邻年度 YearLink 缺失",
  // recurring (audit-emitted)
  recurring_duplicate_catalog: "Recurring catalog 重复",
  recurring_appearance_count_mismatch: "Recurring 上榜次数不一致",
  recurring_unknown_year: "Recurring 涉及未加载年份",
  recurring_duplicate_year: "Recurring 年份集合重复",
  recurring_invalid_rank: "Recurring rank 非法",
  recurring_latest_year_mismatch: "Recurring latestYear 不在 years 中",
} satisfies Record<ReadingDataQualityIssueCode, string>;

// ---------- escape helpers ----------

export function escapeReadingDataRepairMarkdownInline(value: string): string {
  // For inline / heading contexts: strip control chars and neutralise
  // the Markdown chars that could re-write the document.
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!>])/g, "\\$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeReadingDataRepairMarkdownTableCell(value: string): string {
  // For table cells: control chars + pipe escaping (newlines flattened).
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- formatter helpers ----------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatReadingDataRepairMarkdownDate(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    // Fallback to a deterministic placeholder; never emit NaN.
    return "0000-00-00 00:00";
  }
  return (
    `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}` +
    ` ${pad2(value.getHours())}:${pad2(value.getMinutes())}`
  );
}

function formatReadingDataRepairDateStamp(value: Date): string {
  // YYYYMMDD form for the filename; deterministic, ASCII only.
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "00000000";
  }
  return (
    `${value.getFullYear()}` +
    `${pad2(value.getMonth() + 1)}` +
    `${pad2(value.getDate())}`
  );
}

export function formatReadingDataRepairPriority(
  p: ReadingDataRepairPriority,
): string {
  return PRIORITY_LABELS[p];
}

export function formatReadingDataRepairAction(
  a: ReadingDataRepairAction,
): string {
  return ACTION_LABELS[a];
}

export function formatReadingDataRepairCapability(
  c: ReadingDataRepairCapability,
): string {
  return CAPABILITY_LABELS[c];
}

export function formatReadingDataRepairGuidance(
  g: ReadingDataRepairGuidanceKey,
): string {
  return GUIDANCE_LABELS[g];
}

export function formatReadingDataRepairScope(s: ReadingDataQualityScope): string {
  return SCOPE_LABELS[s];
}

function formatIssueLabel(code: ReadingDataQualityIssueCode): string {
  return ISSUE_CODE_LABELS[code];
}

// Safe location rendering — only fields explicitly listed in the spec.
function renderRecommendationLocation(rec: ReadingDataRepairRecommendation): string[] {
  const lines: string[] = [];
  if (typeof rec.year === "number") {
    lines.push(`- 年份：${escapeReadingDataRepairMarkdownInline(String(rec.year))}`);
  }
  if (typeof rec.fromYear === "number" && typeof rec.toYear === "number") {
    lines.push(
      `- 年份范围：${escapeReadingDataRepairMarkdownInline(String(rec.fromYear))} → ${escapeReadingDataRepairMarkdownInline(String(rec.toYear))}`,
    );
  }
  if (typeof rec.itemIndex === "number") {
    lines.push(
      `- 项目位置：第 ${escapeReadingDataRepairMarkdownInline(String(rec.itemIndex + 1))} 项`,
    );
  }
  if (typeof rec.rank === "number") {
    lines.push(
      `- 排名值：${escapeReadingDataRepairMarkdownInline(String(rec.rank))}`,
    );
  }
  return lines;
}

// ---------- Markdown builder ----------

const MARKDOWN_TITLE = "阅读数据修复建议";

function buildHeaderLines(plan: WereadReadingDataRepairPlan, exportedAt: Date): string[] {
  const s = plan.summary;
  const exportedLabel = formatReadingDataRepairMarkdownDate(exportedAt);
  return [
    `# ${MARKDOWN_TITLE}`,
    "",
    "## 元数据",
    "",
    `- 建议总数：${s.total}`,
    `- 优先检查：${s.high}`,
    `- 建议检查：${s.medium}`,
    `- 当前条件有限：${s.low}`,
    `- 信息说明：${s.informational}`,
    `- 可重试：${s.retryable}`,
    `- 可重新加载：${s.reloadable}`,
    `- 需人工核对：${s.manualReview}`,
    `- 当前字段不足：${s.unsupported}`,
    `- 导出时间：${exportedLabel}`,
    "- 生成方式：book-id-search 浏览器本地生成",
    "- 保存状态：未上传服务器",
    "",
    "## 安全说明",
    "",
    "> 本文件根据当前数据质量审计结果生成，只提供检查或重试方向，不会自动请求、修改或修复任何数据。",
    "",
    "> 优先级只表示建议处理顺序，不代表用户或阅读行为的好坏。",
    "",
  ];
}

function buildOverviewTable(plan: WereadReadingDataRepairPlan): string[] {
  const s = plan.summary;
  return [
    "## 建议总览",
    "",
    "| 类型 | 数量 |",
    "|---|---:|",
    `| 优先检查 | ${s.high} |`,
    `| 建议检查 | ${s.medium} |`,
    `| 当前条件有限 | ${s.low} |`,
    `| 信息说明 | ${s.informational} |`,
    `| 可重试 | ${s.retryable} |`,
    `| 可重新加载 | ${s.reloadable} |`,
    `| 需人工核对 | ${s.manualReview} |`,
    `| 当前字段不足 | ${s.unsupported} |`,
    "",
  ];
}

function buildDetailGroups(plan: WereadReadingDataRepairPlan): string[] {
  if (plan.groups.length === 0) {
    return [
      "## 建议明细",
      "",
      "当前审计结果没有需要生成的修复建议。",
      "",
    ];
  }
  const out: string[] = ["## 建议明细", ""];
  for (const group of plan.groups) {
    const heading = `${PRIORITY_LABELS[group.priority]} · ${ACTION_LABELS[group.action]}`;
    out.push(`### ${escapeReadingDataRepairMarkdownInline(heading)}`);
    out.push("");
    out.push(
      `- 操作类型：${escapeReadingDataRepairMarkdownInline(ACTION_LABELS[group.action])}`,
    );
    out.push(
      `- 处理能力：${escapeReadingDataRepairMarkdownInline(CAPABILITY_LABELS[group.capability])}`,
    );
    out.push(
      `- 指导类型：${escapeReadingDataRepairMarkdownInline(GUIDANCE_LABELS[group.guidanceKey])}`,
    );
    out.push(`- 建议数量：${group.count}`);
    out.push("");
    for (const rec of group.recommendations) {
      const issueLabel = formatIssueLabel(rec.sourceIssueCode);
      const scopeLabel = SCOPE_LABELS[rec.scope];
      out.push(
        `- 来源问题：${escapeReadingDataRepairMarkdownInline(issueLabel)}`,
      );
      out.push(
        `- 数据范围：${escapeReadingDataRepairMarkdownInline(scopeLabel)}`,
      );
      const location = renderRecommendationLocation(rec);
      for (const line of location) {
        out.push(line);
      }
      out.push("");
    }
  }
  return out;
}

function buildActionableSection(plan: WereadReadingDataRepairPlan): string[] {
  const count = plan.summary.retryable + plan.summary.reloadable;
  return [
    "## 可由现有界面处理",
    "",
    `共 ${count} 条建议可通过长期档案已有的重试或重新加载入口处理，本文件不会代替用户执行。`,
    "",
  ];
}

function buildManualReviewSection(plan: WereadReadingDataRepairPlan): string[] {
  return [
    "## 需要人工核对",
    "",
    `共 ${plan.summary.manualReview} 条建议需要人工核对：核对年度指标、Top N 公共元数据、相邻年度链接、多年上榜聚合等。`,
    "",
  ];
}

function buildUnsupportedSection(plan: WereadReadingDataRepairPlan): string[] {
  const lines: string[] = [
    "## 当前字段不足",
    "",
  ];
  if (plan.summary.unsupported > 0) {
    lines.push(
      `共 ${plan.summary.unsupported} 条建议当前审计字段不足，系统不会推测缺失结果。`,
    );
  } else {
    lines.push(
      "当前未触发字段不足分支。如未来审计字段扩展，可在此呈现 unsupported 类型建议。",
    );
  }
  lines.push("");
  return lines;
}

function buildMethodSection(): string[] {
  return [
    "## 方法说明",
    "",
    "- 建议来自当前数据质量审计结果。",
    "- 每个审计问题最多生成一条建议。",
    "- 建议按照优先级和操作类型确定性排序。",
    "- 本文件不会自动请求、修改或修复任何数据。",
    "- 本文件不会执行重试或重新加载。",
    "- 本文件不会修改源档案。",
    "- 本文件不会重新请求年度 API。",
    "- 本文件未调用 AI。",
    "- 本文件未读取笔记正文或评论。",
    "- 本文件未上传或保存到服务器。",
    "- 本文件未写入浏览器存储或 URL。",
    "- 当前字段不足时不会推测缺失结果。",
    "- 本文件不评价用户本人或阅读行为。",
    "",
  ];
}

// ---------- public API ----------

export interface ReadingDataRepairMarkdownResult {
  content: string;
  filename: string;
  mimeType?: string;
}

const MARKDOWN_MIME_TYPE = "text/markdown;charset=utf-8";
const MAX_FILENAME_LENGTH = 80;

export function buildReadingDataRepairMarkdownFilename(exportedAt: Date): string {
  const stamp = formatReadingDataRepairDateStamp(exportedAt);
  const filename = `weread-reading-data-repair-plan-${stamp}.md`;
  if (filename.length > MAX_FILENAME_LENGTH) {
    // Defensive truncation; the stamp length is bounded so this never fires
    // in practice, but the cap is documented in the spec.
    return filename.slice(0, MAX_FILENAME_LENGTH);
  }
  return filename;
}

export function buildReadingDataRepairMarkdown(
  input: ReadingDataRepairMarkdownInput,
): ReadingDataRepairMarkdownResult {
  const { plan, exportedAt } = input;
  const lines: string[] = [
    ...buildHeaderLines(plan, exportedAt),
    ...buildOverviewTable(plan),
    ...buildDetailGroups(plan),
    ...buildActionableSection(plan),
    ...buildManualReviewSection(plan),
    ...buildUnsupportedSection(plan),
    ...buildMethodSection(),
  ];
  const content = lines.join("\n");
  const filename = buildReadingDataRepairMarkdownFilename(exportedAt);
  return {
    content,
    filename,
    mimeType: MARKDOWN_MIME_TYPE,
  };
}

// ---------- validator ----------

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  // Recommendation ID style
  /rec[a-z0-9]{8,}/i,
  // Issue ID style
  /issue[a-z0-9]{8,}/i,
  // Note private fields
  /\bnoteId\b/i,
  /\bnote\.text\b/i,
  /\bnote\.comment\b/i,
  /\bwereadBookId\b/i,
  /\bhighlightId\b/i,
  // Public book metadata
  /\bcatalogId\b/,
  /\bbook\.author\b/,
  /\bbook\.title\b/,
  // Auth / token
  /Authorization\s*[:=]/i,
  /Bearer\s+[A-Za-z0-9._-]{8,}/,
  /\bapi[_-]?key\b/i,
  // Raw JSON dumps
  /"recommendations"\s*:/,
  /"issues"\s*:/,
  /"actionCounts"\s*:/,
  /"capabilityCounts"\s*:/,
  /"summary"\s*:/,
  // Internal flags
  /\bdebug\b\s*[:=]/,
  /\bdebug\b\s*\{/,
  // Automatic repair / evaluation claims
  /自动修复/,
  /一键修复/,
  /系统将自动重试/,
  /已帮你修复/,
  /已修复/,
  /系统已修改/,
  /评分/,
  /健康分/,
  /风险分数/,
  /阅读质量分/,
  /评分:?\s*\d/,
  // Performance / behavioural judgement
  /更爱阅读/,
  /兴趣增强/,
  /兴趣减弱/,
  /能力提升/,
  /能力下降/,
  /心理状态/,
  /人格/,
  /成长/,
  /退步/,
  /低谷/,
  /巅峰/,
];

export interface ReadingDataRepairMarkdownValidationIssue {
  pattern: string;
  index: number;
  match: string;
}

export interface ReadingDataRepairMarkdownValidationResult {
  ok: boolean;
  issues: ReadingDataRepairMarkdownValidationIssue[];
}

export function validateReadingDataRepairMarkdown(content: string): ReadingDataRepairMarkdownValidationResult {
  const issues: ReadingDataRepairMarkdownValidationIssue[] = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      issues.push({
        pattern: pattern.source,
        index: match.index,
        match: match[0],
      });
      if (issues.length > 64) break;
    }
    if (issues.length > 64) break;
  }
  return { ok: issues.length === 0, issues };
}

// ---------- browser-local download helper ----------

export interface ReadingDataRepairMarkdownDownloadHandle {
  triggered: boolean;
  filename: string;
  mimeType: string;
}

export function triggerReadingDataRepairMarkdownDownload(
  args: ReadingDataRepairMarkdownResult,
  deps?: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    createElement?: (tag: string) => HTMLElement;
    click?: (element: HTMLElement) => void;
    remove?: (element: HTMLElement) => void;
    setTimeoutFn?: (cb: () => void, ms: number) => unknown;
    documentBody?: HTMLElement | null;
  },
): ReadingDataRepairMarkdownDownloadHandle {
  const mimeType = MARKDOWN_MIME_TYPE;
  const filename = args.filename;

  // Pure JS / Node test environment: do nothing.
  if (typeof Blob === "undefined" || typeof document === "undefined") {
    return { triggered: false, filename, mimeType };
  }

  const blob = new Blob([args.content], { type: mimeType });
  const url =
    deps?.createObjectURL?.(blob) ??
    (typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(blob)
      : "");
  try {
    const anchor =
      (deps?.createElement?.("a") as HTMLAnchorElement | undefined) ??
      (document.createElement("a") as HTMLAnchorElement);
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    const body = deps?.documentBody ?? document.body;
    body?.appendChild(anchor);
    deps?.click?.(anchor) ?? anchor.click();
    deps?.remove?.(anchor) ?? body?.removeChild(anchor);
    const schedule =
      deps?.setTimeoutFn ??
      ((cb: () => void, ms: number) => setTimeout(cb, ms));
    schedule(() => {
      try {
        deps?.revokeObjectURL?.(url) ??
          (typeof URL !== "undefined" && URL.revokeObjectURL
            ? URL.revokeObjectURL(url)
            : undefined);
      } catch {
        /* noop */
      }
    }, 0);
  } catch {
    // swallow — the caller still gets a non-triggered handle.
    return { triggered: false, filename, mimeType };
  }

  return { triggered: true, filename, mimeType };
}

// ---------- exported label maps for downstream callers / tests ----------

export const REPAIR_MARKDOWN_PRIORITY_LABELS = PRIORITY_LABELS;
export const REPAIR_MARKDOWN_ACTION_LABELS = ACTION_LABELS;
export const REPAIR_MARKDOWN_CAPABILITY_LABELS = CAPABILITY_LABELS;
export const REPAIR_MARKDOWN_GUIDANCE_LABELS = GUIDANCE_LABELS;
export const REPAIR_MARKDOWN_SCOPE_LABELS = SCOPE_LABELS;
export const REPAIR_MARKDOWN_ISSUE_LABELS = ISSUE_CODE_LABELS;
export const REPAIR_MARKDOWN_PRIORITY_ORDER = PRIORITY_ORDER;
export const REPAIR_MARKDOWN_ACTION_ORDER = ACTION_ORDER;
export const REPAIR_MARKDOWN_CAPABILITY_ORDER = CAPABILITY_ORDER;
export const REPAIR_MARKDOWN_MIME_TYPE = MARKDOWN_MIME_TYPE;

// ---------- exposed sanitiser aliases (used by other modules / tests) ----------

export const sanitizeReadingDataRepairMarkdownText = escapeReadingDataRepairMarkdownInline;