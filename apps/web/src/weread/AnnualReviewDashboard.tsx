/**
 * S27J / S27J-2 / S27K — AnnualReviewDashboard
 *
 * Pure front-end dashboard for the private WeRead "annual reading
 * review" workspace. Mirrors the privacy contract of the S27H / S27I
 * dashboards.
 *
 * S27J-2 adds a browser-local Markdown export button. The Markdown
 * file is built entirely from the response the dashboard already
 * holds (no extra fetch, no AI call, no storage).
 *
 * S27K adds an opt-in year-over-year comparison view. The comparison
 * is built from two cached `WereadAnnualReviewResponse` payloads
 * (the same shape the dashboard already loads). When the toggle is
 * closed, no second request is fired. When opened, the dashboard
 * loads the base year (or reuses the cache), then renders the
 * `YearComparisonPanel`.
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
 *     server. Token clearing drops the in-memory response and
 *     comparison cache immediately.
 *   - 12-month timeline is rendered as a hand-built SVG bar chart —
 *     no third-party chart library.
 *   - S27J-2: Markdown export consumes the response already held in
 *     `state.response`. No new API request, no AI call, no storage.
 *   - S27K: Year comparison is computed from the cached responses.
 *     No new endpoint, no AI call, no storage. The comparison cache
 *     lives in component memory only and is dropped on token
 *     change / unmount.
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
import YearComparisonPanel from "./YearComparisonPanel";
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
  /** S27L — optional year requested by the long-term archive. When
   *  this value changes the dashboard switches to that year (if it
   *  exists in the loaded `availableYears`). */
  requestedYear?: number | null;
  /** S27L — invoked once after the dashboard has applied the
   *  requested-year hint. The parent can clear its local state to
   *  avoid re-applying the same hint on the next render. */
  onRequestedYearApplied?: () => void;
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

