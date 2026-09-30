import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Lock, Loader2, AlertCircle, RefreshCw, Shield, EyeOff, BarChart3, Library, Map, CalendarClock, Calendar, Archive } from "lucide-react";
import {
  clearWereadStatusCache,
  fetchWereadSummary,
  fetchWereadTrends,
  formatWereadCenterSummary,
  purgeLegacyWereadTokenStorage,
  type WereadSummary,
  type WereadTrends,
} from "../wereadPrivate";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { GoogleLoginPanel } from "../auth/GoogleLoginPanel";
import {
  formatTrendWindow,
  getActivityLevel,
  getTrendCards,
  getTrendCoverageLabel,
  type WereadTrendView,
} from "./wereadCenterModel";
import NotesLibrary from "./NotesLibrary";
import ReadingMapDashboard from "./ReadingMapDashboard";
import ReviewCalendarDashboard from "./ReviewCalendarDashboard";
import AnnualReviewDashboard from "./AnnualReviewDashboard";
import ReadingArchiveDashboard from "./ReadingArchiveDashboard";
import {
  EMPTY_SESSION_THEME_OVERLAY,
  sessionThemeOverlayKey,
  type WereadSessionThemeOverlay,
} from "./wereadSessionThemeModel";

type WorkspaceTab = "notes" | "map" | "review" | "annual" | "archive";

function StatCard({
  label,
  value,
  suffix,
  hint,
}: {
  label: string;
  value: number | string;
  suffix?: string;
  hint?: string;
}) {
  return (
    <div className="weread-stat-card">
      <span className="weread-stat-card__label">{label}</span>
      <span className="weread-stat-card__value">
        {value}
        {suffix ? <span className="weread-stat-card__suffix">{suffix}</span> : null}
      </span>
      {hint ? <span className="weread-stat-card__hint">{hint}</span> : null}
    </div>
  );
}

function PrivacyItem({ text }: { text: string }) {
  return (
    <li className="weread-privacy-card__item">
      <Shield size={14} aria-hidden="true" />
      <span>{text}</span>
    </li>
  );
}

