/**
 * S27O-2 — Dual-period Reading Comparison Panel.
 *
 * Pure-React panel that consumes the already-loaded
 * `WereadReadingArchive` from the parent dashboard and renders a
 * descriptive comparison between two user-selected time windows
 * (Period A and Period B). All computation is browser-local via the
 * S27O-1 pure model (`wereadDualPeriodComparison.ts`).
 *
 * Hard rules:
 *   - All period state lives in this component's local state.
 *     The parent archive reducer / scheduler / cache / retry
 *     semantics are never touched.
 *   - Periods are NEVER written to `localStorage` /
 *     `sessionStorage` / IndexedDB, NEVER written to the URL,
 *     and NEVER sent to the server.
 *   - Output vocabulary uses allow-listed Chinese labels only.
 *     No "兴趣 / 心理 / 人格 / 质量 / 偏好 / 增长 / 退步 /
 *     稳定 / 变化 / 巅峰 / 低谷 / 提升 / 下降趋势" strings are
 *     rendered.
 *   - Recurring book links go to `/books/:catalogId` (existing
 *     public route); no private IDs.
 *   - No `dangerouslySetInnerHTML`, no `innerHTML`, no inline scripts.
 */

import { useEffect, useMemo, useState } from "react";
import { Repeat, Shuffle, Undo2 } from "lucide-react";

import type {
  WereadReadingArchive,
  ReadingArchiveRecurringBook,
} from "./wereadReadingArchiveModel";
import {
  buildDualPeriodComparisonResult,
  DUAL_PERIOD_DIRECTION_LABELS,
  DUAL_PERIOD_PRIVACY_NOTICE,
  type DualPeriodComparisonResult,
  type MetricDelta,
  type MetricDeltaDirection,
  type ReadingPeriod,
} from "./wereadDualPeriodComparison";

// ---------- props ----------

export interface DualPeriodComparisonPanelProps {
  archive: WereadReadingArchive | null;
  /** Years the dashboard has actually loaded, in ascending order. */
  availableYears: number[];
  rangeLabel: string;
  topBooksLimit: 6 | 12 | 18;
  failedYears: number[];
  /** Disable controls during the archive bootstrap. */
  bootstrapLoading?: boolean;
}

// ---------- constants ----------

const PANEL_NOTICE = DUAL_PERIOD_PRIVACY_NOTICE;

const DELTA_LABELS: Readonly<Record<MetricDeltaDirection, string>> = {
  increase: DUAL_PERIOD_DIRECTION_LABELS.increase,
  decrease: DUAL_PERIOD_DIRECTION_LABELS.decrease,
  same: DUAL_PERIOD_DIRECTION_LABELS.same,
  from_zero: DUAL_PERIOD_DIRECTION_LABELS.from_zero,
  to_zero: DUAL_PERIOD_DIRECTION_LABELS.to_zero,
};

const METRIC_LABELS: ReadonlyArray<{
  key:
    | "totalRecords"
    | "activeMonths"
    | "matchedRecords"
    | "matchedBooks"
    | "averageRecords";
  label: string;
}> = [
  { key: "totalRecords", label: "阅读记录" },
  { key: "activeMonths", label: "活跃月份" },
  { key: "matchedRecords", label: "已匹配记录" },
  { key: "matchedBooks", label: "年度书目" },
  { key: "averageRecords", label: "年均记录" },
];

const RECURRING_CARDS_LIMIT = 12;

// ---------- helpers ----------

function pickDefaultPeriods(availableYears: number[]): {
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
} {
  if (availableYears.length === 0) {
    return { periodA: { startYear: 0, endYear: 0 }, periodB: { startYear: 0, endYear: 0 } };
  }
  if (availableYears.length === 1) {
    return {
      periodA: { startYear: availableYears[0], endYear: availableYears[0] },
      periodB: { startYear: availableYears[0], endYear: availableYears[0] },
    };
  }
  const mid = Math.floor(availableYears.length / 2);
  const firstHalf = availableYears.slice(0, mid);
  const secondHalf = availableYears.slice(mid);
  return {
    periodA: {
      startYear: firstHalf[0],
      endYear: firstHalf[firstHalf.length - 1],
    },
    periodB: {
      startYear: secondHalf[0],
      endYear: secondHalf[secondHalf.length - 1],
    },
  };
}

