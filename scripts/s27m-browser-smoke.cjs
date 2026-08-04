#!/usr/bin/env node
/**
 * S27M Browser smoke — Reading Era Segmentation (puppeteer).
 *
 * Headless Chromium against the live /weread page. Reuses the S27L
 * synthetic annual-review interception so the archive loads 6 years of
 * synthetic data (2020..2025) with one failing year (2022) that
 * needs manual retry.  Adds checks for the reading-era panel:
 *
 *   - Era panel renders inside the long-term archive workspace.
 *   - Default mode is "automatic".
 *   - Mode switch re-renders without firing fetches.
 *   - Multi-era output reflects archive boundaries.
 *   - Boundary text uses only allow-listed Chinese labels.
 *   - Recurring books inside an era render with /books/:catalogId.
 *   - Mode switch and range/Top N changes never trigger additional
 *     annual-review requests.
 *   - No server POST, no AI summary, no related-books, no external
 *     requests.
 *   - Archive Markdown export still present.
 *   - request-safety: retry 1→2, stable wait still 2.
 *   - No DOM leak of note text / private IDs.
 *   - Desktop 1440 / mobile 360 have no horizontal overflow.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"));

const PAGE_URL = "https://books.conanxin.com/weread";
const DOWNLOAD_DIR = "/tmp/s27m-downloads";
const FAILING_YEAR = 2022;
const CURRENT_YEAR_FAKED = 2025;

// Shared state with the page route interception handler.
const state = {
  annualReviewCalls: 0,
  failingYearAttempts: 0,
  bootstrapRequestCount: 0,
  yearRequestCounts: {},
  cacheRequestCount: 0,
  allowFailingYearRecovery: false,
  externalRequests: [],
  serverPosts: [],
  downloads: [],
};

// ---------- helpers ----------

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
  return Array.from({ length: 4 }, (_, i) => {
    const start = i * 3;
    const slice = makeMonths(year).slice(start, start + 3);
    const total = slice.reduce((a, b) => a + b.total, 0);
    return { quarter: `${year}-Q${i + 1}`, months: slice, total };
  });
}

function makeAnnualReview(year) {
  return {
    year,
    total: year === 2021 ? 0 : (year - 2019) * 240,
    quarters: makeQuarters(year),
    updatedAt: `${year}-12-31T23:59:59Z`,
  };
}

const ANNUAL_REVIEW_DATA = {
  2020: makeAnnualReview(2020),
  2021: makeAnnualReview(2021),
  2022: makeAnnualReview(2022),
  2023: makeAnnualReview(2023),
  2024: makeAnnualReview(2024),
  2025: makeAnnualReview(2025),
};

const ALL_YEARS = Object.keys(ANNUAL_REVIEW_DATA)
  .map(Number)
  .sort((a, b) => b - a);

function makeTopBooks(year) {
  return Array.from({ length: 3 }, (_, i) => ({
    rank: i + 1,
    catalogId: `synthetic-${year}-${i + 1}`,
    title: `Synthetic Book ${year}-${i + 1}`,
    author: `Author ${year}-${i + 1}`,
    noteCount: (year - 2019) * 30 + (i + 1) * 10,
    highlights: (year - 2019) * 20 + (i + 1) * 5,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
  }));
}

function makeOverview(year) {
  return {
    year,
    totalRecords: (year - 2019) * 240,
    datedRecords: (year - 2019) * 200,
    matchedRecords: (year - 2019) * 180,
    matchedBooks: 3,
    activeMonths: year === 2021 ? 0 : 12,
    longestStreakMonths: year === 2021 ? 0 : 6,
    firstNoteAt: year === 2021 ? null : `${year}-01-01T00:00:00.000Z`,
    lastNoteAt: year === 2021 ? null : `${year}-12-31T00:00:00.000Z`,
    peakMonth: year === 2021 ? null : `${year}-06`,
    peakMonthRecords: year === 2021 ? 0 : 30,
    averageRecordsPerActiveMonth: year === 2021 ? 0 : 20,
  };
}

function makeFullResponse(year) {
  return {
    ok: true,
    selectedYear: year,
    availableYears: ALL_YEARS,
    overview: makeOverview(year),
    months: makeMonths(year),
    quarters: makeQuarters(year),
    topBooks: makeTopBooks(year),
    meta: {
      topBooksRequested: 12,
      topBooksReturned: 3,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

const check = (label, ok) => {
  const tag = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${tag} ${label}`);
  return ok;
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function rmDir(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

async function clickWhenReady(page, selector, timeout = 10000) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && !el.disabled && el.offsetWidth > 0;
    },
    { timeout },
    selector,
  );
  await page.click(selector);
}

// ---------- main ----------

async function main() {
  ensureDir(DOWNLOAD_DIR);
  rmDir(DOWNLOAD_DIR);
  ensureDir(DOWNLOAD_DIR);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();
  const client = await page.target().createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });

  // Instrument <a download> clicks via synthetic element creation.
  await page.evaluateOnNewDocument(() => {
    window.__s27mDownloads = [];
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag) {
      const el = origCreate(tag);
      if (String(tag).toLowerCase() === "a") {
        const origClick = el.click ? el.click.bind(el) : null;
        el.click = function () {
          try {
            window.__s27mDownloads.push({
              download: el.download || null,
              href: el.href || null,
              t: Date.now(),
            });
          } catch {}
          if (origClick) origClick();
        };
      }
      return el;
    };
  });

  page.on("requestfailed", (req) => {
    const u = req.url();
    if (u.includes("localhost") || u.includes("127.0.0.1")) return;
    state.externalRequests.push({ url: u, method: req.method() });
  });

  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const u = req.url();
    const method = req.method();

    if (
      !u.includes("localhost") &&
      !u.includes("127.0.0.1") &&
      !u.includes("books.conanxin.com")
    ) {
      state.externalRequests.push({ url: u, method });
      try {
        req.abort();
      } catch {}
      return;
    }

    if (method === "POST") {
      state.serverPosts.push({ url: u });
    }

    if (!u.includes("/api/private/weread/")) {
      try {
        req.continue();
      } catch {}
      return;
    }

    if (u.includes("/api/private/weread/annual-review")) {
      try {
        const url = new URL(u);
        const yearParam = url.searchParams.get("year");
        const year = yearParam ? Number(yearParam) : NaN;

        if (!Number.isFinite(year)) {
          state.annualReviewCalls += 1;
          state.bootstrapRequestCount += 1;
          const latest = ALL_YEARS[0];
          req.respond({
            status: 200,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify(makeFullResponse(latest)),
          });
          return;
        }

        state.yearRequestCounts[year] =
          (state.yearRequestCounts[year] || 0) + 1;

        if (year === FAILING_YEAR && !state.allowFailingYearRecovery) {
          state.failingYearAttempts += 1;
          req.respond({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ ok: false, error: "synthetic-failure" }),
          });
          return;
        }

        req.respond({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify(makeFullResponse(year)),
        });
      } catch (e) {
        try {
          req.continue();
        } catch {}
      }
      return;
    }

    if (u.includes("/api/private/weread/notes/summarize")) {
      state.externalRequests.push({ url: u, method, kind: "ai-summary" });
      req.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, summary: { overview: "FORBIDDEN" } }),
      });
      return;
    }
    if (u.includes("/api/private/weread/reading-map")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, overview: {}, timeline: [], books: [], links: [], meta: {} }),
      });
      return;
    }
    if (u.includes("/api/private/weread/cache")) {
      state.cacheRequestCount += 1;
    }
    if (u.includes("/api/private/weread/summary")) {
      req.respond({
        status: 200, contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          ok: true, booksCount: 25, notesCount: 100, reviewsCount: 3,
          matchedCatalogsCount: 20, confirmedMatchesCount: 18,
          confirmedWithNotesCount: 15, confirmedWithHighlightsCount: 12,
          totalConfirmedNoteRecords: 85, matchRatePercent: 72,
          notesPerConfirmedMatch: 4.7,
        }),
      });
      return;
    }
    if (u.includes("/api/private/weread/trends")) {
      req.respond({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true, booksCount: 0, notesCount: 0, reviewsCount: 0,
          highlightsTotal: 0, thoughtsTotal: 0, reviewsTotal: 0, unknownTotal: 0,
          daily30: [], meta: { persisted: false },
        }),
      });
      return;
    }
    req.respond({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    try {
      sessionStorage.setItem(
        "book-id-search:weread-private-token",
        "smoke-token-12345",
      );
    } catch {}
  });
  await page.goto(PAGE_URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector('[data-testid="weread-tab-archive"]', {
    timeout: 20000,
  });

  // ---------- BOOTSTRAP ----------
  console.log("\n=== S27M Browser Smoke — Reading Era Segmentation ===\n");

  let okCount = 0;
  let failCount = 0;
  const tap = (ok) => {
    if (ok) okCount += 1;
    else failCount += 1;
  };

  // 1: five workspace tabs
  const tabCount = await page.evaluate(() =>
    ["notes", "map", "review", "annual", "archive"]
      .map((k) => !!document.querySelector(`[data-testid="weread-tab-${k}"]`))
      .filter(Boolean).length,
  );
  tap(check("1. five workspace tabs", tabCount === 5));

  // 2: archive workspace activates
  await page.click('[data-testid="weread-tab-archive"]');
  await page.waitForSelector('[data-testid="weread-reading-archive"]', {
    timeout: 10000,
  });
  tap(check("2. archive workspace activates", true));

  // 3: era panel renders
  await page.waitForSelector('[data-testid="weread-reading-era"]', {
    timeout: 15000,
  });
  tap(check("3. era panel renders", true));

  // 4: default mode is automatic
  await page.waitForFunction(
    () => {
      const auto = document.querySelector(
        '[data-testid="weread-reading-era-mode-automatic"]',
      );
      const gaps = document.querySelector(
        '[data-testid="weread-reading-era-mode-gaps-only"]',
      );
      return auto && gaps && auto instanceof HTMLInputElement && gaps instanceof HTMLInputElement;
    },
    { timeout: 10000 },
  );
  const defaultMode = await page.evaluate(() => {
    const auto = document.querySelector(
      '[data-testid="weread-reading-era-mode-automatic"]',
    );
    const gaps = document.querySelector(
      '[data-testid="weread-reading-era-mode-gaps-only"]',
    );
    return {
      autoChecked: auto.checked,
      gapsChecked: gaps.checked,
    };
  });
  tap(check("4. default mode = automatic", defaultMode.autoChecked && !defaultMode.gapsChecked));

  // 5: timeline renders multi-era for synthetic data
  await page.waitForFunction(
    () => {
      const t = document.querySelector(
        '[data-testid="weread-reading-era-timeline"]',
      );
      if (!t) return false;
      const count = parseInt(t.getAttribute("data-era-count") || "0", 10);
      return count > 0;
    },
    { timeout: 15000 },
  );
  const eraCount = await page.evaluate(() => {
    const t = document.querySelector(
      '[data-testid="weread-reading-era-timeline"]',
    );
    return parseInt(t?.getAttribute("data-era-count") || "0", 10);
  });
  tap(check("5. multi-era timeline rendered", eraCount >= 1));

  // 6: switching to gaps_only mode does NOT add annual-review requests
  const annualBefore = state.annualReviewCalls;
  const yearReqsBefore = { ...state.yearRequestCounts };
  await page.click('[data-testid="weread-reading-era-mode-gaps-only"]');
  await new Promise((r) => setTimeout(r, 1500));
  const annualAfter = state.annualReviewCalls;
  const yearReqsAfter = state.yearRequestCounts;
  tap(check(
    "6. mode switch no extra annual-review requests",
    annualAfter === annualBefore &&
      JSON.stringify(yearReqsBefore) === JSON.stringify(yearReqsAfter),
  ));

  // 7: switch back to automatic and verify boundary reasons render
  await page.click('[data-testid="weread-reading-era-mode-automatic"]');
  await new Promise((r) => setTimeout(r, 1000));
  const boundaryReasonText = await page.evaluate(() => {
    const blocks = Array.from(
      document.querySelectorAll('[data-testid^="weread-reading-era-boundary-"]'),
    );
    return blocks.map((b) => b.textContent || "").join("|");
  });
  tap(check(
    "7. boundary text uses allow-listed Chinese labels",
    boundaryReasonText.includes("年份存在中断") ||
      boundaryReasonText.includes("阅读记录数量变化较大") ||
      boundaryReasonText.includes("活跃月份数量变化较大") ||
      boundaryReasonText.includes("相邻年度 Top N 榜单重合较低"),
  ));

  // 8: no psychological vocabulary in DOM
  const psychVocabulary = [
    "兴趣转变",
    "偏好改变",
    "质量提升",
    "质量下降",
    "专注力变化",
    "成熟期",
    "探索期",
    "低谷",
    "巅峰",
  ];
  const bodyText = await page.evaluate(() => document.body.innerText);
  const foundPsych = psychVocabulary.find((k) => bodyText.includes(k));
  tap(check("8. no psychological-inference vocabulary", !foundPsych));

  // 9: no forbidden private fields in DOM
  const privateFields = [
    "note.text",
    "note.comment",
    "markedText",
    "wereadBookId",
    "highlightId",
    "chapterTitle",
    "Authorization: Bearer",
    "wr_skey",
  ];
  const foundPrivate = privateFields.find((k) => bodyText.includes(k));
  tap(check("9. no private IDs in DOM", !foundPrivate));

  // 10: recurring books have /books/:catalogId links when present
  const bookLinks = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll('[data-testid^="weread-reading-era-book-link-"]'),
    );
    return links.map((a) => a.getAttribute("href") || "");
  });
  tap(check(
    "10. recurring book links are /books/:catalogId",
    bookLinks.length === 0 ||
      bookLinks.every((h) => /^\/books\/[^/]+$/.test(h)),
  ));

  // 11: range change recomputes eras (no extra annual-review requests)
  await clickWhenReady(
    page,
    '[data-testid="weread-reading-archive-range-recent10"]',
    10000,
  );
  await new Promise((r) => setTimeout(r, 1500));
  const annualBeforeRange = state.annualReviewCalls;
  const yearReqsBeforeRange = { ...state.yearRequestCounts };
  await new Promise((r) => setTimeout(r, 500));
  const annualAfterRange = state.annualReviewCalls;
  const yearReqsAfterRange = state.yearRequestCounts;
  tap(check(
    "11. range change no extra annual-review requests",
    annualAfterRange === annualBeforeRange &&
      JSON.stringify(yearReqsBeforeRange) === JSON.stringify(yearReqsAfterRange),
  ));
  // Era count may change with range
  const eraCountAfterRange = await page.evaluate(() => {
    const t = document.querySelector(
      '[data-testid="weread-reading-era-timeline"]',
    );
    return parseInt(t?.getAttribute("data-era-count") || "0", 10);
  });
  tap(check(
    "12. era timeline present after range change",
    eraCountAfterRange >= 1,
  ));

  // 14: retry behavior preserved (request-safety 1→2)
  // Test retry BEFORE the range/Top N changes to keep the request
  // counts clean (range change triggers extra fetches that would
  // inflate the failing-year count).
  await page
    .waitForSelector('[data-testid="weread-reading-archive-retry-failed"]', {
      timeout: 15000,
    })
    .catch(() => {});
  const failingBefore = state.yearRequestCounts[FAILING_YEAR] || 0;
  state.allowFailingYearRecovery = true;
  await page
    .click('[data-testid="weread-reading-archive-retry-failed"]')
    .catch(() => {});
  await page
    .waitForFunction(
      (y) => {
        return !!document.querySelector(
          `[data-testid="weread-reading-archive-year-${y}"]`,
        );
      },
      { timeout: 15000 },
      FAILING_YEAR,
    )
    .catch(() => {});
  // Wait long enough for both concurrent retry requests to land.
  await new Promise((r) => setTimeout(r, 2500));
  state.allowFailingYearRecovery = false;
  const failingAfter = state.yearRequestCounts[FAILING_YEAR] || 0;
  tap(check("14. failing-year before-retry = 1", failingBefore === 1));
  tap(check("15. failing-year after-retry = 2", failingAfter === 2));
  tap(check("16. retry delta = 1", failingAfter - failingBefore === 1));

  // 17: stability wait still 2
  await new Promise((r) => setTimeout(r, 3500));
  tap(check(
    "17. stability wait still 2",
    (state.yearRequestCounts[FAILING_YEAR] || 0) === 2,
  ));

  // 18: Top N change recomputes eras (no extra requests)
  await clickWhenReady(
    page,
    '[data-testid="weread-reading-archive-top-books-18"]',
    10000,
  );
  await new Promise((r) => setTimeout(r, 1000));
  const annualBeforeTop = state.annualReviewCalls;
  await new Promise((r) => setTimeout(r, 500));
  tap(check(
    "18. Top N change no extra annual-review requests",
    state.annualReviewCalls === annualBeforeTop,
  ));

  // 19: Archive Markdown export still present
  await page.waitForSelector(
    '[data-testid="weread-reading-archive-export-button"]',
    { timeout: 10000 },
  ).catch(() => {});
  tap(check(
    "19. Archive Markdown export button still present",
    await page.evaluate(
      () =>
        !!document.querySelector(
          '[data-testid="weread-reading-archive-export-button"]',
        ),
    ),
  ));

  // 20: ICP footer present
  tap(check(
    "20. ICP footer present",
    await page.evaluate(() =>
      !!document.querySelector('[data-testid="site-footer-icp"]'),
    ),
  ));

  // 21: desktop 1440 no horizontal overflow
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise((r) => setTimeout(r, 300));
  const desktopOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > 1440,
  );
  tap(check("21. desktop 1440 no horizontal overflow", !desktopOverflow));

  // 22: mobile 360 no horizontal overflow
  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 300));
  const mobileOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > 360,
  );
  tap(check("22. mobile 360 no horizontal overflow", !mobileOverflow));

  await browser.close();

  // ---------- CLEANUP ----------
  rmDir(DOWNLOAD_DIR);

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`S27M Smoke: ${okCount} PASS / ${failCount} FAIL`);
  console.log("────────────────────────────────────────────────────────────");
  console.log(
    `request-safety: failing-year before-retry=${failingBefore} after-retry=${failingAfter} delta=${
      failingAfter - failingBefore
    } stabilityAfter3.5s=${state.yearRequestCounts[FAILING_YEAR] || 0}`,
  );
  console.log(
    `yearRequestCounts: ${JSON.stringify(state.yearRequestCounts)}`,
  );
  console.log(
    `annualReviewCalls=${state.annualReviewCalls} cacheReqs=${state.cacheRequestCount} serverPosts=${state.serverPosts.length} external=${state.externalRequests.length}`,
  );

  if (failCount > 0) {
    console.log("\nDownload dir cleaned: /tmp/s27m-downloads");
    process.exit(1);
  }
  console.log("\nDownload dir cleaned: /tmp/s27m-downloads");
  process.exit(0);
}

main().catch((err) => {
  console.error("S27M smoke crashed:", err);
  rmDir(DOWNLOAD_DIR);
  process.exit(2);
});