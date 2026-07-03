import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Lock, Loader2, AlertCircle, Search, XCircle, RefreshCw, Shield, EyeOff } from "lucide-react";
import {
  clearWereadToken,
  fetchWereadSummary,
  formatWereadCenterSummary,
  getWereadToken,
  saveWereadToken,
  type WereadSummary,
} from "../wereadPrivate";

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

export default function WereadCenter() {
  const [token, setToken] = useState("");
  const [storedToken, setStoredToken] = useState<string | null>(getWereadToken());
  const [summary, setSummary] = useState<WereadSummary | null>(null);
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
