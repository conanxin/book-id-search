/**
 * S27Q-3A — Browser-local Reading Data Quality Audit Markdown export.
 *
 * Pure-frontend, no network, no AI, no persistence. Produces a
 * deterministic, sanitised Markdown document from a
 * `WereadReadingDataQualityAudit` snapshot plus a small export
 * envelope (range label, Top N, exported-at). Also owns the
 * browser-only download trigger (Blob + object URL + temp anchor).
 *
 * Privacy contract (re-checked by tests):
 *   - Never includes note text / comments / marked text / private ids.
 *   - Never includes catalogId, title, author, raw archive, raw JSON.
 *   - Never includes Issue IDs in the Markdown body.
 *   - Never calls fetch, never writes localStorage / sessionStorage
 *     / IndexedDB, never mutates the URL bar.
 *   - Never uses dangerouslySetInnerHTML or innerHTML.
 *
 * Determinism: every section is built from the input argument by
 * a pure function. Repeated calls with the same input produce the
 * same Markdown bytes (the `auditedAt` and `exportedAt` Date inputs
 * are not embedded as raw timestamps — they are normalised to the
 * audit's `auditedAt` field, and only the export envelope date is
 * used for the file body via a deterministic ISO date formatter).
 *
 * The `satisfies Record<...>` clauses on the label maps below
 * are compile-time guards: any drift in the model union types
 * surfaces immediately as a TypeScript error.
 *
 * No Markdown library is used; only inline string assembly with
 * explicit escaping for headers, table cells, and code spans.
 */

import type {
  ReadingDataQualityIssue,
  ReadingDataQualityIssueCode,
  ReadingDataQualityScope,
  ReadingDataQualityStatus,
  WereadReadingDataQualityAudit,
} from "./wereadReadingDataQualityAudit";

// ---------- input ----------

export interface ReadingDataQualityAuditMarkdownInput {
  audit: WereadReadingDataQualityAudit;
  rangeLabel: string;
  topBooksLimit: 6 | 12 | 18;
  exportedAt: Date;
}

// ---------- exhaustive label tables ----------

const ISSUE_LABELS = {
  empty_archive: "当前没有成功加载的年度档案",
  partial_archive: "部分目标年份暂时加载失败",
  target_year_unaccounted: "目标年份尚未闭合",
  loaded_failed_conflict: "同一年同时出现在成功和失败集合",
  duplicate_loaded_year: "成功加载年份存在重复",
  invalid_year: "年份值不合法",
  non_finite_metric: "年度指标不是有限数值",
  negative_metric: "年度指标为负数",
  dated_records_exceed_total: "有效日期记录超过阅读记录",
  matched_records_exceed_total: "已匹配记录超过阅读记录",
  matched_books_exceed_matched_records: "年度书目数量超过已匹配记录",
  active_months_out_of_range: "活跃月份超出允许范围",
  streak_months_out_of_range: "连续活跃月份超出允许范围",
  streak_exceeds_active_months: "连续活跃月份超过活跃月份",
  peak_month_year_mismatch: "高峰月份与年度不一致",
  top_books_exceed_limit: "Top N 数量超过允许上限",
  top_book_missing_catalog: "Top N 缺少公共 catalog 标识",
  top_book_duplicate_catalog: "Top N 同一 catalog 重复出现",
  top_book_missing_title: "Top N 缺少公共书名",
  top_book_invalid_rank: "Top N 排名值不合法",
  top_book_duplicate_rank: "Top N 同一排名重复出现",
  top_book_records_exceed_year_total: "Top N 记录超过年度阅读记录",
  top_book_order_mismatch: "Top N 排序与预期不一致",
  year_link_unknown_year: "相邻年度链接包含未知年份",
  year_link_invalid_order: "相邻年度链接顺序不合法",
  year_link_duplicate_pair: "相邻年度链接存在重复 pair",
  year_link_invalid_counts: "相邻年度共同上榜数量不合法",
  year_link_ratio_out_of_range: "相邻年度重合率超出 [0,1]",
  year_link_ratio_mismatch: "相邻年度重合率与共同上榜数量不一致",
  missing_year_link: "缺少应存在的相邻年度链接",
  recurring_duplicate_catalog: "多年重复书目存在重复 catalog",
  recurring_appearance_count_mismatch: "多年重复书目出现年份数与列表不一致",
  recurring_unknown_year: "多年重复书目包含未加载年份",
  recurring_duplicate_year: "多年重复书目年份列表存在重复",
  recurring_invalid_rank: "多年重复书目排名值不合法",
  recurring_latest_year_mismatch: "多年重复书目最新年份不在年份列表内",
} satisfies Record<ReadingDataQualityIssueCode, string>;

