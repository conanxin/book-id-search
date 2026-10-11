import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { BookOpen, Loader2 } from "lucide-react";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";

/** Keep the requested route in place so a successful sign-in resumes it. */
export function RequireGoogle({ children, inline = false }: { children: ReactNode; inline?: boolean }) {
  const session = useWebAuthSession();
  const location = useLocation();
  const Container = inline ? "section" : "main";
  if (session.status === "authenticated") {
    return <div className="private-page" key={`${location.pathname}:${getWebAuthAuthGeneration()}`}>{children}</div>;
  }
  if (["idle", "loading", "signing_in", "signing_out"].includes(session.status)) {
    return <Container className={inline ? "" : "page"}><div className="state" role="status"><Loader2 className="spin" size={18} />正在确认登录状态…</div></Container>;
  }
  const returnTo = location.pathname + location.search + location.hash;
  return (
    <Container className={inline ? "" : "page"}>
      <section className="login-required" aria-labelledby="login-required-title">
        <BookOpen size={30} aria-hidden="true" />
        <p className="site-eyebrow">你的阅读空间</p>
        <h1 id="login-required-title">登录后，继续整理这本书与阅读资料</h1>
        <p>书籍介绍、个人笔记、电子版本、微信读书和 AI 功能使用同一个 Google 账号。</p>
        <Link className="site-primary-link" to={`/account?returnTo=${encodeURIComponent(returnTo)}`}>使用 Google 登录</Link>
        <Link className="site-text-link" to="/">继续搜索书目</Link>
      </section>
    </Container>
  );
}
