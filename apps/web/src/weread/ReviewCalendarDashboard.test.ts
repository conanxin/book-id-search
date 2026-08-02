/**
 * S27I — Structural / behavioural checks for ReviewCalendarDashboard
 * and WereadCenter wiring.
 *
 * The project does not currently ship a DOM testing library, so this
 * file follows the existing convention of `weread*Model.test.ts`:
 * structural assertions on the source files plus behaviour checks
 * implemented through the pure model layer. ≥22 assertions per the
 * S27I spec.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REVIEW_DEFAULT_HORIZON,
  REVIEW_DEFAULT_RECOMMEND,
  buildReadingReviewCalendar,
  formatReviewCalendarSummary,
} from "./wereadReviewCalendarModel";
import type { WereadReadingMapResponse } from "../wereadPrivate";
import type { WereadSessionThemeOverlay } from "./wereadSessionThemeModel";

const DASHBOARD_PATH = resolve(__dirname, "./ReviewCalendarDashboard.tsx");
const CENTER_PATH = resolve(__dirname, "./WereadCenter.tsx");
const STYLES_PATH = resolve(__dirname, "../styles.css");
const MODEL_PATH = resolve(__dirname, "./wereadReviewCalendarModel.ts");

const dashboard = readFileSync(DASHBOARD_PATH, "utf8");
const center = readFileSync(CENTER_PATH, "utf8");
const styles = readFileSync(STYLES_PATH, "utf8");
const model = readFileSync(MODEL_PATH, "utf8");

function makeBook(catalogId: string) {
  return {
    catalogId,
    title: `Synthetic ${catalogId}`,
    author: "Synthetic Author",
    noteCount: 5,
    highlights: 3,
    thoughts: 2,
    reviews: 0,
    unknown: 0,
    activeMonths: 1,
    firstNoteAt: "2025-12-01T00:00:00.000Z",
    lastNoteAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeResponse(): WereadReadingMapResponse {
  return {
    ok: true,
    overview: {
      booksCount: 3,
      notesCount: 30,
      matchedCatalogsCount: 3,
      matchedNoteRecordsCount: 30,
      firstNoteAt: "2025-01-01T00:00:00.000Z",
      lastNoteAt: "2026-07-01T00:00:00.000Z",
      activeMonths: 5,
      currentStreakMonths: 1,
      longestStreakMonths: 2,
    },
    timeline: [],
    books: [makeBook("a"), makeBook("b"), makeBook("c")],
    links: [],
    meta: {
      monthsRequested: 36,
      monthsReturned: 36,
      topBooksRequested: 18,
      topBooksReturned: 3,
      linksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

describe("ReviewCalendarDashboard — structural contract", () => {
  // 1 + 2
  it("WereadCenter mounts the third workspace tab + panel", () => {
    expect(center).toMatch(/weread-tab-review/);
    expect(center).toMatch(/weread-panel-review/);
  });

  // 3
  it("default workspace is still 笔记与 AI", () => {
    expect(center).toMatch(/useState<WorkspaceTab>\("notes"\)/);
  });

  // 4
  it("does not request reading-map before activation (uses `active` flag)", () => {
    expect(dashboard).toMatch(/ReviewCalendarDashboardProps/);
    expect(dashboard).toMatch(/active: boolean/);
  });

  // 5
  it("loads once per token (uses lastRequestTokenRef guard)", () => {
    expect(dashboard).toMatch(/lastRequestTokenRef/);
  });

  // 6 — horizon + recommend switching is local state only (no refetch)
  it("horizon / recommend switching is local-only state", () => {
    expect(dashboard).toMatch(/setState\(\(prev\) => \(\{ \.\.\.prev, horizon: h \}\)\)/);
    expect(dashboard).toMatch(/setState\(\(prev\) => \(\{ \.\.\.prev, recommend: r \}\)\)/);
  });

  // 7 — session overlay change drives useMemo recomputation
  it("session overlay drives calendar recomputation", () => {
    expect(dashboard).toMatch(/buildReadingReviewCalendar/);
  });

  // 8 — session boost affects book priority
  it("book sessions get priority boost via the model", () => {
    const overlay: WereadSessionThemeOverlay = {
      enabled: true,
      themes: [],
      catalogIds: ["a"],
      notesUsed: 3,
    };
    const withBoost = buildReadingReviewCalendar({
      response: makeResponse(),
      overlay,
      now: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 28,
      recommendCount: 6,
    });
    const withoutBoost = buildReadingReviewCalendar({
      response: makeResponse(),
      overlay: { ...overlay, catalogIds: [] },
      now: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 28,
      recommendCount: 6,
    });
    const aBoost = withBoost.tasks.find((t) => t.kind === "book" && t.catalogId === "a");
    const aFlat = withoutBoost.tasks.find((t) => t.kind === "book" && t.catalogId === "a");
    expect(aBoost && aFlat).toBeTruthy();
    if (aBoost && aFlat && aBoost.kind === "book" && aFlat.kind === "book") {
      expect(aBoost.priorityScore).toBeGreaterThan(aFlat.priorityScore);
    }
  });

  // 9 — missing summary still produces a calendar
  it("works without an AI summary overlay", () => {
    const cal = buildReadingReviewCalendar({
      response: makeResponse(),
      overlay: {
        enabled: false,
        themes: [],
        catalogIds: [],
        notesUsed: 0,
      },
      now: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 28,
      recommendCount: 12,
    });
    expect(cal.meta.themeTasks).toBe(0);
    expect(cal.meta.bookTasks).toBeGreaterThan(0);
  });

  // 10 — empty reading-map keeps theme tasks alive
  it("empty reading-map preserves theme tasks", () => {
    const emptyResp: WereadReadingMapResponse = {
      ...makeResponse(),
      books: [],
    };
    const overlay: WereadSessionThemeOverlay = {
      enabled: true,
      themes: [{ id: "t", label: "唯一", source: "theme" }],
      catalogIds: [],
      notesUsed: 1,
    };
    const cal = buildReadingReviewCalendar({
      response: emptyResp,
      overlay,
      now: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 14,
      recommendCount: 12,
    });
    expect(cal.meta.themeTasks).toBe(1);
  });

  // 11 — token clear empties local state
  it("clears response + calendar when token is cleared", () => {
    expect(dashboard).toMatch(/if \(!token\) \{/);
    expect(dashboard).toMatch(/setState\(INITIAL_STATE\)/);
  });

  // 12 — workspaces preserve state via hidden panels
  it("keeps all three workspaces mounted (uses `hidden` attribute)", () => {
    expect(center).toMatch(/hidden=\{activeTab !== "notes"\}/);
    expect(center).toMatch(/hidden=\{activeTab !== "map"\}/);
    expect(center).toMatch(/hidden=\{activeTab !== "review"\}/);
  });

  // 13 — never calls fetchWereadAiSummary (only mention in privacy comments is fine)
  it("never invokes fetchWereadAiSummary", () => {
    // Strip privacy-contract comments before searching for real call sites.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const dash = stripComments(dashboard);
    const ctr = stripComments(center);
    expect(dash).not.toMatch(/fetchWereadAiSummary\s*\(/);
    expect(ctr).not.toMatch(/fetchWereadAiSummary\s*\(/);
  });

  // 14 — never calls fetchWereadRelatedBooks
  it("never invokes fetchWereadRelatedBooks", () => {
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(stripComments(dashboard)).not.toMatch(/fetchWereadRelatedBooks\s*\(/);
    expect(stripComments(center)).not.toMatch(/fetchWereadRelatedBooks\s*\(/);
  });

  // 15 — no new API route is added
  it("does not introduce any new fetch endpoint", () => {
    expect(dashboard).not.toMatch(/fetch\(["']\/api\/private\/weread\/(?!reading-map)/);
  });

  // 16 — no localStorage / sessionStorage *writes* (privacy contract)
  it("does not write to localStorage / sessionStorage", () => {
    expect(dashboard).not.toMatch(/localStorage\.(setItem|getItem|removeItem|clear)/);
    expect(dashboard).not.toMatch(/sessionStorage\.(setItem|getItem|removeItem|clear)/);
    // Center may use sessionStorage for the token (documented feature);
    // it must not introduce new storage for the review calendar.
    expect(center).not.toMatch(/weread-review-calendar/);
    expect(dashboard).not.toMatch(/localStorage\.(setItem|getItem|removeItem|clear)/);
  });

  // 17 — no dangerouslySetInnerHTML
  it("does not use dangerouslySetInnerHTML", () => {
    expect(dashboard).not.toMatch(/dangerouslySetInnerHTML/);
  });

  // 18 — book links target /books/:catalogId
  it("book links target /books/:catalogId", () => {
    expect(dashboard).toMatch(/href=\{`\/books\/\$\{task\.catalogId\}`\}/);
  });

  // 19 — missing-date books are surfaced
  it("missing-date books are surfaced as unscheduled", () => {
    expect(dashboard).toMatch(/weread-review-calendar__unscheduled/);
  });

  // 20 — desktop/mobile structure classes are present in CSS
  it("desktop / mobile responsive classes are defined", () => {
    expect(styles).toMatch(/\.weread-review-calendar__overview/);
    expect(styles).toMatch(/\.weread-review-calendar__grid/);
    expect(styles).toMatch(/\.weread-review-calendar__queue/);
    expect(styles).toMatch(/@media \(max-width: 1024px\)/);
    expect(styles).toMatch(/@media \(max-width: 720px\)/);
  });

  // 21 — privacy notice is rendered
  it("renders the privacy notice", () => {
    expect(dashboard).toMatch(/复习日历仅使用阅读日期/);
    expect(dashboard).toMatch(/weread-review-calendar-notice/);
  });

  // 22 — no-persistence disclaimer is rendered
  it("renders the no-persistence disclaimer", () => {
    expect(dashboard).toMatch(/不保存完成状态/);
    expect(dashboard).toMatch(/weread-review-calendar-persistence/);
  });

  // 23 — model export is reachable from dashboard
  it("dashboard uses documented option defaults", () => {
    expect(dashboard).toMatch(/REVIEW_DEFAULT_HORIZON/);
    expect(dashboard).toMatch(/REVIEW_DEFAULT_RECOMMEND/);
    expect(REVIEW_DEFAULT_HORIZON).toBe(28);
    expect(REVIEW_DEFAULT_RECOMMEND).toBe(12);
  });

  // 24 — privacy contract: no note/comment fields in code
  it("forbidden fields never appear in dashboard source", () => {
    expect(dashboard).not.toMatch(/\.text\b/);
    expect(dashboard).not.toMatch(/\.comment\b/);
    expect(dashboard).not.toMatch(/\.overview\b/);
    expect(dashboard).not.toMatch(/\.keyPoints\b/);
    expect(dashboard).not.toMatch(/\.reviewQuestions\b/);
  });

  // 25 — model privacy contract: forbidden fields never appear in JSON output
  it("forbidden fields never appear in calendar JSON output", () => {
    const cal = buildReadingReviewCalendar({
      response: makeResponse(),
      overlay: {
        enabled: true,
        themes: [],
        catalogIds: [],
        notesUsed: 0,
      },
      now: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 28,
      recommendCount: 12,
    });
    const json = JSON.stringify(cal);
    expect(json).not.toContain("overview");
    expect(json).not.toContain("keyPoints");
    expect(json).not.toContain("reviewQuestions");
    expect(json).not.toMatch(/token/i);
  });

  // 26 — model layer never imports storage APIs
  it("model layer never imports storage APIs", () => {
    expect(model).not.toMatch(/localStorage/);
    expect(model).not.toMatch(/sessionStorage/);
    expect(model).not.toMatch(/IndexedDB/);
  });

  // 27 — summary formatter counts high / book / theme
  it("summary formatter mentions all three counters", () => {
    const cal = buildReadingReviewCalendar({
      response: makeResponse(),
      overlay: {
        enabled: true,
        themes: [{ id: "t", label: "x", source: "theme" }],
        catalogIds: [],
        notesUsed: 0,
      },
      now: new Date("2026-08-02T00:00:00.000Z"),
      horizonDays: 28,
      recommendCount: 12,
    });
    const s = formatReviewCalendarSummary(cal);
    expect(s).toMatch(/书目建议/);
    expect(s).toMatch(/会话主题/);
    expect(s).toMatch(/高优先级/);
  });

  // 28 — controls include 14 / 28 / 42 horizons and 6 / 12 / 18 counts
  it("renders horizon and recommend control options", () => {
    expect(dashboard).toMatch(/REVIEW_HORIZON_OPTIONS/);
    expect(dashboard).toMatch(/REVIEW_RECOMMEND_OPTIONS/);
  });
});

/**
 * S27I-2 — Browser-local ICS export wiring. Structural assertions
 * only; the pure model is exercised in wereadReviewCalendarIcs.test.ts.
 */
