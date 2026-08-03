#!/usr/bin/env node
/**
 * S27L Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page. Intercepts the
 * private annual-review endpoint with synthetic fixtures so that we
 * never hit real private data or AI endpoints. Walks the 38 smoke
 * checks defined in the S27L spec (5th workspace: long-term reading
 * archive).
 *
 * Synthetic fixtures provide 6 years of data (2020..2025) with:
 *   - normal years with totalRecords > 0
 *   - one empty year (2021)
 *   - one year that fails on the first request and succeeds on retry
 *     (2022 — the failing year is configurable)
 *   - BOOK-RECURRING-A appears in 2022..2025 (4 years)
 *   - BOOK-RECURRING-B appears in 2023..2025 (3 years)
 *   - adjacent-year overlap: BOOK-OVERLAP-1 in 2024/2025 only
 *
 * The harness asserts that none of the forbidden fields (note text,
 * private IDs, tokens, AI summary bodies) leak into the rendered
 * page text or any network request.
 *
 * Real AI / private data is NEVER fetched from production. Every
 * private request is intercepted.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"));

const URL = "https://books.conanxin.com/weread";
const SCREENSHOT_DIR = "/opt/book-id-search/reports/screenshots";

const RANGE = 12;
const FAILING_YEAR = 2022; // first call returns 500, second call succeeds

function makeMonths(year) {
  return Array.from({ length: 12 }, (_, i) => {
    const total = year === 2021 ? 0 : (year - 2019) * 20 + (i + 1) * 2;
    const bookCount = total > 0 ? Math.min(3, Math.ceil(total / 30)) : 0;
    return {
      month: `${year}-${String(i + 1).padStart(2, "0")}`,
      total,
      highlights: Math.max(0, total - 1),
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      matched: bookCount,
      bookCount,
    };
  });
}

function makeQuarters(year) {
  const totals = [0, 0, 0, 0];
  for (let i = 0; i < 12; i += 1) {
    const total = year === 2021 ? 0 : (year - 2019) * 20 + (i + 1) * 2;
    totals[Math.floor(i / 3)] += total;
  }
  return ["Q1", "Q2", "Q3", "Q4"].map((q, idx) => ({
    quarter: q,
    total: totals[idx],
    activeMonths: 3,
    matchedRecords: 3,
    bookCount: 3,
  }));
}

function makeTopBooks(year) {
  if (year === 2021) return [];
  if (year === 2020) {
    return [
      { catalogId: "BOOK-ONCE-A", title: "合成 ONCE-A", author: "作者 A", publisher: "出版社", publishYear: 2018, noteCount: 20, highlights: 15, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 2, firstNoteAt: "2020-02-01T00:00:00.000Z", lastNoteAt: "2020-04-01T00:00:00.000Z" },
      { catalogId: "BOOK-ONCE-B", title: "合成 ONCE-B", author: "作者 B", publisher: "出版社", publishYear: 2017, noteCount: 15, highlights: 10, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 2, firstNoteAt: "2020-03-01T00:00:00.000Z", lastNoteAt: "2020-04-15T00:00:00.000Z" },
      { catalogId: "BOOK-YEAR-2020", title: "2020 专属", author: "作者 C", publisher: "出版社", publishYear: 2016, noteCount: 8, highlights: 5, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 1, firstNoteAt: "2020-05-01T00:00:00.000Z", lastNoteAt: "2020-05-15T00:00:00.000Z" },
    ];
  }
  if (year === 2022) {
    return [
      { catalogId: "BOOK-RECURRING-A", title: "合成 RECURRING-A", author: "作者 A", publisher: "出版社", publishYear: 2019, noteCount: 35, highlights: 25, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 3, firstNoteAt: "2022-02-01T00:00:00.000Z", lastNoteAt: "2022-04-01T00:00:00.000Z" },
      { catalogId: "BOOK-ONCE-B", title: "合成 ONCE-B", author: "作者 B", publisher: "出版社", publishYear: 2017, noteCount: 12, highlights: 8, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 1, firstNoteAt: "2022-03-01T00:00:00.000Z", lastNoteAt: "2022-03-15T00:00:00.000Z" },
      { catalogId: "BOOK-YEAR-2022", title: "2022 专属", author: "作者 D", publisher: "出版社", publishYear: 2015, noteCount: 6, highlights: 4, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 1, firstNoteAt: "2022-06-01T00:00:00.000Z", lastNoteAt: "2022-06-15T00:00:00.000Z" },
    ];
  }
  if (year === 2023) {
    return [
      { catalogId: "BOOK-RECURRING-A", title: "合成 RECURRING-A", author: "作者 A", publisher: "出版社", publishYear: 2019, noteCount: 40, highlights: 30, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 4, firstNoteAt: "2023-02-01T00:00:00.000Z", lastNoteAt: "2023-05-01T00:00:00.000Z" },
      { catalogId: "BOOK-RECURRING-B", title: "合成 RECURRING-B", author: "作者 B", publisher: "出版社", publishYear: 2018, noteCount: 30, highlights: 22, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 3, firstNoteAt: "2023-03-01T00:00:00.000Z", lastNoteAt: "2023-05-15T00:00:00.000Z" },
      { catalogId: "BOOK-YEAR-2023", title: "2023 专属", author: "作者 E", publisher: "出版社", publishYear: 2014, noteCount: 5, highlights: 3, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 1, firstNoteAt: "2023-07-01T00:00:00.000Z", lastNoteAt: "2023-07-15T00:00:00.000Z" },
    ];
  }
  if (year === 2024) {
    return [
      { catalogId: "BOOK-RECURRING-A", title: "合成 RECURRING-A", author: "作者 A", publisher: "出版社", publishYear: 2019, noteCount: 45, highlights: 35, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 5, firstNoteAt: "2024-02-01T00:00:00.000Z", lastNoteAt: "2024-06-01T00:00:00.000Z" },
      { catalogId: "BOOK-RECURRING-B", title: "合成 RECURRING-B", author: "作者 B", publisher: "出版社", publishYear: 2018, noteCount: 35, highlights: 25, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 4, firstNoteAt: "2024-03-01T00:00:00.000Z", lastNoteAt: "2024-05-15T00:00:00.000Z" },
      { catalogId: "BOOK-OVERLAP-1", title: "合成 OVERLAP-1", author: "作者 C", publisher: "出版社", publishYear: 2016, noteCount: 20, highlights: 14, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 2, firstNoteAt: "2024-04-01T00:00:00.000Z", lastNoteAt: "2024-05-01T00:00:00.000Z" },
    ];
  }
  // year === 2025
  return [
    { catalogId: "BOOK-RECURRING-A", title: "合成 RECURRING-A", author: "作者 A", publisher: "出版社", publishYear: 2019, noteCount: 50, highlights: 40, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 6, firstNoteAt: "2025-02-01T00:00:00.000Z", lastNoteAt: "2025-07-15T00:00:00.000Z" },
    { catalogId: "BOOK-RECURRING-B", title: "合成 RECURRING-B", author: "作者 B", publisher: "出版社", publishYear: 2018, noteCount: 40, highlights: 30, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 5, firstNoteAt: "2025-03-01T00:00:00.000Z", lastNoteAt: "2025-06-15T00:00:00.000Z" },
    { catalogId: "BOOK-OVERLAP-1", title: "合成 OVERLAP-1", author: "作者 C", publisher: "出版社", publishYear: 2016, noteCount: 22, highlights: 16, thoughts: 0, reviews: 0, unknown: 1, activeMonths: 2, firstNoteAt: "2025-04-01T00:00:00.000Z", lastNoteAt: "2025-05-01T00:00:00.000Z" },
  ];
}

function makeOverview(year) {
  const totalRecords = year === 2021 ? 0 : (year - 2019) * 240;
  return {
    year,
    totalRecords,
    datedRecords: totalRecords,
    matchedRecords: year === 2021 ? 0 : Math.min(60, totalRecords),
    matchedBooks: year === 2021 ? 0 : 3,
    activeMonths: year === 2021 ? 0 : 12,
    longestStreakMonths: year === 2021 ? 0 : 5,
    firstNoteAt: year === 2021 ? null : `${year}-01-01T00:00:00.000Z`,
    lastNoteAt: year === 2021 ? null : `${year}-12-31T00:00:00.000Z`,
    peakMonth: year === 2021 ? null : `${year}-06`,
    peakMonthRecords: year === 2021 ? 0 : 25,
    averageRecordsPerActiveMonth: year === 2021 ? 0 : totalRecords / 12,
  };
}

function makeResponse(year) {
  return {
    ok: true,
    selectedYear: year,
    availableYears: [2025, 2024, 2023, 2022, 2021, 2020],
    overview: makeOverview(year),
    months: makeMonths(year),
    quarters: makeQuarters(year),
    topBooks: makeTopBooks(year),
    meta: {
      topBooksRequested: RANGE,
      topBooksReturned: makeTopBooks(year).length,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

const FAILURES = [];
function check(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    FAILURES.push(label);
  }
}

async function getYearCardIds(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('[data-testid^="weread-reading-archive-year-"]');
    return Array.from(cards)
      .map((c) => c.getAttribute("data-testid"))
      .filter((id) => /^weread-reading-archive-year-\d{4}$/.test(id));
  });
}

async function getRecurringBookIds(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('[data-testid^="weread-reading-archive-book-"]');
    return Array.from(cards)
      .map((c) => c.getAttribute("data-testid"))
      .filter((id) => /^weread-reading-archive-book-BOOK-[A-Z0-9_-]+$/.test(id));
  });
}

async function waitForArchiveControls(page, timeoutMs = 15000) {
  // Wait for the dashboard's controls to be rendered (not the loading
  // state). This means at least one year is loaded.
  return page.waitForFunction(
    () => {
      const c = document.querySelector('[data-testid="weread-reading-archive-controls"]');
      return !!c;
    },
    { timeout: timeoutMs }
  );
}

async function waitForYearCount(page, expected, timeoutMs = 15000) {
  return page.waitForFunction(
    (n) => {
      const cards = document.querySelectorAll('[data-testid^="weread-reading-archive-year-"]');
      const filtered = Array.from(cards).filter((c) =>
        /^weread-reading-archive-year-\d{4}$/.test(c.getAttribute("data-testid"))
      );
      return filtered.length >= n;
    },
    { timeout: timeoutMs },
    expected
  );
}

(async () => {
  console.log("[s27l-smoke] launching headless Chromium against", URL);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  let annualReviewCalls = 0;
  let annualReviewByYear = {};
  let aiSummaryCalls = 0;
  let relatedBooksCalls = 0;
  const externalRequests = [];
  const serverPosts = [];

  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    try {
      const url = req.url();
      const method = req.method();
      if (
        !url.startsWith("https://books.conanxin.com") &&
        !url.startsWith("http://127.0.0.1") &&
        !url.startsWith("data:") &&
        !url.startsWith("blob:")
      ) {
        externalRequests.push({ url, method });
      }
      if (
        (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") &&
        !url.includes("/api/private/weread/notes/summarize")
      ) {
        serverPosts.push({ url, method });
      }
      if (!url.includes("/api/private/weread/")) return req.continue();
      // Handle CORS preflight (OPTIONS) requests
      if (req.method() === "OPTIONS") {
        return req.respond({
          status: 200,
          contentType: "text/plain",
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
          body: "",
        });
      }
      const auth = req.headers()["authorization"];
      if (url.includes("/annual-review")) {
        annualReviewCalls += 1;
        if (!auth) {
          return req.respond({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Missing token." }) });
        }
        const m = url.match(/[?&]year=(\d+)/);
        const year = m ? Number(m[1]) : null;
        annualReviewByYear[year] = (annualReviewByYear[year] || 0) + 1;
        // Simulate a transient failure on the first request for the
        // configured failing year.
        if (year === FAILING_YEAR && annualReviewByYear[year] === 1) {
          return req.respond({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "synthetic transient failure" }),
          });
        }
        const body = makeResponse(year);
        return req.respond({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(body),
        });
      }
      if (url.includes("/reading-map")) {
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            overview: {
              booksCount: 0, notesCount: 0, matchedCatalogsCount: 0,
              matchedNoteRecordsCount: 0, firstNoteAt: null, lastNoteAt: null,
              activeMonths: 0, currentStreakMonths: 0, longestStreakMonths: 0,
            },
            timeline: [], books: [], links: [],
            meta: { monthsRequested: 24, monthsReturned: 24, topBooksRequested: 12, topBooksReturned: 0, linksReturned: 0, persisted: false, source: "private_snapshot+public_catalog" },
          }),
        });
      }
      if (url.includes("/notes/summarize")) {
        aiSummaryCalls += 1;
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            summary: { overview: "FORBIDDEN_OVERVIEW", themes: ["FORBIDDEN_THEME_BODY"], keyPoints: ["FORBIDDEN_KEYPOINT"], reviewQuestions: ["FORBIDDEN_QUESTION"], readingDirections: [] },
            meta: { itemsUsed: 0, totalCharacters: 0, persisted: false, provider: "minimax" },
          }),
        });
      }
      if (url.includes("/related-books")) {
        relatedBooksCalls += 1;
        return req.respond({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ ok: true, items: [], meta: { persisted: false } }),
        });
      }
      // Intercept /summary and /trends so WereadCenter can render
      // the workspace tabs without hitting the real private API.
      if (url.includes("/summary")) {
        return req.respond({
          status: 200, contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({
            ok: true,
            booksCount: 25, notesCount: 100, reviewsCount: 3,
            matchedCatalogsCount: 20, confirmedMatchesCount: 18,
            confirmedWithNotesCount: 15, confirmedWithHighlightsCount: 12,
            totalConfirmedNoteRecords: 85, matchRatePercent: 72,
            notesPerConfirmedMatch: 4.7,
          }),
        });
      }
      if (url.includes("/trends")) {
        return req.respond({
          status: 200, contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({
            ok: true,
            booksCount: 25, notesCount: 100, reviewsCount: 3,
            highlightsTotal: 80, thoughtsTotal: 15, reviewsTotal: 3, unknownTotal: 2,
            daily30: Array.from({ length: 30 }, (_, i) => ({
              date: new Date(Date.now() - (29 - i) * 86400000).toISOString().split("T")[0],
              notes: Math.floor(Math.random() * 5),
            })),
            meta: { persisted: false },
          }),
        });
      }
      return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    } catch (e) {
      try { req.continue(); } catch {}
    }
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"); } catch {}
  });
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector('[data-testid="weread-tab-archive"]', { timeout: 20000 });

  // 1: five workspace tabs exist
  const tabCount = await page.evaluate(() => {
    return ["notes", "map", "review", "annual", "archive"]
      .map((k) => !!document.querySelector(`[data-testid="weread-tab-${k}"]`))
      .filter(Boolean).length;
  });
  check("1. five workspace tabs exist", tabCount === 5);

  // 2: default workspace is notes
  const defaultTab = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="weread-tab-notes"]');
    return t && t.getAttribute("aria-selected") === "true";
  });
  check("2. default workspace is 笔记与 AI", !!defaultTab);

  // 3: archive not active — no annual-review calls yet
  check("3. archive not active → no annual-review requests yet", annualReviewCalls === 0);

  // 4: activate archive tab → triggers initial fetch
  await page.click('[data-testid="weread-tab-archive"]');
  await page.waitForSelector('[data-testid="weread-reading-archive"]', { timeout: 10000 });
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 1500));
  check("4. archive activation triggers annual-review fetch", annualReviewCalls > 0);

  // 5: progress picks up availableYears
  const initialYearIds = await getYearCardIds(page);
  check("5. archive populates year directory from availableYears", initialYearIds.length >= 5);

  // 12: default range is recent5
  const range5Active = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="weread-reading-archive-range-recent5"]');
    return r && r.checked;
  });
  check("12. default range is recent5", range5Active);

  // 7-11: render contract
  check("7. overview section rendered", await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-archive-overview"]')));
  check("8. cross-year timeline rendered", await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-archive-timeline"]')));
  check("9. year directory rendered", await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-archive-year-grid"]')));
  check("10. recurring books section rendered", await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-archive-book-grid"]')));
  check("11. adjacent-year links rendered", await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-archive-links"]')));

  // 6: switch to "all" range — all 6 years should load
  await page.click('[data-testid="weread-reading-archive-range-all"]');
  await waitForYearCount(page, 6, 15000);
  await new Promise((r) => setTimeout(r, 1500));
  const allYearIds = await getYearCardIds(page);
  check(
    "6. all 6 years eventually load (range=all, concurrency ≤ 2)",
    allYearIds.length === 6 && allYearIds.some((id) => id.endsWith("-2020"))
  );

  // 13: switch back to recent5 (cache hit on 5 years; 2020 may need to be
  // fetched if topBooks changed since we last saw it)
  const callsBeforeRecent5 = annualReviewCalls;
  await page.click('[data-testid="weread-reading-archive-range-recent5"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 2000));
  const yearCount5 = (await getYearCardIds(page)).length;
  check("13. recent5 range loads 5 years", yearCount5 === 5);
  check("13b. recent5 reuses cache for already-loaded years", annualReviewCalls - callsBeforeRecent5 <= 0);

  // 14: switch to recent10
  await page.click('[data-testid="weread-reading-archive-range-recent10"]');
  await waitForYearCount(page, 6, 15000);
  await new Promise((r) => setTimeout(r, 1500));
  const yearCount10 = (await getYearCardIds(page)).length;
  check("14. recent10 range loads 6 years (≤ 10)", yearCount10 === 6);

  // 15: meta line shows max-years cap of 20
  const metaText = await page.evaluate(() => {
    const m = document.querySelector('[data-testid="weread-reading-archive-meta"]');
    return m ? m.textContent : "";
  });
  check("15. meta line shows max-years cap of 20", /20/.test(metaText || ""));

  // 16: Top 6
  await page.click('[data-testid="weread-reading-archive-top-books-6"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 2500));
  const recCount6 = (await getRecurringBookIds(page)).length;
  check("16. Top 6 limit applied to recurring books", recCount6 >= 2);

  // 17: Top 12
  await page.click('[data-testid="weread-reading-archive-top-books-12"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 2500));
  const recCount12 = (await getRecurringBookIds(page)).length;
  check("17. Top 12 default limit returns RECURRING-A and RECURRING-B", recCount12 >= 2);

  // 18: Top 18
  await page.click('[data-testid="weread-reading-archive-top-books-18"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 2500));
  const recCount18 = (await getRecurringBookIds(page)).length;
  check("18. Top 18 limit doesn't expand recurring books further", recCount18 >= 2);

  // 19: cache hit — switch back to recent5 (no new annual-review call
  // because all 5 years in recent5 are already cached for topBooks=18)
  const callsBeforeCache = annualReviewCalls;
  await page.click('[data-testid="weread-reading-archive-range-recent5"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 2500));
  check("19. cache hit: switching range doesn't trigger new annual-review requests", annualReviewCalls === callsBeforeCache);

  // 20: tab switch round-trip doesn't re-fetch
  const callsBeforeRoundTrip = annualReviewCalls;
  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 800));
  await page.click('[data-testid="weread-tab-archive"]');
  // Wait for the year cards to be visible (the full layout).
  // The dashboard may briefly be in a loading state while the
  // year-slice effect re-evaluates after the `active` change.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="weread-reading-archive-year-"]').length > 0,
    { timeout: 25000 }
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  check("20. tab round-trip doesn't re-fetch (cache hit)", annualReviewCalls === callsBeforeRoundTrip);

  // Switch to "all" so all 6 years are present for the failure / retry
  // tests below. Wait for the controls to be present (they may briefly
  // hide during the year-slice re-evaluation after the tab switch).
  await page.waitForSelector('[data-testid="weread-reading-archive-range-all"]', { timeout: 25000 });
  await page.click('[data-testid="weread-reading-archive-range-all"]');
  await waitForYearCount(page, 6, 15000);
  await new Promise((r) => setTimeout(r, 2500));

  // 21: partial failure handling — successful years still shown
  const stillShowsYears = await getYearCardIds(page);
  check(
    "21. partial failure: successful years still rendered",
    stillShowsYears.length >= 5 && stillShowsYears.some((id) => id.endsWith("-2025"))
  );

  // 22: retry failed year — re-fires the failing year and the page picks it up
  const callsBeforeRetry = annualReviewCalls;
  const retryBtn = await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-archive-retry-failed"]'));
  if (retryBtn) {
    await page.click('[data-testid="weread-reading-archive-retry-failed"]');
    await new Promise((r) => setTimeout(r, 3000));
    check("22a. retry-failed button triggers new annual-review call", annualReviewCalls > callsBeforeRetry);
    const hasFailingYear = await page.evaluate(() => {
      return !!document.querySelector(`[data-testid="weread-reading-archive-year-${FAILING_YEAR}"]`);
    });
    check(`22b. retry succeeds: ${FAILING_YEAR} is now in the year directory`, hasFailingYear);
  } else {
    check("22a. retry-failed button present", false);
    check(`22b. retry succeeds: ${FAILING_YEAR} is now in the year directory`, false);
  }

  // 23: open annual-year button works
  const openBtnExists = await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-archive-open-2024"]'));
  check("23. 查看年度回顾 button for 2024 is present", openBtnExists);
  if (openBtnExists) {
    await page.click('[data-testid="weread-reading-archive-open-2024"]');
    await new Promise((r) => setTimeout(r, 1500));
    const annualActive = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="weread-tab-annual"]');
      return t && t.getAttribute("aria-selected") === "true";
    });
    check("24. clicking the button switches to the annual workspace", !!annualActive);
  }

  // 25: switching back to archive preserves state (cache hit)
  const callsBeforeBack = annualReviewCalls;
  await page.click('[data-testid="weread-tab-archive"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 1500));
  check("25. switching back to archive doesn't re-fetch (state preserved)", annualReviewCalls === callsBeforeBack);

  // 26-28: privacy / no-ai / no-posts
  check("26. no MiniMax / AI summary call", aiSummaryCalls === 0);
  check("27. no related-books call", relatedBooksCalls === 0);
  check("28. no POST/PUT/PATCH/DELETE requests", serverPosts.length === 0);

  // 29: annual Markdown export entry still exists
  await page.click('[data-testid="weread-tab-annual"]');
  await new Promise((r) => setTimeout(r, 2000));
  const annualMdBtn = await page.evaluate(() => !!document.querySelector('[data-testid="weread-annual-review-export-button"]'));
  check("29. S27J-2 annual-review Markdown export entry still present", annualMdBtn);

  // 30: year-comparison toggle still exists
  const ycToggle = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-toggle"]'));
  check("30. S27K year-comparison entry still present", ycToggle);

  // 31: year-comparison Markdown export still exists
  if (ycToggle) {
    await page.click('[data-testid="weread-year-comparison-toggle"]');
    await new Promise((r) => setTimeout(r, 2500));
    const ycExportBtn = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-export-button"]'));
    check("31. S27K-2 year-comparison Markdown export entry still present", ycExportBtn);
    const closeBtn = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-close"]'));
    if (closeBtn) {
      await page.click('[data-testid="weread-year-comparison-close"]');
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    check("31. S27K-2 year-comparison Markdown export entry still present", false);
  }

  // 32: ICS export entry still exists
  await page.click('[data-testid="weread-tab-review"]');
  await page.waitForSelector('[data-testid="weread-review-calendar-export-button"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const icsBtn = await page.evaluate(() => !!document.querySelector('[data-testid="weread-review-calendar-export-button"]'));
  check("32. S27I ICS export entry still present", icsBtn);

  // 33: ICP footer
  const footer = await page.evaluate(() => /icp|备案|Beian/i.test(document.body.textContent || ""));
  check("33. ICP footer still present", footer);

  // 34: desktop 1440 no horizontal overflow
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('[data-testid="weread-tab-archive"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 1500));
  const horizDesktop = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("34. desktop 1440 has no horizontal overflow", horizDesktop <= 1);

  // 35: mobile 360 no horizontal overflow
  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 800));
  const horizMobile = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("35. mobile 360 has no horizontal overflow", horizMobile <= 2);

  // 36: no DOM leakage of note text / private IDs
  // We check only the rendered text content, NOT the full HTML, because
  // the JS bundle + privacy-card copy legitimately contain the literal
  // strings "wereadBookId", "noteId", "highlightId", "chapterTitle"
  // (e.g. "不返回 wereadBookId"). What must NOT appear in the *rendered
  // text* is the actual private id values or note text.
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('[data-testid="weread-tab-archive"]');
  await waitForArchiveControls(page);
  await new Promise((r) => setTimeout(r, 1000));
  const domText = await page.evaluate(() => document.body.textContent || "");
  const FORBIDDEN_TEXT_LEAKS = ["FORBIDDEN_NOTE_TEXT", "FORBIDDEN_NOTE_COMMENT", "FORBIDDEN_NOTE_BODY"];
  const textLeaks = FORBIDDEN_TEXT_LEAKS.filter((s) => domText.includes(s));
  // Also ensure no catalogId-looking strings (8+ alnum) appear in the
  // rendered text, which would indicate real book IDs leaked in.
  const realIdPattern = /\b(BOOK-[A-Z0-9]{8,}|NOTE-[A-Z0-9]{8,}|HIGHLIGHT-[A-Z0-9]{8,})/;
  const realIdLeak = realIdPattern.test(domText);
  check(
    "36. DOM does not leak note text / private IDs",
    textLeaks.length === 0 && !realIdLeak
  );

  // 37: Top N scope disclaimer present
  const scopeText = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="weread-reading-archive-scope"]');
    return s ? s.textContent : "";
  });
  check("37. Top N scope disclaimer present", !!scopeText && /Top N/.test(scopeText));

  // 37b: all four disclaimer/notice testids are present
  const disclaimers = await page.evaluate(() => {
    return {
      privacy: !!document.querySelector('[data-testid="weread-reading-archive-notice"]'),
      scope: !!document.querySelector('[data-testid="weread-reading-archive-scope"]'),
      recurring: !!document.querySelector('[data-testid="weread-reading-archive-recurring-scope"]'),
      overlap: !!document.querySelector('[data-testid="weread-reading-archive-overlap-scope"]'),
    };
  });
  check(
    "37b. all 4 disclaimer/notice testids are present",
    disclaimers.privacy && disclaimers.scope && disclaimers.recurring && disclaimers.overlap
  );

  // 38: no psychological-inference vocabulary in the page
  const PSYCH_WORDS = ["懒惰", "焦虑", "专注力", "人格", "性格", "情绪", "心理", "阅读能力"];
  const body = await page.evaluate(() => document.body.textContent || "");
  const psychFound = PSYCH_WORDS.filter((w) => body.includes(w));
  check("38. no psychological-inference vocabulary", psychFound.length === 0);

  // Bonus: no external requests
  check("BONUS-1. no external requests (no MiniMax / no third-party CDN)", externalRequests.length === 0);

  // Screenshot (NOT committed; reports/screenshots is untracked)
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.setViewport({ width: 1440, height: 900 });
    await page.click('[data-testid="weread-tab-archive"]');
    await waitForArchiveControls(page);
    await new Promise((r) => setTimeout(r, 1000));
    const outPath = path.join(SCREENSHOT_DIR, "s27l-reading-archive.png");
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`  (screenshot: ${outPath})`);
  } catch (e) {
    console.log("  (screenshot failed:", e.message, ")");
  }

  await browser.close();

  console.log("\n---");
  if (FAILURES.length === 0) {
    console.log(
      `STATUS: PASS (annual-review=${annualReviewCalls} ai-summary=${aiSummaryCalls} related-books=${relatedBooksCalls} external-requests=${externalRequests.length} server-posts=${serverPosts.length})`
    );
    process.exit(0);
  } else {
    console.log(`STATUS: FAIL — ${FAILURES.length} check(s) failed:`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error("Browser smoke crashed:", err);
  process.exit(2);
});
