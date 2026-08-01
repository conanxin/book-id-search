import { useEffect, useState } from "react";
import { BookOpen, Lock, Loader2, AlertCircle, XCircle, RefreshCw, Shield, EyeOff, BarChart3, Library } from "lucide-react";
import {
  clearWereadToken,
  fetchWereadSummary,
  fetchWereadTrends,
  formatWereadCenterSummary,
  getWereadToken,
  saveWereadToken,
  type WereadSummary,
  type WereadTrends,
} from "../wereadPrivate";
import {
  formatTrendWindow,
  getActivityLevel,
  getTrendCards,
  getTrendCoverageLabel,
  type WereadTrendView,
} from "./wereadCenterModel";
import NotesLibrary from "./NotesLibrary";

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
  const [token, setToken] = useState("");
  const [storedToken, setStoredToken] = useState<string | null>(getWereadToken());
  const [summary, setSummary] = useState<WereadSummary | null>(null);
  const [trends, setTrends] = useState<WereadTrends | null>(null);
  const [trendsStatus, setTrendsStatus] = useState<"idle" | "loading" | "error" | "ok">("idle");
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "disabled">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = getWereadToken();
    if (t) {
      setStoredToken(t);
      loadSummary(t);
    }
  }, []);

  async function loadSummary(t: string) {
    setStatus("loading");
    setError(null);
    try {
      const s = await fetchWereadSummary(t);
      setSummary(s);
      setStatus(s.ok ? "idle" : "error");
      if (!s.ok) setError("私有 API 返回异常");
      if (s.ok) {
        void loadTrends(t);
      }
    } catch (err) {
      setStatus("error");
      const msg = err instanceof Error ? err.message : "连接失败";
      if (/401|403|unauthorized|invalid token|missing token|认证失败|已过期|token 无效/i.test(msg)) {
        setStatus("disabled");
        setError("Token 无效或已过期");
      } else if (/disabled|not enabled|未启用/i.test(msg)) {
        setStatus("disabled");
        setError("私有 API 未启用");
      } else {
        setError(msg || "连接失败");
      }
    }
  }

  async function loadTrends(t: string) {
    setTrendsStatus("loading");
    setTrendsError(null);
    try {
      const resp = await fetchWereadTrends(t);
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

  function handleConnect() {
    if (!token.trim()) return;
    saveWereadToken(token.trim());
    setStoredToken(token.trim());
    loadSummary(token.trim());
  }

  function handleClear() {
    clearWereadToken();
    setStoredToken(null);
    setSummary(null);
    setTrends(null);
    setTrendsStatus("idle");
    setTrendsError(null);
    setStatus("idle");
    setError(null);
    setToken("");
  }

  function handleRetry() {
    const t = getWereadToken();
    if (t) loadSummary(t);
  }

  const view = summary ? formatWereadCenterSummary(summary) : null;

  return (
    <main className="page weread-center-page" data-testid="weread-center-page">
      <header className="weread-center-hero">
        <BookOpen size={32} />
        <h1>微信读书中心</h1>
        <p className="weread-center-hero__subtitle">
          这是你的私有阅读数据入口。输入 private token 后显示微信读书统计。
        </p>
      </header>

      {!storedToken ? (
        <section className="weread-center-panel" data-testid="weread-token-form">
          <div className="weread-private-form">
            <Lock size={16} />
            <span className="weread-private-label">私有 token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              placeholder="输入 private token"
              aria-label="private token"
            />
            <button type="button" onClick={handleConnect} disabled={!token.trim()}>
              连接
            </button>
          </div>
          <p className="weread-center-hint">
            Token 只保存在当前浏览器 sessionStorage，不会上传到除本站 private API 外的地方。
          </p>
        </section>
      ) : (
        <section className="weread-center-panel weread-token-status" data-testid="weread-token-status">
          <div className="weread-private-status">
            <div className="weread-private-status__left">
              <Lock size={16} />
              <span>微信读书私有模式已启用</span>
              {status === "loading" && <Loader2 size={14} className="spin" />}
            </div>
            <div className="weread-center-actions">
              <button type="button" onClick={handleRetry} disabled={status === "loading"} title="重新连接">
                <RefreshCw size={14} />
                重新连接
              </button>
              <button type="button" onClick={handleClear} title="清除 token">
                <XCircle size={14} />
                清除 token
              </button>
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

      {view && status !== "disabled" ? (
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

          <div className="weread-center-grid" data-testid="weread-center-grid">
            <section className="weread-center-card weread-notes-card" data-testid="weread-notes-card">
              <h2 className="weread-center-card__title">
                <Library size={16} aria-hidden="true" /> 私有笔记库
              </h2>
              {storedToken ? <NotesLibrary token={storedToken} /> : null}
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
                  私有内容仅在当前 private token 会话中可见。
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
        </>
      ) : null}

      {/* Global SiteFooter is rendered by App.tsx for every route. */}
    </main>
  );
}