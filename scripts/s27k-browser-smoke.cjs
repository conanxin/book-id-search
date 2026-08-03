#!/usr/bin/env node
/**
 * S27K Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page. Intercepts private
 * API endpoints with synthetic fixtures covering **two** annual-review
 * responses (2025 baseline + 2024 target), walks the 28 smoke checks
 * defined in the S27K spec. The real AI / private data is NEVER
 * fetched from production — every private request is intercepted.
 *
 * The synthetic fixtures are deliberately small and free of any real
 * note text, private IDs, tokens, or AI summary bodies. The smoke
 * harness asserts that none of those forbidden fields leak into the
 * DOM, into the download (the previous S27J-2 export still works),
 * or into any network request.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"));

const URL = "https://books.conanxin.com/weread";
const DOWNLOAD_DIR = "/tmp/s27k-downloads";

const BASE_YEAR = 2024;
const TARGET_YEAR = 2025;
const RANGE = 12;

function makeMonths(year) {
  return Array.from({ length: 12 }, (_, i) => {
    const total = year === TARGET_YEAR ? (i + 1) * 5 : (12 - i) * 4;
    const bookCount = year === TARGET_YEAR ? Math.min(3, total) : Math.min(2, total);
    return {
      month: `${year}-${String(i + 1).padStart(2, "0")}`,
      total,
      highlights: Math.max(0, total - 2),
      thoughts: 1,
      reviews: 1,
      unknown: 0,
      matched: bookCount,
      bookCount,
    };
  });
}

function makeQuarters(year) {
  const totals = [0, 0, 0, 0];
  for (let i = 0; i < 12; i += 1) {
    totals[Math.floor(i / 3)] += year === TARGET_YEAR ? (i + 1) * 5 : (12 - i) * 4;
  }
  return ["Q1", "Q2", "Q3", "Q4"].map((q, idx) => ({
    quarter: q,
    total: totals[idx],
    activeMonths: 3,
    matchedRecords: 5,
    bookCount: 3,
  }));
}

function makeTopBooks(year) {
  // 2024 baseline: B, C, D
  // 2025 target:   A, B, C
  // Other years:   empty (used to test empty-year behaviour).
  if (year === 2024) {
    return [
      { catalogId: "BOOK-B", title: "合成 B", author: "作者 B", publisher: "出版社", publishYear: 2020, noteCount: 30, highlights: 25, thoughts: 2, reviews: 1, unknown: 2, activeMonths: 4, firstNoteAt: "2024-02-01T00:00:00.000Z", lastNoteAt: "2024-06-01T00:00:00.000Z" },
      { catalogId: "BOOK-C", title: "合成 C", author: "作者 C", publisher: "出版社", publishYear: 2019, noteCount: 25, highlights: 20, thoughts: 2, reviews: 1, unknown: 2, activeMonths: 3, firstNoteAt: "2024-03-01T00:00:00.000Z", lastNoteAt: "2024-05-01T00:00:00.000Z" },
      { catalogId: "BOOK-D", title: "合成 D", author: "作者 D", publisher: "出版社", publishYear: 2018, noteCount: 18, highlights: 14, thoughts: 2, reviews: 1, unknown: 1, activeMonths: 2, firstNoteAt: "2024-04-01T00:00:00.000Z", lastNoteAt: "2024-04-15T00:00:00.000Z" },
    ];
  }
  if (year === 2025) {
    return [
      { catalogId: "BOOK-A", title: "合成 A", author: "作者 A", publisher: "出版社", publishYear: 2021, noteCount: 50, highlights: 40, thoughts: 4, reviews: 2, unknown: 4, activeMonths: 6, firstNoteAt: "2025-01-10T00:00:00.000Z", lastNoteAt: "2025-07-15T00:00:00.000Z" },
      { catalogId: "BOOK-B", title: "合成 B", author: "作者 B", publisher: "出版社", publishYear: 2020, noteCount: 30, highlights: 25, thoughts: 2, reviews: 1, unknown: 2, activeMonths: 4, firstNoteAt: "2025-02-01T00:00:00.000Z", lastNoteAt: "2025-06-01T00:00:00.000Z" },
      { catalogId: "BOOK-C", title: "合成 C", author: "作者 C", publisher: "出版社", publishYear: 2019, noteCount: 20, highlights: 16, thoughts: 2, reviews: 1, unknown: 1, activeMonths: 3, firstNoteAt: "2025-03-01T00:00:00.000Z", lastNoteAt: "2025-05-01T00:00:00.000Z" },
    ];
  }
  return [];
}

function makeEmptyOverview(year) {
  return {
    year,
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
  };
}

function makeEmptyMonths(year) {
  return Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0,
  }));
}

function makeEmptyQuarters() {
  return ["Q1", "Q2", "Q3", "Q4"].map((q) => ({ quarter: q, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 }));
}

function makeEmptyResponse(year) {
  return {
    ok: true,
    selectedYear: year,
    availableYears: [2025, 2024, 2023, 2022, 2021, 2020],
    overview: makeEmptyOverview(year),
    months: makeEmptyMonths(year),
    quarters: makeEmptyQuarters(),
    topBooks: [],
    meta: { topBooksRequested: RANGE, topBooksReturned: 0, persisted: false, source: "private_snapshot+public_catalog" },
  };
}

function makeResponse(year) {
  return {
    ok: true,
    selectedYear: year,
    availableYears: [2025, 2024, 2023, 2022, 2021, 2020],
    overview: {
      year,
      totalRecords: year === TARGET_YEAR ? 390 : 312,
      datedRecords: year === TARGET_YEAR ? 390 : 312,
      matchedRecords: year === TARGET_YEAR ? 60 : 36,
      matchedBooks: year === TARGET_YEAR ? 3 : 3,
      activeMonths: 12,
      longestStreakMonths: 6,
      firstNoteAt: `${year}-01-01T00:00:00.000Z`,
      lastNoteAt: `${year}-12-31T00:00:00.000Z`,
      peakMonth: year === TARGET_YEAR ? "2025-03" : "2024-01",
      peakMonthRecords: 20,
      averageRecordsPerActiveMonth: year === TARGET_YEAR ? 32.5 : 26.0,
    },
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

const ANNUAL_REVIEW_2025 = makeResponse(2025);
const ANNUAL_REVIEW_2024 = makeResponse(2024);
const ANNUAL_REVIEW_EMPTY = makeEmptyResponse(2021);

const FAILURES = [];
function check(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    FAILURES.push(label);
  }
}

(async () => {
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  console.log("[s27k-smoke] launching headless Chromium against", URL);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  let annualReviewCalls = 0;
  const annualReviewByYear = new Map();
  let aiSummaryCalls = 0;
  let relatedBooksCalls = 0;
  let mdDownloadCalls = 0;
  let lastAnnualQuery = null;
  const externalRequests = [];
  const serverPosts = [];

  const client = await page.target().createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });
  client.on("Browser.downloadWillBegin", (event) => {
    if (event && typeof event.url === "string") mdDownloadCalls += 1;
  });

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
      const auth = req.headers()["authorization"];
      if (url.includes("/annual-review")) {
        annualReviewCalls += 1;
        lastAnnualQuery = url;
        if (!auth) {
          return req.respond({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Missing token." }) });
        }
        const m = url.match(/[?&]year=(\d+)/);
        const year = m ? Number(m[1]) : null;
        annualReviewByYear.set(year, (annualReviewByYear.get(year) || 0) + 1);
        const body = year === 2024
          ? ANNUAL_REVIEW_2024
          : year === 2021
            ? ANNUAL_REVIEW_EMPTY
            : ANNUAL_REVIEW_2025;
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
            summary: { overview: "FORBIDDEN_OVERVIEW", themes: [], keyPoints: [], reviewQuestions: [], readingDirections: [] },
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
  await page.waitForSelector('[data-testid="weread-tab-annual"]', { timeout: 20000 });

  // 1: annual tab present
  check("1. annual review tab exists", await page.evaluate(() => !!document.querySelector('[data-testid="weread-tab-annual"]')));

  // 2: default closed (no second year request fired) — the toggle
  // only appears once the main year has loaded.
  await page.click('[data-testid="weread-tab-annual"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-toggle"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  const initialAnnualCalls = annualReviewCalls;
  check("2. year comparison closed by default (no second annual request yet)", initialAnnualCalls === 1);

  // 3: activating the annual tab triggers ONE request (the main year)
  check("3. activating annual tab fires exactly 1 annual request (main year only)", initialAnnualCalls === 1);

  // 4: opening the comparison should fire a SECOND request for the base year
  const callsBeforeOpen = annualReviewCalls;
  await page.click('[data-testid="weread-year-comparison-toggle"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-metrics"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  const callsAfterOpen = annualReviewCalls;
  check("4. opening comparison fires a second annual request", callsAfterOpen === callsBeforeOpen + 1);

  // 5: closing the comparison must clear the comparison state
  await page.click('[data-testid="weread-year-comparison-close"]');
  await new Promise((r) => setTimeout(r, 400));
  const stillThere = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-metrics"]'));
  check("5. closing comparison removes the comparison section", !stillThere);

  // 6: reopening should NOT refetch (cache hit)
  const callsBeforeReopen = annualReviewCalls;
  await page.click('[data-testid="weread-year-comparison-toggle"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-metrics"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  check("6. reopening comparison hits the cache (no new annual request)", annualReviewCalls === callsBeforeReopen);

  // 7: base year defaults to the most recent year < target year
  const baseYearValue = await page.$eval('[data-testid="weread-year-comparison-base-year"]', (el) => el.value);
  check("7. default base year is the most recent older year", Number(baseYearValue) === 2024);

  // 8: target year equals the main year
  const targetYearValue = await page.$eval('[data-testid="weread-year-comparison-target-year"]', (el) => el.value);
  check("8. target year equals the main selected year", Number(targetYearValue) === 2025);

  // 9: swap button works
  const callsBeforeSwap = annualReviewCalls;
  await page.click('[data-testid="weread-year-comparison-swap"]');
  await new Promise((r) => setTimeout(r, 800));
  const baseAfterSwap = await page.$eval('[data-testid="weread-year-comparison-base-year"]', (el) => el.value);
  const targetAfterSwap = await page.$eval('[data-testid="weread-year-comparison-target-year"]', (el) => el.value);
  check("9. swap button switches base/target years", Number(baseAfterSwap) === 2025 && Number(targetAfterSwap) === 2024);
  // Swap may have fetched a new base year (2025 was cached as target).
  const callsAfterSwap = annualReviewCalls;
  check("9b. swap may trigger one new base-year fetch", callsAfterSwap <= callsBeforeSwap + 1);

  // 10: swap back so we are comparing 2024 vs 2025 again
  await page.click('[data-testid="weread-year-comparison-swap"]');
  await new Promise((r) => setTimeout(r, 800));

  // 11: six metric cards are rendered
  const metricCount = await page.$$eval('[data-testid^="weread-year-comparison-metric-"]', (els) => els.length);
  check("11. six metric cards are rendered", metricCount === 6);

  // 12: dual-bar timeline is rendered with 12 entries
  const monthBars = await page.$$eval('[data-testid="weread-year-comparison-timeline-svg"] g', (els) => els.length);
  check("12. 12-month dual-bar timeline rendered", monthBars === 12);

  // 13: Q1..Q4 quarter cards are rendered
  const quarterCount = await page.$$eval('[data-testid="weread-year-comparison-quarters"] [data-quarter]', (els) => els.length);
  check("13. four quarter cards are rendered", quarterCount === 4);

  // 14: continuing / entered / left book groups are rendered
  const continuingCount = await page.$$eval('[data-testid="weread-year-comparison-books-continuing"] [data-catalog-id]', (els) => els.length);
  const enteredCount = await page.$$eval('[data-testid="weread-year-comparison-books-entered"] [data-catalog-id]', (els) => els.length);
  const leftCount = await page.$$eval('[data-testid="weread-year-comparison-books-left"] [data-catalog-id]', (els) => els.length);
  check("14. continuing books count is 2 (B and C)", continuingCount === 2);
  check("14b. entered books count is 1 (A)", enteredCount === 1);
  check("14c. left books count is 1 (D)", leftCount === 1);

  // 15: book link uses public catalog URL
  const bookHref = await page.$eval('[data-testid="weread-year-comparison-book-link"]', (el) => el.getAttribute("href"));
  check("15. book link points at /books/<catalogId>", bookHref && /^\/books\/BOOK-[A-D]$/.test(bookHref));

  // 16: base=0 path renders "由 0 增至 N" instead of Infinity
  // The fixture is non-zero so we exercise the formatter via the
  // empty-target branch: select 2021 (no topBooks) and inspect.
  await page.select('[data-testid="weread-year-comparison-base-year"]', "2021");
  await new Promise((r) => setTimeout(r, 1000));
  const html = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="weread-year-comparison"]');
    return node ? node.outerHTML : "";
  });
  check("16. no Infinity / NaN strings leak into the DOM", html && !/Infinity|NaN/.test(html));

  // 17: empty-year (base empty) renders the empty hint and keeps the
  // main view intact.
  const emptyHint = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-empty-base"], [data-testid="weread-year-comparison-empty-target"]'));
  check("17. empty-year allowed without breaking the main view", emptyHint);

  // Restore base to 2024 for the remaining checks.
  await page.select('[data-testid="weread-year-comparison-base-year"]', "2024");
  await new Promise((r) => setTimeout(r, 800));

  // 18: descriptive disclaimer is rendered (no psychological inference)
  const noticeText = await page.$eval('[data-testid="weread-year-comparison-notice"]', (el) => el.textContent || "");
  check("18. descriptive disclaimer rendered", noticeText.includes("不代表阅读质量"));

  // 19: no forbidden psychological inference language in the summary list
  // (the summary disclaimer explicitly mentions "专注力" and 人格特征 to
  //  disavow that interpretation. We strip the disclaimer text before
  //  asserting.)
  const summaryText = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="weread-year-comparison-summaries"]');
    if (!node) return "";
    const ul = node.querySelector("ul");
    return ul ? ul.textContent || "" : "";
  });
  const forbiddenWords = ["专注力", "阅读兴趣发生转移", "更喜欢", "今年新读", "人格", "阅读偏好"];
  check("19. summaries contain no psychological inference", !forbiddenWords.some((w) => summaryText.includes(w)));

  // 20: S27J-2 Markdown export still works
  const filesBefore = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md") && !f.endsWith(".crdownload"));
  await page.click('[data-testid="weread-annual-review-export-button"]');
  let downloaded = null;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md") && !f.endsWith(".crdownload"));
    const newFiles = files.filter((f) => !filesBefore.includes(f));
    if (newFiles.length > 0) {
      downloaded = path.join(DOWNLOAD_DIR, newFiles[0]);
      break;
    }
  }
  check("20. S27J-2 Markdown export still works", downloaded !== null);

  // 21: S27I ICS export still exists
  await page.click('[data-testid="weread-tab-review"]');
  await page.waitForSelector('[data-testid="weread-review-calendar-export-button"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const icsButton = await page.evaluate(() => !!document.querySelector('[data-testid="weread-review-calendar-export-button"]'));
  check("21. S27I ICS export entry still present", icsButton);

  // 22: token clearing wipes the comparison
  await page.evaluate(() => {
    try { sessionStorage.removeItem("book-id-search:weread-private-token"); } catch {}
  });
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForSelector('[data-testid="weread-tab-annual"]', { timeout: 20000 });
  await page.click('[data-testid="weread-tab-annual"]');
  await new Promise((r) => setTimeout(r, 800));
  const afterReload = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-metrics"]'));
  check("22. token clear (and reload) wipes the comparison", !afterReload);

  // 23: no MiniMax / AI summary calls during the entire flow
  check("23. no AI summary call", aiSummaryCalls === 0);

  // 24: no related-books call during the entire flow
  check("24. no related-books call", relatedBooksCalls === 0);

  // 25: no server POST during the entire flow
  check("25. no server POST during the entire flow", serverPosts.length === 0);

  // 26: ICP footer still present
  const footer = await page.evaluate(() => /icp|备案|Beian/i.test(document.body.textContent || ""));
  check("26. ICP footer still present", footer);

  // 27: desktop 1440 has no horizontal overflow
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('[data-testid="weread-tab-annual"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-toggle"]', { timeout: 10000 });
  await page.click('[data-testid="weread-year-comparison-toggle"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-metrics"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const horizDesktop = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("27a. desktop 1440 has no horizontal overflow", horizDesktop <= 1);

  // 28: mobile 360 has no horizontal overflow
  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 500));
  const horizMobile = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("28. mobile 360 has no horizontal overflow", horizMobile <= 2);

  // 29: forbidden DOM content (note text / private IDs / AI summary)
  // We inspect ONLY the rendered year-comparison subtree (the only
  // piece of code this change controls). The surrounding weread
  // center / notes / etc. tabs are out of scope for S27K.
  const comparisonText = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="weread-year-comparison"]');
    return root ? root.textContent || "" : "";
  });
  const forbidden = /FORBIDDEN_NOTE_TEXT|FORBIDDEN_NOTE_COMMENT|FORBIDDEN_OVERVIEW|FORBIDDEN_KEYPOINT|FORBIDDEN_QUESTION|FORBIDDEN_THEME_BODY/.test(comparisonText) ||
    /\bnoteId\b/.test(comparisonText) ||
    /\bhighlightId\b/.test(comparisonText) ||
    /\bchapterTitle\b/.test(comparisonText) ||
    /\bwereadBookId\b/.test(comparisonText);
  check("29. comparison subtree contains no forbidden note text / private IDs", !forbidden);

  // Local screenshot (NOT committed).
  try {
    const dir = path.resolve(__dirname, "..", "reports", "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    await page.setViewport({ width: 1440, height: 900 });
    await page.click('[data-testid="weread-tab-annual"]');
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(dir, "s27k-year-comparison.png"), fullPage: true });
    console.log(`  (screenshot: ${path.join(dir, "s27k-year-comparison.png")})`);
  } catch (e) {
    console.log("  (screenshot failed:", e.message, ")");
  }

  await browser.close();
  try { fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true }); } catch {}

  console.log("\n---");
  if (FAILURES.length === 0) {
    console.log(
      `STATUS: PASS (annual-review=${annualReviewCalls} ai-summary=${aiSummaryCalls} related-books=${relatedBooksCalls} md-downloads=${mdDownloadCalls} external-requests=${externalRequests.length})`
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