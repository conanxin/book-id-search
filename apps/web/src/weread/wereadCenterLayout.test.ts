import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * S27D-UI-POLISH structural assertions.
 *
 * The web app does not depend on a DOM testing library (no @testing-library
 * / jsdom). These tests instead pin the structural contract of the new
 * WeRead Center layout by reading the source files and asserting that the
 * required markers are present (testids, copy, classnames, section order).
 * They run as part of `vitest run` and fail loudly if the layout regresses.
 */

const wereadCenterSrc = readFileSync(
  resolve(__dirname, "WereadCenter.tsx"),
  "utf8"
);
const notesLibrarySrc = readFileSync(
  resolve(__dirname, "NotesLibrary.tsx"),
  "utf8"
);
const stylesSrc = readFileSync(
  resolve(__dirname, "..", "styles.css"),
  "utf8"
);

describe("WereadCenter layout (S27D-UI-POLISH)", () => {
  it("contains NotesLibrary component", () => {
    expect(wereadCenterSrc).toContain("NotesLibrary");
  });

  it("renders the privacy disclosure with the required copy", () => {
    expect(wereadCenterSrc).toContain("私有内容仅在当前 private token 会话中可见");
    expect(wereadCenterSrc).toContain("不返回 wereadBookId");
    expect(wereadCenterSrc).toContain("不返回 noteId / highlightId");
    expect(wereadCenterSrc).toContain("不返回笔记正文");
    expect(wereadCenterSrc).toContain("不返回划线正文");
    expect(wereadCenterSrc).toContain("不进入 Meilisearch");
  });

  it("uses details/summary for the privacy block", () => {
    expect(wereadCenterSrc).toContain("<details");
    expect(wereadCenterSrc).toContain("<summary>");
  });

  it("exposes testids for the major layout regions", () => {
    expect(wereadCenterSrc).toContain('data-testid="weread-center-page"');
    expect(wereadCenterSrc).toContain('data-testid="weread-kpi-grid"');
    expect(wereadCenterSrc).toContain('data-testid="weread-center-grid"');
    expect(wereadCenterSrc).toContain('data-testid="weread-notes-card"');
    expect(wereadCenterSrc).toContain('data-testid="weread-side-rail"');
    expect(wereadCenterSrc).toContain('data-testid="weread-privacy-card"');
    expect(wereadCenterSrc).toContain('data-testid="weread-center-footer"');
  });

  it("renders exactly one 返回搜索 link", () => {
    const matches = wereadCenterSrc.match(/返回搜索/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("KPI section uses six metric cards with the required labels", () => {
    expect(wereadCenterSrc).toContain("KPI_LABELS");
    expect(wereadCenterSrc).toContain('label={KPI_LABELS.books}');
    expect(wereadCenterSrc).toContain('label={KPI_LABELS.notes}');
    expect(wereadCenterSrc).toContain('label={KPI_LABELS.matchedBooks}');
    expect(wereadCenterSrc).toContain('label={KPI_LABELS.matchedWithNotes}');
    expect(wereadCenterSrc).toContain('label={KPI_LABELS.matchedWithHighlights}');
    expect(wereadCenterSrc).toContain('label={KPI_LABELS.matchedNoteRecords}');
  });

  it("does not use dangerouslySetInnerHTML", () => {
    expect(wereadCenterSrc).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("NotesLibrary layout (S27D-UI-POLISH)", () => {
  it("renders three rows: search → filters → actions", () => {
    const searchRowIdx = notesLibrarySrc.indexOf("weread-notes-search-row");
    const filterRowIdx = notesLibrarySrc.indexOf("weread-notes-filter-row");
    const actionsRowIdx = notesLibrarySrc.indexOf("weread-notes-actions-row");
    expect(searchRowIdx).toBeGreaterThan(0);
    expect(filterRowIdx).toBeGreaterThan(searchRowIdx);
    expect(actionsRowIdx).toBeGreaterThan(filterRowIdx);
  });

  it("search button has dedicated testid", () => {
    expect(notesLibrarySrc).toContain('data-testid="weread-notes-search-button"');
  });

  it("shows empty idle hint when no data is loaded", () => {
    expect(notesLibrarySrc).toContain("输入搜索词，或点击加载笔记开始浏览。");
    expect(notesLibrarySrc).toContain('data-testid="weread-notes-empty-idle"');
  });

  it("Enter key still triggers search", () => {
    expect(notesLibrarySrc).toContain("handleSearchKeyDown");
    expect(notesLibrarySrc).toContain('e.key === "Enter"');
  });

  it("load-more keeps q and filters (currentQuery is sent verbatim)", () => {
    expect(notesLibrarySrc).toContain("currentQuery");
    expect(notesLibrarySrc).toContain("fetchWereadNotes(token, { ...currentQuery, offset })");
  });

  it("token change still clears q and items", () => {
    expect(notesLibrarySrc).toContain("useEffect");
    expect(notesLibrarySrc).toContain('}, [token]);');
  });

  it("does not use dangerouslySetInnerHTML", () => {
    expect(notesLibrarySrc).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("styles.css layout (S27D-UI-POLISH)", () => {
  it("sets the page width to the S27D spec", () => {
    expect(stylesSrc).toMatch(/\.weread-center-page\s*\{[^}]*max-width:\s*1220px/);
    expect(stylesSrc).toMatch(/\.weread-center-page\s*\{[^}]*width:\s*calc\(100%\s*-\s*32px\)/);
  });

  it("uses align-items: start on the main grid to prevent equal heights", () => {
    const gridBlock = stylesSrc.match(/\.weread-center-grid\s*\{[^}]*\}/);
    expect(gridBlock?.[0]).toBeDefined();
    expect(gridBlock?.[0]).toContain("align-items: start");
  });

  it("does not stretch cards via height: 100% / min-height: 100%", () => {
    expect(stylesSrc).not.toMatch(/\.weread-center-card\s*\{[^}]*height:\s*100%/);
    expect(stylesSrc).not.toMatch(/\.weread-center-card\s*\{[^}]*min-height:\s*100%/);
    expect(stylesSrc).not.toMatch(/\.weread-notes-card\s*\{[^}]*height:\s*100%/);
  });

  it("does not enable grid-auto-rows: 1fr on weread grids", () => {
    expect(stylesSrc).not.toMatch(/\.weread-center-grid\s*\{[^}]*grid-auto-rows:\s*1fr/);
  });

  it("KPI grid is 6-column on desktop", () => {
    expect(stylesSrc).toMatch(/\.weread-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(6/);
  });

  it("KPI grid collapses to 3 columns on tablet", () => {
    const tabletMedia = stylesSrc.match(/@media\s*\(max-width:\s*1100px\)\s*\{([\s\S]*?)\n\}/);
    expect(tabletMedia?.[1]).toBeDefined();
    expect(tabletMedia?.[1]).toMatch(/\.weread-kpi-grid\s*\{[^}]*repeat\(3/);
  });

  it("KPI grid collapses to 2 columns on mobile", () => {
    // Multiple @media (max-width: 720px) blocks exist; assert the KPI rule
    // appears within any one of them.
    const blocks = stylesSrc.match(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\n\}/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    const found = blocks.some((b) => /\.weread-kpi-grid\s*\{[^}]*repeat\(2/.test(b));
    expect(found).toBe(true);
  });

  it("trend metric blocks use a 2-column grid", () => {
    expect(stylesSrc).toMatch(/\.weread-trend-grid--2col\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  });

  it("main grid is 8/4 on desktop", () => {
    const gridBlock = stylesSrc.match(/\.weread-center-grid\s*\{[^}]*\}/);
    expect(gridBlock?.[0]).toMatch(/grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(0,\s*1fr\)/);
  });
});