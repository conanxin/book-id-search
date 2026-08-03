/**
 * S27K — Year-over-year reading comparison panel.
 *
 * Pure front-end component that takes two `WereadAnnualReviewResponse`
 * payloads (the same shape the S27J dashboard already loads) and
 * produces a six-section comparison view:
 *   1. Comparison notice (disclaimer)
 *   2. Six core metric cards with deltas + percent changes
 *   3. 12-month dual-bar SVG timeline (with a textual a11y list)
 *   4. Q1–Q4 quarter cards
 *   5. Top-books change groups (continuing / entered / left)
 *   6. Descriptive summaries (no psychological inference)
 *
 * Privacy contract (mirrors S27H / S27I / S27J):
 *   - Receives only the public catalog fields the S27J response
 *     already exposes.
 *   - NEVER renders note text, comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, the raw WeRead title / author,
 *     the AI summary, or the token.
 *   - NEVER calls fetchWereadAiSummary / fetchWereadRelatedBooks.
 *   - NEVER persists anything to localStorage / sessionStorage /
 *     IndexedDB / server.
 *   - The percentages, deltas, and summaries are produced by pure
 *     functions in `wereadYearComparisonModel`.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, BarChart3, BookOpen, Download, GitCompareArrows, RefreshCw, X } from "lucide-react";
import type { WereadAnnualReviewResponse, WereadAnnualReviewTopBooksOption } from "../wereadPrivate";
import {
  buildWereadYearComparison,
  formatComparisonDelta,
  formatComparisonPercent,
  hasYearComparisonData,
  type WereadYearComparison,
  type YearComparisonBookChange,
  type YearComparisonDirection,
  type YearComparisonMetric,
  type YearComparisonMonth,
  type YearComparisonQuarter,
} from "./wereadYearComparisonModel";
import { formatAnnualReviewMonth, formatAnnualReviewYear } from "./wereadAnnualReviewModel";
import {
  buildYearComparisonMarkdown,
  triggerYearComparisonMarkdownDownload,
  YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE,
} from "./wereadYearComparisonMarkdown";

const FORBIDDEN_CLASSNAMES = ["dangerously"] as const;

export interface YearComparisonPanelProps {
  base: WereadAnnualReviewResponse;
  target: WereadAnnualReviewResponse;
  topBooksRange: WereadAnnualReviewTopBooksOption;
  /** Optional error message (e.g. when the compare-year request failed). */
  errorMessage?: string | null;
  /** Optional retry handler for the error state. */
  onRetry?: () => void;
  /** Called when the user closes the comparison. */
  onClose?: () => void;
  /** Called when the user clicks swap years. */
  onSwap?: () => void;
  /** Optional callback to change topBooks range (must apply to both years). */
  onTopBooksRangeChange?: (next: WereadAnnualReviewTopBooksOption) => void;
}

