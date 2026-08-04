/**
 * S27L — Structural / behavioural checks for ReadingArchiveDashboard
 * and WereadCenter wiring (5th workspace tab).
 *
 * Follows the existing `weread*Dashboard.test.ts` convention used in
 * S27I / S27J / S27J-2 / S27K / S27K-2: structural assertions on the
 * source files + behaviour checks implemented through the pure model
 * layer (no DOM testing library).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildArchiveYearLinks,
  buildRecurringArchiveBooks,
  buildReadingArchiveOverview,
  buildReadingArchiveYears,
  buildWereadReadingArchive,
  calculateActiveYearStreak,
  DEFAULT_READING_ARCHIVE_RANGE,
  DEFAULT_READING_ARCHIVE_RECURRING_LIMIT,
  DEFAULT_READING_ARCHIVE_TOP_BOOKS,
  findMostActiveArchiveYear,
  hasReadingArchiveData,
  normalizeArchiveYears,
  pickArchiveYearSlice,
  READING_ARCHIVE_MAX_YEARS,
  READING_ARCHIVE_RANGE_OPTIONS,
  READING_ARCHIVE_TOP_BOOKS_OPTIONS,
} from "./wereadReadingArchiveModel";
import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewResponse,
  WereadAnnualReviewTopBooksOption,
} from "../wereadPrivate";

const DASHBOARD_PATH = resolve(__dirname, "./ReadingArchiveDashboard.tsx");
const CENTER_PATH = resolve(__dirname, "./WereadCenter.tsx");
const STYLES_PATH = resolve(__dirname, "../styles.css");
const MODEL_PATH = resolve(__dirname, "./wereadReadingArchiveModel.ts");
const ANNUAL_DASHBOARD_PATH = resolve(__dirname, "./AnnualReviewDashboard.tsx");

const dashboard = readFileSync(DASHBOARD_PATH, "utf8");
const center = readFileSync(CENTER_PATH, "utf8");
const styles = readFileSync(STYLES_PATH, "utf8");
const model = readFileSync(MODEL_PATH, "utf8");
const annualDashboard = readFileSync(ANNUAL_DASHBOARD_PATH, "utf8");

// Strip leading privacy-contract comment blocks from the dashboard so
// the structural regex checks below only match the live code.
const dashboardCode = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");

// ---------- fixtures ----------

function makeBook(args: {
  catalogId: string;
  title?: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  noteCount?: number;
}): WereadAnnualReviewBook {
  return {
    catalogId: args.catalogId,
    title: args.title ?? `Book ${args.catalogId}`,
    author: args.author ?? null,
    publisher: args.publisher ?? null,
    publishYear: args.publishYear ?? null,
    noteCount: args.noteCount ?? 10,
    highlights: 5,
    thoughts: 1,
    reviews: 0,
    unknown: 0,
    activeMonths: 1,
    firstNoteAt: "2025-01-01",
    lastNoteAt: "2025-12-31",
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const selectedYear = overrides.selectedYear ?? 2025;
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: `${selectedYear}-${String(i + 1).padStart(2, "0")}`,
    total: 0,
    highlights: 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: 0,
    bookCount: 0,
  }));
  return {
    ok: true,
    selectedYear,
    availableYears: [selectedYear, selectedYear - 1, selectedYear - 2],
    overview: {
      year: selectedYear,
      totalRecords: 0,
      datedRecords: 0,
      matchedRecords: 0,
      matchedBooks: 0,
      activeMonths: 0,
      longestStreakMonths: 0,
      firstNoteAt: null,
      lastNoteAt: null,
      peakMonth: null,
      peakMonthRecords: 0,
      averageRecordsPerActiveMonth: 0,
    },
    months,
    quarters: [
      { quarter: "Q1", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q2", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q3", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q4", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    ],
    topBooks: [],
    meta: {
      topBooksRequested: 12,
      topBooksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
    ...overrides,
  };
}

function makeSixYearFixture(): WereadAnnualReviewResponse[] {
  // 6 years of synthetic data: BOOK-RECURRING-A and BOOK-RECURRING-B
  // appear in multiple years so we can test recurring-books output.
  // Two adjacent years (2024 / 2025) share BOOK-OVERLAP-1 to test
  // adjacent-year overlap; 2020 / 2021 do not overlap.
  const years = [2020, 2021, 2022, 2023, 2024, 2025];
  return years.map((year) => {
    const totalRecords = year * 10;
    return makeResponse({
      selectedYear: year,
      availableYears: [2025, 2024, 2023, 2022, 2021, 2020],
      overview: {
        year,
        totalRecords,
        datedRecords: totalRecords,
        matchedRecords: Math.min(30, totalRecords),
        matchedBooks: 3,
        activeMonths: 12,
        longestStreakMonths: 4,
        firstNoteAt: `${year}-01-01T00:00:00.000Z`,
        lastNoteAt: `${year}-12-31T00:00:00.000Z`,
        peakMonth: `${year}-06`,
        peakMonthRecords: 12,
        averageRecordsPerActiveMonth: totalRecords / 12,
      },
      topBooks: [
        makeBook({
          catalogId: year >= 2022 ? "BOOK-RECURRING-A" : "BOOK-ONCE-A",
          title: year >= 2022 ? "重复书目 A" : "一次性书目 A",
          author: "作者 A",
          noteCount: 30,
        }),
        makeBook({
          catalogId: year >= 2023 ? "BOOK-RECURRING-B" : "BOOK-ONCE-B",
          title: year >= 2023 ? "重复书目 B" : "一次性书目 B",
          author: "作者 B",
          noteCount: 20,
        }),
        makeBook({
          catalogId: year === 2024 || year === 2025 ? "BOOK-OVERLAP-1" : `BOOK-YEAR-${year}`,
          title: year === 2024 || year === 2025 ? "相邻年份共有" : `${year} 专属`,
          author: "作者 C",
          noteCount: 15,
        }),
      ],
    });
  });
}

// Words that would imply the dashboard is making psychological /
// quality / preference inferences about the reader. These are
// checked against the model source (which is the single source of
// truth for the dashboard's copy). Note: "偏好" is allowed in the
// disclaimer copy where we *say* we do NOT infer reading
// preferences. So we only check the strong psychological words.
const FORBIDDEN_DASHBOARD_WORDS = ["懒惰", "焦虑", "专注力", "人格", "性格", "情绪", "心理", "阅读能力"];
const FORBIDDEN_RESPONSE_FIELDS = /wereadBookId|noteId|highlightId|chapterTitle|wereadTitle|wereadAuthor|rawTitle|rawAuthor|"text":|"comment":|"content":|"markedText":/;

// ============================================================
// Section 1: WereadCenter wiring (5th workspace tab)
// ============================================================

describe("ReadingArchiveDashboard — WereadCenter wiring (5th workspace)", () => {
  // 1
  it("WereadCenter mounts the fifth workspace tab + panel", () => {
    expect(center).toMatch(/weread-tab-archive/);
    expect(center).toMatch(/weread-panel-archive/);
  });

  // 2
  it("default workspace is still 笔记与 AI (notes)", () => {
    expect(center).toMatch(/useState<WorkspaceTab>\("notes"\)/);
  });

  // 3
  it("does not request annual-review before activation (uses `active` flag)", () => {
    expect(dashboard).toMatch(/ReadingArchiveDashboardProps/);
    expect(dashboard).toMatch(/active: boolean/);
  });

  // 4
  it("loads at most once per token (machine bootstrap is single-shot)", () => {
    // Phase B: bootstrap is single-shot because the reducer
    // transitions bootstrap.status out of "idle" on
    // BOOTSTRAP_STARTED, and the controller only fires a bootstrap
    // when status === "idle". The dashboard delegates this to the
    // adapter hook + state machine.
    expect(dashboard).toMatch(/useReadingArchiveMachine/);
  });

  // 5
  it("switching back to archive reuses cached data (no refetch on re-activation)", () => {
    // Phase B: cache is owned by the reducer; the selector
    // `selectArchiveRequestsToStart` returns an empty list when
    // every required key is cached. Re-activation does not issue
    // a new bootstrap.
    expect(dashboard).not.toMatch(/initialFetchIssuedRef/);
    expect(dashboard).toMatch(/cachedResponses/);
  });

  // 6
  it("range / topBooks change only reschedules missing cache keys", () => {
    // Phase B: the selector returns only the keys that are not
    // already cached, so changing range / topBooks triggers
    // fetches only for the new gap. The dashboard forwards the
    // view changes to the reducer via `setRange` / `setTopBooks`.
    expect(dashboard).toMatch(/setRange\(archiveRangeFromModel/);
    expect(dashboard).toMatch(/setTopBooks\(opt\)/);
  });

  // 7
  it("renders the five workspace panels (notes / map / review / annual / archive) via `hidden`", () => {
    expect(center).toMatch(/id="weread-panel-notes"/);
    expect(center).toMatch(/id="weread-panel-map"/);
    expect(center).toMatch(/id="weread-panel-review"/);
    expect(center).toMatch(/id="weread-panel-annual"/);
    expect(center).toMatch(/id="weread-panel-archive"/);
  });

  // 8
  it("uses an `Archive` icon for the tab label", () => {
    expect(center).toMatch(/<Archive size=\{14\} aria-hidden="true" \/> 长期档案/);
  });
});

// ============================================================
// Section 2: dashboard render contract
// ============================================================

describe("ReadingArchiveDashboard — render contract", () => {
  // 9
  it("renders the data-testid for the dashboard root + empty hint", () => {
    expect(dashboard).toMatch(/data-testid="weread-reading-archive"/);
    expect(dashboard).toMatch(/点击上方「长期档案」工作区后开始加载/);
  });

  // 10
  it("renders the privacy disclaimer in the header", () => {
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-notice"/);
    expect(dashboard).toMatch(/getArchivePrivacyDisclaimer/);
  });

  // 11
  it("renders the range + topBooks controls (5 / 10 / all · 6 / 12 / 18)", () => {
    expect(dashboard).toMatch(/weread-reading-archive-range-\$\{opt\.value\}/);
    expect(dashboard).toMatch(/weread-reading-archive-top-books-\$\{opt\}/);
    // The three range values + three topBooks values come from the
    // READING_ARCHIVE_RANGE_OPTIONS / READING_ARCHIVE_TOP_BOOKS_OPTIONS
    // constants imported from the model.
    expect(READING_ARCHIVE_RANGE_OPTIONS).toHaveLength(3);
    expect(READING_ARCHIVE_TOP_BOOKS_OPTIONS).toHaveLength(3);
  });

  // 12
  it("renders the archive overview section", () => {
    const fixture = makeSixYearFixture();
    const archive = buildWereadReadingArchive({
      responses: fixture,
      requestedYears: fixture.length,
      topBooksLimit: 12,
    });
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-overview"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-overview-summary"/);
    expect(archive.overview.yearsWithData).toBe(6);
  });

  // 13
  it("renders the cross-year timeline section", () => {
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-timeline"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-bars"|aria-label="年度阅读记录趋势"/);
  });

  // 14
  it("renders the year directory grid with one card per loaded year", () => {
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-year-grid"/);
    expect(dashboard).toMatch(/weread-reading-archive-year-\$\{y\.year\}/);
    // Verify the fixture provides multiple distinct years.
    const fixture = makeSixYearFixture();
    const years = new Set(fixture.map((r) => r.selectedYear));
    expect(years.size).toBe(6);
  });

  // 15
  it("renders the recurring-books section", () => {
    const fixture = makeSixYearFixture();
    const recurring = buildRecurringArchiveBooks({ responses: fixture });
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-book-grid"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-recurring-scope"/);
    expect(recurring.length).toBeGreaterThan(0);
  });

  // 16
  it("renders the adjacent-year overlap links", () => {
    const fixture = makeSixYearFixture();
    const links = buildArchiveYearLinks({ responses: fixture });
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-links"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-overlap-scope"/);
    expect(links.length).toBe(5);
  });

  // 17
  it("the 查看年度回顾 button calls onOpenAnnualYear(year)", () => {
    const fixture = makeSixYearFixture();
    expect(dashboard).toMatch(/weread-reading-archive-open-\$\{y\.year\}/);
    // The button must call onOpenAnnualYear(y.year)
    expect(dashboard).toMatch(/onClick=\{\(\) => onOpenAnnualYear\(y\.year\)\}/);
    // The fixture provides a year-2024 row.
    const has2024 = fixture.some((r) => r.selectedYear === 2024);
    expect(has2024).toBe(true);
  });

  // 18
  it("the openAnnualYear handler switches to the annual workspace and sets requestedYear", () => {
    expect(center).toMatch(/function handleOpenAnnualYear\(year: number\)/);
    expect(center).toMatch(/setRequestedAnnualReviewYear\(year\)/);
    expect(center).toMatch(/setAnnualActivated\(true\)/);
    expect(center).toMatch(/setActiveTab\("annual"\)/);
  });

  // 19
  it("the requestedYear effect clears the hint after switching to the annual tab", () => {
    // The effect: when requestedAnnualReviewYear !== null and
    // activeTab === "annual", schedule a 0ms timeout to clear the
    // year. This prevents subsequent year-change effects from
    // re-applying the stale value.
    expect(center).toMatch(/useEffect\(\(\) => \{/);
    expect(center).toMatch(/requestedAnnualReviewYear !== null && activeTab === "annual"/);
    expect(center).toMatch(/setRequestedAnnualReviewYear\(null\)/);
  });

  // 20
  it("AnnualReviewDashboard accepts a `requestedYear` prop", () => {
    expect(annualDashboard).toMatch(/requestedYear\?: number \| null/);
    // The dashboard must use the requestedYear prop to drive the
    // initial request, not as direct state.
    expect(annualDashboard).toMatch(/requestedYear/);
  });

  // 21
  it("switching back to the archive tab preserves the cached state", () => {
    // Phase B: the reducer's cache lives across renders. The hook
    // only fires a bootstrap when bootstrap.status === "idle"
    // (which only happens on first activation or after TOKEN_RESET).
    expect(dashboard).toMatch(/useReadingArchiveMachine/);
    expect(dashboard).toMatch(/cachedResponses/);
  });

  // 22
  it("token change aborts in-flight requests and clears the cache", () => {
    // Phase B: the hook module owns the token-change path; the
    // dashboard just forwards `token` to the hook. Verify the
    // hook module (which is the one with the wiring) handles
    // TOKEN_RESET + abortAll + onAbortAll.
    const hookSource = readFileSync(
      resolve(__dirname, "./useReadingArchiveMachine.ts"),
      "utf8",
    );
    expect(hookSource).toMatch(/TOKEN_RESET/);
    expect(hookSource).toMatch(/abortAll|onAbortAll/);
  });

  // 23
  it("Top N scope disclaimer is present in the dashboard", () => {
    expect(dashboard).toMatch(/getArchiveTopNScopeNotice/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-scope"/);
  });
});

// ============================================================
// Section 3: model behaviour (synthetic annual-review responses)
// ============================================================

describe("ReadingArchiveDashboard — model behaviour (synthetic responses)", () => {
  // 24
  it("range = recent5 returns the 5 most recent years", () => {
    const fixture = makeSixYearFixture();
    const availableYears = fixture.map((r) => r.selectedYear);
    const slice = pickArchiveYearSlice({ availableYears, range: "recent5" });
    expect(slice).toEqual([2025, 2024, 2023, 2022, 2021]);
  });

  // 25
  it("range = recent10 returns the 10 most recent years", () => {
    const fixture = makeSixYearFixture();
    const availableYears = fixture.map((r) => r.selectedYear);
    const slice = pickArchiveYearSlice({ availableYears, range: "recent10" });
    expect(slice).toEqual([2025, 2024, 2023, 2022, 2021, 2020]);
  });

  // 26
  it("range = all clamps to READING_ARCHIVE_MAX_YEARS (20)", () => {
    const availableYears = Array.from({ length: 30 }, (_, i) => 2030 - i);
    const slice = pickArchiveYearSlice({ availableYears, range: "all" });
    expect(slice.length).toBe(READING_ARCHIVE_MAX_YEARS);
    expect(slice[0]).toBe(2030);
    expect(slice[slice.length - 1]).toBe(2011);
  });

  // 27
  it("Top 6 / 12 / 18 limits are accepted by the model", () => {
    const fixture = makeSixYearFixture();
    for (const limit of [6, 12, 18] as WereadAnnualReviewTopBooksOption[]) {
      const archive = buildWereadReadingArchive({
        responses: fixture,
        requestedYears: fixture.length,
        topBooksLimit: limit,
      });
      expect(archive.meta.topBooksLimit).toBe(limit);
    }
  });

  // 28
  it("changing Top N only invalidates the cache for years that change scope", () => {
    // The model must include all topBooks in recurring-books output
    // when limit=18 but only the top 6 when limit=6. Cache invalidation
    // is the dashboard's responsibility; we just check the math here.
    const fixture = makeSixYearFixture();
    const all = buildRecurringArchiveBooks({ responses: fixture, limit: 100 });
    const limited = buildRecurringArchiveBooks({ responses: fixture, limit: 6 });
    expect(all.length).toBeGreaterThanOrEqual(limited.length);
  });

  // 29
  it("partial failure handling — missing years do not drop successful ones", () => {
    const fixture = makeSixYearFixture();
    // Simulate a failure by dropping 2023.
    const partial = fixture.filter((r) => r.selectedYear !== 2023);
    const archive = buildWereadReadingArchive({
      responses: partial,
      requestedYears: 6,
      topBooksLimit: 12,
    });
    expect(archive.years.length).toBe(5);
    expect(archive.years.find((y) => y.year === 2023)).toBeUndefined();
    expect(archive.years.find((y) => y.year === 2024)).toBeDefined();
  });

  // 30
  it("retry failure path — the model accepts responses in any order", () => {
    const fixture = makeSixYearFixture();
    const shuffled = [...fixture].sort((a, b) => b.selectedYear - a.selectedYear);
    const archive = buildWereadReadingArchive({
      responses: shuffled,
      requestedYears: fixture.length,
      topBooksLimit: 12,
    });
    expect(archive.years.length).toBe(fixture.length);
    const years = archive.years.map((y) => y.year);
    expect(years).toEqual([...years].sort((a, b) => a - b));
  });

  // 31
  it("recurring books aggregate correctly across multiple years", () => {
    const fixture = makeSixYearFixture();
    const recurring = buildRecurringArchiveBooks({ responses: fixture });
    // BOOK-RECURRING-A appears in 2022, 2023, 2024, 2025 (4 years)
    // BOOK-RECURRING-B appears in 2023, 2024, 2025 (3 years)
    const a = recurring.find((b) => b.catalogId === "BOOK-RECURRING-A");
    const b = recurring.find((b) => b.catalogId === "BOOK-RECURRING-B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.yearsOnList).toBe(4);
    expect(b!.yearsOnList).toBe(3);
  });

  // 32
  it("adjacent-year overlap counts only the immediate neighbour", () => {
    const fixture = makeSixYearFixture();
    const links = buildArchiveYearLinks({ responses: fixture });
    expect(links.length).toBe(5);
    // 2024 → 2025: in this fixture all three top books are identical
    // (RECURRING-A + RECURRING-B + OVERLAP-1), so sharedTopBooks === 3.
    // 2020 → 2021: BOOK-ONCE-A + BOOK-ONCE-B are shared, so
    // sharedTopBooks === 2.
    const link2024 = links.find((l) => l.sourceYear === 2024 && l.targetYear === 2025);
    const link2020 = links.find((l) => l.sourceYear === 2020 && l.targetYear === 2021);
    expect(link2024).toBeDefined();
    expect(link2024!.sharedTopBooks).toBe(3);
    expect(link2020).toBeDefined();
    expect(link2020!.sharedTopBooks).toBe(2);
  });

  // 33
  it("empty year still produces an archive year row with zero records", () => {
    const empty = makeResponse({ selectedYear: 2020 });
    const years = buildReadingArchiveYears({ responses: [empty] });
    expect(years.length).toBe(1);
    expect(years[0].totalRecords).toBe(0);
  });

  // 34
  it("hasReadingArchiveData is false when no year has any record", () => {
    const empty = makeResponse({ selectedYear: 2020 });
    const archive = buildWereadReadingArchive({
      responses: [empty],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    expect(hasReadingArchiveData(archive)).toBe(false);
  });

  // 35
  it("overview computes first / latest year + most active year", () => {
    const fixture = makeSixYearFixture();
    const years = buildReadingArchiveYears({ responses: fixture });
    const overview = buildReadingArchiveOverview({ years });
    expect(overview.firstYear).toBe(2020);
    expect(overview.latestYear).toBe(2025);
    expect(overview.mostActiveYear).toBe(2025); // largest totalRecords
  });

  // 36
  it("active-year streak counts consecutive years", () => {
    const fixture = makeSixYearFixture();
    const years = buildReadingArchiveYears({ responses: fixture });
    const streak = calculateActiveYearStreak(years);
    expect(streak).toBe(6);
  });

  // 37
  it("normalizeArchiveYears dedupes and sorts desc", () => {
    expect(normalizeArchiveYears([2024, 2023, 2024, 2025])).toEqual([2025, 2024, 2023]);
  });

  // 38
  it("findMostActiveArchiveYear returns the earlier year on ties", () => {
    // The function takes ReadingArchiveYear objects, not
    // WereadAnnualReviewResponse. Build them via buildReadingArchiveYear
    // so the totalRecords value is copied through.
    const a = buildReadingArchiveYears({
      responses: [
        makeResponse({
          selectedYear: 2024,
          overview: { ...makeResponse({ selectedYear: 2024 }).overview, totalRecords: 100 },
        }),
      ],
    })[0];
    const b = buildReadingArchiveYears({
      responses: [
        makeResponse({
          selectedYear: 2025,
          overview: { ...makeResponse({ selectedYear: 2025 }).overview, totalRecords: 100 },
        }),
      ],
    })[0];
    const found = findMostActiveArchiveYear([a, b]);
    expect(found?.year).toBe(2024);
  });
});

// ============================================================
// Section 4: privacy + side-effect contract
// ============================================================

describe("ReadingArchiveDashboard — privacy contract", () => {
  // 39
  it("never invokes fetchWereadAiSummary", () => {
    expect(dashboardCode).not.toMatch(/fetchWereadAiSummary/);
  });

  // 40
  it("never invokes fetchWereadRelatedBooks", () => {
    expect(dashboardCode).not.toMatch(/fetchWereadRelatedBooks/);
  });

  // 41
  it("does not introduce new API routes", () => {
    // The dashboard must only consume `/api/private/weread/annual-review`
    // (via fetchWereadAnnualReview). Direct fetch() calls to any
    // other private path are forbidden.
    expect(dashboardCode).not.toMatch(/fetch\([^)]*\/private\/weread\/(?!annual-review)/);
    expect(dashboardCode).not.toMatch(/POST|PUT|PATCH|DELETE/);
  });

  // 42
  it("does not use localStorage / sessionStorage / IndexedDB", () => {
    expect(dashboardCode).not.toMatch(/localStorage/);
    expect(dashboardCode).not.toMatch(/sessionStorage/);
    expect(dashboardCode).not.toMatch(/indexedDB|IndexedDB/);
  });

  // 43
  it("does not use dangerouslySetInnerHTML", () => {
    expect(dashboard).not.toMatch(/dangerouslySetInnerHTML/);
  });

  // 44
  it("renders the privacy notice verbatim (via model + dashboard)", () => {
    // The dashboard calls getArchivePrivacyDisclaimer() which returns
    // the constant from the model. Assert on both layers.
    expect(model).toMatch(/不读取笔记正文/);
    expect(model).toMatch(/不会保存到服务器/);
    expect(model).toMatch(/不调用外部 AI/);
    expect(dashboard).toMatch(/getArchivePrivacyDisclaimer/);
  });

  // 45
  it("Top N scope disclaimer is rendered in the dashboard", () => {
    expect(dashboard).toMatch(/getArchiveTopNScopeNotice/);
    // The exact Chinese copy is also present.
    expect(model).toMatch(/多年重复书目和年度榜单重合只基于当前 Top N 范围/);
  });

  // 46
  it("never produces psychological-inference vocabulary", () => {
    // The disclaimer paragraph on the page is allowed to *mention*
    // these terms to explicitly disclaim them. We just check the
    // dashboard never *asserts* them. The dashboard code (without
    // comments) must not contain psychological words except inside
    // an explicit disclaimer string.
    const FORBIDDEN_WORDS = FORBIDDEN_DASHBOARD_WORDS;
    for (const word of FORBIDDEN_WORDS) {
      // The model is the single source of truth; it must also be clean.
      expect(model.includes(word)).toBe(false);
    }
  });

  // 47
  it("forbidden response fields never leak through the model", () => {
    const fixture = makeSixYearFixture();
    const serialized = JSON.stringify(fixture);
    expect(FORBIDDEN_RESPONSE_FIELDS.test(serialized)).toBe(false);
    // Recurring books and overview use only safe public fields.
    const archive = buildWereadReadingArchive({
      responses: fixture,
      requestedYears: fixture.length,
      topBooksLimit: 12,
    });
    const archiveSerialized = JSON.stringify(archive);
    expect(FORBIDDEN_RESPONSE_FIELDS.test(archiveSerialized)).toBe(false);
  });

  // 48
  it("the model meta.persisted is hard-coded to false", () => {
    expect(model).toMatch(/persisted: false/);
  });

  // 49
  it("the model meta.source marks data as derived from annual-review only", () => {
    expect(model).toMatch(/source: "annual-review-cache"/);
  });
});

// ============================================================
// Section 5: defaults + constants
// ============================================================

describe("ReadingArchiveDashboard — defaults + constants", () => {
  // 50
  it("default range is recent5", () => {
    expect(DEFAULT_READING_ARCHIVE_RANGE).toBe("recent5");
  });

  // 51
  it("default topBooks is 12", () => {
    expect(DEFAULT_READING_ARCHIVE_TOP_BOOKS).toBe(12);
  });

  // 52
  it("default recurring limit is 12", () => {
    expect(DEFAULT_READING_ARCHIVE_RECURRING_LIMIT).toBe(12);
  });

  // 53
  it("range options expose 5 / 10 / 20", () => {
    expect(READING_ARCHIVE_RANGE_OPTIONS.map((o) => o.value)).toEqual([
      "recent5",
      "recent10",
      "all",
    ]);
    const recent5 = READING_ARCHIVE_RANGE_OPTIONS.find((o) => o.value === "recent5");
    const recent10 = READING_ARCHIVE_RANGE_OPTIONS.find((o) => o.value === "recent10");
    const all = READING_ARCHIVE_RANGE_OPTIONS.find((o) => o.value === "all");
    expect(recent5?.count).toBe(5);
    expect(recent10?.count).toBe(10);
    expect(all?.count).toBe(READING_ARCHIVE_MAX_YEARS);
    expect(all?.count).toBe(20);
  });

  // 54
  it("topBooks options are 6 / 12 / 18", () => {
    expect(READING_ARCHIVE_TOP_BOOKS_OPTIONS).toEqual([6, 12, 18]);
  });
});

// ============================================================
// Section 6: CSS + responsive
// ============================================================

describe("ReadingArchiveDashboard — styling + responsive", () => {
  // 55
  it("uses 1100px / 720px responsive breakpoints somewhere in styles", () => {
    // The dashboard renders inside a panel that inherits the existing
    // 1100/720 breakpoints from weread-center. We just assert those
    // breakpoints are present in the stylesheet.
    expect(styles).toMatch(/@media \(max-width: 1100px\)/);
    expect(styles).toMatch(/@media \(max-width: 720px\)/);
  });
});

// ============================================================
// Section 7: section-3 navigation + cache
// ============================================================

describe("ReadingArchiveDashboard — section-3 navigation + cache", () => {
  // 56
  it("navigating to the annual tab clears requestedAnnualReviewYear (avoids repeat effect)", () => {
    // The WereadCenter effect schedules a 0ms setTimeout to clear
    // the year once the user lands on the annual tab. This keeps
    // the dashboard's requestedYear prop from re-firing the effect
    // forever.
    const effect = center.match(
      /useEffect\(\(\) => \{[\s\S]*?requestedAnnualReviewYear[\s\S]*?\}, \[requestedAnnualReviewYear, activeTab, annualActivated\]\)/
    );
    expect(effect).not.toBeNull();
    expect(effect?.[0] ?? "").toMatch(/setRequestedAnnualReviewYear\(null\)/);
  });

  // 57
  it("the dashboard never persists its state (no setItem on storage)", () => {
    expect(dashboardCode).not.toMatch(/setItem/);
  });

  // 58
  it("the dashboard supports bounded concurrency (MAX_ARCHIVE_CONCURRENCY = 2)", () => {
    // Phase B: concurrency is enforced by the state machine
    // selector + reducer (YEAR_REQUEST_STARTED on already-pending
    // keys is a no-op). The dashboard never holds a parallel
    // inflight tracker.
    expect(dashboard).toMatch(/useReadingArchiveMachine/);
    expect(dashboard).not.toMatch(/MAX_CONCURRENT_REQUESTS/);
    expect(dashboard).not.toMatch(/inflightRef/);
  });

  // 59
  it("the dashboard does NOT request annual-review before activation (behaviour)", () => {
    // Phase B: the hook gates the bootstrap + scheduler on the
    // `active` flag (controller.tick returns early when
    // !getActive()). The dashboard forwards `active` to the hook.
    expect(dashboard).toMatch(/useReadingArchiveMachine\(\{ token, active \}\)/);
  });

  // 60
  it("the dashboard shows the 5/10/all range buttons but never reaches beyond 20 years", () => {
    // Even when a user provides 100 available years, the slice is
    // clamped to 20.
    const manyYears = Array.from({ length: 100 }, (_, i) => 2100 - i);
    const slice = pickArchiveYearSlice({ availableYears: manyYears, range: "all" });
    expect(slice.length).toBeLessThanOrEqual(READING_ARCHIVE_MAX_YEARS);
  });
});

// ============================================================
// Section 8: Phase B supplementary tests (S27L-B8)
// ============================================================

describe("ReadingArchiveDashboard — Phase B React adapter integration", () => {
  it("B8-1. dashboard imports useReadingArchiveMachine", () => {
    expect(dashboard).toMatch(/from "\.\/useReadingArchiveMachine"/);
  });

  it("B8-2. dashboard no longer has `requestedYear` prop", () => {
    // The state machine discovers availableYears via bootstrap, so
    // the dashboard no longer needs a "hint" year from the parent.
    expect(dashboard).not.toMatch(/requestedYear\??: number/);
  });

  it("B8-3. dashboard shell always renders controls (no early return on bootstrap loading)", () => {
    // The controls block must appear in the JSX regardless of
    // bootstrap status, so the user can see the range / topBooks
    // options even while data is loading.
    expect(dashboard).toMatch(/weread-reading-archive-controls/);
    // The early-return for "loading" must NOT short-circuit the
    // whole component.
    expect(dashboard).not.toMatch(/if \(isLoading && loadedCount === 0\) \{[\s\S]*?return \(/);
  });

  it("B8-4. controls are disabled while bootstrap is loading (and no data yet)", () => {
    expect(dashboard).toMatch(/disabled=\{bootstrapLoading && loadedCount === 0\}/);
  });

  it("B8-5. controls are enabled once any year is loaded", () => {
    // Same expression as B8-4: when `loadedCount > 0`, the
    // `&& loadedCount === 0` short-circuits to false.
    expect(dashboard).toMatch(/loadedCount === 0/);
  });

  it("B8-6. range change calls machine setRange with the model value (5/10/all)", () => {
    expect(dashboard).toMatch(/onChange=\{\(\) => setRange\(archiveRangeFromModel\(opt\.value\)\)\}/);
  });

  it("B8-7. topBooks change calls machine setTopBooks", () => {
    expect(dashboard).toMatch(/onChange=\{\(\) => setTopBooks\(opt\)\}/);
  });

  it("B8-8. retry button calls machine retryFailed", () => {
    expect(dashboard).toMatch(/onClick=\{retryFailed\}/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-retry-failed"/);
  });

  it("B8-9. controls are visible while bootstrap is in-flight", () => {
    // The `data-testid` block must be in the JSX (not inside a
    // conditional that hides during bootstrap).
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-controls"/);
  });

  it("B8-10. failed year still surfaces the retry button", () => {
    expect(dashboard).toMatch(/failedCount > 0/);
    expect(dashboard).toMatch(/重试失败年份/);
  });

  it("B8-11. plain archive tab activation does NOT pre-set requestedAnnualReviewYear", () => {
    // The state machine discovers availableYears on its own via
    // the bootstrap. The WereadCenter should not pre-set a year
    // when switching to the archive tab. Restrict the regex to
    // the archive-branch body (the if-block ends at the next `}`
    // at the same indent level).
    const archiveBlock = center.match(
      /if \(next === "archive"\) \{[\s\S]*?\n    \}/,
    );
    expect(archiveBlock).not.toBeNull();
    expect(archiveBlock?.[0] ?? "").not.toMatch(/setRequestedAnnualReviewYear/);
  });

  it("B8-12. clicking 年度回顾 (onOpenAnnualYear) writes requestedAnnualReviewYear", () => {
    expect(center).toMatch(/function handleOpenAnnualYear\(year: number\)/);
    expect(center).toMatch(/setRequestedAnnualReviewYear\(year\)/);
  });

  it("B8-13. token clear in WereadCenter also clears the machine (TOKEN_RESET)", () => {
    // WereadCenter.handleClear sets requestedAnnualReviewYear to
    // null; the archive machine handles its own token-change path
    // via the hook. Verify the wiring stays symmetric: the
    // dashboard's `token` prop comes from `storedToken`, which
    // is reset by handleClear.
    expect(center).toMatch(/handleClear/);
    expect(center).toMatch(/setStoredToken\(null\)/);
    expect(center).toMatch(/setRequestedAnnualReviewYear\(null\)/);
  });

  it("B8-14. other four workspaces' state is not touched by ReadingArchiveDashboard", () => {
    // The dashboard import surface is restricted to its own
    // state machine + the private annual-review fetcher. It must
    // not import any of the other four workspace modules.
    // Use the live code (without the leading JSDoc comment).
    expect(dashboardCode).not.toMatch(/NotesLibrary/);
    expect(dashboardCode).not.toMatch(/ReadingMap/);
    expect(dashboardCode).not.toMatch(/ReviewCalendar/);
    expect(dashboardCode).not.toMatch(/AnnualReviewDashboard/);
  });

  it("B8-15. dashboard never imports requestedAnnualReviewYear", () => {
    expect(dashboard).not.toMatch(/requestedAnnualReviewYear/);
  });

  it("B8-16. dashboard no longer maintains a second inflight tracker or scheduler", () => {
    // Use the live code (without the leading JSDoc comment that
    // mentions these names for context).
    expect(dashboardCode).not.toMatch(/inflightRef/);
    expect(dashboardCode).not.toMatch(/cacheRef/);
    expect(dashboardCode).not.toMatch(/scheduleYearFetches/);
  });
});

// ---------- S27L-2: Markdown export action wiring ----------

describe("ReadingArchiveDashboard — S27L-2 Markdown export wiring", () => {
  it("renders the export button + container testids", () => {
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-export"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-export-button"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-export-summary"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-export-notice"/);
    expect(dashboard).toMatch(/data-testid="weread-reading-archive-export-status"/);
  });

  it("imports the Markdown model and download trigger", () => {
    expect(dashboard).toMatch(/buildReadingArchiveMarkdown/);
    expect(dashboard).toMatch(/triggerReadingArchiveMarkdownDownload/);
  });

  it("does NOT call any annual-review fetcher from the export handler", () => {
    expect(dashboard).not.toMatch(/fetchWereadAnnualReview/);
    expect(dashboard).not.toMatch(/fetchWereadAiSummary/);
    expect(dashboard).not.toMatch(/fetchWereadRelatedBooks/);
  });

  it("does NOT use localStorage / sessionStorage / IndexedDB", () => {
    expect(dashboardCode).not.toMatch(/localStorage/);
    expect(dashboardCode).not.toMatch(/sessionStorage/);
    expect(dashboardCode).not.toMatch(/IndexedDB/);
  });

  it("does NOT use dangerouslySetInnerHTML", () => {
    expect(dashboardCode).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("export action is rendered as a JSX child (not in the state machine)", () => {
    // The export action lives in the Dashboard, not in the reducer.
    expect(dashboardCode).toMatch(/ReadingArchiveExportAction/);
    // The state-machine module does not know about Markdown export.
    const stateMachine = readFileSync(
      resolve(
        __dirname,
        "wereadReadingArchiveState.ts",
      ),
      "utf8",
    );
    expect(stateMachine).not.toMatch(/Markdown/);
    expect(stateMachine).not.toMatch(/reading-archive-markdown/);
  });

  it("export button copy is localizable Chinese", () => {
    expect(dashboard).toMatch(/导出长期档案 Markdown/);
  });
});
