import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * POST-ICP-COMPLIANCE — structural assertions for the global site footer.
 *
 * The web app does not depend on a DOM testing library (no @testing-library
 * / jsdom). These tests read the source files and assert the structural
 * contract of the public compliance footer. They run as part of `vitest
 * run` and fail loudly if a regressor removes the ICP record or introduces
 * a fabricated public security record.
 */

const complianceSrc = readFileSync(
  resolve(__dirname, "..", "siteCompliance.ts"),
  "utf8"
);
const footerSrc = readFileSync(
  resolve(__dirname, "SiteFooter.tsx"),
  "utf8"
);
const appSrc = readFileSync(
  resolve(__dirname, "..", "App.tsx"),
  "utf8"
);
const wereadCenterSrc = readFileSync(
  resolve(__dirname, "..", "weread", "WereadCenter.tsx"),
  "utf8"
);
const stylesSrc = readFileSync(
  resolve(__dirname, "..", "styles.css"),
  "utf8"
);

describe("siteCompliance.ts (POST-ICP-COMPLIANCE)", () => {
  it("icpNumber is set", () => {
    const match = complianceSrc.match(/icpNumber:\s*"([^"]+)"/);
    expect(match?.[1]).toBeDefined();
    expect((match?.[1] ?? "").length).toBeGreaterThan(0);
  });

  it("icpNumber does not contain placeholder markers", () => {
    const match = complianceSrc.match(/icpNumber:\s*"([^"]+)"/);
    const value = match?.[1] ?? "";
    expect(value).not.toMatch(/[<>]/);
    expect(value).not.toContain("填写");
    expect(value).not.toContain("ICP备案号");
  });

  it("icpNumber matches the expected ICP format", () => {
    const match = complianceSrc.match(/icpNumber:\s*"([^"]+)"/);
    const value = match?.[1] ?? "";
    // Chinese ICP format: <省简称>ICP备<digits>号[-<sub>].
    expect(value).toMatch(/^[^\s]+?ICP备\d+号(-\d+)?$/);
  });

  it("icpUrl is the official MIIT record site", () => {
    const match = complianceSrc.match(/icpUrl:\s*"([^"]+)"/);
    expect(match?.[1]).toBe("https://beian.miit.gov.cn/");
  });

  it("publicSecurityNumber is empty (not yet filed — must not be fabricated)", () => {
    const match = complianceSrc.match(/publicSecurityNumber:\s*"([^"]*)"/);
    expect(match?.[1]).toBe("");
  });

  it("publicSecurityUrl is empty when publicSecurityNumber is empty", () => {
    const match = complianceSrc.match(/publicSecurityUrl:\s*"([^"]*)"/);
    expect(match?.[1]).toBe("");
  });

  it("does not contain identity materials", () => {
    expect(complianceSrc).not.toMatch(/居民身份证|身份证号码|备案订单号|手机号码|家庭住址/);
  });
});