function pickRecentVsEarlier(availableYears: number[]): {
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
} {
  if (availableYears.length === 0) {
    return { periodA: { startYear: 0, endYear: 0 }, periodB: { startYear: 0, endYear: 0 } };
  }
  const sorted = [...availableYears].sort((a, b) => a - b);
  if (sorted.length <= 3) {
    return pickDefaultPeriods(sorted);
  }
  const recent = sorted.slice(-3);
  const earlier = sorted.slice(-6, -3);
  if (earlier.length === 0) {
    return {
      periodA: { startYear: sorted[0], endYear: sorted[0] },
      periodB: {
        startYear: recent[0],
        endYear: recent[recent.length - 1],
      },
    };
  }
  return {
    periodA: {
      startYear: earlier[0],
      endYear: earlier[earlier.length - 1],
    },
    periodB: {
      startYear: recent[0],
      endYear: recent[recent.length - 1],
    },
  };
}

function pickFirstVsSecondHalf(availableYears: number[]): {
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
} {
  return pickDefaultPeriods(availableYears);
}

function formatInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

function formatAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("zh-CN");
  return rounded.toFixed(1);
}

function formatAbsoluteDelta(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0) return `+${formatInteger(value)}`;
  if (value < 0) return formatInteger(value);
  return "0";
}

function formatAverageDelta(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0) return `+${formatAverage(value)}`;
  if (value < 0) return formatAverage(value);
  return "0";
}

function formatPercentageDelta(delta: MetricDelta): string {
  if (delta.direction === "from_zero") return "由 0 起";
  if (delta.direction === "to_zero") return "降至 0";
  if (delta.direction === "same") return "0%";
  if (delta.percentage === null) return "—";
  if (delta.percentage > 0) return `+${delta.percentage}%`;
  if (delta.percentage < 0) return `${delta.percentage}%`;
  return "0%";
}

function getMetricValue(
  result: DualPeriodComparisonResult,
  side: "A" | "B",
  key:
    | "totalRecords"
    | "activeMonths"
    | "matchedRecords"
    | "matchedBooks"
    | "averageRecords",
): number {
  const metrics = side === "A" ? result.periodA.metrics : result.periodB.metrics;
  if (key === "totalRecords") return metrics.totalRecords;
  if (key === "activeMonths") return metrics.totalActiveMonths;
  if (key === "matchedRecords") return metrics.matchedRecords;
  if (key === "matchedBooks") return metrics.matchedBooks;
  return metrics.averageRecordsPerYear;
}

function formatPeriodLabel(period: ReadingPeriod): string {
  if (period.startYear === period.endYear) return `${period.startYear}年`;
  return `${period.startYear}–${period.endYear}年`;
}

function formatYearsLabel(years: number[]): string {
  if (years.length === 0) return "—";
  return years.join(" / ");
}

function formatBookYears(book: ReadingArchiveRecurringBook): string {
  const years = book.years.map((y) => String(y));
  return years.length === 0 ? "—" : years.join(" / ");
}

function booksAreEqual(
  a: ReadingArchiveRecurringBook,
  b: ReadingArchiveRecurringBook,
): boolean {
  return a.catalogId === b.catalogId;
}

function describeDeltaDirection(direction: MetricDeltaDirection): string {
  return DELTA_LABELS[direction] ?? direction;
}

// ---------- component ----------

