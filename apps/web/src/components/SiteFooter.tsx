import { ArrowLeft, ShieldCheck } from "lucide-react";
import { SITE_COMPLIANCE } from "../siteCompliance";

/**
 * POST-ICP-COMPLIANCE — single global site footer.
 *
 * Rendered once at the application root (App.tsx). Provides:
 *  - "← 返回搜索" navigation back to the home search page
 *  - ICP filing record link (always rendered when configured)
 *  - Public security network record link (only when issued — NEVER fabricated)
 *  - Copyright line with current year
 *
 * The component is intentionally dumb: it reads `SITE_COMPLIANCE` from a
 * separate module so swapping a number does not require touching this file.
 *
 * Privacy contract:
 *  - No token, no search terms, no note text, no user data rendered.
 *  - All links are external (`target="_blank"`) with `rel="noopener noreferrer"`.
 *  - No unescaped HTML injection (no `dangerously…` props).
 */
export default function SiteFooter() {
  const year = new Date().getFullYear();
  const hasPoliceRecord = SITE_COMPLIANCE.publicSecurityNumber.trim().length > 0;
  const hasPoliceUrl = SITE_COMPLIANCE.publicSecurityUrl.trim().length > 0;

  return (
    <footer className="site-footer" data-testid="site-footer">
      <div className="site-footer__inner">
        <a className="site-footer__back" href="/" data-testid="site-footer-back">
          <ArrowLeft size={14} aria-hidden="true" />
          返回搜索
        </a>

        <div className="site-footer__records" data-testid="site-footer-records">
          <a
            className="site-footer__record site-footer__record--icp"
            href={SITE_COMPLIANCE.icpUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="site-footer-icp"
          >
            <ShieldCheck size={12} aria-hidden="true" />
            <span>{SITE_COMPLIANCE.icpNumber}</span>
          </a>

          {hasPoliceRecord ? (
            <a
              className="site-footer__record site-footer__record--police"
              href={hasPoliceUrl ? SITE_COMPLIANCE.publicSecurityUrl : "#"}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="site-footer-police"
            >
              <ShieldCheck size={12} aria-hidden="true" />
              <span>{SITE_COMPLIANCE.publicSecurityNumber}</span>
            </a>
          ) : null}
        </div>

        <div className="site-footer__copyright">
          © {year} conanxin.com
        </div>
      </div>
    </footer>
  );
}