describe("SiteFooter.tsx (POST-ICP-COMPLIANCE)", () => {
  it("renders the ICP record link", () => {
    expect(footerSrc).toContain("SITE_COMPLIANCE.icpNumber");
    expect(footerSrc).toContain("SITE_COMPLIANCE.icpUrl");
    expect(footerSrc).toContain('data-testid="site-footer-icp"');
  });

  it("opens external links with noopener noreferrer", () => {
    const icpLinkMatch = footerSrc.match(/site-footer__record--icp[\s\S]*?<\/a>/);
    expect(icpLinkMatch?.[0]).toBeDefined();
    expect(icpLinkMatch?.[0]).toContain('target="_blank"');
    expect(icpLinkMatch?.[0]).toContain('rel="noopener noreferrer"');
  });

  it("renders the police record block ONLY when publicSecurityNumber is non-empty", () => {
    // The condition must depend on the config value at runtime.
    expect(footerSrc).toContain("hasPoliceRecord");
    expect(footerSrc).toContain("publicSecurityNumber.trim().length > 0");
    // The police block is wrapped in `{hasPoliceRecord ? (...) : null}`
    // so it does not render when the number is empty.
    expect(footerSrc).toMatch(/\{hasPoliceRecord\s*\?\s*\([\s\S]*?:\s*null\}/);
  });

  it("renders the 返回搜索 navigation link", () => {
    expect(footerSrc).toContain("返回搜索");
    expect(footerSrc).toContain('data-testid="site-footer-back"');
  });

  it("does not use dangerouslySetInnerHTML", () => {
    expect(footerSrc).not.toContain("dangerouslySetInnerHTML");
  });

  it("exposes testids for footer regions", () => {
    expect(footerSrc).toContain('data-testid="site-footer"');
    expect(footerSrc).toContain('data-testid="site-footer-records"');
  });

  it("does not embed identity materials", () => {
    expect(footerSrc).not.toMatch(/居民身份证|身份证号码|备案订单号|手机号码|家庭住址/);
  });
});

describe("App.tsx mounts SiteFooter once (POST-ICP-COMPLIANCE)", () => {
  it("App.tsx imports SiteFooter", () => {
    expect(appSrc).toContain('import SiteFooter');
  });

  it("App.tsx renders <SiteFooter /> inside the app root", () => {
    expect(appSrc).toMatch(/<SiteFooter\s*\/>/);
    // Footer must be inside the same JSX root as <Routes>; both share the
    // fragment wrapper so every route inherits the footer.
    // We find the LAST top-level fragment (the App export) rather than the
    // first `<>...</>` literal in the file (which can occur in other
    // components such as AiSearchPanel).
    const matches = Array.from(appSrc.matchAll(/<>[\s\S]*?<\/>/g));
    expect(matches.length).toBeGreaterThan(0);
    const appRoot = matches[matches.length - 1];
    expect(appRoot[0]).toContain("<SiteFooter");
    expect(appRoot[0]).toContain("<Routes");
  });
});

describe("Global 返回搜索 count (POST-ICP-COMPLIANCE)", () => {
  it("exactly one 返回搜索 <a> link in the whole app (provided by SiteFooter)", () => {
    // Only count actual rendered <a> links whose visible text contains
    // 返回搜索. This excludes the phrase 返回搜索结果 (results page
    // heading) and comments / JSDoc that mention the phrase.
    // The link may contain inline JSX (e.g. an <ArrowLeft /> icon), so we
    // match <a ...> ... 返回搜索 ... </a> across lines.
    const haystack = [
      footerSrc,
      wereadCenterSrc,
      appSrc,
    ].join("\n");
    const linkMatches = haystack.match(/<a\b[^>]*>[\s\S]*?返回搜索[\s\S]*?<\/a>/g) ?? [];
    expect(linkMatches.length).toBe(1);
  });

  it("App.tsx uses 返回搜索结果 for the results-page heading, not as a 返回搜索 link", () => {
    // 返回搜索结果 is the page-title for the search results; it must not be
    // conflated with the navigation link. The phrase is allowed here.
    expect(appSrc).toContain("返回搜索结果");
  });
});

describe("styles.css site-footer rules (POST-ICP-COMPLIANCE)", () => {
  it("defines .site-footer", () => {
    expect(stylesSrc).toMatch(/\.site-footer\s*\{/);
  });

  it("does not use fixed/sticky positioning on the footer", () => {
    const block = stylesSrc.match(/\.site-footer\s*\{[^}]*\}/);
    expect(block?.[0]).toBeDefined();
    expect(block?.[0]).not.toContain("position: fixed");
    expect(block?.[0]).not.toContain("position: sticky");
  });

  it("uses the same width contract as the rest of the site", () => {
    expect(stylesSrc).toMatch(/\.site-footer__inner\s*\{[^}]*max-width:\s*1220px/);
    expect(stylesSrc).toMatch(/\.site-footer__inner\s*\{[^}]*width:\s*calc\(100%\s*-\s*32px\)/);
  });

  it("wraps on small screens (mobile rule)", () => {
    expect(stylesSrc).toMatch(/@media\s*\(max-width:\s*720px\)\s*\{[^}]*\.site-footer__inner\s*\{[^}]*flex-direction:\s*column/);
  });
});