describe("ReviewCalendarDashboard — S27I-2 ICS export", () => {
  const ics = readFileSync(
    resolve(__dirname, "./wereadReviewCalendarIcs.ts"),
    "utf8"
  );

  it("renders the export range selector with three options", () => {
    expect(dashboard).toMatch(/weread-review-calendar__export/);
    expect(dashboard).toMatch(/weread-review-calendar__export-controls/);
    expect(dashboard).toMatch(/weread-review-calendar__export-notice/);
    expect(dashboard).toMatch(/weread-review-calendar__export-status/);
    expect(dashboard).toMatch(/weread-review-export-range-\$\{opt\.value\}/);
    expect(dashboard).toMatch(/全部任务/);
    expect(dashboard).toMatch(/仅书目任务/);
    expect(dashboard).toMatch(/仅当前会话主题/);
  });

  it("renders the export button labelled 导出日历文件 (.ics)", () => {
    expect(dashboard).toMatch(/导出日历文件 \(.ics\)/);
    expect(dashboard).toMatch(/weread-review-calendar-export-button/);
  });

  it("disables the export button when there are no tasks", () => {
    expect(dashboard).toMatch(/disabled=\{exportableCount === 0\}/);
  });

  it("does not issue any new fetch when exporting", () => {
    expect(dashboard).not.toMatch(/fetch\(/);
  });

  it("uses the browser-local download API only", () => {
    expect(dashboard).toMatch(/triggerIcsDownload/);
    expect(dashboard).toMatch(/buildReviewCalendarIcs/);
  });

  it("never writes to localStorage / sessionStorage / IndexedDB", () => {
    // Strip the privacy-contract comment so we don't false-positive
    // on the comment that documents the prohibition.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const dash = stripComments(dashboard);
    expect(dash).not.toMatch(/localStorage\.(setItem|getItem|removeItem|clear)/);
    expect(dash).not.toMatch(/sessionStorage\.(setItem|getItem|removeItem|clear)/);
    expect(dash).not.toMatch(/IndexedDB/);
  });

  // Strip privacy-contract comments so the comment that documents
  // the *prohibition* is not flagged as a violation.
  it("never references Google / Apple / Outlook APIs for the export", () => {
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(stripComments(dashboard)).not.toMatch(/google\.com\/calendar|apple\.com\/cal|outlook\.live\.com|graph\.microsoft/);
    expect(stripComments(dashboard)).not.toMatch(/window\.open/);
  });

  it("never uses dangerouslySetInnerHTML", () => {
    expect(dashboard).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("never auto-opens Google Calendar / Apple Calendar / Outlook", () => {
    expect(dashboard).not.toMatch(/google\.com\/calendar|apple\.com\/cal|outlook\.live\.com|graph\.microsoft/);
    expect(dashboard).not.toMatch(/window\.open/);
  });

  it("ICS model uses CRLF + all-day VALUE=DATE", () => {
    expect(ics).toMatch(/DTSTART;VALUE=DATE/);
    expect(ics).toMatch(/DTEND;VALUE=DATE/);
    expect(ics).toMatch(/\\r\\n/);
  });

  it("ICS UID never embeds the raw catalogId", () => {
    // The model uses fnv1a32 over `kind|id|dtstart` — the catalogId
    // only enters as the `id` prefix (`book:NN_...`), which is then
    // hashed. So no literal `${task.catalogId}` should appear in
    // the UID construction.
    expect(ics).toMatch(/fnv1a32/);
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(stripComments(ics)).not.toMatch(/\$\{task\.catalogId\}/);
    expect(stripComments(ics)).not.toMatch(/\.catalogId`/);
  });

  it("ICS filename never embeds titles / themes / catalogIds", () => {
    expect(ics).toMatch(/buildReviewCalendarIcsFilename/);
    expect(ics).toMatch(/weread-review-calendar/);
    // The filename function must not reference any task field.
    // Extract just the body of `buildReviewCalendarIcsFilename` and
    // assert it only consumes range / horizonDays / now.
    const match = ics.match(/export function buildReviewCalendarIcsFilename[\s\S]*?^\}/m);
    expect(match).not.toBeNull();
    if (match) {
      const body = match[0];
      expect(body).not.toMatch(/task\./);
      expect(body).not.toMatch(/\.title/);
      expect(body).not.toMatch(/\.label/);
      expect(body).not.toMatch(/catalogId/);
    }
  });
});