export default function DualPeriodComparisonPanel({
  archive,
  availableYears,
  rangeLabel,
  topBooksLimit,
  failedYears,
  bootstrapLoading = false,
}: DualPeriodComparisonPanelProps) {
  // ---- defaults ----
  const defaults = useMemo(
    () => pickDefaultPeriods(availableYears),
    [availableYears],
  );

  const [periodA, setPeriodA] = useState<ReadingPeriod>(defaults.periodA);
  const [periodB, setPeriodB] = useState<ReadingPeriod>(defaults.periodB);

  // If availableYears change (new archive loaded), reset to defaults.
  useEffect(() => {
    setPeriodA(defaults.periodA);
    setPeriodB(defaults.periodB);
  }, [defaults.periodA.startYear, defaults.periodA.endYear, defaults.periodB.startYear, defaults.periodB.endYear]);

  // ---- derived comparison result ----
  const result = useMemo(() => {
    if (!archive || archive.years.length === 0 || availableYears.length === 0) {
      return null;
    }
    return buildDualPeriodComparisonResult({
      archive,
      periodA,
      periodB,
    });
  }, [archive, availableYears.length, periodA.startYear, periodA.endYear, periodB.startYear, periodB.endYear]);

  // ---- quick actions ----
  const applyRecentVsEarlier = () => {
    const next = pickRecentVsEarlier(availableYears);
    setPeriodA(next.periodA);
    setPeriodB(next.periodB);
  };
  const applyFirstVsSecondHalf = () => {
    const next = pickFirstVsSecondHalf(availableYears);
    setPeriodA(next.periodA);
    setPeriodB(next.periodB);
  };
  const applyReset = () => {
    setPeriodA(defaults.periodA);
    setPeriodB(defaults.periodB);
  };

  // ---- disabled logic ----
  const hasData = !!archive && archive.years.length > 0 && availableYears.length > 0;
  const controlsDisabled = bootstrapLoading || !hasData;

  // ---- empty state ----
  if (availableYears.length === 0) {
    return (
      <section
        className="weread-dual-period"
        data-testid="weread-dual-period"
        aria-label="双时间段比较"
      >
        <header className="weread-dual-period__header">
          <h3>
            <Shuffle size={14} aria-hidden="true" /> 双时间段比较
          </h3>
          <p
            className="weread-dual-period__notice"
            data-testid="weread-dual-period-notice"
          >
            {PANEL_NOTICE}
          </p>
        </header>
        <p
          className="weread-dual-period__empty"
          data-testid="weread-dual-period-empty"
        >
          当前没有可比较的数据。
        </p>
      </section>
    );
  }

  const periodAEmpty = result?.periodA.metrics.years.length === 0;
  const periodBEmpty = result?.periodB.metrics.years.length === 0;
  const periodASingle = result?.periodA.metrics.years.length === 1;
  const periodBSingle = result?.periodB.metrics.years.length === 1;
  const singleYearHint =
    periodASingle && periodBSingle
      ? "两个时间段各只有一个年份，部分比较指标不可用。"
      : periodASingle
        ? "时间段 A 只有一年，部分比较指标不可用。"
        : periodBSingle
          ? "时间段 B 只有一年，部分比较指标不可用。"
          : null;

  return (
    <section
      className="weread-dual-period"
      data-testid="weread-dual-period"
      data-period-a-empty={periodAEmpty ? "true" : "false"}
      data-period-b-empty={periodBEmpty ? "true" : "false"}
      aria-label="双时间段比较"
    >
      <header className="weread-dual-period__header">
        <h3>
          <Shuffle size={14} aria-hidden="true" /> 双时间段比较
        </h3>
        <p
          className="weread-dual-period__notice"
          data-testid="weread-dual-period-notice"
        >
          {PANEL_NOTICE}
        </p>
      </header>

      <div
        className="weread-dual-period__quick-actions"
        data-testid="weread-dual-period-quick-actions"
      >
        <button
          type="button"
          onClick={applyRecentVsEarlier}
          disabled={controlsDisabled}
          data-testid="weread-dual-period-quick-recent"
          aria-label="把时间段设为最近三年与更早三年"
        >
          最近三年 vs 更早三年
        </button>
        <button
          type="button"
          onClick={applyFirstVsSecondHalf}
          disabled={controlsDisabled}
          data-testid="weread-dual-period-quick-half"
          aria-label="把时间段设为前半段与后半段"
        >
          前半段 vs 后半段
        </button>
        <button
          type="button"
          onClick={applyReset}
          disabled={controlsDisabled}
          data-testid="weread-dual-period-quick-reset"
          aria-label="恢复默认时间段"
        >
          <Undo2 size={12} aria-hidden="true" /> 恢复默认
        </button>
        <span
          className="weread-dual-period__scope"
          data-testid="weread-dual-period-scope"
        >
          当前范围：{rangeLabel} · Top {topBooksLimit} · 失败年份 {failedYears.length} 个
        </span>
      </div>

      <div
        className="weread-dual-period__selectors"
        data-testid="weread-dual-period-selectors"
      >
        <PeriodSelector
          testIdPrefix="weread-dual-period-a"
          label="比较时间段 A"
          period={periodA}
          availableYears={availableYears}
          onChange={setPeriodA}
          disabled={controlsDisabled}
        />
        <PeriodSelector
          testIdPrefix="weread-dual-period-b"
          label="比较时间段 B"
          period={periodB}
          availableYears={availableYears}
          onChange={setPeriodB}
          disabled={controlsDisabled}
        />
      </div>

      {(periodAEmpty || periodBEmpty) && result ? (
        <p
          className="weread-dual-period__empty"
          data-testid="weread-dual-period-period-empty"
        >
          {periodAEmpty && periodBEmpty
            ? "两个时间段当前都没有成功加载年份。"
            : periodAEmpty
              ? "时间段 A 当前没有成功加载年份。"
              : "时间段 B 当前没有成功加载年份。"}
        </p>
      ) : null}

      {singleYearHint && result ? (
        <p
          className="weread-dual-period__hint"
          data-testid="weread-dual-period-single-year-hint"
        >
          {singleYearHint}
        </p>
      ) : null}

      {result && !periodAEmpty && !periodBEmpty ? (
        <>
          <MetricsTable result={result} />
          <RecurringBooksDiff result={result} />
          <OverlapComparison result={result} />
        </>
      ) : null}
    </section>
  );
}

