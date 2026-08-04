/**
 * S27N — Long-term Reading Comparison Filters panel.
 *
 * Pure-React panel that consumes the already-loaded
 * `WereadReadingArchive` from the parent dashboard, applies a
 * user-selected set of comparison filters, and renders the
 * resulting comparison snapshot. NEVER fetches anything; NEVER
 * calls AI; NEVER persists anything.
 *
 * Hard rules:
 *   - All filter state lives in this component's local state.
 *     The parent archive reducer / scheduler / cache / retry
 *     semantics are never touched.
 *   - Conditions are NOT written to `localStorage` /
 *     `sessionStorage` / IndexedDB, NOT written to the URL,
 *     and NOT sent to the server.
 *   - Output vocabulary uses allow-listed Chinese labels only.
 *     No "兴趣 / 心理 / 人格 / 质量 / 偏好 / 专注力 / 低谷 /
 *     巅峰 / 探索期 / 成熟期" strings are rendered.
 *   - Recurring book links go to `/books/:catalogId` (existing
 *     public route); no private IDs.
 */

import { useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

import type { WereadReadingArchive } from "./wereadReadingArchiveModel";
import {
  buildReadingComparisonResult,
  createDefaultReadingComparisonFilters,
  READING_COMPARISON_MIN_RECORDS_OPTIONS,
  READING_COMPARISON_MIN_ACTIVE_MONTHS_OPTIONS,
  READING_COMPARISON_RECURRING_MIN_YEARS_OPTIONS,
  READING_COMPARISON_OVERLAP_OPTIONS,
  READING_COMPARISON_PANEL_NOTICE,
  READING_COMPARISON_REASON_LABELS,
  READING_COMPARISON_OVERLAP_LABELS,
  type ReadingComparisonFilters,
  type ReadingComparisonOverlapFilter,
  type ReadingComparisonExcludedYearReason,
} from "./wereadReadingComparisonFilters";
import {
  buildReadingComparisonMarkdown,
  triggerReadingComparisonMarkdownDownload,
  formatReadingComparisonRangeLabel,
  type ReadingComparisonRangeLabel,
  type ReadingComparisonTopBooksLimit,
} from "./wereadReadingComparisonMarkdown";

export interface ReadingComparisonFiltersPanelProps {
  archive: WereadReadingArchive | null;
  rangeLabel: ReadingComparisonRangeLabel;
  topBooksLimit: ReadingComparisonTopBooksLimit;
  failedYears: number[];
  /** Optional override; defaults to `/books`. */
  booksBasePath?: string;
  /** Optional site base URL for the Markdown export. */
  siteBaseUrl?: string;
  /** Disable controls during the archive bootstrap. */
  bootstrapLoading?: boolean;
}

const DEFAULT_BOOKS_BASE_PATH = "/books";

const EXPORT_NOTICE =
  "筛选比较文件只在当前浏览器中生成，不会重新请求年度数据，也不会上传或保存到服务器。";

const EXPORT_SUCCESS = "筛选比较 Markdown 已生成，请在浏览器下载中查看。";

const EXPORT_ERROR = "生成筛选比较文件失败，请重试。";

const FORBIDDEN_PSYCH = [
  "兴趣转变",
  "偏好改变",
  "质量提升",
  "质量下降",
  "专注力变化",
  "成熟期",
  "探索期",
  "低谷",
  "巅峰",
  "更爱",
  "增强",
  "减弱",
  "心理",
  "人格",
];

function safeReasonLabels(reasons: ReadingComparisonExcludedYearReason[]): string {
  const labels: string[] = [];
  for (const reason of reasons) {
    const lbl = READING_COMPARISON_REASON_LABELS[reason];
    if (lbl) labels.push(lbl);
  }
  return labels.join("、");
}

function safeOverlapLabel(o: ReadingComparisonOverlapFilter): string {
  return READING_COMPARISON_OVERLAP_LABELS[o] ?? "全部";
}

function formatInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

function formatAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

function bookHref(catalogId: string, basePath: string): string {
  return `${basePath}/${encodeURIComponent(catalogId)}`;
}

function formatYearRange(first: number | null, latest: number | null): string {
  if (first === null || latest === null) return "—";
  if (first === latest) return `${first}`;
  return `${first}—${latest}`;
}

function describeExclusion(
  reasons: ReadingComparisonExcludedYearReason[],
): string {
  if (reasons.length === 0) return "";
  const labels: string[] = [];
  for (const r of reasons) {
    if (r === "before_start") labels.push("早于起始年份");
    else if (r === "after_end") labels.push("晚于结束年份");
    else if (r === "records_below_min") labels.push("低于最低阅读记录");
    else if (r === "active_months_below_min") labels.push("低于最低活跃月份");
  }
  return labels.join("、");
}

export default function ReadingComparisonFiltersPanel({
  archive,
  rangeLabel,
  topBooksLimit,
  failedYears,
  booksBasePath = DEFAULT_BOOKS_BASE_PATH,
  siteBaseUrl,
  bootstrapLoading = false,
}: ReadingComparisonFiltersPanelProps) {
  const [filters, setFilters] = useState<ReadingComparisonFilters>(
    createDefaultReadingComparisonFilters(),
  );
  const [exportStatus, setExportStatus] = useState<"idle" | "success" | "error">("idle");

  const availableYears = useMemo<number[]>(
    () => (archive ? [...archive.years].map((y) => y.year).sort((a, b) => a - b) : []),
    [archive],
  );

  const result = useMemo(
    () => buildReadingComparisonResult(archive, filters),
    [archive, filters],
  );

  // Clear export status whenever the exported snapshot would change.
  useMemo(() => {
    setExportStatus("idle");
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, result, rangeLabel, topBooksLimit, failedYears.join(",")]);

  const updateFilters = (patch: Partial<ReadingComparisonFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  const resetFilters = () => {
    setFilters(createDefaultReadingComparisonFilters());
  };

  const empty = !archive || availableYears.length === 0;
  // Allow export when archive is loaded (even if zero years) — the
  // user can still capture an empty snapshot for review. Disable only
  // during bootstrap.
  const exportDisabled = bootstrapLoading || !archive;

  const handleExport = () => {
    if (exportDisabled) return;
    setExportStatus("idle");
    try {
      const build = buildReadingComparisonMarkdown({
        result,
        rangeLabel,
        topBooksLimit,
        failedYears,
        exportedAt: new Date(),
        siteBaseUrl,
      });
      triggerReadingComparisonMarkdownDownload({
        content: build.content,
        filename: build.filename,
      });
      setExportStatus("success");
    } catch {
      setExportStatus("error");
    }
  };

  return (
    <section
      className="weread-reading-comparison"
      data-testid="weread-reading-comparison"
      aria-label="长期比较筛选"
    >
      <header
        className="weread-reading-comparison__notice"
        data-testid="weread-reading-comparison-notice"
      >
        <h3>长期比较筛选</h3>
        <p className="weread-reading-comparison__notice-body">
          {READING_COMPARISON_PANEL_NOTICE}
        </p>
      </header>

      <div
        className="weread-reading-comparison__controls"
        data-testid="weread-reading-comparison-controls"
      >
        <label className="weread-reading-comparison__field">
          <span>起始年份</span>
          <select
            value={filters.startYear ?? ""}
            disabled={bootstrapLoading || empty}
            onChange={(e) => {
              const v = e.target.value;
              updateFilters({ startYear: v === "" ? null : Number(v) });
            }}
            data-testid="weread-reading-comparison-start-year"
          >
            <option value="">不限</option>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="weread-reading-comparison__field">
          <span>结束年份</span>
          <select
            value={filters.endYear ?? ""}
            disabled={bootstrapLoading || empty}
            onChange={(e) => {
              const v = e.target.value;
              updateFilters({ endYear: v === "" ? null : Number(v) });
            }}
            data-testid="weread-reading-comparison-end-year"
          >
            <option value="">不限</option>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="weread-reading-comparison__field">
          <span>最低阅读记录</span>
          <select
            value={String(filters.minRecords)}
            disabled={bootstrapLoading || empty}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (
                n === 0 ||
                n === 10 ||
                n === 25 ||
                n === 50 ||
                n === 100
              ) {
                updateFilters({ minRecords: n as ReadingComparisonFilters["minRecords"] });
              }
            }}
            data-testid="weread-reading-comparison-min-records"
          >
            {READING_COMPARISON_MIN_RECORDS_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "不限" : `${v}+`}
              </option>
            ))}
          </select>
        </label>
        <label className="weread-reading-comparison__field">
          <span>最低活跃月份</span>
          <select
            value={String(filters.minActiveMonths)}
            disabled={bootstrapLoading || empty}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (
                n === 0 ||
                n === 3 ||
                n === 6 ||
                n === 9 ||
                n === 12
              ) {
                updateFilters({
                  minActiveMonths: n as ReadingComparisonFilters["minActiveMonths"],
                });
              }
            }}
            data-testid="weread-reading-comparison-min-active-months"
          >
            {READING_COMPARISON_MIN_ACTIVE_MONTHS_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "不限" : `${v}+`}
              </option>
            ))}
          </select>
        </label>
        <label className="weread-reading-comparison__field">
          <span>Recurring 最低上榜年份</span>
          <select
            value={String(filters.recurringMinYears)}
            disabled={bootstrapLoading || empty}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n === 2 || n === 3 || n === 4) {
                updateFilters({
                  recurringMinYears:
                    n as ReadingComparisonFilters["recurringMinYears"],
                });
              }
            }}
            data-testid="weread-reading-comparison-recurring-min-years"
          >
            {READING_COMPARISON_RECURRING_MIN_YEARS_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}+
              </option>
            ))}
          </select>
        </label>
        <label className="weread-reading-comparison__field">
          <span>榜单重合范围</span>
          <select
            value={filters.overlap}
            disabled={bootstrapLoading || empty}
            onChange={(e) => {
              updateFilters({
                overlap: e.target.value as ReadingComparisonOverlapFilter,
              });
            }}
            data-testid="weread-reading-comparison-overlap"
          >
            {READING_COMPARISON_OVERLAP_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {safeOverlapLabel(v)}
              </option>
            ))}
          </select>
        </label>
        <div className="weread-reading-comparison__actions">
          <button
            type="button"
            className="weread-reading-comparison__reset"
            disabled={bootstrapLoading}
            onClick={resetFilters}
            data-testid="weread-reading-comparison-reset"
          >
            <RefreshCw size={12} aria-hidden="true" />
            恢复默认
          </button>
          <button
            type="button"
            className="weread-reading-comparison__export-button"
            disabled={exportDisabled}
            onClick={handleExport}
            data-testid="weread-reading-comparison-export-button"
          >
            <Download size={12} aria-hidden="true" />
            导出筛选比较 Markdown
          </button>
        </div>
      </div>

      <div
        className="weread-reading-comparison__export"
        data-testid="weread-reading-comparison-export"
      >
        <p
          className="weread-reading-comparison__export-summary"
          data-testid="weread-reading-comparison-export-summary"
        >
          当前导出口径：{formatReadingComparisonRangeLabel(rangeLabel)} · Top {topBooksLimit} · 纳入 {result.summary.includedYearCount} 个年份 · 排除 {result.summary.excludedYearCount} 个年份 · 失败 {failedYears.length} 个年份
        </p>
        <p
          className="weread-reading-comparison__export-notice"
          data-testid="weread-reading-comparison-export-notice"
        >
          {EXPORT_NOTICE}
        </p>
        {exportStatus === "success" ? (
          <p
            className="weread-reading-comparison__export-status weread-reading-comparison__export-status--success"
            data-testid="weread-reading-comparison-export-status"
            data-status="success"
          >
            {EXPORT_SUCCESS}
          </p>
        ) : null}
        {exportStatus === "error" ? (
          <p
            className="weread-reading-comparison__export-status weread-reading-comparison__export-status--error"
            data-testid="weread-reading-comparison-export-status"
            data-status="error"
          >
            {EXPORT_ERROR}
          </p>
        ) : null}
      </div>

      {empty ? (
        <p
          className="weread-reading-comparison__empty"
          data-testid="weread-reading-comparison-empty"
        >
          暂无长期档案年份，比较筛选暂不可用。
        </p>
      ) : (
        <>
          <section
            className="weread-reading-comparison__summary"
            data-testid="weread-reading-comparison-summary"
          >
            <h4>当前比较范围</h4>
            <ul>
              <li>纳入年份：{result.summary.includedYearCount}</li>
              <li>排除年份：{result.summary.excludedYearCount}</li>
              <li>
                年份范围：
                {formatYearRange(result.summary.earliestYear, result.summary.latestYear)}
              </li>
              <li>阅读记录合计：{formatInteger(result.summary.totalRecords)}</li>
              <li>活跃月份合计：{formatInteger(result.summary.totalActiveMonths)}</li>
              <li>年均记录：{formatAverage(result.summary.averageRecordsPerYear)}</li>
            </ul>
          </section>

          {result.excludedYears.length > 0 ? (
            <section
              className="weread-reading-comparison__excluded"
              data-testid="weread-reading-comparison-excluded"
            >
              <h4>被排除年份</h4>
              <ul>
                {result.excludedYears.map((e) => (
                  <li
                    key={e.year}
                    data-testid={`weread-reading-comparison-excluded-${e.year}`}
                  >
                    {e.year}：{describeExclusion(e.reasons)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {result.includedYears.length > 0 ? (
            <section
              className="weread-reading-comparison__table"
              data-testid="weread-reading-comparison-table"
            >
              <h4>年度指标比较</h4>
              <table>
                <thead>
                  <tr>
                    <th>年份</th>
                    <th>阅读记录</th>
                    <th>活跃月份</th>
                    <th>月均记录</th>
                    <th>已匹配记录</th>
                    <th>年度书目</th>
                    <th>最长连续月份</th>
                    <th>高峰月份</th>
                  </tr>
                </thead>
                <tbody>
                  {result.includedYears.map((y) => (
                    <tr key={y.year} data-testid={`weread-reading-comparison-year-${y.year}`}>
                      <td>{y.year}</td>
                      <td>{formatInteger(y.totalRecords)}</td>
                      <td>{formatInteger(y.activeMonths)}</td>
                      <td>{formatAverage(y.averageRecordsPerActiveMonth)}</td>
                      <td>{formatInteger(y.matchedRecords)}</td>
                      <td>{formatInteger(y.matchedBooks)}</td>
                      <td>{formatInteger(y.longestActiveStreak)}</td>
                      <td>{y.peakMonth ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <p
              className="weread-reading-comparison__empty"
              data-testid="weread-reading-comparison-empty-result"
            >
              当前筛选条件下暂无符合条件的年份。
            </p>
          )}

          {result.recurringBooks.length > 0 ? (
            <section
              className="weread-reading-comparison__books"
              data-testid="weread-reading-comparison-books"
            >
              <h4>筛选范围内重复进入 Top N 的书目</h4>
              <ul>
                {result.recurringBooks.map((b) => (
                  <li
                    key={b.catalogId}
                    className="weread-reading-comparison__book"
                    data-testid={`weread-reading-comparison-book-${b.catalogId}`}
                  >
                    <a
                      href={bookHref(b.catalogId, booksBasePath)}
                      data-testid={`weread-reading-comparison-book-link-${b.catalogId}`}
                    >
                      {b.title && b.title.trim().length > 0 ? b.title : `书目 ${b.catalogId}`}
                    </a>
                    <span>
                      进入 {b.yearsOnList} 个年份（{b.years.join("、")}），最佳排名第 {b.bestRank}，最新 {b.latestYear}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {result.yearLinks.length > 0 ? (
            <section
              className="weread-reading-comparison__overlap"
              data-testid="weread-reading-comparison-overlap-list"
            >
              <h4>相邻年度榜单重合</h4>
              <ul>
                {result.yearLinks.map((l) => (
                  <li
                    key={`${l.sourceYear}-${l.targetYear}`}
                    data-testid={`weread-reading-comparison-overlap-${l.sourceYear}-${l.targetYear}`}
                  >
                    {l.sourceYear} → {l.targetYear}：重合 {l.sharedTopBooks} 本，比例 {formatAverage(l.overlapRatio)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

// Keep the constant exported for the smoke / report.
export { FORBIDDEN_PSYCH };