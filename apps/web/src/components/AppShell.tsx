import { useEffect, useRef, type ReactNode } from "react";
import { BookOpen, Library, Search, UserRound, MoreHorizontal } from "lucide-react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { GoogleLoginPanel } from "../auth/GoogleLoginPanel";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { clearWereadStatusCache } from "../wereadPrivate";
import "./app-shell.css";

export function AppShell({ children }: { children: ReactNode }) {
  const session = useWebAuthSession();
  const location = useLocation();
  const returnTo = location.pathname + location.search + location.hash;
  const more = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (more.current) more.current.open = false; }, [returnTo]);
  useEffect(() => {
    if (session.status !== "authenticated") clearWereadStatusCache();
  }, [session.status]);
  return (
    <div className="site-shell">
      <a className="site-skip-link" href="#site-content">跳到主要内容</a>
      <header className="site-header">
        <div className="site-header__inner">
          <Link to="/" className="site-brand" aria-label="BOOK ID 首页"><BookOpen size={26} /><span>BOOK ID<small>发现好书，留下思考</small></span></Link>
          <nav className="site-nav" aria-label="主导航">
            <NavLink to="/" end><Search size={16} />搜书</NavLink>
            <NavLink to="/library"><Library size={16} />我的书籍</NavLink>
            <NavLink to="/weread"><BookOpen size={16} />微信读书</NavLink>
            <details className="site-more" ref={more}>
              <summary><MoreHorizontal size={16} />更多</summary>
              <div><Link to="/research/projects">专题研究</Link><Link to="/account">账号与设置</Link></div>
            </details>
          </nav>
          <div className="site-account">
            <Link to={session.status === "authenticated" ? "/account" : `/account?returnTo=${encodeURIComponent(returnTo)}`}>
              <UserRound size={17} /><span>{session.status === "authenticated" ? (session.user?.name ?? "我的账号") : "Google 登录"}</span>
            </Link>
          </div>
        </div>
      </header>
      <div id="site-content" tabIndex={-1}>{children}</div>
    </div>
  );
}

export function AccountPage() {
  const session = useWebAuthSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const candidate = params.get("returnTo");
  // A login link only resumes a local path, never a user-provided external URL.
  const returnTo = candidate?.startsWith("/") && !candidate.startsWith("//") && !candidate.includes("\\")
    && !candidate.startsWith("/account") ? candidate : null;
  useEffect(() => {
    if (session.status === "authenticated" && returnTo) navigate(returnTo, { replace: true });
  }, [session.status, returnTo, navigate]);
  return (
    <main className="page account-page">
      <p className="site-eyebrow">个人阅读空间</p>
      <h1>账号与设置</h1>
      <p className="site-lead">使用 Google 登录，保存书籍介绍、笔记和电子版本，并查看你的微信读书资料。</p>
      <section className="site-card" aria-label="Google 账号">
        <h2>Google 账号</h2>
        <GoogleLoginPanel className="site-google-panel" />
      </section>
      <section className="site-card">
        <h2>阅读资料</h2>
        <p>微信读书页面展示已导入的阅读记录。Google 登录用于访问本站，不会自动连接或同步微信读书。</p>
        <div className="site-link-row"><Link to="/library">打开我的书籍</Link><Link to="/weread">打开微信读书</Link></div>
      </section>
    </main>
  );
}
