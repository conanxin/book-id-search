/**
 * S27J / S27J-2 — AnnualReviewDashboard
 *
 * Pure front-end dashboard for the private WeRead "annual reading
 * review" workspace. Mirrors the privacy contract of the S27H / S27I
 * dashboards.
 *
 * S27J-2 adds a browser-local Markdown export button. The Markdown
 * file is built entirely from the response the dashboard already
 * holds (no extra fetch, no AI call, no storage).
 *
 * Privacy contract:
 *   - Reads only the public fields returned by
 *     `/api/private/weread/annual-review` (catalogId, title, author,
 *     publisher, publishYear, counts, types, dates).
 *   - NEVER reads or receives note text, comment, wereadBookId,
 *     noteId, highlightId, chapterTitle, raw WeRead title / author,
 *     AI summary, or session theme overlay.
 *   - Never calls fetchWereadAiSummary or fetchWereadRelatedBooks.
 *   - Never persists to localStorage / sessionStorage / IndexedDB /
 *     server. Token clearing drops the in-memory response immediately.
 *   - 12-month timeline is rendered as a hand-built SVG bar chart —
 *     no third-party chart library.
 *   - S27J-2: Markdown export consumes the response already held in
 *     `state.response`. No new API request, no AI call, no storage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Calendar,
  ChevronRight,
  Download,
  EyeOff,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  fetchWereadAnnualReview,
  type WereadAnnualReviewResponse,
  type WereadAnnualReviewTopBooksOption,
} from "../wereadPrivate";
import {
  ANNUAL_ACTIVITY_LABELS,
  buildAnnualOverviewView,
  buildAnnualRecordCards,
  buildAnnualRhythmSummary,
  buildAnnualTimelineModel,
  buildAnnualTypeDistribution,
  buildQuarterReviewModel,
  formatAnnualReviewDate,
  formatAnnualReviewMonth,
  formatAnnualReviewYear,
  hasAnnualReviewData,
  truncateAnnualBookTitle,
} from "./wereadAnnualReviewModel";
import {
  buildAnnualReviewMarkdown,
  triggerAnnualReviewMarkdownDownload,
} from "./wereadAnnualReviewMarkdown";

const TOP_BOOKS_OPTIONS: ReadonlyArray<WereadAnnualReviewTopBooksOption> = [6, 12, 18];

export interface AnnualReviewDashboardProps {
  token: string;
  active: boolean;
}

interface DashboardState {
  response: WereadAnnualReviewResponse | null;
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  selectedYear: number | null;
  topBooks: WereadAnnualReviewTopBooksOption;
  exportStatus: "idle" | "ready" | "error";
  exportMessage: string;
}

const INITIAL_STATE: DashboardState = {
  response: null,
  status: "idle",
  error: null,
  selectedYear: null,
  topBooks: 12,
  exportStatus: "idle",
  exportMessage: "",
};

const NOW_INJECTION = () => new Date();

export default function AnnualReviewDashboard({ token, active }: AnnualReviewDashboardProps) {
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const lastRequestTokenRef = useRef<string>("");

  // Reset on token change.
  useEffect(() => {
    if (!token) {
      abortRef.current?.abort();
      lastRequestTokenRef.current = "";
      setState(INITIAL_STATE);
      return;
    }
    lastRequestTokenRef.current = "";
    setState((prev) => ({
      ...prev,
      response: null,
      status: "idle",
      error: null,
      selectedYear: null,
      exportStatus: "idle",
      exportMessage: "",
    }));
  }, [token]);

  // Issue the initial fetch once the tab is activated.
  useEffect(() => {
    if (!token) return;
    if (!active) return;
    if (state.response || state.status === "loading") return;
    if (lastRequestTokenRef.current === token) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastRequestTokenRef.current = token;
    setState((prev) => ({ ...prev, status: "loading", error: null }));
    fetchWereadAnnualReview(token, {
      topBooks: state.topBooks,
      signal: controller.signal,
    })
      .then((resp) => {
        setState((prev) => ({
          ...prev,
          response: resp,
          status: "ok",
          selectedYear: resp.selectedYear,
        }));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "年度回顾加载失败";
        setState((prev) => ({ ...prev, status: "error", error: msg, response: null }));
      });
  }, [active, token, state.response, state.status, state.topBooks]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const requestAnnualReview = useCallback(
    (year: number | null, topBooks: WereadAnnualReviewTopBooksOption) => {
      if (!token) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      lastRequestTokenRef.current = token;
      setState((prev) => ({
        ...prev,
        status: "loading",
        error: null,
        selectedYear: year,
        exportStatus: "idle",
        exportMessage: "",
      }));
      fetchWereadAnnualReview(token, {
        year: year ?? undefined,
        topBooks,
        signal: controller.signal,
      })
        .then((resp) => {
          setState((prev) => ({
            ...prev,
            response: resp,
            status: "ok",
            selectedYear: resp.selectedYear,
          }));
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const msg = err instanceof Error ? err.message : "年度回顾加载失败";
          setState((prev) => ({ ...prev, status: "error", error: msg }));
        });
    },
    [token]
  );

  const handleYearChange = useCallback(
    (next: number) => {
      if (!state.response) return;
      if (next === state.selectedYear) return;
      requestAnnualReview(next, state.topBooks);
    },
    [state.response, state.selectedYear, state.topBooks, requestAnnualReview]
  );

  const handleTopBooksChange = useCallback(
    (next: WereadAnnualReviewTopBooksOption) => {
      if (next === state.topBooks) return;
      requestAnnualReview(state.selectedYear, next);
    },
    [state.selectedYear, state.topBooks, requestAnnualReview]
  );

  const handleRetry = useCallback(() => {
    if (!token) return;
    abortRef.current?.abort();
    lastRequestTokenRef.current = "";
    setState((prev) => ({ ...prev, status: "loading", error: null }));
    requestAnnualReview(state.selectedYear, state.topBooks);
  }, [token, state.selectedYear, state.topBooks, requestAnnualReview]);

  // Track the latest response so the export handler always operates
  // on the most recent data, even if the user clicks before the
  // pending state update lands.
  const responseRef = useRef<WereadAnnualReviewResponse | null>(null);
  useEffect(() => {
    responseRef.current = state.response;
  }, [state.response]);

  const handleExportClick = useCallback(() => {
    const resp = responseRef.current;
    if (!resp) return;
    try {
      const built = buildAnnualReviewMarkdown({
        review: resp,
        exportedAt: new Date(),
      });
      triggerAnnualReviewMarkdownDownload({
        content: built.content,
        filename: built.filename,
      });
      setState((prev) => ({
        ...prev,
        exportStatus: "ready",
        exportMessage: `已生成 ${resp.selectedYear} 年年度回顾 Markdown。`,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未能生成 Markdown，请稍后重试。";
      setState((prev) => ({
        ...prev,
        exportStatus: "error",
        exportMessage: msg,
      }));
    }
  }, []);

  // Render: not yet activated
  if (!active) {
    return (
      <section
        className="weread-annual-review weread-annual-review--empty"
        data-testid="weread-annual-review"
        aria-label="年度回顾"
      >
        <p className="weread-annual-review__empty-hint">点击上方「年度回顾」工作区后开始加载。</p>
      </section>
    );
  }

  // Render: loading
  if (state.status === "loading" && !state.response) {
    return (
      <section
        className="weread-annual-review"
        data-testid="weread-annual-review"
        data-status="loading"
        aria-label="年度回顾"
      >
        <header className="weread-annual-review__header">
          <h2>
            <Calendar size={16} aria-hidden="true" /> 年度回顾
          </h2>
        </header>
        <p className="weread-annual-review__loading">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 正在加载年度回顾…
        </p>
      </section>
    );
  }

  // Render: error
  if (state.status === "error" && !state.response) {
    return (
      <section
        className="weread-annual-review weread-annual-review--error"
        data-testid="weread-annual-review"
        data-status="error"
        aria-label="年度回顾"
      >
        <header className="weread-annual-review__header">
          <h2>
            <Calendar size={16} aria-hidden="true" /> 年度回顾
          </h2>
        </header>
        <p className="weread-annual-review__notice weread-annual-review__notice--error" role="alert">
          <AlertCircle size={14} aria-hidden="true" /> 年度回顾加载失败，请稍后重试。
        </p>
        <button
          type="button"
          className="weread-annual-review__retry"
          onClick={handleRetry}
          data-testid="weread-annual-review-retry"
        >
          <RefreshCw size={14} aria-hidden="true" /> 重新加载
        </button>
      </section>
    );
  }

  const response = state.response;
  if (!response) {
    return (
      <section className="weread-annual-review weread-annual-review--empty" data-testid="weread-annual-review">
        <p className="weread-annual-review__empty-hint">尚未加载年度回顾。</p>
      </section>
    );
  }

  return (
    <AnnualReviewContent
      response={response}
      selectedYear={state.selectedYear}
      topBooks={state.topBooks}
      errorMessage={state.error}
      loading={state.status === "loading"}
      exportStatus={state.exportStatus}
      exportMessage={state.exportMessage}
      onYearChange={handleYearChange}
      onTopBooksChange={handleTopBooksChange}
      onRetry={handleRetry}
      onExportClick={handleExportClick}
    />
  );
}

// ---------- content component (keeps model imports local) ----------

interface AnnualReviewContentProps {
  response: WereadAnnualReviewResponse;
  selectedYear: number | null;
  topBooks: WereadAnnualReviewTopBooksOption;
  errorMessage: string | null;
  loading: boolean;
  exportStatus: "idle" | "ready" | "error";
  exportMessage: string;
  onYearChange: (next: number) => void;
  onTopBooksChange: (next: WereadAnnualReviewTopBooksOption) => void;
  onRetry: () => void;
  onExportClick: () => void;
}

function AnnualReviewContent({
  response,
  selectedYear,
  topBooks,
  errorMessage,
  loading,
  exportStatus,
  exportMessage,
  onYearChange,
  onTopBooksChange,
  onRetry,
  onExportClick,
}: AnnualReviewContentProps) {
  const average = response.overview.averageRecordsPerActiveMonth;
  const timeline = useMemo(
    () =>
      buildAnnualTimelineModel({
        months: response.months,
        year: response.selectedYear,
        averagePerActiveMonth: average,
      }),
    [response.months, response.selectedYear, average]
  );
  const typeDistribution = useMemo(
    () => buildAnnualTypeDistribution({ months: response.months }),
    [response.months]
  );
  const quarters = useMemo(
    () =>
      buildQuarterReviewModel({
        quarters: response.quarters,
        months: response.months,
        averagePerActiveMonth: average,
      }),
    [response.quarters, response.months, average]
  );
  const rhythm = useMemo(() => buildAnnualRhythmSummary({ response }), [response]);
  const overviewView = useMemo(
    () => buildAnnualOverviewView({ response, topBookCount: response.topBooks.length }),
    [response]
  );
  const recordCards = useMemo(() => buildAnnualRecordCards({ response }), [response]);

  const isEmptyYear = !hasAnnualReviewData(response);

  return (
    <section
      className="weread-annual-review"
      data-testid="weread-annual-review"
      data-status="ok"
      data-empty-year={isEmptyYear ? "true" : "false"}
      aria-label="年度回顾"
    >
      <header className="weread-annual-review__header">
        <h2>
          <Calendar size={16} aria-hidden="true" /> 年度回顾
          <span className="weread-annual-review__year-label">{formatAnnualReviewYear(response.selectedYear)}</span>
        </h2>
        <p className="weread-annual-review__notice" data-testid="weread-annual-review-notice">
          <EyeOff size={14} aria-hidden="true" />
          年度回顾仅使用阅读日期、记录类型、数量和已确认的公共书目匹配关系生成，不读取笔记正文，不调用外部 AI，也不会保存到服务器。
        </p>
      </header>

      <div className="weread-annual-review__controls" data-testid="weread-annual-review-controls">
        <label className="weread-annual-review__control">
          <span className="weread-annual-review__control-label">选择年份</span>
          <select
            value={selectedYear ?? response.selectedYear}
            onChange={(e) => onYearChange(Number(e.target.value))}
            data-testid="weread-annual-review-year"
            aria-label="选择回顾年份"
          >
            {(response.availableYears.length > 0
              ? response.availableYears
              : [response.selectedYear]
            ).map((y) => (
              <option key={y} value={y}>
                {formatAnnualReviewYear(y)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="weread-annual-review__control">
          <legend className="weread-annual-review__control-label">年度高互动书目</legend>
          {TOP_BOOKS_OPTIONS.map((opt) => (
            <label key={opt}>
              <input
                type="radio"
                name="weread-annual-review-top-books"
                value={opt}
                checked={topBooks === opt}
                onChange={() => onTopBooksChange(opt)}
                data-testid={`weread-annual-review-top-books-${opt}`}
              />
              <span>{opt}</span>
            </label>
          ))}
        </fieldset>
      </div>

      {/* S27J-2 — Browser-local Markdown export */}
      <div
        className="weread-annual-review__export"
        data-testid="weread-annual-review-export"
      >
        <div
          className="weread-annual-review__export-actions"
          data-testid="weread-annual-review-export-actions"
        >
          <button
            type="button"
            className="weread-annual-review__export-button"
            onClick={onExportClick}
            disabled={loading}
            data-testid="weread-annual-review-export-button"
            aria-label="导出年度回顾 Markdown"
            title="在浏览器内生成 Markdown 文件"
          >
            <Download size={14} aria-hidden="true" />
            导出年度回顾 Markdown
          </button>
        </div>
        <p
          className="weread-annual-review__export-notice"
          data-testid="weread-annual-review-export-notice"
        >
          年度回顾文件只在当前浏览器中生成，不会上传或保存到服务器。文件中包含公共书目信息和个人阅读统计，请自行妥善保管。
        </p>
        {exportStatus === "ready" ? (
          <p
            className="weread-annual-review__export-status"
            data-testid="weread-annual-review-export-status"
            role="status"
          >
            {exportMessage}
          </p>
        ) : null}
        {exportStatus === "error" ? (
          <p
            className="weread-annual-review__export-status weread-annual-review__export-status--error"
            data-testid="weread-annual-review-export-status-error"
            role="alert"
          >
            {exportMessage}
          </p>
        ) : null}
      </div>

      {errorMessage ? (
        <p className="weread-annual-review__notice weread-annual-review__notice--error" role="alert">
          <AlertCircle size={14} aria-hidden="true" /> {errorMessage}
          <button type="button" className="weread-annual-review__retry" onClick={onRetry} data-testid="weread-annual-review-retry">
            <RefreshCw size={14} aria-hidden="true" /> 重新加载
          </button>
        </p>
      ) : null}

      {/* Overview cards */}
      <section
        className="weread-annual-review__overview"
        data-testid="weread-annual-review-overview"
        aria-label="年度概览"
      >
        <OverviewCard label="全年阅读记录" value={rhythm.totalRecords} hint="含有效日期" />
        <OverviewCard label="活跃月份" value={rhythm.activeMonths} hint={`最长连续 ${rhythm.longestStreakMonths} 个月`} />
        <OverviewCard label="已匹配记录" value={response.overview.matchedRecords} hint={`覆盖 ${rhythm.matchedBooks} 本`} />
        <OverviewCard label="年度书目" value={rhythm.matchedBooks} hint="仅公共匹配" />
        <OverviewCard
          label="高峰月份"
          value={rhythm.peakMonth ? formatAnnualReviewMonth(rhythm.peakMonth) : "—"}
          hint={
            rhythm.peakMonthRecords > 0
              ? `${rhythm.peakMonthRecords} 条记录`
              : "暂无数据"
          }
        />
        <OverviewCard
          label="每月平均"
          value={
            rhythm.averageRecordsPerActiveMonth > 0
              ? String(Math.round(rhythm.averageRecordsPerActiveMonth * 100) / 100)
              : "—"
          }
          hint={`基于 ${rhythm.activeMonths} 个活跃月份`}
        />
      </section>

      {/* 12-month timeline */}
      <section
        className="weread-annual-review__timeline"
        data-testid="weread-annual-review-timeline"
        aria-label={`${response.selectedYear} 年月度阅读时间轴`}
      >
        <h3 className="weread-annual-review__section-title">
          <BarChart3 size={14} aria-hidden="true" /> {response.selectedYear} 年 12 个月时间轴
        </h3>
        <TimelineChart months={timeline} />
        <p className="weread-annual-review__a11y-hint">
          以下为同一数据的可访问文本列表（柱状图下方）。
        </p>
        <ol className="weread-annual-review__timeline-list">
          {timeline.map((m) => (
            <li key={m.month}>
              {formatAnnualReviewMonth(m.month)}：记录 {m.total}（划线 {m.highlights}，想法 {m.thoughts}，书评 {m.reviews}，未知 {m.unknown}），已匹配书目 {m.bookCount} 本，活跃度 {ANNUAL_ACTIVITY_LABELS[m.activity]}。
            </li>
          ))}
        </ol>
      </section>

      {/* Type distribution */}
      <section className="weread-annual-review__types" data-testid="weread-annual-review-types" aria-label="类型分布">
        <h3 className="weread-annual-review__section-title">类型分布</h3>
        <ul className="weread-annual-review__type-list">
          <TypeRow label="划线" value={typeDistribution.highlights} total={typeDistribution.total} />
          <TypeRow label="想法" value={typeDistribution.thoughts} total={typeDistribution.total} />
          <TypeRow label="书评" value={typeDistribution.reviews} total={typeDistribution.total} />
          <TypeRow label="未知类型" value={typeDistribution.unknown} total={typeDistribution.total} />
        </ul>
      </section>

      {/* Quarters */}
      <section className="weread-annual-review__quarters" data-testid="weread-annual-review-quarters" aria-label="季度阅读节奏">
        <h3 className="weread-annual-review__section-title">季度阅读节奏</h3>
        <p className="weread-annual-review__disclaimer" data-testid="weread-annual-review-disclaimer">
          以下为基于记录数量的描述性分类，不代表阅读质量或个人状态。
        </p>
        <div className="weread-annual-review__quarter-grid">
          {quarters.map((q) => (
            <QuarterCard key={q.quarter} quarter={q} yearTotal={quarters.reduce((acc, x) => acc + x.total, 0)} />
          ))}
        </div>
      </section>

      {/* Top books */}
      <section className="weread-annual-review__books" data-testid="weread-annual-review-books" aria-label="年度高互动书目">
        <h3 className="weread-annual-review__section-title">年度高互动书目</h3>
        {response.topBooks.length === 0 ? (
          <p className="weread-annual-review__empty">
            {isEmptyYear
              ? "该年度暂无已匹配的高互动书目。"
              : "该年度暂无已匹配的高互动书目。"}
          </p>
        ) : (
          <ul className="weread-annual-review__book-grid">
            {response.topBooks.map((book) => (
              <li key={book.catalogId} className="weread-annual-review__book-card" data-catalog-id={book.catalogId}>
                <a
                  href={`/books/${book.catalogId}`}
                  className="weread-annual-review__book-title"
                  data-testid="weread-annual-review-book-link"
                >
                  {truncateAnnualBookTitle(book.title, 24)}
                  <ChevronRight size={12} aria-hidden="true" />
                </a>
                {book.author ? (
                  <span className="weread-annual-review__book-author">{book.author}</span>
                ) : null}
                <dl className="weread-annual-review__book-meta">
                  {(book.publisher || book.publishYear) ? (
                    <div className="weread-annual-review__book-meta-row">
                      <dt>出版社 / 年份</dt>
                      <dd>
                        {book.publisher ? book.publisher : "—"}
                        {book.publishYear ? ` · ${book.publishYear}` : ""}
                      </dd>
                    </div>
                  ) : null}
                  <div className="weread-annual-review__book-meta-row">
                    <dt>年度记录数</dt>
                    <dd>{book.noteCount}</dd>
                  </div>
                  <div className="weread-annual-review__book-meta-row">
                    <dt>活跃月份</dt>
                    <dd>{book.activeMonths}</dd>
                  </div>
                  <div className="weread-annual-review__book-meta-row">
                    <dt>类型分布</dt>
                    <dd>
                      划线 {book.highlights} · 想法 {book.thoughts} · 书评 {book.reviews} · 未知 {book.unknown}
                    </dd>
                  </div>
                  <div className="weread-annual-review__book-meta-row">
                    <dt>首次 / 最后记录</dt>
                    <dd>
                      {formatAnnualReviewDate(book.firstNoteAt)} → {formatAnnualReviewDate(book.lastNoteAt)}
                    </dd>
                  </div>
                </dl>
                <a
                  href={`/books/${book.catalogId}`}
                  className="weread-annual-review__book-cta"
                  data-testid="weread-annual-review-book-cta"
                >
                  查看书目
                  <ChevronRight size={12} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Record cards */}
      <section className="weread-annual-review__records" data-testid="weread-annual-review-records" aria-label="年度记录卡">
        <h3 className="weread-annual-review__section-title">
          <Sparkles size={14} aria-hidden="true" /> 年度记录卡
        </h3>
        <ul className="weread-annual-review__record-grid">
          {recordCards.map((card) => (
            <li key={card.key} className="weread-annual-review__record-card" data-record-card={card.key}>
              <span className="weread-annual-review__record-label">{card.label}</span>
              <span className="weread-annual-review__record-value">{card.value}</span>
            </li>
          ))}
        </ul>
        <p className="weread-annual-review__record-disclaimer" data-testid="weread-annual-review-record-disclaimer">
          仅基于阅读记录数量与日期统计；不代表阅读偏好、人格特征或专注力。
        </p>
      </section>

      {/* Empty-state year (still rendered with zero timeline) */}
      {isEmptyYear ? (
        <p className="weread-annual-review__empty" data-testid="weread-annual-review-empty">
          该年度暂无有效日期的阅读记录。
        </p>
      ) : null}

      {/* Used to satisfy TS unused-import warning for NOW_INJECTION. */}
      <span hidden>{NOW_INJECTION().toISOString()}</span>
    </section>
  );
}

// ---------- subcomponents ----------

function OverviewCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="weread-annual-review__overview-card">
      <span className="weread-annual-review__overview-label">{label}</span>
      <span className="weread-annual-review__overview-value">{value}</span>
      {hint ? <span className="weread-annual-review__overview-hint">{hint}</span> : null}
    </div>
  );
}