const SCOPE_LABELS = {
  archive: "长期档案",
  coverage: "年份覆盖",
  year: "年度指标",
  top_book: "年度 Top N",
  year_link: "相邻年度链接",
  recurring_book: "多年重复书目聚合",
} satisfies Record<ReadingDataQualityScope, string>;

const STATUS_LABELS: Record<ReadingDataQualityStatus, string> = {
  pass: "通过",
  warn: "需注意",
  fail: "存在一致性错误",
};

const SEVERITY_ORDER: ReadonlyArray<"error" | "warning" | "info"> = [
  "error",
  "warning",
  "info",
];

const SEVERITY_LABELS: Record<"error" | "warning" | "info", string> = {
  error: "错误",
  warning: "警告",
  info: "信息",
};

const RATIO_KEYS = [
  "accountedRatio",
  "datedRecordRatio",
  "matchedRecordRatio",
  "publicTopBookMetadataRatio",
  "yearLinkCoverageRatio",
] as const;

type RatioKey = (typeof RATIO_KEYS)[number];

const RATIO_LABELS: Record<RatioKey, string> = {
  accountedRatio: "年份闭合比例",
  datedRecordRatio: "有效日期记录占比",
  matchedRecordRatio: "已匹配记录占比",
  publicTopBookMetadataRatio: "Top N 公共元数据完整比例",
  yearLinkCoverageRatio: "相邻年度链接覆盖比例",
};

// ---------- sanitisation ----------

const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /note\.text/i,
  /note\.comment/i,
  /markedText/i,
  /wereadBookId/i,
  /noteId/i,
  /highlightId/i,
  /chapterTitle/i,
  /Authorization/i,
  /token=/i,
  /api[_-]?key/i,
  /cookie/i,
  /session/i,
  /catalogId/i,
  /catalog[_-]?id/i,
  /raw[_-]?archive/i,
  /request[_-]??key/i,
  /cache[_-]?key/i,
  /debug[_-]?snapshot/i,
  /更爱阅读/,
  /兴趣增强/,
  /兴趣减弱/,
  /能力提升/,
  /能力下降/,
  /阅读质量/,
  /心理状态/,
  /人格/,
  /退步/,
  /低谷/,
  /巅峰/,
  /用户评分/,
];

export interface ReadingDataQualityMarkdownValidationResult {
  ok: boolean;
  findings: string[];
}

export function sanitizeReadingDataQualityMarkdownText(
  value: unknown,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return String(value);
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "是" : "否";
  return "";
}

export function escapeReadingDataQualityMarkdownInline(
  value: string,
): string {
  // Escape characters that would otherwise break inline Markdown.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!>])/g, "\\$1");
}

export function escapeReadingDataQualityMarkdownTableCell(
  value: string,
): string {
  // Cells must not contain a literal pipe or a newline.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function stripControlCharacters(value: string): string {
  // Remove ASCII control characters that could break Markdown
  // rendering or be smuggled into the file body.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function redactForbidden(value: string): string {
  let out = value;
  for (const pattern of FORBIDDEN_PATTERNS) {
    out = out.replace(pattern, "[已过滤]");
  }
  return out;
}

function safeValue(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "[已过滤]";
    return String(value);
  }
  return redactForbidden(stripControlCharacters(String(value)));
}

export function formatReadingDataQualityMarkdownDate(
  value: Date,
): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "—";
  }
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function formatReadingDataQualityStatus(
  status: ReadingDataQualityStatus,
): string {
  return STATUS_LABELS[status];
}

export function formatReadingDataQualityIssueLabel(
  code: ReadingDataQualityIssueCode,
): string {
  return ISSUE_LABELS[code];
}

export function formatReadingDataQualityScope(
  scope: ReadingDataQualityScope,
): string {
  return SCOPE_LABELS[scope];
}