export default function YearComparisonPanel({
  base,
  target,
  topBooksRange,
  errorMessage,
  onRetry,
  onClose,
  onSwap,
  onTopBooksRangeChange,
}: YearComparisonPanelProps) {
  const comparison: WereadYearComparison = useMemo(
    () => buildWereadYearComparison({ base, target, topBooksRange }),
    [base, target, topBooksRange]
  );

  const baseHasData = comparison.meta.baseHasData;
  const targetHasData = comparison.meta.targetHasData;
  const showError = Boolean(errorMessage);
  const emptyComparison = !hasYearComparisonData(comparison);
  // S27K-2 — the export button is available whenever the panel
  // could build a comparison. The spec explicitly allows exporting
  // when both years are empty. While the error banner is shown we
  // still let the user export the partial result they can already
  // see.
  const canExport = !showError;
  const [exportStatus, setExportStatus] = useState<"idle" | "ready" | "error">("idle");
  const [exportMessage, setExportMessage] = useState<string>("");

  // S27K-2 — clear the export success/error state whenever any of
  // the inputs that change the underlying comparison changes. This
  // keeps the success message honest about what the user just
  // downloaded.
  const exportResetKey = `${comparison.baseYear}:${comparison.targetYear}:${topBooksRange}`;
  useEffect(() => {
    setExportStatus("idle");
    setExportMessage("");
    // We deliberately depend on the reset key only; the comparison
    // values are derived from the same source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportResetKey]);

  const handleExportClick = () => {
    try {
      const built = buildYearComparisonMarkdown({
        comparison,
        topBooksLimit: topBooksRange,
        exportedAt: new Date(),
      });
      triggerYearComparisonMarkdownDownload({
        content: built.content,
        filename: built.filename,
      });
      setExportStatus("ready");
      setExportMessage(
        `已生成 ${comparison.baseYear}—${comparison.targetYear} 年年度对比 Markdown。`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未能生成 Markdown，请稍后重试。";
      setExportStatus("error");
      setExportMessage(msg);
    }
  };

  return (
    <section
      className="weread-year-comparison"
      data-testid="weread-year-comparison"
      data-base-year={comparison.baseYear}
      data-target-year={comparison.targetYear}
      aria-label={`${comparison.baseYear} 年与 ${comparison.targetYear} 年年度对比`}
    >
      <header className="weread-year-comparison__header">
        <h3>
          <GitCompareArrows size={14} aria-hidden="true" /> {comparison.baseYear} ↔ {comparison.targetYear} 年度对比
        </h3>
        <div className="weread-year-comparison__header-actions">
          {onSwap ? (
            <button
              type="button"
              className="weread-year-comparison__swap"
              onClick={onSwap}
              data-testid="weread-year-comparison-swap"
            >
              <ArrowLeftRight size={14} aria-hidden="true" /> 交换年份
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className="weread-year-comparison__close"
              onClick={onClose}
              data-testid="weread-year-comparison-close"
              aria-label="关闭年度对比"
            >
              <X size={14} aria-hidden="true" /> 关闭对比
            </button>
          ) : null}
        </div>
      </header>

      <p className="weread-year-comparison__notice" data-testid="weread-year-comparison-notice">
        年度对比只基于阅读记录数量、日期、类型和已确认的公共书目匹配关系。它描述数据变化，不代表阅读质量、兴趣或个人状态。
      </p>

      {onTopBooksRangeChange ? (
        <div className="weread-year-comparison__controls" data-testid="weread-year-comparison-controls">
          <fieldset className="weread-year-comparison__control">
            <legend>高互动书目范围（两年均使用）</legend>
            {[6, 12, 18].map((opt) => (
              <label key={opt}>
                <input
                  type="radio"
                  name="weread-year-comparison-top-books"
                  value={opt}
                  checked={topBooksRange === opt}
                  onChange={() => onTopBooksRangeChange(opt as WereadAnnualReviewTopBooksOption)}
                  data-testid={`weread-year-comparison-top-books-${opt}`}
                />
                <span>{opt}</span>
              </label>
            ))}
          </fieldset>
          <p className="weread-year-comparison__range-notice" data-testid="weread-year-comparison-range-notice">
            榜单变化仅基于当前 topBooks 范围，并不表示开始或停止阅读。切换范围会同时影响基准年和目标年的对比。
          </p>
        </div>
      ) : null}

      {/* S27K-2 — Browser-local Markdown export */}
      <div
        className="weread-year-comparison__export"
        data-testid="weread-year-comparison-export"
      >
        <div
          className="weread-year-comparison__export-actions"
          data-testid="weread-year-comparison-export-actions"
        >
          <button
            type="button"
            className="weread-year-comparison__export-button"
            onClick={handleExportClick}
            disabled={!canExport}
            data-testid="weread-year-comparison-export-button"
            aria-label="导出年度对比 Markdown"
            title="在浏览器内生成 Markdown 文件"
          >
            <Download size={14} aria-hidden="true" />
            导出年度对比 Markdown
          </button>
        </div>
        <p
          className="weread-year-comparison__export-notice"
          data-testid="weread-year-comparison-export-notice"
        >
          {YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE}
        </p>
        {exportStatus === "ready" ? (
          <p
            className="weread-year-comparison__export-status"
            data-testid="weread-year-comparison-export-status"
            role="status"
          >
            {exportMessage}
          </p>
        ) : null}
        {exportStatus === "error" ? (
          <p
            className="weread-year-comparison__export-status weread-year-comparison__export-status--error"
            data-testid="weread-year-comparison-export-status-error"
            role="alert"
          >
            {exportMessage}
          </p>
        ) : null}
      </div>

      {showError ? (
        <div
          className="weread-year-comparison__error"
          data-testid="weread-year-comparison-error"
          role="alert"
        >
          <p>{errorMessage}</p>
          {onRetry ? (
            <button
              type="button"
              className="weread-year-comparison__retry"
              onClick={onRetry}
              data-testid="weread-year-comparison-retry"
            >
              <RefreshCw size={14} aria-hidden="true" /> 重试对比
            </button>
          ) : null}
        </div>
      ) : null}

      {!baseHasData ? (
        <p className="weread-year-comparison__empty" data-testid="weread-year-comparison-empty-base">
          基准年度（{formatAnnualReviewYear(comparison.baseYear)}）暂无有效日期的阅读记录。
        </p>
      ) : null}
      {!targetHasData ? (
        <p className="weread-year-comparison__empty" data-testid="weread-year-comparison-empty-target">
          目标年度（{formatAnnualReviewYear(comparison.targetYear)}）暂无有效日期的阅读记录。
        </p>
      ) : null}

      {!emptyComparison ? (
        <div className="weread-year-comparison__body">
          <MetricsGrid metrics={comparison.metrics} baseYear={comparison.baseYear} targetYear={comparison.targetYear} />
          <TimelineSection months={comparison.months} baseYear={comparison.baseYear} targetYear={comparison.targetYear} />
          <QuartersSection quarters={comparison.quarters} baseYear={comparison.baseYear} targetYear={comparison.targetYear} />
          <BookGroupsSection comparison={comparison} />
          <SummariesSection summaries={comparison.summaries} />
        </div>
      ) : (
        !showError && (
          <p className="weread-year-comparison__empty" data-testid="weread-year-comparison-empty">
            两个年度暂无可比较的阅读记录或高互动书目。
          </p>
        )
      )}
    </section>
  );
}

// ---------- subcomponents ----------

function MetricsGrid({
  metrics,
  baseYear,
  targetYear,
}: {
  metrics: YearComparisonMetric[];
  baseYear: number;
  targetYear: number;
}) {
  return (
    <section
      className="weread-year-comparison__metrics"
      data-testid="weread-year-comparison-metrics"
      aria-label="核心指标同比"
    >
      <h4 className="weread-year-comparison__section-title">核心指标同比</h4>
      <div className="weread-year-comparison__metric-grid">
        {metrics.map((metric) => (
          <MetricCard key={metric.key} metric={metric} baseYear={baseYear} targetYear={targetYear} />
        ))}
      </div>
    </section>
  );
}

function MetricCard({
  metric,
  baseYear,
  targetYear,
}: {
  metric: YearComparisonMetric;
  baseYear: number;
  targetYear: number;
}) {
  const tone = neutralTone(metric.direction);
  return (
    <article
      className={`weread-year-comparison__metric weread-year-comparison__metric--${tone}`}
      data-testid={`weread-year-comparison-metric-${metric.key}`}
      data-direction={metric.direction}
    >
      <header>
        <h5>{metric.label}</h5>
      </header>
      <dl className="weread-year-comparison__metric-values">
        <div>
          <dt>{formatAnnualReviewYear(baseYear)}</dt>
          <dd>{formatCount(metric.baseValue)}</dd>
        </div>
        <div>
          <dt>{formatAnnualReviewYear(targetYear)}</dt>
          <dd>{formatCount(metric.targetValue)}</dd>
        </div>
      </dl>
      <p className="weread-year-comparison__metric-delta">
        <span className="weread-year-comparison__delta-value">{formatComparisonDelta(metric.delta)}</span>
        <span className="weread-year-comparison__delta-pct">
          {metric.percentChange === null
            ? metric.direction === "from_zero"
              ? "由 0 增至 " + formatCount(metric.targetValue)
              : metric.direction === "to_zero"
                ? "由 " + formatCount(metric.baseValue) + " 降至 0"
                : formatComparisonPercent(metric.percentChange)
            : formatComparisonPercent(metric.percentChange)}
        </span>
      </p>
    </article>
  );
}

function neutralTone(direction: YearComparisonDirection): string {
  switch (direction) {
    case "increase":
    case "from_zero":
      return "neutral-up";
    case "decrease":
    case "to_zero":
      return "neutral-down";
    case "same":
    default:
      return "neutral-flat";
  }
}

function TimelineSection({
  months,
  baseYear,
  targetYear,
}: {
  months: YearComparisonMonth[];
  baseYear: number;
  targetYear: number;
}) {
  const maxTotal = months.reduce((acc, m) => Math.max(acc, m.baseTotal, m.targetTotal), 0);
  return (
    <section
      className="weread-year-comparison__timeline"
      data-testid="weread-year-comparison-timeline"
      aria-label="12 个月双年对比时间轴"
    >
      <h4 className="weread-year-comparison__section-title">
        <BarChart3 size={14} aria-hidden="true" /> 12 个月双年时间轴
      </h4>
      <div className="weread-year-comparison__legend" data-testid="weread-year-comparison-legend">
        <span className="weread-year-comparison__legend-item weread-year-comparison__legend-item--base">
          {formatAnnualReviewYear(baseYear)}
        </span>
        <span className="weread-year-comparison__legend-item weread-year-comparison__legend-item--target">
          {formatAnnualReviewYear(targetYear)}
        </span>
      </div>
      <TimelineBars months={months} maxTotal={maxTotal} baseYear={baseYear} targetYear={targetYear} />
      <p className="weread-year-comparison__a11y-hint">以下为同一数据的可访问文本列表（双柱图下方）。</p>
      <ol className="weread-year-comparison__timeline-list">
        {months.map((m) => (
          <li key={m.monthNumber}>
            {m.label}：{formatAnnualReviewYear(baseYear)} {formatCount(m.baseTotal)} 条（{formatCount(m.baseBookCount)} 本），
            {formatAnnualReviewYear(targetYear)} {formatCount(m.targetTotal)} 条（{formatCount(m.targetBookCount)} 本），
            差值 {formatComparisonDelta(m.delta)}。
          </li>
        ))}
      </ol>
    </section>
  );
}

function TimelineBars({
  months,
  maxTotal,
  baseYear,
  targetYear,
}: {
  months: YearComparisonMonth[];
  maxTotal: number;
  baseYear: number;
  targetYear: number;
}) {
  const W = 720;
  const H = 220;
  const padX = 24;
  const padY = 24;
  const chartW = W - padX * 2;
  const chartH = H - padY * 2;
  const slot = chartW / months.length;
  const pairWidth = Math.max(10, Math.min(36, slot * 0.7));
  const barWidth = pairWidth / 2;
  const gap = 2;
  return (
    <svg
      className="weread-year-comparison__timeline-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${baseYear} 年与 ${targetYear} 年 12 个月阅读记录双柱对比`}
      data-testid="weread-year-comparison-timeline-svg"
    >
      {months.map((m, idx) => {
        const slotX = padX + idx * slot;
        const baseH = maxTotal > 0 ? (m.baseTotal / maxTotal) * chartH : 0;
        const targetH = maxTotal > 0 ? (m.targetTotal / maxTotal) * chartH : 0;
        const baseX = slotX + (slot - pairWidth) / 2;
        const targetX = baseX + barWidth + gap;
        return (
          <g
            key={m.monthNumber}
            className="weread-year-comparison__bar-group"
            data-month={m.monthNumber}
            data-base-total={m.baseTotal}
            data-target-total={m.targetTotal}
          >
            <title>
              {m.label}：{formatAnnualReviewYear(baseYear)} {formatCount(m.baseTotal)} 条（{formatCount(m.baseBookCount)} 本），
              {formatAnnualReviewYear(targetYear)} {formatCount(m.targetTotal)} 条（{formatCount(m.targetBookCount)} 本），
              差值 {formatComparisonDelta(m.delta)}。
            </title>
            <rect
              className="weread-year-comparison__bar weread-year-comparison__bar--base"
              x={baseX}
              y={padY + chartH - baseH}
              width={barWidth}
              height={Math.max(0, baseH)}
              rx={2}
            />
            <rect
              className="weread-year-comparison__bar weread-year-comparison__bar--target"
              x={targetX}
              y={padY + chartH - targetH}
              width={barWidth}
              height={Math.max(0, targetH)}
              rx={2}
            />
            <text
              className="weread-year-comparison__bar-label"
              x={slotX + slot / 2}
              y={padY + chartH + 14}
              textAnchor="middle"
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function QuartersSection({
  quarters,
  baseYear,
  targetYear,
}: {
  quarters: YearComparisonQuarter[];
  baseYear: number;
  targetYear: number;
}) {
  return (
    <section
      className="weread-year-comparison__quarters"
      data-testid="weread-year-comparison-quarters"
      aria-label="季度对比"
    >
      <h4 className="weread-year-comparison__section-title">季度对比</h4>
      <p className="weread-year-comparison__disclaimer" data-testid="weread-year-comparison-quarter-disclaimer">
        以下为基于记录数量的描述性分类，不代表阅读质量或个人状态。
      </p>
      <div className="weread-year-comparison__quarter-grid">
        {quarters.map((q) => (
          <article key={q.quarter} className="weread-year-comparison__quarter" data-quarter={q.quarter}>
            <header>
              <h5>{q.label}</h5>
            </header>
            <dl>
              <div>
                <dt>{formatAnnualReviewYear(baseYear)} 记录</dt>
                <dd>{formatCount(q.baseTotal)}</dd>
              </div>
              <div>
                <dt>{formatAnnualReviewYear(targetYear)} 记录</dt>
                <dd>{formatCount(q.targetTotal)}</dd>
              </div>
              <div>
                <dt>差值</dt>
                <dd>{formatComparisonDelta(q.delta)}</dd>
              </div>
              <div>
                <dt>活跃月份</dt>
                <dd>
                  {formatCount(q.baseActiveMonths)} → {formatCount(q.targetActiveMonths)}
                </dd>
              </div>
              <div>
                <dt>书目数量</dt>
                <dd>
                  {formatCount(q.baseBookCount)} → {formatCount(q.targetBookCount)}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function BookGroupsSection({ comparison }: { comparison: WereadYearComparison }) {
  const total = comparison.continuingBooks.length + comparison.enteredBooks.length + comparison.leftBooks.length;
  if (total === 0) {
    return (
      <section
        className="weread-year-comparison__books"
        data-testid="weread-year-comparison-books-empty"
        aria-label="高互动书目榜变化"
      >
        <h4 className="weread-year-comparison__section-title">高互动书目榜变化</h4>
        <p className="weread-year-comparison__empty">两年均无足够公共书目匹配用于比较。</p>
      </section>
    );
  }
  return (
    <section
      className="weread-year-comparison__books"
      data-testid="weread-year-comparison-books"
      aria-label="高互动书目榜变化"
    >
      <h4 className="weread-year-comparison__section-title">高互动书目榜变化</h4>
      <p className="weread-year-comparison__disclaimer" data-testid="weread-year-comparison-book-disclaimer">
        榜单变化仅基于当前 topBooks 范围，并不表示开始或停止阅读。
      </p>
      <div className="weread-year-comparison__book-groups">
        <BookGroup
          title="连续上榜"
          testId="weread-year-comparison-books-continuing"
          books={comparison.continuingBooks}
          baseYear={comparison.baseYear}
          targetYear={comparison.targetYear}
        />
        <BookGroup
          title="进入目标年度榜单"
          testId="weread-year-comparison-books-entered"
          books={comparison.enteredBooks}
          baseYear={comparison.baseYear}
          targetYear={comparison.targetYear}
        />
        <BookGroup
          title="未进入目标年度榜单"
          testId="weread-year-comparison-books-left"
          books={comparison.leftBooks}
          baseYear={comparison.baseYear}
          targetYear={comparison.targetYear}
        />
      </div>
    </section>
  );
}

function BookGroup({
  title,
  testId,
  books,
  baseYear,
  targetYear,
}: {
  title: string;
  testId: string;
  books: YearComparisonBookChange[];
  baseYear: number;
  targetYear: number;
}) {
  return (
    <section className="weread-year-comparison__book-group" data-testid={testId} aria-label={title}>
      <h5 className="weread-year-comparison__book-group-title">{title}（{books.length}）</h5>
      {books.length === 0 ? (
        <p className="weread-year-comparison__empty weread-year-comparison__book-group-empty">无</p>
      ) : (
        <ul className="weread-year-comparison__book-card-list">
          {books.map((book) => (
            <BookCard key={book.catalogId} book={book} baseYear={baseYear} targetYear={targetYear} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BookCard({
  book,
  baseYear,
  targetYear,
}: {
  book: YearComparisonBookChange;
  baseYear: number;
  targetYear: number;
}) {
  const rankDisplay =
    book.baseRank !== null && book.targetRank !== null
      ? `${book.baseRank} → ${book.targetRank}`
      : book.targetRank !== null
        ? `— → ${book.targetRank}`
        : book.baseRank !== null
          ? `${book.baseRank} → —`
          : "—";
  const rankChangeLabel =
    book.rankChange === null
      ? "—"
      : book.rankChange > 0
        ? `↑ ${book.rankChange}`
        : book.rankChange < 0
          ? `↓ ${Math.abs(book.rankChange)}`
          : "持平";
  return (
    <li className="weread-year-comparison__book-card" data-catalog-id={book.catalogId}>
      <a
        href={`/books/${book.catalogId}`}
        className="weread-year-comparison__book-title"
        data-testid="weread-year-comparison-book-link"
      >
        <BookOpen size={12} aria-hidden="true" /> {book.title}
      </a>
      {book.author ? (
        <span className="weread-year-comparison__book-author">{book.author}</span>
      ) : null}
      <dl className="weread-year-comparison__book-meta">
        <div>
          <dt>排名</dt>
          <dd>{rankDisplay}</dd>
        </div>
        <div>
          <dt>排名变化</dt>
          <dd>{rankChangeLabel}</dd>
        </div>
        <div>
          <dt>{formatAnnualReviewYear(baseYear)} 记录</dt>
          <dd>{formatCount(book.baseNoteCount)}</dd>
        </div>
        <div>
          <dt>{formatAnnualReviewYear(targetYear)} 记录</dt>
          <dd>{formatCount(book.targetNoteCount)}</dd>
        </div>
      </dl>
      <a
        href={`/books/${book.catalogId}`}
        className="weread-year-comparison__book-cta"
        data-testid="weread-year-comparison-book-cta"
      >
        查看书目
      </a>
    </li>
  );
}

function SummariesSection({ summaries }: { summaries: string[] }) {
  if (summaries.length === 0) return null;
  return (
    <section
      className="weread-year-comparison__summaries"
      data-testid="weread-year-comparison-summaries"
      aria-label="描述性变化摘要"
    >
      <h4 className="weread-year-comparison__section-title">描述性变化摘要</h4>
      <ul>
        {summaries.map((line, idx) => (
          <li key={idx}>{line}</li>
        ))}
      </ul>
      <p className="weread-year-comparison__summary-disclaimer">
        以上为基于记录数量和排名的描述性统计，不代表阅读偏好、人格特征或专注力。
      </p>
    </section>
  );
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  return rounded.toLocaleString("zh-CN");
}

// Re-exporting the forbidden classnames so consumers (and tests)
// can detect accidental injection.
export const YEAR_COMPARISON_FORBIDDEN_CLASSNAMES = FORBIDDEN_CLASSNAMES;

// Re-export for tests / dashboard.
export { formatAnnualReviewMonth };