import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Lock, Loader2, AlertCircle, XCircle, RefreshCw, Shield, EyeOff, BarChart3 } from "lucide-react";
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
      <div className="weread-trend-grid">
        {cards.map((card) => (
          <StatCard key={card.label} label={card.label} value={card.value} />
        ))}
      </div>
      <div className="weread-trend-card">
        <h3 className="weread-trend-card__title">类型分布（全部时间）</h3>
        <div className="weread-trend-grid">
          <StatCard label="划线" value={view.highlightsTotal} />
          <StatCard label="想法" value={view.thoughtsTotal} />
          <StatCard label="书评" value={view.reviewsTotal} />
          <StatCard label="未知类型" value={view.unknownTotal} />
        </div>
      </div>
      <div className="weread-trend-card">
        <h3 className="weread-trend-card__title">最近 30 天每日新增</h3>
        <TrendBars daily={view.daily30} />
      </div>
      <p className="weread-center-card__note">
        <EyeOff size={14} aria-hidden="true" />
        只显示数量统计，不显示笔记或划线的原文，不返回微信读书内部 ID。
      </p>
    </>
  );
}

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
    <main className="page weread-center-page">
      <div className="weread-center-hero">
        <BookOpen size={32} />
        <h1>微信读书中心</h1>
        <p className="weread-center-hero__subtitle">
          这是你的私有阅读数据入口。输入 private token 后显示微信读书统计。
        </p>
      </div>

      {!storedToken ? (
        <section className="weread-center-panel">
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
        <section className="weread-center-panel">
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
        <div className="weread-center-grid">
          <div className="weread-center-card">
            <h2 className="weread-center-card__title">总览</h2>
            <div className="weread-center-card__stats">
              <StatCard label="书架" value={view.booksCount} />
              <StatCard label="笔记" value={view.notesCount} />
              <StatCard label="已确认匹配" value={view.confirmedMatchesCount} />
            </div>
          </div>

          <div className="weread-center-card">
            <h2 className="weread-center-card__title">匹配</h2>
            <div className="weread-center-card__stats">
              <StatCard label="已匹配到书目" value={view.confirmedMatchesCount} />
              <StatCard label="有笔记的已匹配书" value={view.confirmedWithNotesCount} />
              <StatCard label="有划线的已匹配书" value={view.confirmedWithHighlightsCount} />
            </div>
          </div>

          <div className="weread-center-card">
            <h2 className="weread-center-card__title">笔记统计</h2>
            <div className="weread-center-card__stats">
              <StatCard label="已匹配书目的笔记记录" value={view.totalConfirmedNoteRecords} />
              <StatCard
                label="匹配率"
                value={view.matchRatePercent}
                suffix="%"
                hint="已确认匹配数 / 书架总数"
              />
              <StatCard
                label="每本匹配书平均笔记记录"
                value={view.notesPerConfirmedMatch}
                hint="笔记记录 / 已匹配书"
              />
            </div>
            <p className="weread-center-card__note">
              <EyeOff size={14} aria-hidden="true" />
              只显示数量，不显示笔记或划线的原文。
            </p>
          </div>

          <div className="weread-center-card weread-privacy-card">
            <h2 className="weread-center-card__title">隐私边界</h2>
            <ul className="weread-privacy-card__list">
              <PrivacyItem text="不返回 wereadBookId" />
              <PrivacyItem text="不返回 noteId / highlightId" />
              <PrivacyItem text="不返回笔记正文" />
              <PrivacyItem text="不返回划线正文" />
              <PrivacyItem text="不进入 Meilisearch" />
            </ul>
          </div>

          {trends || trendsStatus === "loading" || trendsStatus === "error" ? (
            <div className="weread-center-card weread-trend-section">
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
            </div>
          ) : null}

          <div className="weread-center-card">
            <h2 className="weread-center-card__title">使用说明</h2>
            <ul className="weread-center-card__list">
              <li>去搜索页搜索书籍。</li>
              <li>已确认匹配的书会显示微信读书 badge。</li>
              <li>badge 只显示 counts-only 统计。</li>
            </ul>
            <a href="/" className="weread-center-button">
              <ArrowLeft size={14} />
              返回搜索
            </a>
          </div>
        </div>
      ) : null}

      <div className="weread-center-footer">
        <a href="/" className="weread-center-link">
          <ArrowLeft size={14} />
          返回搜索
        </a>
      </div>
    </main>
  );
}
