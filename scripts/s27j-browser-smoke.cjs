#!/usr/bin/env node
/**
 * S27J Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page. Intercepts private
 * API endpoints with synthetic fixtures, walks the 30+ smoke checks
 * defined in the S27J spec. The real AI / private data is NEVER fetched
 * from production — every private request is intercepted.
 */

const path = require("path");
const puppeteer = require(path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"));

const URL = "https://books.conanxin.com/weread";

const ANNUAL_REVIEW_RESPONSE = {
  ok: true,
  selectedYear: 2025,
  availableYears: [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2010],
  overview: {
    year: 2025,
    totalRecords: 2454,
    datedRecords: 2454,
    matchedRecords: 101,
    matchedBooks: 6,
    activeMonths: 7,
    longestStreakMonths: 7,
    firstNoteAt: "2025-01-01T13:57:12.000Z",
    lastNoteAt: "2025-12-12T15:29:03.000Z",
    peakMonth: "2025-02",
    peakMonthRecords: 600,
    averageRecordsPerActiveMonth: 350.57,
  },
  months: [
    { month: "2025-01", total: 17, highlights: 16, thoughts: 1, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-02", total: 60, highlights: 60, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-03", total: 2, highlights: 2, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-04", total: 14, highlights: 14, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-05", total: 35, highlights: 35, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-06", total: 11, highlights: 11, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-07", total: 1, highlights: 1, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-08", total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-09", total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-10", total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-11", total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
    { month: "2025-12", total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 0 },
  ],
  quarters: [
    { quarter: "Q1", total: 79, activeMonths: 3, matchedRecords: 0, bookCount: 0 },
    { quarter: "Q2", total: 60, activeMonths: 3, matchedRecords: 0, bookCount: 0 },
    { quarter: "Q3", total: 1, activeMonths: 1, matchedRecords: 0, bookCount: 0 },
    { quarter: "Q4", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
  ],
  topBooks: [
    {
      catalogId: "13249219_000008297380",
      title: "每晚一个离奇谜案故事",
      author: "（美）钱德勒等著；韩佳媛编译",
      publisher: "北京：新世界出版社",
      publishYear: 2012,
      noteCount: 16,
      highlights: 16,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      activeMonths: 1,
      firstNoteAt: "2025-05-20T11:22:10.000Z",
      lastNoteAt: "2025-05-20T11:22:14.000Z",
    },
    {
      catalogId: "14490447_000017477980",
      title: "一桩事先张扬的凶杀案",
      author: "加西亚·马尔克斯著",
      publisher: "海口：南海出版公司",
      publishYear: 2018,
      noteCount: 1,
      highlights: 1,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      activeMonths: 1,
      firstNoteAt: "2025-05-14T04:07:15.000Z",
      lastNoteAt: "2025-05-14T04:07:15.000Z",
    },
    {
      catalogId: "14554815_000017817324",
      title: "写作的禅机",
      author: "（美）雷·布雷德伯里著；巨超译",
      publisher: "南昌：江西人民出版社",
      publishYear: 2019,
      noteCount: 1,
      highlights: 1,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      activeMonths: 1,
      firstNoteAt: "2025-01-21T23:59:56.000Z",
      lastNoteAt: "2025-01-21T23:59:56.000Z",
    },
    {
      catalogId: "14037946_000016100030",
      title: "北京  四九城里的风流岁月",
      author: "孙晔著",
      publisher: "哈尔滨：北方文艺出版社",
      publishYear: 2016,
      noteCount: 1,
      highlights: 0,
      thoughts: 1,
      reviews: 0,
      unknown: 0,
      activeMonths: 1,
      firstNoteAt: "2025-01-11T01:24:41.000Z",
      lastNoteAt: "2025-01-11T01:24:41.000Z",
    },
  ],
  meta: {
    topBooksRequested: 12,
    topBooksReturned: 4,
    persisted: false,
    source: "private_snapshot+public_catalog",
  },
};

const EMPTY_ANNUAL_REVIEW_RESPONSE = {
  ok: true,
  selectedYear: 2010,
  availableYears: [2025, 2024, 2023],
  overview: {
    year: 2010,
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
  months: Array.from({ length: 12 }, (_, i) => ({
    month: `2010-${String(i + 1).padStart(2, "0")}`,
    total: 0,
    highlights: 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: 0,
    bookCount: 0,
  })),
  quarters: ["Q1", "Q2", "Q3", "Q4"].map((q) => ({
    quarter: q,
    total: 0,
    activeMonths: 0,
    matchedRecords: 0,
    bookCount: 0,
  })),
  topBooks: [],
  meta: {
    topBooksRequested: 12,
    topBooksReturned: 0,
    persisted: false,
    source: "private_snapshot+public_catalog",
  },
};

const READING_MAP_RESPONSE = {
  ok: true,
  overview: {
    booksCount: 1586,
    notesCount: 6989,
    matchedCatalogsCount: 323,
    matchedNoteRecordsCount: 281,
    firstNoteAt: "2018-11-09T06:47:19.000Z",
    lastNoteAt: "2026-07-01T15:29:03.000Z",
    activeMonths: 69,
    currentStreakMonths: 14,
    longestStreakMonths: 21,
  },
  timeline: Array.from({ length: 24 }, (_, i) => ({
    month: `2025-${String((i % 12) + 1).padStart(2, "0")}`,
    total: Math.max(0, 30 - i * 1.2) | 0,
    highlights: Math.max(0, 20 - i * 0.8) | 0,
    thoughts: Math.max(0, 6 - i * 0.2) | 0,
    reviews: i % 6 === 0 ? 1 : 0,
    unknown: 0,
    matched: Math.max(0, 20 - i * 0.7) | 0,
  })),
  books: Array.from({ length: 12 }, (_, i) => ({
    catalogId: `10000000_0000000000${String(i + 1).padStart(2, "0")}`,
    title: `公共书目 ${i + 1}`,
    author: `作者 ${i + 1}`,
    publisher: null,
    publishYear: 2024,
    noteCount: 60 - i * 4,
    highlights: 30 - i * 2,
    thoughts: 10 - i,
    reviews: i % 5 === 0 ? 2 : 0,
    unknown: 0,
    activeMonths: Math.max(2, 12 - i),
    firstNoteAt: "2025-01-01T00:00:00.000Z",
    lastNoteAt: "2026-07-01T00:00:00.000Z",
  })),
  links: [],
  meta: {
    monthsRequested: 24,
    monthsReturned: 24,
    topBooksRequested: 12,
    topBooksReturned: 12,
    linksReturned: 0,
    persisted: false,
    source: "private_snapshot+public_catalog",
  },
};

const SUMMARY_RESPONSE = {
  ok: true,
  dataAvailable: true,
  booksCount: 1586,
  notesCount: 6989,
  confirmedMatchesCount: 323,
  confirmedWithNotesCount: 200,
  confirmedWithHighlightsCount: 180,
  totalConfirmedNoteRecords: 281,
};

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
  console.log("[s27j-smoke] launching headless Chromium against", URL);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  let annualReviewCalls = 0;
  let readingMapCalls = 0;
  let summaryCalls = 0;
  let trendsCalls = 0;
  let notesCalls = 0;
  let aiSummaryCalls = 0;
  let relatedBooksCalls = 0;
  let lastAnnualQuery = null;

  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    try {
      const url = req.url();
      if (!url.includes("/api/private/weread/")) {
        return req.continue();
      }
      const auth = req.headers()["authorization"];
      if (url.includes("/annual-review")) {
        annualReviewCalls += 1;
        lastAnnualQuery = url;
        if (!auth) {
          return req.respond({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Missing token." }) });
        }
        // Decide which fixture to serve based on the query string.
        const match = url.match(/[?&]year=(\d+)/);
        const requested = match ? Number(match[1]) : null;
        if (requested === 2010) {
          return req.respond({
            status: 200,
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify(EMPTY_ANNUAL_REVIEW_RESPONSE),
          });
        }
        return req.respond({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(ANNUAL_REVIEW_RESPONSE),
        });
      }
      if (url.includes("/reading-map")) {
        readingMapCalls += 1;
        if (!auth) {
          return req.respond({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Missing token." }) });
        }
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(READING_MAP_RESPONSE),
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
      if (url.includes("/summary")) {
        summaryCalls += 1;
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(SUMMARY_RESPONSE) });
      }
      if (url.includes("/trends")) {
        trendsCalls += 1;
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            trends: {
              generatedAt: "2026-08-01T00:00:00.000Z",
              windows: {
                days7: { total: 12, activeDays: 5, activeBooks: 3, highlights: 8, thoughts: 3, reviews: 1, unknown: 0 },
                days30: { total: 48, activeDays: 18, activeBooks: 9, highlights: 32, thoughts: 12, reviews: 4, unknown: 0 },
                days90: { total: 120, activeDays: 45, activeBooks: 18, highlights: 80, thoughts: 30, reviews: 10, unknown: 0 },
                allTime: { total: 6989, activeDays: 240, activeBooks: 240, highlights: 3500, thoughts: 800, reviews: 90, unknown: 4 },
              },
              confirmedOnly: { total: 281, activeBooks: 50, highlights: 200, thoughts: 60, reviews: 21, unknown: 0 },
              coverage: { notesWithDate: 6900, notesWithoutDate: 89, dateCoverageRatio: 0.987 },
            },
          }),
        });
      }
      if (url.includes("/notes")) {
        notesCalls += 1;
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            items: [
              {
                type: "highlight",
                text: "FORBIDDEN_NOTE_TEXT",
                comment: null,
                createdAt: "2025-06-01T00:00:00.000Z",
                updatedAt: null,
                matched: true,
                catalogId: "10000000_000000000001",
                source: "private_weread",
              },
            ],
            pageInfo: { limit: 20, offset: 0, total: 1, hasMore: false },
            summary: { totalAfterFilter: 1, highlights: 1, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 1, unmatchedCount: 0 },
          }),
        });
      }
      if (url.includes("/related-books")) {
        relatedBooksCalls += 1;
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, items: [], meta: { persisted: false } }),
        });
      }
      return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    } catch (e) {
      try { req.continue(); } catch {}
    }
  });

  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"); } catch {}
  });

  await page.goto(URL, { waitUntil: "load", timeout: 30000 });

  await page.waitForSelector('[data-testid="weread-tab-notes"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="weread-tab-map"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="weread-tab-review"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="weread-tab-annual"]', { timeout: 15000 });

  // 1: four workspace tabs render
  check("1. four workspace tabs render", true);
  // 2: default workspace is still notes
  const notesActive = await page.evaluate(() => {
    return document.querySelector('[data-testid="weread-tab-notes"]').getAttribute("aria-selected") === "true";
  });
  check("2. default workspace is still 笔记与 AI", notesActive);
  // 3: annual review endpoint NOT called before activation
  check("3. annual review not requested before activation", annualReviewCalls === 0);

  // 4: switch to annual tab — first call fires
  await page.click('[data-testid="weread-tab-annual"]');
  await new Promise((r) => setTimeout(r, 1200));
  check("4. annual review fires exactly once on first activation", annualReviewCalls === 1);

  // Wait for dashboard render
  await page.waitForSelector('[data-testid="weread-annual-review-overview"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="weread-annual-review-timeline-svg"]', { timeout: 5000 });

  // 5: switch back and forth, no extra fetch
  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 400));
  await page.click('[data-testid="weread-tab-annual"]');
  await new Promise((r) => setTimeout(r, 400));
  check("5. switching back to annual keeps the cached response (no extra fetch)", annualReviewCalls === 1);

  // 6: year selector populated from availableYears
  const yearOptions = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="weread-annual-review-year"]');
    return sel ? Array.from(sel.querySelectorAll("option")).map((o) => Number(o.value)) : [];
  });
  check("6. year selector renders availableYears", yearOptions.length >= 3);

  // 7: changing the year triggers a new fetch
  await page.select('[data-testid="weread-annual-review-year"]', "2024");
  await new Promise((r) => setTimeout(r, 1000));
  check("7. year change triggers a fresh request", annualReviewCalls === 2);

  // 8: changing topBooks triggers a new fetch
  await page.click('[data-testid="weread-annual-review-top-books-18"]');
  await new Promise((r) => setTimeout(r, 1000));
  check("8. topBooks change triggers a fresh request", annualReviewCalls === 3);

  // 9: six overview cards
  const overviewCards = await page.evaluate(() => document.querySelectorAll(".weread-annual-review__overview-card").length);
  check("9. six overview cards rendered", overviewCards === 6);

  // 10: 12-month timeline SVG
  const svgGroups = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="weread-annual-review-timeline-svg"]');
    return svg ? svg.querySelectorAll("g[data-month]").length : 0;
  });
  check("10. 12-month timeline SVG with 12 bar groups", svgGroups === 12);

  // 11: type distribution list
  const typeRows = await page.evaluate(() => document.querySelectorAll(".weread-annual-review__type-row").length);
  check("11. type distribution rendered (4 rows)", typeRows === 4);

  // 12: Q1..Q4 quarter cards
  const quarters = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".weread-annual-review__quarter")).map((el) => el.getAttribute("data-quarter"))
  );
  check("12. four quarter cards rendered (Q1..Q4)", quarters.join(",") === "Q1,Q2,Q3,Q4");

  // 13: activity classes appear in DOM
  const activityClasses = await page.evaluate(() => {
    const set = new Set();
    document.querySelectorAll("[class*='weread-annual-review__quarter-month--']").forEach((el) => {
      el.classList.forEach((c) => {
        if (c.startsWith("weread-annual-review__quarter-month--")) set.add(c);
      });
    });
    return Array.from(set);
  });
  check(
    "13. descriptive activity classes present",
    activityClasses.length > 0 &&
      activityClasses.some((c) => /--high$|--steady$|--light$|--none$/.test(c))
  );

  // 14: descriptive disclaimer is shown
  const disclaimer = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="weread-annual-review-disclaimer"]');
    return el ? el.textContent || "" : "";
  });
  check("14. descriptive disclaimer mentions record counts only", /基于记录数量|不代表阅读质量/.test(disclaimer));

  // 15: top books cards
  const topBookCards = await page.evaluate(() => document.querySelectorAll(".weread-annual-review__book-card").length);
  check("15. top books cards rendered", topBookCards >= 1);

  // 16: book URL pattern
  const bookLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-testid="weread-annual-review-book-link"]')).map((a) => a.getAttribute("href"));
  });
  const allHrefsOk = bookLinks.length > 0 && bookLinks.every((h) => /^\/books\/\d+_\d{12}$/.test(h || ""));
  check("16. top book URLs all match /books/<catalogId>", allHrefsOk);

  // 17: record cards
  const recordCards = await page.evaluate(() => document.querySelectorAll(".weread-annual-review__record-card").length);
  check("17. six descriptive record cards", recordCards === 6);

  // 18: empty-year state when 2010 is selected
  await page.select('[data-testid="weread-annual-review-year"]', "2010");
  await new Promise((r) => setTimeout(r, 1000));
  const emptyText = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="weread-annual-review-empty"]');
    return el ? el.textContent || "" : "";
  });
  check("18. empty-year state shown", /该年度暂无有效日期/.test(emptyText));

  // 19: forbidden psychology words do not appear in DOM
  const forbiddenWords = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    // Strip all disclaimer paragraphs that explicitly DISCLAIM these
    // terms — they are allowed to *mention* the words to make clear
    // that the dashboard does not assert them.
    clone.querySelectorAll(
      '[data-testid="weread-annual-review-notice"], [data-testid="weread-annual-review-disclaimer"], [data-testid="weread-annual-review-record-disclaimer"], .weread-privacy-card, .weread-annual-review__record-disclaimer'
    ).forEach((el) => el.remove());
    const text = clone.textContent || "";
    const flags = [];
    for (const word of ["懒惰", "焦虑", "专注力", "人格特征", "情绪", "心理", "阅读能力"]) {
      if (text.includes(word)) flags.push(word);
    }
    return flags;
  });
  check("19. no psychological-inference vocabulary in DOM (disclaimers excluded)", forbiddenWords.length === 0);

  // 20: token clear empties the dashboard
  await page.select('[data-testid="weread-annual-review-year"]', "2025");
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => sessionStorage.removeItem("book-id-search:weread-private-token"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 700));
  const annualGone = await page.evaluate(() => !document.querySelector('[data-testid="weread-annual-review"]'));
  check("20. token clear drops the annual review dashboard", annualGone);

  // 21: switch back to notes preserves the existing summary state
  await page.evaluate(() => sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 700));
  await page.click('[data-testid="weread-tab-annual"]');
  await new Promise((r) => setTimeout(r, 800));
  check("21. no related-books request after rebuild", relatedBooksCalls === 0);
  check("22. no AI summary call from annual review dashboard", aiSummaryCalls === 0);

  // 23: ICP footer
  const footer = await page.evaluate(() => {
    const text = document.body.textContent || "";
    return /icp|备案|Beian/i.test(text);
  });
  check("23. ICP footer still present", footer);

  // 24: desktop 1440 — no horizontal overflow
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise((r) => setTimeout(r, 300));
  const horizDesktop = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("24. desktop 1440 has no horizontal overflow", horizDesktop <= 1);

  // 25: mobile 360 — no horizontal overflow
  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 300));
  const horizMobile = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("25. mobile 360 has no horizontal overflow", horizMobile <= 2);

  // 26: DOM privacy check (no forbidden fields)
  const domCheck = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    // Strip disclosure containers which are allowed to mention forbidden
    // fields as a defense statement.
    clone.querySelectorAll('[data-testid="weread-annual-review-notice"], .weread-privacy-card, [data-testid="weread-annual-review-disclaimer"]').forEach((el) => el.remove());
    const text = clone.textContent || "";
    return {
      hasForbiddenText: /FORBIDDEN_NOTE_TEXT|FORBIDDEN_NOTE_COMMENT|FORBIDDEN_OVERVIEW|FORBIDDEN_KEYPOINT|FORBIDDEN_QUESTION/.test(text),
      hasWereadBookId: /\bwereadBookId\b/.test(text),
      hasNoteId: /\bnoteId\b/.test(text),
      hasHighlightId: /\bhighlightId\b/.test(text),
      hasChapterTitle: /\bchapterTitle\b/.test(text),
    };
  });
  const privacyOk = !domCheck.hasForbiddenText && !domCheck.hasWereadBookId && !domCheck.hasNoteId && !domCheck.hasHighlightId && !domCheck.hasChapterTitle;
  if (!privacyOk) {
    FAILURES.push(`26. DOM privacy check failed: ${JSON.stringify(domCheck)}`);
    console.log("  ✗ 26. DOM privacy check failed:", domCheck);
  } else {
    console.log("  ✓ 26. DOM has no note text / private IDs");
  }

  // Capture reading-map call count BEFORE clicking review/map tabs.
  const readMapCallsAfterAnnual = readingMapCalls;

  // 27: S27I ICS export button still present in review workspace
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('[data-testid="weread-tab-review"]');
  await new Promise((r) => setTimeout(r, 1000));
  const icsButton = await page.evaluate(() => !!document.querySelector('[data-testid="weread-review-calendar-export-button"]'));
  check("27. S27I ICS export entry still present", icsButton);

  // 28: S27H reading map still mounted in the map workspace
  await page.click('[data-testid="weread-tab-map"]');
  await new Promise((r) => setTimeout(r, 800));
  const mapMounted = await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-map"]'));
  check("28. S27H reading map still mounted", mapMounted);

  // 29: AnnualReviewDashboard does NOT call /reading-map during the
  // annual review lifecycle (we already activated the annual tab in
  // steps 4-26 and reading-map was never called by it).
  check(
    "29. annual review never invokes reading-map endpoint",
    readMapCallsAfterAnnual === 0
  );

  // 30: documented topBooks limits 6/12/18 (must run while the annual
  // review dashboard is mounted).
  await page.click('[data-testid="weread-tab-annual"]');
  await new Promise((r) => setTimeout(r, 800));
  const topBooksOptions = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-testid^="weread-annual-review-top-books-"]'))
      .map((el) => Number(el.getAttribute("value")))
      .sort((a, b) => a - b);
  });
  check(
    "30. topBooks radio set is 6 / 12 / 18",
    JSON.stringify(topBooksOptions) === JSON.stringify([6, 12, 18])
  );

  await browser.close();

  console.log("\n---");
  if (FAILURES.length === 0) {
    console.log(
      `STATUS: PASS (annual-review=${annualReviewCalls} reading-map=${readingMapCalls} summary=${summaryCalls} trends=${trendsCalls})`
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