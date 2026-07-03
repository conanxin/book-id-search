import { useEffect, useState } from "react";
import { BookOpen, Lock, X, Loader2, AlertCircle } from "lucide-react";
import { fetchWereadSummary, clearWereadToken, getWereadToken, saveWereadToken, type WereadSummary } from "./wereadPrivate";

export default function WereadPrivatePanel() {
  const [token, setToken] = useState("");
  const [storedToken, setStoredToken] = useState<string | null>(null);
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
      setError(err instanceof Error ? err.message : "连接失败");
      if (err instanceof Error && /401|403|404|unauthorized/i.test(err.message)) {
        setStatus("disabled");
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

  if (!storedToken) {
    return (
      <div className="weread-private-panel">
        <div className="weread-private-form">
          <Lock size={16} />
          <span className="weread-private-label">微信读书私有模式</span>
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
        <p className="weread-private-hint">
          Token 只保存在当前浏览器 sessionStorage，不会上传到除本站 private API 外的地方。
        </p>
      </div>
    );
  }

  return (
    <div className="weread-private-panel">
      <div className="weread-private-status">
        <div className="weread-private-status__left">
          <BookOpen size={16} />
          <span>微信读书私有模式已启用</span>
          {status === "loading" && <Loader2 size={14} className="spin" />}
        </div>
        <button type="button" className="weread-private-clear" onClick={handleClear} title="清除 token">
          <X size={14} />
          清除 token
        </button>
      </div>
      {summary && summary.ok ? (
        <div className="weread-private-summary">
          <span>书架 {summary.booksCount}</span>
          <span>笔记 {summary.notesCount}</span>
          <span>已确认匹配 {summary.confirmedMatchesCount}</span>
        </div>
      ) : null}
      {(status === "error" || status === "disabled") && error ? (
        <div className="weread-private-error">
          <AlertCircle size={14} />
          {status === "disabled" ? "私有 API 未启用或 token 无效" : error}
        </div>
      ) : null}
    </div>
  );
}
