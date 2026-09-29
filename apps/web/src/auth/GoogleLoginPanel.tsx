import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import {
  ensureAuthSessionLoaded,
  getWebAuthSnapshot,
  signOut,
  subscribeWebAuth,
} from "./session.js";
import {
  initializeGoogleIdentity,
  renderGoogleButton,
  disableGoogleAutoSelect,
} from "./googleIdentity.js";

/**
 * Reusable Google login panel (Task 7). Not yet mounted by any business
 * page — Task 8/9 will integrate it into ProjectsPage / WereadCenter.
 *
 * Security: the raw credential/JWT never appears in the DOM; the official
 * Google renderButton is used instead of a hand-rolled logo.
 */
export function GoogleLoginPanel({
  clientId,
  className,
  buttonWidth,
}: {
  clientId?: string;
  className?: string;
  buttonWidth?: number;
}) {
  const resolvedClientId = clientId ?? (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined);
  const snapshot = useSyncExternalStore(subscribeWebAuth, getWebAuthSnapshot, getWebAuthSnapshot);
  const buttonHostRef = useRef<HTMLDivElement | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  useEffect(() => {
    if (!resolvedClientId) return;
    void ensureAuthSessionLoaded();
  }, [resolvedClientId]);

  useEffect(() => {
    if (!resolvedClientId) return;
    if (snapshot.status !== "unauthenticated") return;
    let cancelled = false;
    (async () => {
      try {
        const { signInWithGoogleCredential } = await import("./session.js");
        await initializeGoogleIdentity(resolvedClientId, signInWithGoogleCredential);
        if (cancelled) return;
        const host = buttonHostRef.current;
        if (host) {
          await renderGoogleButton(host, buttonWidth !== undefined ? { width: buttonWidth } : {});
        }
      } catch {
        if (!cancelled) setPanelError("Google 登录组件加载失败，请重试。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolvedClientId, snapshot.status, buttonWidth]);

  async function handleLogout(): Promise<void> {
    await signOut();
    disableGoogleAutoSelect();
  }

  if (!resolvedClientId) {
    return (
      <div className={className} data-testid="google-login-unconfigured">
        Google 登录尚未配置。
      </div>
    );
  }

  if (snapshot.status === "authenticated") {
    return (
      <div className={className} data-testid="google-login-authenticated">
        <span>Google 已登录：{snapshot.user?.email ?? snapshot.user?.name ?? "已授权账号"}</span>
        {snapshot.error !== null ? <span>{snapshot.error}</span> : null}
        <button type="button" onClick={() => void handleLogout()}>
          退出登录
        </button>
      </div>
    );
  }

  if (snapshot.status === "signing_in" || snapshot.status === "signing_out") {
    return (
      <div className={className} data-testid={`google-login-${snapshot.status}`}>
        {snapshot.status === "signing_in" ? "正在登录…" : "正在退出…"}
      </div>
    );
  }

  if (snapshot.status === "disabled") {
    return (
      <div className={className} data-testid="google-login-disabled">
        Google 登录尚未启用。
      </div>
    );
  }

  if (snapshot.status === "unavailable") {
    return (
      <div className={className} data-testid="google-login-unavailable">
        登录服务暂不可用，请稍后重试。
      </div>
    );
  }

  if (snapshot.status === "error") {
    return (
      <div className={className} data-testid="google-login-error">
        <span>{snapshot.error ?? "登录状态异常，请重试。"}</span>
        <button type="button" onClick={() => void ensureAuthSessionLoaded()}>重试</button>
      </div>
    );
  }

  // idle / loading / unauthenticated → show the official button host.
  return (
    <div className={className} data-testid="google-login-button-host">
      {panelError !== null ? <span>{panelError}</span> : null}
      <div ref={buttonHostRef} />
    </div>
  );
}