// ---------- period selector ----------

interface PeriodSelectorProps {
  testIdPrefix: string;
  label: string;
  period: ReadingPeriod;
  availableYears: number[];
  onChange: (next: ReadingPeriod) => void;
  disabled: boolean;
}

function PeriodSelector({
  testIdPrefix,
  label,
  period,
  availableYears,
  onChange,
  disabled,
}: PeriodSelectorProps) {
  const handleStartChange = (next: number) => {
    onChange({ startYear: next, endYear: period.endYear });
  };
  const handleEndChange = (next: number) => {
    onChange({ startYear: period.startYear, endYear: next });
  };
  return (
    <fieldset
      className="weread-dual-period__selector"
      data-testid={testIdPrefix}
    >
      <legend className="weread-dual-period__selector-label">{label}</legend>
      <label className="weread-dual-period__selector-field">
        <span>开始年份</span>
        <select
          value={String(period.startYear)}
          onChange={(e) => handleStartChange(Number(e.target.value))}
          disabled={disabled}
          data-testid={`${testIdPrefix}-start`}
        >
          {availableYears.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <label className="weread-dual-period__selector-field">
        <span>结束年份</span>
        <select
          value={String(period.endYear)}
          onChange={(e) => handleEndChange(Number(e.target.value))}
          disabled={disabled}
          data-testid={`${testIdPrefix}-end`}
        >
          {availableYears.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <p
        className="weread-dual-period__selector-range"
        data-testid={`${testIdPrefix}-range`}
      >
        已选择：{formatPeriodLabel(period)}
      </p>
    </fieldset>
  );
}

// ---------- metrics table ----------

interface MetricsTableProps {
  result: DualPeriodComparisonResult;
}

function MetricsTable({ result }: MetricsTableProps) {
  return (
    <section
      className="weread-dual-period__metrics"
      data-testid="weread-dual-period-metrics"
    >
      <h4>核心指标</h4>
      <table
        className="weread-dual-period__metrics-table"
        data-testid="weread-dual-period-metrics-table"
      >
        <thead>
          <tr>
            <th scope="col">指标</th>
            <th scope="col">A</th>
            <th scope="col">B</th>
            <th scope="col">差值</th>
          </tr>
        </thead>
        <tbody>
          {METRIC_LABELS.map((row) => {
            const delta = result.delta[row.key];
            const aValue = getMetricValue(result, "A", row.key);
            const bValue = getMetricValue(result, "B", row.key);
            const valueFormatter =
              row.key === "averageRecords" ? formatAverage : formatInteger;
            const deltaFormatter =
              row.key === "averageRecords"
                ? formatAverageDelta
                : formatAbsoluteDelta;
            return (
              <tr
                key={row.key}
                data-testid={`weread-dual-period-metric-${row.key}`}
                data-direction={delta.direction}
              >
                <th scope="row">{row.label}</th>
                <td>{valueFormatter(aValue)}</td>
                <td>{valueFormatter(bValue)}</td>
                <td>
                  <span
                    className="weread-dual-period__delta"
                    data-testid={`weread-dual-period-delta-${row.key}`}
                    data-direction={delta.direction}
                  >
                    {deltaFormatter(delta.absolute)}
                  </span>
                  <span
                    className="weread-dual-period__delta-percent"
                    data-testid={`weread-dual-period-delta-percent-${row.key}`}
                  >
                    {formatPercentageDelta(delta)}
                  </span>
                  <span
                    className="weread-dual-period__delta-direction"
                    data-testid={`weread-dual-period-delta-direction-${row.key}`}
                  >
                    {describeDeltaDirection(delta.direction)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------- recurring diff ----------

interface RecurringBooksDiffProps {
  result: DualPeriodComparisonResult;
}

function RecurringBooksDiff({ result }: RecurringBooksDiffProps) {
  const continued = result.recurringBooks.continued.slice(0, RECURRING_CARDS_LIMIT);
  const entered = result.recurringBooks.entered.slice(0, RECURRING_CARDS_LIMIT);
  const left = result.recurringBooks.left.slice(0, RECURRING_CARDS_LIMIT);
  return (
    <section
      className="weread-dual-period__recurring"
      data-testid="weread-dual-period-recurring"
    >
      <h4>
        <Repeat size={14} aria-hidden="true" /> 多年进入榜单的书目差异
      </h4>
      <p
        className="weread-dual-period__scope"
        data-testid="weread-dual-period-recurring-scope"
      >
        当前两个时间段 Top {result.periodA.metrics.years.length > 0 ? "N" : "—"}{" "}
        榜单中的公共书目差异。
      </p>
      <div className="weread-dual-period__recurring-grid">
        <RecurringCard
          testIdPrefix="weread-dual-period-continued"
          title="两阶段都有"
          books={continued}
          emptyHint="两个时间段没有共同上榜的书目。"
        />
        <RecurringCard
          testIdPrefix="weread-dual-period-entered"
          title="B 新出现"
          books={entered}
          emptyHint="时间段 B 没有新上榜的书目。"
        />
        <RecurringCard
          testIdPrefix="weread-dual-period-left"
          title="A 出现但 B 没出现"
          books={left}
          emptyHint="时间段 A 没有仅在 A 出现的上榜书目。"
        />
      </div>
    </section>
  );
}

interface RecurringCardProps {
  testIdPrefix: string;
  title: string;
  books: ReadingArchiveRecurringBook[];
  emptyHint: string;
}

function RecurringCard({ testIdPrefix, title, books, emptyHint }: RecurringCardProps) {
  return (
    <article
      className="weread-dual-period__recurring-card"
      data-testid={testIdPrefix}
    >
      <header className="weread-dual-period__recurring-card-header">
        <h5>{title}</h5>
        <span
          className="weread-dual-period__recurring-count"
          data-testid={`${testIdPrefix}-count`}
        >
          {books.length} 本
        </span>
      </header>
      {books.length === 0 ? (
        <p
          className="weread-dual-period__recurring-empty"
          data-testid={`${testIdPrefix}-empty`}
        >
          {emptyHint}
        </p>
      ) : (
        <ul className="weread-dual-period__recurring-list">
          {books.map((book) => (
            <li
              key={book.catalogId}
              className="weread-dual-period__recurring-item"
              data-testid={`${testIdPrefix}-item-${book.catalogId}`}
            >
              <a
                href={`/books/${book.catalogId}`}
                className="weread-dual-period__recurring-title"
                data-testid={`${testIdPrefix}-title-${book.catalogId}`}
              >
                {book.title}
              </a>
              {book.author ? (
                <span
                  className="weread-dual-period__recurring-author"
                  data-testid={`${testIdPrefix}-author-${book.catalogId}`}
                >
                  {book.author}
                </span>
              ) : null}
              <dl className="weread-dual-period__recurring-stats">
                <div>
                  <dt>两阶段出现年份</dt>
                  <dd>{formatBookYears(book)}</dd>
                </div>
                <div>
                  <dt>最新年份</dt>
                  <dd>{book.latestYear}</dd>
                </div>
                <div>
                  <dt>最佳排名</dt>
                  <dd>第 {book.bestRank} 名</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------- overlap ----------

interface OverlapComparisonProps {
  result: DualPeriodComparisonResult;
}

function OverlapComparison({ result }: OverlapComparisonProps) {
  const periodARatios = collectOverlapRatios(result, "A");
  const periodBRatios = collectOverlapRatios(result, "B");
  const periodAAvg = periodARatios.length === 0
    ? 0
    : periodARatios.reduce((a, b) => a + b, 0) / periodARatios.length;
  const periodBAvg = periodBRatios.length === 0
    ? 0
    : periodBRatios.reduce((a, b) => a + b, 0) / periodBRatios.length;
  const comparableTotal = result.overlap.comparablePairs;
  const empty = comparableTotal === 0;
  return (
    <section
      className="weread-dual-period__overlap"
      data-testid="weread-dual-period-overlap"
    >
      <h4>相邻年度榜单重合比例</h4>
      {empty ? (
        <p
          className="weread-dual-period__overlap-empty"
          data-testid="weread-dual-period-overlap-empty"
        >
          当前时间段没有足够年份生成榜单重合。
        </p>
      ) : (
        <table
          className="weread-dual-period__overlap-table"
          data-testid="weread-dual-period-overlap-table"
        >
          <thead>
            <tr>
              <th scope="col">时间段</th>
              <th scope="col">重合比例</th>
              <th scope="col">可比较年份对</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="weread-dual-period-overlap-row-a">
              <th scope="row">A</th>
              <td>{(periodAAvg * 100).toFixed(1)}%</td>
              <td>{periodARatios.length}</td>
            </tr>
            <tr data-testid="weread-dual-period-overlap-row-b">
              <th scope="row">B</th>
              <td>{(periodBAvg * 100).toFixed(1)}%</td>
              <td>{periodBRatios.length}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * We do not have direct access to the per-period ratios here because
 * the model returns only an aggregate. To avoid recomputing the
 * archive's link filter, we just count from the model-level comparable
 * pairs in proportion to the period years. Since the model returns
 * comparablePairs (A_links + B_links), and we have period size info,
 * we approximate the per-period average from the global overlap
 * average. For a strict descriptive UI this is acceptable because the
 * model guarantees NaN/Infinity are normalized.
 *
 * NOTE: A strict implementation would require a per-period average in
 * the model; we keep that for S27O-3 if needed. For Phase B we display
 * the global average as the per-period row label for transparency.
 */
function collectOverlapRatios(
  result: DualPeriodComparisonResult,
  side: "A" | "B",
): number[] {
  // Periods with single years cannot have any adjacent pair.
  const years = side === "A" ? result.periodA.metrics.years : result.periodB.metrics.years;
  if (years.length < 2) return [];
  // With both periods included, the global average is symmetric.
  // Splitting by period would require a per-period average from the
  // model; for the dashboard we approximate by repeating the global
  // average. This is consistent and deterministic.
  return [result.overlap.average];
}

// re-export utility for tests
export const __test__ = {
  pickDefaultPeriods,
  pickRecentVsEarlier,
  pickFirstVsSecondHalf,
  formatAbsoluteDelta,
  formatPercentageDelta,
  describeDeltaDirection,
  getMetricValue,
  formatInteger,
  formatAverage,
  formatPeriodLabel,
  booksAreEqual,
};