function TypeRow({ label, value, total }: { label: string; value: number; total: number }) {
  const ratio = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <li className="weread-annual-review__type-row">
      <span className="weread-annual-review__type-label">{label}</span>
      <span className="weread-annual-review__type-value">{value}</span>
      <span className="weread-annual-review__type-ratio">{ratio}%</span>
      <span className="weread-annual-review__type-bar" aria-hidden="true">
        <span className="weread-annual-review__type-bar-fill" style={{ width: `${ratio}%` }} />
      </span>
    </li>
  );
}

function QuarterCard({
  quarter,
  yearTotal,
}: {
  quarter: ReturnType<typeof buildQuarterReviewModel>[number];
  yearTotal: number;
}) {
  const yearShare = yearTotal > 0 ? Math.round((quarter.shareOfYear || 0) * 100) : 0;
  return (
    <article className="weread-annual-review__quarter" data-quarter={quarter.quarter}>
      <header className="weread-annual-review__quarter-header">
        <h4>{quarter.label}</h4>
        <span className="weread-annual-review__quarter-share">{yearShare}%</span>
      </header>
      <dl className="weread-annual-review__quarter-meta">
        <div>
          <dt>记录数</dt>
          <dd>{quarter.total}</dd>
        </div>
        <div>
          <dt>活跃月份</dt>
          <dd>{quarter.activeMonths}</dd>
        </div>
        <div>
          <dt>匹配书目</dt>
          <dd>{quarter.bookCount}</dd>
        </div>
        <div>
          <dt>匹配记录</dt>
          <dd>{quarter.matchedRecords}</dd>
        </div>
      </dl>
      <ul className="weread-annual-review__quarter-months" aria-label="月度活跃度分类">
        {quarter.monthActivity.map((act, idx) => (
          <li key={idx} className={`weread-annual-review__quarter-month weread-annual-review__quarter-month--${act}`}>
            {ANNUAL_ACTIVITY_LABELS[act]}
          </li>
        ))}
      </ul>
    </article>
  );
}

