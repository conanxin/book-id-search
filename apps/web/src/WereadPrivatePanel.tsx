import { useEffect, useState } from "react";
import { BookOpen, Lock, Loader2, AlertCircle } from "lucide-react";
import { clearWereadStatusCache, fetchWereadSummary, purgeLegacyWereadTokenStorage, WereadPrivateError, type WereadSummary } from "./wereadPrivate";
import { useWebAuthSession } from "./auth/useWebAuthSession";
import { GoogleLoginPanel } from "./auth/GoogleLoginPanel";

export default function WereadPrivatePanel() {
  const session = useWebAuthSession();
  const authenticated = session.status === "authenticated";
  const [summary, setSummary] = useState<WereadSummary | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "disabled">("idle");
  const [error, setError] = useState<string | null>(null);

  // Task 9: one-time purge of the legacy sessionStorage token key.
  useEffect(() => {
    purgeLegacyWereadTokenStorage();
  }, []);

  useEffect(() => {
    if (!authenticated) {
      clearWereadStatusCache();
      setSummary(null);
      setStatus("idle");
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    fetchWereadSummary()
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        setStatus(s.ok ? "idle" : "error");
        if (!s.ok) setError("私有 API 返回异常");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        if (err instanceof WereadPrivateError && (err.status === 401 || err.status === 403 || err.status === 404)) {
          setStatus("disabled");
        } else {
          setError(err instanceof Error ? err.message : "连接失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  if (!authenticated) {
    return (
      <div className="weread-private-panel">
        <div className="weread-private-form">
          <Lock size={16} />
          <span className="weread-private-label">微信读书私有模式</span>
        </div>
        <p className="weread-private-hint">
          登录后查看私人微信读书数据。浏览器通过本站安全登录会话访问，cookie 为 HttpOnly，页面脚本不可读取。
        </p>
        <GoogleLoginPanel className="weread-google-login" />
      </div>
    );
  }

  return (
    <div className="weread-private-panel">
      <div className="weread-private-status">
        <div className="weread-private-status__left">
          <BookOpen size={16} />
          <span>微信读书私有模式已启用（Google 登录）</span>
          {status === "loading" && <Loader2 size={14} className="spin" />}
        </div>
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
          {status === "disabled" ? "微信读书私有功能当前不可用" : error}
        </div>
      ) : null}
    </div>
  );
}
