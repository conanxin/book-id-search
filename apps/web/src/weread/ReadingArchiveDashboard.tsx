/**
 * S27L — ReadingArchiveDashboard (Phase B)
 *
 * The fifth workspace tab under /weread. Aggregates multiple annual
 * review responses (fetched on demand, never persisted) into a
 * long-term archive index. The dashboard never reads note text,
 * comment, wereadBookId, AI summaries, or any private id; it only
 * re-uses the public-catalog fields exposed by the existing
 * `annual-review` GET endpoint.
 *
 * Phase B: data layer now backed by the pure state machine
 * (`./wereadReadingArchiveState.ts`) wired through the React
 * adapter (`./useReadingArchiveMachine.ts`). The component itself
 * is a thin presenter that maps the machine state to the existing
 * UI components.
 *
 * Concurrency / cache / retry / abort / stale-response behaviour
 * is owned by the state machine + controller. The dashboard does
 * not maintain a parallel cache, an inflight tracker, a
 * failedYears list, or a per-year progress map. The machine
 * reducer is the single source of truth.
 *
 * Privacy contract: see `wereadReadingArchiveModel.ts` for the
 * exhaustive list of forbidden fields. The model always emits
 * `meta.persisted: false` and `meta.source: "annual-review-cache"`.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  Calendar,
  CalendarRange,
  ChevronRight,
  Download,
  EyeOff,
  Library,
  Loader2,
  RefreshCw,
} from "lucide-react";

import {
  DEFAULT_READING_ARCHIVE_RECURRING_LIMIT,
  READING_ARCHIVE_MAX_YEARS,
  READING_ARCHIVE_RANGE_OPTIONS,
  READING_ARCHIVE_TOP_BOOKS_OPTIONS,
  buildWereadReadingArchive,
  formatArchiveOverview,
  formatArchiveOverlap,
  formatArchiveYearRange,
  getArchiveOverlapScopeNote,
  getArchivePrivacyDisclaimer,
  getArchiveRecurringScopeNote,
  getArchiveTopNScopeNotice,
  hasReadingArchiveData,
  type ReadingArchiveRangeValue,
} from "./wereadReadingArchiveModel";

import {
  archiveRangeFromModel,
  archiveRangeToModel,
  parseArchiveCacheKey,
} from "./wereadReadingArchiveState";

import {
  buildReadingArchiveMarkdown,
  triggerReadingArchiveMarkdownDownload,
  type ReadingArchiveRangeLabel,
} from "./wereadReadingArchiveMarkdown";

import { useReadingArchiveMachine } from "./useReadingArchiveMachine";
import ReadingEraPanel from "./ReadingEraPanel";
import type { ReadingEraSegmentationMode } from "./wereadReadingEraModel";

// ---------- props ----------

export interface ReadingArchiveDashboardProps {
  token: string;
  active: boolean;
  /**
   * Invoked when the user clicks "查看年度回顾" on a year card. The
   * parent should switch the active workspace to `annual` and pass
   * `year` to the annual review dashboard.
   */
  onOpenAnnualYear: (year: number) => void;
}

// ---------- component ----------