interface ComparisonState {
  enabled: boolean;
  baseYear: number | null;
  targetYear: number | null;
  baseResponse: WereadAnnualReviewResponse | null;
  baseStatus: "idle" | "loading" | "ok" | "error";
  baseError: string | null;
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

const INITIAL_COMPARISON: ComparisonState = {
  enabled: false,
  baseYear: null,
  targetYear: null,
  baseResponse: null,
  baseStatus: "idle",
  baseError: null,
};

const NOW_INJECTION = () => new Date();

function compareKey(year: number, topBooks: WereadAnnualReviewTopBooksOption): string {
  return `${year}:${topBooks}`;
}

export default function AnnualReviewDashboard({ token, active, requestedYear, onRequestedYearApplied }: AnnualReviewDashboardProps) {
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const [comparison, setComparison] = useState<ComparisonState>(INITIAL_COMPARISON);
  const abortRef = useRef<AbortController | null>(null);
  const compareAbortRef = useRef<AbortController | null>(null);
  const lastRequestTokenRef = useRef<string>("");
  // S27K — in-memory cache of annual-review responses keyed by
  // `${year}:${topBooks}`. Lives only for the dashboard's lifetime.
  const compareCacheRef = useRef<Map<string, WereadAnnualReviewResponse>>(new Map());
  // S27K — guards against issuing two concurrent requests for the
  // same compare key.
  const compareInflightRef = useRef<Set<string>>(new Set());

  // Reset on token change.
  useEffect(() => {
    if (!token) {
      abortRef.current?.abort();
      compareAbortRef.current?.abort();
      lastRequestTokenRef.current = "";
      compareCacheRef.current.clear();
      compareInflightRef.current.clear();
      setState(INITIAL_STATE);
      setComparison(INITIAL_COMPARISON);
      return;
    }
    lastRequestTokenRef.current = "";
    compareCacheRef.current.clear();
    compareInflightRef.current.clear();
    setState((prev) => ({
      ...prev,
      response: null,
      status: "idle",
      error: null,
      selectedYear: null,
      exportStatus: "idle",
      exportMessage: "",
    }));
    setComparison(INITIAL_COMPARISON);
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
      compareAbortRef.current?.abort();
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

  // S27L — when the long-term archive requests a specific year,
  // switch the dashboard to that year. Cached responses are re-used
  // by `fetchWereadAnnualReview` semantics (the server returns the
  // requested year when it is in `availableYears`). We never loop:
  // the effect fires only when `requestedYear` changes or when the
  // loaded response makes the year available. Once we apply the
  // hint we notify the parent so it can clear its local state.
  const lastRequestedYearRef = useRef<number | null>(null);
  useEffect(() => {
    if (requestedYear === undefined || requestedYear === null) return;
    if (!Number.isInteger(requestedYear)) return;
    if (lastRequestedYearRef.current === requestedYear) return;
    if (!token) return;
    if (!state.response) return; // wait for the initial load to land
    const available = state.response.availableYears;
    if (Array.isArray(available) && available.length > 0 && !available.includes(requestedYear)) {
      // Year not available — record the hint so we don't loop, but
      // still notify the parent so it can clear the state.
      lastRequestedYearRef.current = requestedYear;
      onRequestedYearApplied?.();
      return;
    }
    lastRequestedYearRef.current = requestedYear;
    if (state.selectedYear !== requestedYear) {
      requestAnnualReview(requestedYear, state.topBooks);
    }
    onRequestedYearApplied?.();
  }, [
    requestedYear,
    token,
    state.response,
    state.selectedYear,
    state.topBooks,
    requestAnnualReview,
    onRequestedYearApplied,
  ]);

  // S27K — write the freshly-loaded response into the compare cache
  // so the comparison view can re-use it without re-fetching.
  useEffect(() => {
    if (!state.response) return;
    if (state.selectedYear === null) return;
    const key = compareKey(state.selectedYear, state.topBooks);
    compareCacheRef.current.set(key, state.response);
  }, [state.response, state.selectedYear, state.topBooks]);

  // S27K — fetch (or reuse) the base year response for comparison.
  const loadCompareYear = useCallback(
    (year: number, topBooks: WereadAnnualReviewTopBooksOption) => {
      if (!token) return;
      const key = compareKey(year, topBooks);
      const cached = compareCacheRef.current.get(key);
      if (cached) {
        setComparison((prev) => ({
          ...prev,
          baseYear: year,
          baseResponse: cached,
          baseStatus: "ok",
          baseError: null,
        }));
        return;
      }
      if (compareInflightRef.current.has(key)) {
        // A concurrent request is already on its way; do not duplicate.
        return;
      }
      compareInflightRef.current.add(key);
      compareAbortRef.current?.abort();
      const controller = new AbortController();
      compareAbortRef.current = controller;
      setComparison((prev) => ({
        ...prev,
        baseYear: year,
        baseStatus: "loading",
        baseError: null,
      }));
      fetchWereadAnnualReview(token, {
        year,
        topBooks,
        signal: controller.signal,
      })
        .then((resp) => {
          compareInflightRef.current.delete(key);
          if (controller.signal.aborted) return;
          compareCacheRef.current.set(key, resp);
          setComparison((prev) => ({
            ...prev,
            baseResponse: resp,
            baseStatus: "ok",
            baseError: null,
          }));
        })
        .catch((err: unknown) => {
          compareInflightRef.current.delete(key);
          if (controller.signal.aborted) return;
          const msg = err instanceof Error ? err.message : "对比年度加载失败";
          setComparison((prev) => ({
            ...prev,
            baseStatus: "error",
            baseError: msg,
          }));
        });
    },
    [token]
  );

  // S27K — derive the default base year from `availableYears`.
  const deriveDefaultBaseYear = useCallback(
    (targetYear: number): number | null => {
      const available = state.response?.availableYears ?? [];
      const candidates = available.filter((y) => y !== targetYear);
      if (candidates.length === 0) return null;
      const older = candidates.filter((y) => y < targetYear);
      const pool = older.length > 0 ? older : candidates;
      let best = pool[0];
      for (const y of pool) {
        if (y > (best ?? 0)) best = y;
      }
      return best ?? null;
    },
    [state.response]
  );

  const handleToggleComparison = useCallback(() => {
    if (!state.response || state.selectedYear === null) return;
    setComparison((prev) => {
      const nextEnabled = !prev.enabled;
      if (!nextEnabled) {
        compareAbortRef.current?.abort();
        return { ...INITIAL_COMPARISON };
      }
      const targetYear = state.selectedYear;
      if (targetYear === null) {
        return { ...INITIAL_COMPARISON, enabled: true };
      }
      const baseYear =
        prev.baseYear && prev.baseYear !== targetYear
          ? prev.baseYear
          : deriveDefaultBaseYear(targetYear);
      return {
        ...prev,
        enabled: true,
        targetYear,
        baseYear: baseYear ?? null,
        baseStatus: baseYear === null ? "idle" : prev.baseStatus,
        baseResponse: baseYear === null ? null : prev.baseResponse,
        baseError: baseYear === null ? null : prev.baseError,
      };
    });
  }, [state.response, state.selectedYear, deriveDefaultBaseYear]);

  // When the toggle is enabled and the base year changes, fetch it.
  useEffect(() => {
    if (!comparison.enabled) return;
    if (comparison.baseYear === null) return;
    if (comparison.baseResponse && comparison.baseResponse.selectedYear === comparison.baseYear) return;
    loadCompareYear(comparison.baseYear, state.topBooks);
  }, [
    comparison.enabled,
    comparison.baseYear,
    comparison.baseResponse,
    loadCompareYear,
    state.topBooks,
  ]);

  // Sync the target year whenever the main dashboard's selected year
  // changes — but only if the user has not pinned a different year
  // AND the target year still matches the previous main year. If the
  // user has already swapped (so target differs from main), leave
  // the swapped values alone.
  useEffect(() => {
    if (!comparison.enabled) return;
    if (state.selectedYear === null) return;
    if (comparison.targetYear === state.selectedYear) return;
    // If targetYear differs from the previous main year, the user
    // (or swap) intentionally set a different target. Do not overwrite.
    const previousMain = mainYearRef.current;
    if (comparison.targetYear !== previousMain && comparison.targetYear !== state.selectedYear) {
      return;
    }
    setComparison((prev) => ({
      ...prev,
      targetYear: state.selectedYear,
      // Re-derive the base year when the main year changes.
      baseYear:
        prev.baseYear && prev.baseYear !== state.selectedYear
          ? prev.baseYear
          : state.selectedYear !== null
            ? deriveDefaultBaseYear(state.selectedYear)
            : null,
    }));
  }, [comparison.enabled, comparison.targetYear, state.selectedYear, deriveDefaultBaseYear]);

  const handleCompareBaseYearChange = useCallback(
    (next: number) => {
      if (next === comparison.baseYear) return;
      if (comparison.targetYear !== null && next === comparison.targetYear) {
        // Disallow picking the same year as the target.
        return;
      }
      setComparison((prev) => ({
        ...prev,
        baseYear: next,
        baseResponse: null,
        baseStatus: "loading",
        baseError: null,
      }));
      loadCompareYear(next, state.topBooks);
    },
    [comparison.baseYear, comparison.targetYear, loadCompareYear, state.topBooks]
  );

  const handleCompareTargetYearChange = useCallback(
    (next: number) => {
      if (next === comparison.targetYear) return;
      if (comparison.baseYear !== null && next === comparison.baseYear) {
        return;
      }
      setComparison((prev) => ({
        ...prev,
        targetYear: next,
      }));
    },
    [comparison.baseYear, comparison.targetYear]
  );

  // S27K — keep a ref to the comparison state so handlers can read
  // the latest base/target year without having stale closure values.
  const comparisonRef = useRef<ComparisonState>(INITIAL_COMPARISON);
  useEffect(() => {
    comparisonRef.current = comparison;
  }, [comparison]);

  // S27K — track the previous main year so we can distinguish between
  // "main year changed by user" (sync target) and "user swapped
  // target away from main" (leave target alone).
  const mainYearRef = useRef<number | null>(null);
  useEffect(() => {
    mainYearRef.current = state.selectedYear;
  }, [state.selectedYear]);

  const handleCompareSwap = useCallback(() => {
    const prev = comparisonRef.current;
    if (prev.baseYear === null || prev.targetYear === null) return;
    const newTarget = prev.baseYear;
    const newBase = prev.targetYear;
    setComparison({
      ...prev,
      targetYear: newTarget,
      baseYear: newBase,
      baseResponse: null,
      baseStatus: "loading",
      baseError: null,
    });
    loadCompareYear(newBase, state.topBooks);
  }, [loadCompareYear, state.topBooks]);

  const handleCompareClose = useCallback(() => {
    compareAbortRef.current?.abort();
    setComparison(INITIAL_COMPARISON);
  }, []);

  const handleCompareRetry = useCallback(() => {
    if (comparison.baseYear === null) return;
    loadCompareYear(comparison.baseYear, state.topBooks);
  }, [comparison.baseYear, loadCompareYear, state.topBooks]);

  const handleCompareTopBooksChange = useCallback(
    (next: WereadAnnualReviewTopBooksOption) => {
      // Force both years to use the same topBooks range. Update
      // the dashboard's topBooks (which re-fetches the main year)
      // and invalidate the cached base response for the old range.
      if (next === state.topBooks) return;
      compareCacheRef.current.clear();
      setComparison((prev) => ({
        ...prev,
        baseResponse: null,
        baseStatus: prev.baseYear === null ? "idle" : "loading",
        baseError: null,
      }));
      requestAnnualReview(state.selectedYear, next);
    },
    [state.topBooks, state.selectedYear, requestAnnualReview]
  );

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
    <>
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
        comparison={comparison}
        availableYearsForComparison={response.availableYears}
        onToggleComparison={handleToggleComparison}
        onCloseComparison={handleCompareClose}
        onSwapComparison={handleCompareSwap}
        onRetryComparison={handleCompareRetry}
        onChangeBaseYear={handleCompareBaseYearChange}
        onChangeTargetYear={handleCompareTargetYearChange}
        onChangeComparisonTopBooks={handleCompareTopBooksChange}
      />
    </>
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
  comparison: ComparisonState;
  availableYearsForComparison: number[];
  onToggleComparison: () => void;
  onCloseComparison: () => void;
  onSwapComparison: () => void;
  onRetryComparison: () => void;
  onChangeBaseYear: (next: number) => void;
  onChangeTargetYear: (next: number) => void;
  onChangeComparisonTopBooks: (next: WereadAnnualReviewTopBooksOption) => void;
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
  comparison,
  availableYearsForComparison,
  onToggleComparison,
  onCloseComparison,
  onSwapComparison,
  onRetryComparison,
  onChangeBaseYear,
  onChangeTargetYear,
  onChangeComparisonTopBooks,
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
    <>
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

    <ComparisonControls
      enabled={comparison.enabled}
      comparison={comparison}
      availableYears={availableYearsForComparison}
      targetYear={comparison.targetYear ?? selectedYear ?? response.selectedYear}
      topBooks={topBooks}
      onToggle={onToggleComparison}
      onChangeBaseYear={onChangeBaseYear}
      onChangeTargetYear={onChangeTargetYear}
      onSwap={onSwapComparison}
      onClose={onCloseComparison}
    />

    {comparison.enabled && comparison.baseResponse && comparison.targetYear !== null && comparison.baseYear !== null ? (
      <YearComparisonPanel
        base={comparison.baseResponse}
        target={response}
        topBooksRange={topBooks}
        errorMessage={comparison.baseStatus === "error" ? comparison.baseError : null}
        onRetry={onRetryComparison}
        onSwap={onSwapComparison}
        onClose={onCloseComparison}
        onTopBooksRangeChange={onChangeComparisonTopBooks}
      />
    ) : null}

    {comparison.enabled && comparison.baseStatus === "loading" ? (
      <div className="weread-year-comparison weread-year-comparison--loading" data-testid="weread-year-comparison-loading" aria-label="年度对比加载中">
        <p>正在加载基准年度…</p>
      </div>
    ) : null}

    {comparison.enabled && comparison.baseStatus === "error" && !comparison.baseResponse ? (
      <div className="weread-year-comparison weread-year-comparison--error" data-testid="weread-year-comparison-error-base" role="alert">
        <p>基准年度加载失败：{comparison.baseError ?? "未知错误"}</p>
        <button type="button" className="weread-year-comparison__retry" onClick={onRetryComparison} data-testid="weread-year-comparison-retry-base">
          重试基准年度
        </button>
      </div>
    ) : null}
  </>);
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
// ---------- S27K comparison controls ----------

interface ComparisonControlsProps {
  enabled: boolean;
  comparison: ComparisonState;
  availableYears: number[];
  targetYear: number;
  topBooks: WereadAnnualReviewTopBooksOption;
  onToggle: () => void;
  onChangeBaseYear: (next: number) => void;
  onChangeTargetYear: (next: number) => void;
  onSwap: () => void;
  onClose: () => void;
}

function ComparisonControls({
  enabled,
  comparison,
  availableYears,
  targetYear,
  onToggle,
  onChangeBaseYear,
  onChangeTargetYear,
}: ComparisonControlsProps) {
  const years = availableYears.length > 0 ? availableYears : [targetYear];
  const comparableCount = years.length;
  const disabled = comparableCount < 2;
  const currentBase = comparison.baseYear;
  const baseYearOptions = years.filter((y) => y !== targetYear);
  const baseOptions = baseYearOptions.length > 0 ? baseYearOptions : years;
  const targetOptions = years.filter((y) => y !== currentBase);
  return (
    <div className="weread-year-comparison__controls" data-testid="weread-year-comparison-controls-root">
      <button
        type="button"
        className="weread-year-comparison__toggle"
        onClick={onToggle}
        disabled={disabled && !enabled}
        data-testid="weread-year-comparison-toggle"
        aria-pressed={enabled}
      >
        {enabled ? "关闭年度对比" : "开启年度对比"}
      </button>
      {disabled && !enabled ? (
        <p className="weread-year-comparison__controls-hint" data-testid="weread-year-comparison-controls-hint">
          至少需要两个有记录的年份才能进行年度对比。
        </p>
      ) : null}
      {enabled ? (
        <div className="weread-year-comparison__selectors" data-testid="weread-year-comparison-selectors">
          <label>
            <span>基准年份</span>
            <select
              value={comparison.baseYear ?? ""}
              onChange={(e) => onChangeBaseYear(Number(e.target.value))}
              data-testid="weread-year-comparison-base-year"
              aria-label="选择对比基准年份"
              disabled={baseOptions.length === 0}
            >
              {baseOptions.map((y) => (
                <option key={y} value={y}>
                  {formatAnnualReviewYear(y)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>目标年份</span>
            <select
              value={targetYear}
              onChange={(e) => onChangeTargetYear(Number(e.target.value))}
              data-testid="weread-year-comparison-target-year"
              aria-label="选择对比目标年份"
              disabled={targetOptions.length === 0}
            >
              {targetOptions.map((y) => (
                <option key={y} value={y}>
                  {formatAnnualReviewYear(y)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}