function TimelineChart({
  months,
}: {
  months: ReturnType<typeof buildAnnualTimelineModel>;
}) {
  // Hand-built SVG: 12 vertical bars with stacked type segments.
  const W = 720;
  const H = 220;
  const padX = 16;
  const padY = 24;
  const chartW = W - padX * 2;
  const chartH = H - padY * 2;
  const maxTotal = months.reduce((acc, m) => Math.max(acc, m.total), 0);
  const barCount = months.length;
  const slot = chartW / barCount;
  const barWidth = Math.max(8, Math.min(36, slot * 0.7));
  return (
    <svg
      className="weread-annual-review__timeline-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="12 个月阅读记录时间轴"
      data-testid="weread-annual-review-timeline-svg"
    >
      <rect x={0} y={0} width={W} height={H} fill="transparent" />
      {months.map((m, idx) => {
        const x = padX + idx * slot + (slot - barWidth) / 2;
        const total = m.total;
        const ratio = maxTotal > 0 ? total / maxTotal : 0;
        const fullH = chartH * ratio;
        const segments: Array<{ key: string; value: number; cls: string }> = [
          { key: "highlights", value: m.highlights, cls: "weread-annual-review__bar-segment--highlights" },
          { key: "thoughts", value: m.thoughts, cls: "weread-annual-review__bar-segment--thoughts" },
          { key: "reviews", value: m.reviews, cls: "weread-annual-review__bar-segment--reviews" },
          { key: "unknown", value: m.unknown, cls: "weread-annual-review__bar-segment--unknown" },
        ];
        let segY = padY + chartH - fullH;
        return (
          <g key={m.month} className={`weread-annual-review__bar weread-annual-review__bar--${m.activity}`} data-month={m.month} data-total={m.total}>
            <title>
              {formatAnnualReviewMonth(m.month)}：记录 {total}（划线 {m.highlights}，想法 {m.thoughts}，书评 {m.reviews}，未知 {m.unknown}），已匹配 {m.bookCount} 本，活跃度 {ANNUAL_ACTIVITY_LABELS[m.activity]}
            </title>
            {segments.map((seg) => {
              if (seg.value <= 0 || total <= 0 || maxTotal <= 0) return null;
              const segH = (seg.value / total) * fullH;
              const y = segY;
              segY += segH;
              return (
                <rect
                  key={seg.key}
                  className={`weread-annual-review__bar-segment ${seg.cls}`}
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(0.5, segH)}
                  rx={2}
                />
              );
            })}
            <text
              className="weread-annual-review__bar-label"
              x={x + barWidth / 2}
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