export default function ReadingArchiveDashboard({
  token,
  active,
  onOpenAnnualYear,
}: ReadingArchiveDashboardProps) {
  const archive = useReadingArchiveMachine({ token, active });

  const {
    state,
    setRange,
    setTopBooks,
    retryFailed,
    reloadBootstrap,
  } = archive;

  // Bridge: the model uses string-valued range options, the state
  // machine uses numeric counts. Convert at the boundary.
  const modelRange: ReadingArchiveRangeValue = archiveRangeToModel(
    state.view.range,
  );

  // ----- derived model -----
  const dashboardArchive = useMemo(() => {
    return buildWereadReadingArchive({
      responses: archive.cachedResponses,
      requestedYears: archive.requestedCount,
      topBooksLimit: state.view.topBooks,
      recurringLimit: DEFAULT_READING_ARCHIVE_RECURRING_LIMIT,
    });
  }, [archive.cachedResponses, archive.requestedCount, state.view.topBooks]);

  const dataAvailable = hasReadingArchiveData(dashboardArchive);
  const failedCount = archive.failedKeys.length;
  const failedYears = useMemo(
    () => failedKeyYears(archive.failedKeys),
    [archive.failedKeys],
  );
  const loadedCount = archive.loadedCount;
  const requestedCount = archive.requestedCount;
  const bootstrapLoading = archive.bootstrapLoading;
  const topBooks = state.view.topBooks;
  const [eraMode, setEraMode] = useState<ReadingEraSegmentationMode>(
    "automatic",
  );

  // ----- render: not activated -----
  if (!active) {
    return (
      <section
        className="weread-reading-archive weread-reading-archive--empty"
        data-testid="weread-reading-archive"
        aria-label="长期档案"
      >
        <p className="weread-reading-archive__empty-hint">点击上方「长期档案」工作区后开始加载。</p>
      </section>
    );
  }

  // ----- render: shell (always rendered while active, regardless of bootstrap state) -----
  const yearsAsc = [...dashboardArchive.years].sort((a, b) => a.year - b.year);
  const yearsDesc = [...dashboardArchive.years].sort((a, b) => b.year - a.year);

  return (
    <section
      className="weread-reading-archive"
      data-testid="weread-reading-archive"
      data-status={dataAvailable ? "ok" : bootstrapLoading ? "loading" : "empty"}
      data-range={modelRange}
      data-top-books={String(topBooks)}
      aria-label="长期档案"
    >
      <header className="weread-reading-archive__header">
        <h2>
          <Archive size={16} aria-hidden="true" /> 长期档案
        </h2>
        <p
          className="weread-reading-archive__notice"
          data-testid="weread-reading-archive-notice"
        >
          <EyeOff size={14} aria-hidden="true" /> {getArchivePrivacyDisclaimer()}
        </p>
      </header>

      <div
        className="weread-reading-archive__controls"
        data-testid="weread-reading-archive-controls"
      >
        <fieldset className="weread-reading-archive__control">
          <legend className="weread-reading-archive__control-label">年份范围</legend>
          {READING_ARCHIVE_RANGE_OPTIONS.map((opt) => (
            <label key={opt.value}>
              <input
                type="radio"
                name="weread-reading-archive-range"
                value={opt.value}
                checked={modelRange === opt.value}
                onChange={() => setRange(archiveRangeFromModel(opt.value))}
                disabled={bootstrapLoading && loadedCount === 0}
                data-testid={`weread-reading-archive-range-${opt.value}`}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="weread-reading-archive__control">
          <legend className="weread-reading-archive__control-label">高互动书目</legend>
          {READING_ARCHIVE_TOP_BOOKS_OPTIONS.map((opt) => (
            <label key={opt}>
              <input
                type="radio"
                name="weread-reading-archive-top-books"
                value={opt}
                checked={topBooks === opt}
                onChange={() => setTopBooks(opt)}
                disabled={bootstrapLoading && loadedCount === 0}
                data-testid={`weread-reading-archive-top-books-${opt}`}
              />
              <span>{opt}</span>
            </label>
          ))}
        </fieldset>
        <p
          className="weread-reading-archive__scope"
          data-testid="weread-reading-archive-scope"
        >
          {getArchiveTopNScopeNotice()}
        </p>
        <ReadingArchiveExportAction
          archive={dashboardArchive}
          rangeLabel={archiveRangeLabel(state.view.range)}
          topBooksLimit={topBooks}
          failedYears={failedYears}
          bootstrapReady={!bootstrapLoading || loadedCount > 0}
        />
        {bootstrapLoading && loadedCount === 0 ? (
          <button
            type="button"
            className="weread-reading-archive__reload"
            onClick={reloadBootstrap}
            data-testid="weread-reading-archive-reload"
            aria-label="重新加载长期档案"
          >
            <RefreshCw size={12} aria-hidden="true" /> 重新加载
          </button>
        ) : null}
      </div>

      {bootstrapLoading && loadedCount === 0 ? (
        <p
          className="weread-reading-archive__loading"
          data-testid="weread-reading-archive-loading"
        >
          <Loader2 size={14} className="spin" aria-hidden="true" /> 正在整理长期档案…
        </p>
      ) : null}

      {requestedCount > 0 ? (
        <div
          className="weread-reading-archive__progress"
          data-testid="weread-reading-archive-progress"
        >
          <Loader2
            size={14}
            className={bootstrapLoading && loadedCount < requestedCount ? "spin" : ""}
            aria-hidden="true"
          />
          <span>
            正在整理长期档案：已加载 {loadedCount} / {requestedCount} 个年份
            {failedCount > 0 ? `（${failedCount} 个年份暂时失败）` : ""}
          </span>
          {failedCount > 0 ? (
            <button
              type="button"
              className="weread-reading-archive__retry-link"
              onClick={retryFailed}
              data-testid="weread-reading-archive-retry-failed"
            >
              <RefreshCw size={12} aria-hidden="true" /> 重试失败年份
            </button>
          ) : null}
        </div>
      ) : null}

      {!dataAvailable ? (
        <p
          className="weread-reading-archive__empty"
          data-testid="weread-reading-archive-empty"
        >
          暂无长期档案数据。
        </p>
      ) : (
        <>
          <ArchiveOverviewSection archive={dashboardArchive} />

          <ArchiveTimelineSection years={yearsAsc} />

          <ReadingEraPanel
            archive={dashboardArchive}
            mode={eraMode}
            onModeChange={setEraMode}
          />

          <ArchiveYearDirectory
            years={yearsDesc}
            onOpenAnnualYear={onOpenAnnualYear}
          />

          <ArchiveRecurringBooksSection archive={dashboardArchive} />

          <ArchiveYearLinksSection archive={dashboardArchive} />
        </>
      )}

      {failedCount > 0 ? (
        <p
          className="weread-reading-archive__error"
          data-testid="weread-reading-archive-error"
        >
          <AlertCircle size={14} aria-hidden="true" />
          有 {failedCount} 个年份暂时加载失败，已成功年份仍可查看。
        </p>
      ) : null}

      <p
        className="weread-reading-archive__meta"
        data-testid="weread-reading-archive-meta"
      >
        请求年份数 {dashboardArchive.meta.requestedYears} · 加载年份数 {dashboardArchive.meta.loadedYears} · 上限 {READING_ARCHIVE_MAX_YEARS} 年 · 不持久化
      </p>
    </section>
  );
}

// ---------- overview ----------

interface ArchiveOverviewSectionProps {
  archive: ReturnType<typeof buildWereadReadingArchive>;
}

function ArchiveOverviewSection({ archive }: ArchiveOverviewSectionProps) {
  const o = archive.overview;
  return (
    <section
      className="weread-reading-archive__overview"
      data-testid="weread-reading-archive-overview"
    >
      <h3>
        <Library size={14} aria-hidden="true" /> 档案总览
      </h3>
      <p
        className="weread-reading-archive__overview-summary"
        data-testid="weread-reading-archive-overview-summary"
      >
        {formatArchiveOverview(archive)}
      </p>
      <div className="weread-reading-archive__overview-grid">
        <ArchiveStat
          label="有记录年份"
          value={o.yearsWithData > 0 ? String(o.yearsWithData) : "—"}
          hint="有阅读记录的年份数"
        />
        <ArchiveStat
          label="最早年份"
          value={o.firstYear !== null ? describeYear(o.firstYear) : "—"}
          hint="最早一份记录的年份"
        />
        <ArchiveStat
          label="最近年份"
          value={o.latestYear !== null ? describeYear(o.latestYear) : "—"}
          hint="最新一份记录的年份"
        />
        <ArchiveStat
          label="年份范围"
          value={formatArchiveYearRange({ firstYear: o.firstYear, latestYear: o.latestYear })}
          hint="最早与最新年份跨度"
        />
        <ArchiveStat
          label="阅读记录合计"
          value={o.totalRecords > 0 ? o.totalRecords.toLocaleString("zh-CN") : "0"}
          hint="跨年份的阅读记录总数"
        />
        <ArchiveStat
          label="活跃月份合计"
          value={o.totalActiveMonths > 0 ? o.totalActiveMonths.toLocaleString("zh-CN") : "0"}
          hint="各年度活跃月份数之和"
        />
        <ArchiveStat
          label="年均记录"
          value={
            o.averageRecordsPerYear > 0
              ? Math.round(o.averageRecordsPerYear).toLocaleString("zh-CN")
              : "—"
          }
          hint="阅读记录合计 / 有记录年份数"
        />
        <ArchiveStat
          label="最高记录年份"
          value={o.mostActiveYear !== null ? describeYear(o.mostActiveYear) : "—"}
          hint={
            o.mostActiveYearRecords > 0
              ? `该年 ${o.mostActiveYearRecords.toLocaleString("zh-CN")} 条记录`
              : "暂无数据"
          }
        />
        <ArchiveStat
          label="最长连续活跃年份"
          value={o.longestActiveYearStreak > 0 ? `${o.longestActiveYearStreak} 年` : "—"}
          hint="按自然年份连续计数"
        />
        <ArchiveStat
          label="多年进入榜单书目"
          value={o.recurringTopBooks > 0 ? `${o.recurringTopBooks} 本` : "0"}
          hint={`基于当前 Top ${archive.meta.topBooksLimit} 范围`}
        />
      </div>
    </section>
  );
}

interface ArchiveStatProps {
  label: string;
  value: string;
  hint?: string;
}

function ArchiveStat({ label, value, hint }: ArchiveStatProps) {
  return (
    <div className="weread-reading-archive__stat-card">
      <span className="weread-reading-archive__stat-label">{label}</span>
      <span className="weread-reading-archive__stat-value">{value}</span>
      {hint ? <span className="weread-reading-archive__stat-hint">{hint}</span> : null}
    </div>
  );
}

// ---------- timeline ----------

interface ArchiveTimelineSectionProps {
  years: ReadonlyArray<import("./wereadReadingArchiveModel").ReadingArchiveYear>;
}

function ArchiveTimelineSection({ years }: ArchiveTimelineSectionProps) {
  if (years.length === 0) return null;
  const maxTotal = years.reduce((acc, y) => Math.max(acc, y.totalRecords), 0);
  const maxActive = years.reduce((acc, y) => Math.max(acc, y.activeMonths), 0);
  return (
    <section
      className="weread-reading-archive__timeline"
      data-testid="weread-reading-archive-timeline"
    >
      <h3>
        <CalendarRange size={14} aria-hidden="true" /> 跨年度趋势
      </h3>
      <ul className="weread-reading-archive__bars" aria-label="年度阅读记录趋势">
        {years.map((y) => {
          const totalH = maxTotal > 0 ? Math.max(2, Math.round((y.totalRecords / maxTotal) * 100)) : 0;
          const activeH = maxActive > 0 ? Math.max(2, Math.round((y.activeMonths / Math.max(1, maxActive)) * 100)) : 0;
          return (
            <li
              key={y.year}
              className="weread-reading-archive__bar"
              tabIndex={0}
              aria-label={`${y.year} 年阅读记录 ${y.totalRecords} 条，活跃月份 ${y.activeMonths} 个`}
            >
              <div className="weread-reading-archive__bar-track" aria-hidden="true">
                <div
                  className="weread-reading-archive__bar-fill weread-reading-archive__bar-fill--total"
                  style={{ height: `${totalH}%` }}
                />
                <div
                  className="weread-reading-archive__bar-fill weread-reading-archive__bar-fill--active"
                  style={{ height: `${activeH}%` }}
                />
              </div>
              <span className="weread-reading-archive__bar-label">{y.year}</span>
              <span className="weread-reading-archive__bar-value">
                {y.totalRecords.toLocaleString("zh-CN")}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="weread-reading-archive__timeline-key" aria-hidden="true">
        深色 = 阅读记录 · 浅色 = 活跃月份
      </p>
    </section>
  );
}

// ---------- year directory ----------

interface ArchiveYearDirectoryProps {
  years: ReadonlyArray<import("./wereadReadingArchiveModel").ReadingArchiveYear>;
  onOpenAnnualYear: (year: number) => void;
}

function ArchiveYearDirectory({ years, onOpenAnnualYear }: ArchiveYearDirectoryProps) {
  if (years.length === 0) return null;
  return (
    <section
      className="weread-reading-archive__year-grid"
      data-testid="weread-reading-archive-year-grid"
    >
      <h3>
        <Calendar size={14} aria-hidden="true" /> 年度档案目录
      </h3>
      <div className="weread-reading-archive__year-grid-list">
        {years.map((y) => (
          <article
            key={y.year}
            className="weread-reading-archive__year-card"
            data-testid={`weread-reading-archive-year-${y.year}`}
          >
            <header className="weread-reading-archive__year-card-header">
              <span className="weread-reading-archive__year-card-year">{describeYear(y.year)}</span>
            </header>
            <dl className="weread-reading-archive__year-card-stats">
              <div>
                <dt>阅读记录</dt>
                <dd>{y.totalRecords.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>活跃月份</dt>
                <dd>{y.activeMonths.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>最长连续月份</dt>
                <dd>{y.longestStreakMonths.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>已匹配记录</dt>
                <dd>{y.matchedRecords.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>年度书目</dt>
                <dd>{y.topBookCount.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>高峰月份</dt>
                <dd>{y.peakMonth ? y.peakMonth : "—"}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="weread-reading-archive__year-card-action"
              onClick={() => onOpenAnnualYear(y.year)}
              data-testid={`weread-reading-archive-open-${y.year}`}
              aria-label={`查看 ${y.year} 年年度回顾`}
            >
              查看年度回顾 <ChevronRight size={12} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------- recurring books ----------

interface ArchiveRecurringBooksSectionProps {
  archive: ReturnType<typeof buildWereadReadingArchive>;
}

function ArchiveRecurringBooksSection({ archive }: ArchiveRecurringBooksSectionProps) {
  if (archive.recurringBooks.length === 0) return null;
  return (
    <section
      className="weread-reading-archive__book-grid"
      data-testid="weread-reading-archive-book-grid"
    >
      <h3>多年进入 Top {archive.meta.topBooksLimit} 高互动榜的书目</h3>
      <p
        className="weread-reading-archive__scope"
        data-testid="weread-reading-archive-recurring-scope"
      >
        {getArchiveRecurringScopeNote()}
      </p>
      <div className="weread-reading-archive__book-grid-list">
        {archive.recurringBooks.map((book) => (
          <article
            key={book.catalogId}
            className="weread-reading-archive__book-card"
            data-testid={`weread-reading-archive-book-${book.catalogId}`}
          >
            <header className="weread-reading-archive__book-card-header">
              <a
                className="weread-reading-archive__book-card-title"
                href={`/books/${book.catalogId}`}
                data-testid={`weread-reading-archive-book-link-${book.catalogId}`}
              >
                {book.title}
              </a>
              {book.author ? (
                <span className="weread-reading-archive__book-card-author">{book.author}</span>
              ) : null}
            </header>
            <dl className="weread-reading-archive__book-card-stats">
              <div>
                <dt>出现年份数</dt>
                <dd>{book.yearsOnList} 年</dd>
              </div>
              <div>
                <dt>年份列表</dt>
                <dd>{book.years.map((y) => y).join(" / ")}</dd>
              </div>
              <div>
                <dt>最佳排名</dt>
                <dd>第 {book.bestRank} 名</dd>
              </div>
              <div>
                <dt>最新年份排名</dt>
                <dd>{book.latestYear} 年第 {book.latestRank} 名</dd>
              </div>
              <div>
                <dt>榜单内年度记录合计</dt>
                <dd>{book.totalNoteCountWithinLists.toLocaleString("zh-CN")}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------- adjacent-year overlap ----------

interface ArchiveYearLinksSectionProps {
  archive: ReturnType<typeof buildWereadReadingArchive>;
}

function ArchiveYearLinksSection({ archive }: ArchiveYearLinksSectionProps) {
  if (archive.yearLinks.length === 0) return null;
  return (
    <section
      className="weread-reading-archive__links"
      data-testid="weread-reading-archive-links"
    >
      <h3>相邻年度榜单重合</h3>
      <p
        className="weread-reading-archive__scope"
        data-testid="weread-reading-archive-overlap-scope"
      >
        {getArchiveOverlapScopeNote()}
      </p>
      <ul className="weread-reading-archive__links-list">
        {archive.yearLinks.map((link) => (
          <li
            key={`${link.sourceYear}-${link.targetYear}`}
            className="weread-reading-archive__link"
            data-testid={`weread-reading-archive-link-${link.sourceYear}-${link.targetYear}`}
          >
            <span className="weread-reading-archive__link-range">
              {link.sourceYear} → {link.targetYear}
            </span>
            <span className="weread-reading-archive__link-shared">
              共同上榜 {link.sharedTopBooks} 本
            </span>
            <span className="weread-reading-archive__link-ratio">
              Top {archive.meta.topBooksLimit} 榜单重合率 {formatArchiveOverlap(link.overlapRatio)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- helpers ----------

function describeYear(year: number): string {
  return `${year} 年`;
}

// ---------- S27L-2: Markdown export action ----------

function archiveRangeLabel(range: number): ReadingArchiveRangeLabel {
  if (range === 5) return "最近5年";
  if (range === 10) return "最近10年";
  return "全部";
}

function failedKeyYears(failedKeys: readonly string[]): number[] {
  const years: number[] = [];
  for (const key of failedKeys) {
    try {
      const parsed = parseArchiveCacheKey(
        key as unknown as Parameters<typeof parseArchiveCacheKey>[0],
      );
      years.push(parsed.year);
    } catch {
      // skip unparseable keys
    }
  }
  return Array.from(new Set(years)).sort((a, b) => a - b);
}

interface ReadingArchiveExportActionProps {
  archive: ReturnType<typeof buildWereadReadingArchive>;
  rangeLabel: ReadingArchiveRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  failedYears: number[];
  bootstrapReady: boolean;
}

function ReadingArchiveExportAction({
  archive,
  rangeLabel,
  topBooksLimit,
  failedYears,
  bootstrapReady,
}: ReadingArchiveExportActionProps) {
  // S27L-2: export success/error state is local UI state. It must
  // NOT enter the state machine reducer. Reset whenever any input
  // that changes the document body changes.
  const [exportStatus, setExportStatus] = useState<"idle" | "ready" | "error">(
    "idle",
  );
  const [exportMessage, setExportMessage] = useState<string>("");

  const resetKey =
    `${rangeLabel}|${topBooksLimit}|` +
    `${archive.meta.loadedYears}|` +
    `${archive.overview.firstYear ?? ""}|` +
    `${archive.overview.latestYear ?? ""}|` +
    `${failedYears.join(",")}`;
  useEffect(() => {
    setExportStatus("idle");
    setExportMessage("");
    // We deliberately depend on the reset key only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const canExport = bootstrapReady;

  const handleExport = () => {
    try {
      const built = buildReadingArchiveMarkdown({
        archive,
        rangeLabel,
        topBooksLimit,
        failedYears,
        exportedAt: new Date(),
      });
      triggerReadingArchiveMarkdownDownload({
        content: built.content,
        filename: built.filename,
      });
      setExportStatus("ready");
      setExportMessage("已生成长期阅读档案 Markdown。");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "未能生成 Markdown，请稍后重试。";
      setExportStatus("error");
      setExportMessage(msg);
    }
  };

  return (
    <div
      className="weread-reading-archive__export"
      data-testid="weread-reading-archive-export"
      data-export-status={exportStatus}
    >
      <div className="weread-reading-archive__export-actions">
        <button
          type="button"
          className="weread-reading-archive__export-button"
          onClick={handleExport}
          disabled={!canExport}
          data-testid="weread-reading-archive-export-button"
          aria-label="导出长期阅读档案 Markdown"
        >
          <Download size={14} aria-hidden="true" /> 导出长期档案 Markdown
        </button>
      </div>
      <p
        className="weread-reading-archive__export-summary"
        data-testid="weread-reading-archive-export-summary"
      >
        当前范围：{rangeLabel} · 高互动书目口径：Top {topBooksLimit} · 成功加载{" "}
        {archive.meta.loadedYears} 个年份
        {failedYears.length > 0
          ? ` · 失败 ${failedYears.length} 个年份`
          : ""}
      </p>
      <p
        className="weread-reading-archive__export-notice"
        data-testid="weread-reading-archive-export-notice"
      >
        长期档案文件只在当前浏览器中生成，不会重新请求年度数据，也不会上传或保存到服务器。文件包含公共书目信息和个人阅读统计。
      </p>
      {exportStatus !== "idle" ? (
        <p
          className="weread-reading-archive__export-status"
          data-testid="weread-reading-archive-export-status"
          data-status={exportStatus}
          role="status"
        >
          {exportMessage}
        </p>
      ) : null}
    </div>
  );
}