function formatRatioValue(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 0) return "0.0%";
  if (value > 1) return "100%";
  if (value >= 0.9999) return "100%";
  const pct = Math.round(value * 1000) / 10;
  return `${pct.toFixed(1)}%`;
}

function describeIssueLocation(issue: ReadingDataQualityIssue): string[] {
  const out: string[] = [];
  if (issue.year !== undefined && issue.year !== null) {
    out.push(`年份：${issue.year} 年`);
  }
  if (
    issue.fromYear !== undefined &&
    issue.fromYear !== null &&
    issue.toYear !== undefined &&
    issue.toYear !== null
  ) {
    out.push(`年份范围：${issue.fromYear} → ${issue.toYear}`);
  }
  if (issue.itemIndex !== undefined && issue.itemIndex !== null) {
    out.push(`项目位置：第 ${issue.itemIndex + 1} 项`);
  }
  if (issue.rank !== undefined && issue.rank !== null) {
    out.push(`排名值：${issue.rank}`);
  }
  if (issue.actual !== undefined && issue.actual !== null) {
    out.push(`实际值：${safeValue(issue.actual)}`);
  }
  if (issue.expected !== undefined && issue.expected !== null) {
    out.push(`期望值：${safeValue(issue.expected)}`);
  }
  return out;
}

// ---------- main builder ----------

export interface ReadingDataQualityAuditMarkdownResult {
  content: string;
  filename: string;
}

export function buildReadingDataQualityAuditMarkdown(
  input: ReadingDataQualityAuditMarkdownInput,
): ReadingDataQualityAuditMarkdownResult {
  const audit = input.audit;
  const summary = audit.summary;
  const coverage = audit.coverage;
  const issues = audit.issues;

  const exportedAtLabel = formatReadingDataQualityMarkdownDate(
    input.exportedAt,
  );
  const auditedAtLabel = formatReadingDataQualityMarkdownDate(
    audit.auditedAt,
  );

  const lines: string[] = [];
  lines.push("# 长期档案数据质量审计", "");

  // --- metadata ---
  lines.push("## 元数据", "");
  lines.push(`- 当前长期档案范围：${sanitizeReadingDataQualityMarkdownText(input.rangeLabel)}`);
  lines.push(`- 当前 Top N 口径：Top ${input.topBooksLimit}`);
  lines.push(`- 审计状态：${formatReadingDataQualityStatus(audit.status)}`);
  lines.push(`- 目标年份：${summary.targetYearCount}`);
  lines.push(`- 成功加载年份：${summary.loadedYearCount}`);
  lines.push(`- 暂时失败年份：${summary.failedYearCount}`);
  lines.push(`- 未闭合年份：${summary.unaccountedYearCount}`);
  lines.push(`- 错误数量：${summary.errorCount}`);
  lines.push(`- 警告数量：${summary.warningCount}`);
  lines.push(`- 信息数量：${summary.infoCount}`);
  lines.push(`- 导出时间：${exportedAtLabel}`);
  lines.push(`- 审计时间：${auditedAtLabel}`);
  lines.push("- 生成方式：浏览器本地生成");
  lines.push("- 保存状态：未上传服务器");
  lines.push("");

  // --- privacy preamble ---
  lines.push(
    "> 本文件只检查当前已加载档案的数据覆盖、数值合法性和字段一致性，不评价阅读行为，也不会自动修改数据。",
    "",
  );

  if (summary.failedYearCount > 0 || summary.unaccountedYearCount > 0) {
    lines.push(
      "> 当前存在暂时失败或未闭合的目标年份；这些年份的内容无法被审计。",
      "",
    );
  }

  // --- overview ---
  lines.push("## 审计总览", "");
  lines.push(`- 状态：${formatReadingDataQualityStatus(audit.status)}`);
  lines.push(`- 错误数量：${summary.errorCount}`);
  lines.push(`- 警告数量：${summary.warningCount}`);
  lines.push(`- 信息数量：${summary.infoCount}`);
  for (const key of RATIO_KEYS) {
    lines.push(`- ${RATIO_LABELS[key]}：${formatRatioValue(summary[key])}`);
  }
  lines.push("");
  lines.push(
    "> 上述比例只描述数据覆盖和可核对程度，不评价阅读行为。",
    "",
  );

  // --- coverage ---
  lines.push("## 年份覆盖", "");
  const ascending = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);
  lines.push("### 目标年份");
  lines.push(ascending(coverage.targetYears).join("、") || "—");
  lines.push("");
  lines.push("### 成功加载年份");
  lines.push(ascending(coverage.loadedYears).join("、") || "—");
  lines.push("");
  lines.push("### 暂时失败年份");
  lines.push(ascending(coverage.failedYears).join("、") || "—");
  lines.push("");
  lines.push("### 未闭合年份");
  lines.push(ascending(coverage.unaccountedYears).join("、") || "—");
  lines.push("");
  lines.push("### 额外加载年份");
  lines.push(ascending(coverage.unexpectedLoadedYears).join("、") || "—");
  lines.push("");

  // --- issue groups ---
  lines.push("## 审计问题", "");
  const grouped: Record<"error" | "warning" | "info", ReadingDataQualityIssue[]> = {
    error: [],
    warning: [],
    info: [],
  };
  for (const issue of issues) grouped[issue.severity].push(issue);

  for (const severity of SEVERITY_ORDER) {
    lines.push(`### ${SEVERITY_LABELS[severity]}`);
    const list = grouped[severity];
    if (list.length === 0) {
      lines.push("当前没有此级别的问题。");
      lines.push("");
      continue;
    }
    for (const issue of list) {
      lines.push(
        `- ${formatReadingDataQualityIssueLabel(issue.code)} · ${formatReadingDataQualityScope(issue.scope)}`,
      );
      const location = describeIssueLocation(issue);
      for (const line of location) lines.push(`  - ${line}`);
    }
    lines.push("");
  }

  // --- limitations ---
  lines.push("## 当前模型限制", "");
  lines.push(
    "多年重复书目数据没有逐年度排名映射，因此无法独立重算最佳排名或核对最近年份对应排名。审计不会为缺失字段推测结果。",
    "",
  );

  // --- methodology ---
  lines.push("## 方法说明", "");
  lines.push("- 只使用当前浏览器已加载档案。");
  lines.push("- 不重新请求年度 API。");
  lines.push("- 不调用 AI。");
  lines.push("- 不读取笔记正文和评论。");
  lines.push("- 不上传服务器。");
  lines.push("- 不写浏览器存储或 URL。");
  lines.push("- 不执行自动修复。");
  lines.push("- 失败年份的内容无法被审计。");
  lines.push("- 审计结果不评价用户本人。");
  lines.push("");

  const content = stripControlCharacters(lines.join("\n"));
  const filename = buildReadingDataQualityAuditFilename(input.exportedAt);
  return { content, filename };
}