function TrendBars({ daily }: { daily: Array<{ date: string; total: number }> }) {
  if (daily.length === 0) {
    return <div className="weread-trend-bars__empty">暂无最近 30 天的每日记录。</div>;
  }
  const max = Math.max(1, ...daily.map((d) => d.total));
  return (
    <div className="weread-trend-bars" aria-label="最近 30 天每日新增">
      {daily.map((d) => {
        const heightPct = Math.round((d.total / max) * 100);
        return (
          <div key={d.date} className="weread-trend-bar" title={`${d.date}: ${d.total}`}>
            <div className="weread-trend-bar__fill" style={{ height: `${heightPct}%` }} />
            <span className="weread-trend-bar__label">{d.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function TrendContent({ trends }: { trends: WereadTrends }) {
  const view: WereadTrendView = formatTrendWindow(trends);
  const cards = getTrendCards(view);
  const activity = getActivityLevel(view);
  const activityLabels: Record<typeof activity, string> = {
    quiet: "静默期",
    normal: "正常",
    active: "活跃",
    intense: "非常活跃",
  };
  return (
    <>
      <div className="weread-trend-meta">
        <span className="weread-trend-meta__pill">{activityLabels[activity]}</span>
        <span>日期覆盖率 {getTrendCoverageLabel(view)}</span>
      </div>
      <div className="weread-trend-block">
        <span className="weread-trend-block__label">时间窗口</span>
        <div className="weread-trend-grid weread-trend-grid--2col">
          {cards.map((card) => (
            <StatCard key={card.label} label={card.label} value={card.value} />
          ))}
        </div>
      </div>
      <div className="weread-trend-block">
        <span className="weread-trend-block__label">类型分布（全部时间）</span>
        <div className="weread-trend-grid weread-trend-grid--2col">
          <StatCard label="划线" value={view.highlightsTotal} />
          <StatCard label="想法" value={view.thoughtsTotal} />
          <StatCard label="书评" value={view.reviewsTotal} />
          <StatCard label="未知类型" value={view.unknownTotal} />
        </div>
      </div>
      <div className="weread-trend-block weread-trend-block--chart">
        <span className="weread-trend-block__label">最近 30 天每日新增</span>
        <TrendBars daily={view.daily30} />
      </div>
      <p className="weread-center-card__note">
        <EyeOff size={14} aria-hidden="true" />
        只显示数量统计，不显示笔记或划线的原文，不返回微信读书内部 ID。
      </p>
    </>
  );
}

// S27D-UI-POLISH: KPI cards — 6 main metrics in a single grid.
const KPI_LABELS = {
  books: "书架",
  notes: "笔记",
  matchedBooks: "已匹配书目",
  matchedWithNotes: "有笔记的匹配书",
  matchedWithHighlights: "有划线的匹配书",
  matchedNoteRecords: "已匹配笔记记录",
} as const;

export default function WereadCenter() {
  const session = useWebAuthSession();
  const authenticated = session.status === "authenticated";
  const [summary, setSummary] = useState<WereadSummary | null>(null);
  const [trends, setTrends] = useState<WereadTrends | null>(null);
  const [trendsStatus, setTrendsStatus] = useState<"idle" | "loading" | "error" | "ok">("idle");
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "disabled">("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("notes");
  const [mapActivated, setMapActivated] = useState(false);
  const [reviewActivated, setReviewActivated] = useState(false);
  const [annualActivated, setAnnualActivated] = useState(false);
  const [archiveActivated, setArchiveActivated] = useState(false);
  // S27L — when the long-term archive asks the dashboard to switch
  // to a specific year, set this so AnnualReviewDashboard picks it
  // up. Cleared by the dashboard once applied.
  const [requestedAnnualReviewYear, setRequestedAnnualReviewYear] = useState<number | null>(null);

  // S27H-2: lifted session-theme overlay. NotesLibrary emits changes
  // whenever its AI summary state or loaded items change; ReadingMap
  // reads the same overlay to draw the focus ring without ever
  // receiving note text, comment, overview, key points, or private IDs.
  const [sessionThemeOverlay, setSessionThemeOverlay] = useState<WereadSessionThemeOverlay>(
    EMPTY_SESSION_THEME_OVERLAY
  );
  const lastSessionOverlayKeyRef = useRef<string>(sessionThemeOverlayKey(EMPTY_SESSION_THEME_OVERLAY));
  const handleSessionOverlayChange = useCallback((overlay: WereadSessionThemeOverlay) => {
    const key = sessionThemeOverlayKey(overlay);
    if (key === lastSessionOverlayKeyRef.current) return;
    lastSessionOverlayKeyRef.current = key;
    setSessionThemeOverlay(overlay);
  }, []);

  // Task 9: session-driven lifecycle. One-time purge of the legacy
  // sessionStorage token key (never read, never used for auth).
  useEffect(() => {
    purgeLegacyWereadTokenStorage();
  }, []);

  useEffect(() => {
    if (authenticated) {
      loadSummary();
    } else {
      // logout / unauthenticated: drop every private surface immediately.
      clearWereadStatusCache();
      setSummary(null);
      setTrends(null);
      setTrendsStatus("idle");
      setTrendsError(null);
      setStatus("idle");
      setError(null);
      setActiveTab("notes");
      setMapActivated(false);
      setReviewActivated(false);
      setAnnualActivated(false);
      setArchiveActivated(false);
      setRequestedAnnualReviewYear(null);
      lastSessionOverlayKeyRef.current = sessionThemeOverlayKey(EMPTY_SESSION_THEME_OVERLAY);
      setSessionThemeOverlay(EMPTY_SESSION_THEME_OVERLAY);
    }
  }, [authenticated]);

  // S27L — clear the long-term archive's requested-year hint once
  // the user has switched to the annual-review tab so a manual
  // year change in the dashboard is not immediately overridden.
  useEffect(() => {
    if (requestedAnnualReviewYear !== null && activeTab === "annual") {
      const t = setTimeout(() => setRequestedAnnualReviewYear(null), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [requestedAnnualReviewYear, activeTab, annualActivated]);

  async function loadSummary() {
    setStatus("loading");
    setError(null);
    try {
      const s = await fetchWereadSummary();
      if (s.ok) {
        setSummary(s);
        setStatus("idle");
        void loadTrends();
      } else {
        // Task 9: a not-ok summary never mounts the private workspace and
        // never chains the trends/notes/map fetches.
        setSummary(null);
        setStatus("error");
        setError("私有 API 返回异常");
      }
    } catch (err) {
      setStatus("error");
      const msg = err instanceof Error ? err.message : "连接失败";
      if (/401|403|unauthorized|认证失败|登录已失效|登录安全校验/i.test(msg)) {
        setStatus("disabled");
        setError("登录已失效，请重新登录");
      } else if (/disabled|not enabled|未启用/i.test(msg)) {
        setStatus("disabled");
        setError("私有 API 未启用");
      } else {
        setError(msg || "连接失败");
      }
    }
  }

  async function loadTrends() {
    setTrendsStatus("loading");
    setTrendsError(null);
    try {
      const resp = await fetchWereadTrends();
      if (resp.ok && resp.trends) {
        setTrends(resp.trends);
        setTrendsStatus("ok");
      } else {
        setTrendsStatus("error");
        setTrendsError(resp.error ?? "趋势数据不可用");
      }
    } catch {
      setTrendsStatus("error");
      setTrendsError("趋势数据暂不可用");
    }
  }

  // Task 9: unified logout — the GoogleLoginPanel handles signing out;
  // the unauthenticated effect above clears all private state on the
  // authenticated→unauthenticated transition.

  function handleTabChange(next: WorkspaceTab) {
    setActiveTab(next);
    if (next === "map") setMapActivated(true);
    if (next === "review") setReviewActivated(true);
    if (next === "annual") setAnnualActivated(true);
    if (next === "archive") {
      // S27L Phase B: the archive state machine discovers
      // availableYears on its own via the bootstrap fetch. We must
      // NOT pre-set a requested year here — that's a separate
      // concern owned by the annual-review dashboard.
      setArchiveActivated(true);
    }
  }

  function handleOpenAnnualYear(year: number) {
    setRequestedAnnualReviewYear(year);
    setAnnualActivated(true);
    setActiveTab("annual");
  }

  function handleRetry() {
    if (authenticated) loadSummary();
  }

  const view = summary ? formatWereadCenterSummary(summary) : null;

  return (
    <main className="page weread-center-page" data-testid="weread-center-page">
      <header className="weread-center-hero">
        <BookOpen size={32} />
        <h1>微信读书中心</h1>
        <p className="weread-center-hero__subtitle">
          这是你的私有阅读数据入口。使用 Google 账号登录后显示微信读书统计，浏览器通过本站安全登录会话访问私人数据。
        </p>
      </header>

      {!authenticated ? (
        <section className="weread-center-panel" data-testid="weread-login-panel">
          <div className="weread-login-panel__inner">
            <Lock size={16} />
            <span className="weread-private-label">私人数据需要登录</span>
          </div>
          <p className="weread-center-hint">
            使用 Google 账号登录后，浏览器将通过本站安全登录会话访问你的微信读书私人数据；会话 cookie 为 HttpOnly，页面脚本不可读取。
          </p>
          <GoogleLoginPanel className="weread-google-login" />
        </section>
      ) : (
        <section className="weread-center-panel weread-token-status" data-testid="weread-session-status">
          <div className="weread-private-status">
            <div className="weread-private-status__left">
              <Lock size={16} />
              <span>微信读书私有模式已启用（Google 登录）</span>
              {status === "loading" && <Loader2 size={14} className="spin" />}
            </div>
            <div className="weread-center-actions">
              <button type="button" onClick={handleRetry} disabled={status === "loading"} title="刷新数据">
                <RefreshCw size={14} />
                刷新数据
              </button>
              <GoogleLoginPanel className="weread-google-login" />
            </div>
          </div>
          {(status === "error" || status === "disabled") && error ? (
            <div className="weread-private-error">
              <AlertCircle size={14} />
              {error}
            </div>
          ) : null}
        </section>
      )}

      {authenticated && view && status !== "disabled" ? (
        <>
          <section className="weread-kpi-section" aria-label="总览指标">
            <h2 className="weread-section-title">总览</h2>
            <div className="weread-kpi-grid" data-testid="weread-kpi-grid">
              <StatCard label={KPI_LABELS.books} value={view.booksCount} />
              <StatCard label={KPI_LABELS.notes} value={view.notesCount} />
              <StatCard label={KPI_LABELS.matchedBooks} value={view.confirmedMatchesCount} />
              <StatCard label={KPI_LABELS.matchedWithNotes} value={view.confirmedWithNotesCount} />
              <StatCard label={KPI_LABELS.matchedWithHighlights} value={view.confirmedWithHighlightsCount} />
              <StatCard label={KPI_LABELS.matchedNoteRecords} value={view.totalConfirmedNoteRecords} />
            </div>
            <p className="weread-kpi-meta">
              <EyeOff size={12} aria-hidden="true" />
              匹配率 {view.matchRatePercent}% · 每本匹配书平均笔记记录 {view.notesPerConfirmedMatch}
              <span className="weread-kpi-meta__sep">·</span>
              只显示数量，不显示笔记或划线的原文。
            </p>
          </section>

          <div className="weread-workspace-tabs" role="tablist" aria-label="微信读书中心工作区">
            <button
              type="button"
              role="tab"
              id="weread-tab-notes"
              aria-selected={activeTab === "notes"}
              aria-controls="weread-panel-notes"
              className={`weread-workspace-tab ${activeTab === "notes" ? "weread-workspace-tab--active" : ""}`}
              onClick={() => handleTabChange("notes")}
              data-testid="weread-tab-notes"
            >
              <Library size={14} aria-hidden="true" /> 笔记与 AI
            </button>
            <button
              type="button"
              role="tab"
              id="weread-tab-map"
              aria-selected={activeTab === "map"}
              aria-controls="weread-panel-map"
              className={`weread-workspace-tab ${activeTab === "map" ? "weread-workspace-tab--active" : ""}`}
              onClick={() => handleTabChange("map")}
              data-testid="weread-tab-map"
            >
              <Map size={14} aria-hidden="true" /> 个人阅读地图
            </button>
            <button
              type="button"
              role="tab"
              id="weread-tab-review"
              aria-selected={activeTab === "review"}
              aria-controls="weread-panel-review"
              className={`weread-workspace-tab ${activeTab === "review" ? "weread-workspace-tab--active" : ""}`}
              onClick={() => handleTabChange("review")}
              data-testid="weread-tab-review"
            >
              <CalendarClock size={14} aria-hidden="true" /> 复习日历
            </button>
            <button
              type="button"
              role="tab"
              id="weread-tab-annual"
              aria-selected={activeTab === "annual"}
              aria-controls="weread-panel-annual"
              className={`weread-workspace-tab ${activeTab === "annual" ? "weread-workspace-tab--active" : ""}`}
              onClick={() => handleTabChange("annual")}
              data-testid="weread-tab-annual"
            >
              <Calendar size={14} aria-hidden="true" /> 年度回顾
            </button>
            <button
              type="button"
              role="tab"
              id="weread-tab-archive"
              aria-selected={activeTab === "archive"}
              aria-controls="weread-panel-archive"
              className={`weread-workspace-tab ${activeTab === "archive" ? "weread-workspace-tab--active" : ""}`}
              onClick={() => handleTabChange("archive")}
              data-testid="weread-tab-archive"
            >
              <Archive size={14} aria-hidden="true" /> 长期档案
            </button>
          </div>

          <div
            id="weread-panel-notes"
            role="tabpanel"
            aria-labelledby="weread-tab-notes"
            hidden={activeTab !== "notes"}
            className="weread-workspace-panel"
            data-testid="weread-panel-notes"
          >
          <div className="weread-center-grid" data-testid="weread-center-grid">
            <section className="weread-center-card weread-notes-card" data-testid="weread-notes-card">
              <h2 className="weread-center-card__title">
                <Library size={16} aria-hidden="true" /> 私有笔记库
              </h2>
              <NotesLibrary onSessionOverlayChange={handleSessionOverlayChange} />
            </section>

            <aside className="weread-side-rail" data-testid="weread-side-rail">
              {trends || trendsStatus === "loading" || trendsStatus === "error" ? (
                <section className="weread-center-card weread-trend-section">
                  <h2 className="weread-center-card__title">
                    <BarChart3 size={16} aria-hidden="true" /> 阅读趋势
                  </h2>
                  {trends ? (
                    <TrendContent trends={trends} />
                  ) : trendsStatus === "loading" ? (
                    <div className="weread-trend-meta">
                      <Loader2 size={14} className="spin" /> 趋势数据加载中…
                    </div>
                  ) : (
                    <div className="weread-trend-error">
                      <AlertCircle size={14} /> {trendsError ?? "趋势数据暂不可用"}
                    </div>
                  )}
                </section>
              ) : null}

              <section className="weread-privacy-card" data-testid="weread-privacy-card">
                <h2 className="weread-center-card__title">
                  <Shield size={16} aria-hidden="true" /> 隐私边界
                </h2>
                <p className="weread-privacy-card__summary">
                  私有内容仅在本站 Google 登录会话中可见。
                </p>
                <details className="weread-privacy-card__details">
                  <summary>展开隐私说明</summary>
                  <ul className="weread-privacy-card__list">
                    <PrivacyItem text="不返回 wereadBookId" />
                    <PrivacyItem text="不返回 noteId / highlightId" />
                    <PrivacyItem text="不返回笔记正文" />
                    <PrivacyItem text="不返回划线正文" />
                    <PrivacyItem text="不进入 Meilisearch" />
                  </ul>
                </details>
              </section>
            </aside>
          </div>
          </div>

          <div
            id="weread-panel-map"
            role="tabpanel"
            aria-labelledby="weread-tab-map"
            hidden={activeTab !== "map"}
            className="weread-workspace-panel"
            data-testid="weread-panel-map"
          >
            {mapActivated ? (
              <ReadingMapDashboard sessionThemeOverlay={sessionThemeOverlay} />
            ) : null}
          </div>

          <div
            id="weread-panel-review"
            role="tabpanel"
            aria-labelledby="weread-tab-review"
            hidden={activeTab !== "review"}
            className="weread-workspace-panel"
            data-testid="weread-panel-review"
          >
            {reviewActivated ? (
              <ReviewCalendarDashboard
                active={activeTab === "review"}
                sessionThemeOverlay={sessionThemeOverlay}
              />
            ) : null}
          </div>

          <div
            id="weread-panel-annual"
            role="tabpanel"
            aria-labelledby="weread-tab-annual"
            hidden={activeTab !== "annual"}
            className="weread-workspace-panel"
            data-testid="weread-panel-annual"
          >
            {annualActivated ? (
              <AnnualReviewDashboard
                active={activeTab === "annual"}
                requestedYear={requestedAnnualReviewYear}
              />
            ) : null}
          </div>

          <div
            id="weread-panel-archive"
            role="tabpanel"
            aria-labelledby="weread-tab-archive"
            hidden={activeTab !== "archive"}
            className="weread-workspace-panel"
            data-testid="weread-panel-archive"
          >
            {archiveActivated ? (
              <ReadingArchiveDashboard
                active={activeTab === "archive"}
                onOpenAnnualYear={handleOpenAnnualYear}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {/* Global SiteFooter is rendered by App.tsx for every route. */}
    </main>
  );
}