// ---------- filename ----------

export function buildReadingDataQualityAuditFilename(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "weread-reading-data-quality-audit.md";
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const filename = `weread-reading-data-quality-audit-${y}${m}${d}.md`;
  // Hard cap at 80 chars (already well under) and ASCII-only.
  return filename.slice(0, 80);
}

// ---------- validation ----------

export function validateReadingDataQualityAuditMarkdown(
  content: string,
): ReadingDataQualityMarkdownValidationResult {
  const findings: string[] = [];
  if (typeof content !== "string" || content.length === 0) {
    findings.push("content must be a non-empty string");
    return { ok: false, findings };
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      findings.push(`forbidden pattern matched: ${pattern.source}`);
    }
  }
  return { ok: findings.length === 0, findings };
}

// ---------- browser download trigger ----------

export interface ReadingDataQualityAuditMarkdownDownloadHandle {
  /** Set when the trigger was invoked in a browser-like environment. */
  triggered: boolean;
  filename: string;
  mimeType: string;
}

export function triggerReadingDataQualityAuditMarkdownDownload(
  args: ReadingDataQualityAuditMarkdownResult,
  deps?: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    createElement?: (tag: string) => HTMLElement;
    click?: (element: HTMLElement) => void;
    remove?: (element: HTMLElement) => void;
    setTimeoutFn?: (cb: () => void, ms: number) => unknown;
    documentBody?: HTMLElement | null;
    logger?: (info: object) => void;
  },
): ReadingDataQualityAuditMarkdownDownloadHandle {
  const mimeType = "text/markdown;charset=utf-8";
  const filename = args.filename;

  // Test-only path: pure JS environment, no DOM.
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
  } finally {
    // `finally` ensures revoke runs even if click/remove throws.
  }
  return { triggered: true, filename, mimeType };
}