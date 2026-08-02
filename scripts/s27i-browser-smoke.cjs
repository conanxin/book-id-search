#!/usr/bin/env node
/**
 * S27I Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page. Intercepts private
 * API endpoints with synthetic fixtures and walks the 27 smoke checks
 * defined in the S27I spec. The real AI / private data is NEVER
 * fetched from production — every private request is intercepted.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"));

const URL = "https://books.conanxin.com/weread";

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
  timeline: [],
  books: [
    {
      catalogId: "10000000_000000000001",
      title: "公共书目 一",
      author: "作者 一",
      publisher: null,
      publishYear: 2024,
      noteCount: 200,
      highlights: 120,
      thoughts: 60,
      reviews: 20,
      unknown: 0,
      activeMonths: 11,
      firstNoteAt: "2024-01-01T00:00:00.000Z",
      lastNoteAt: "2024-01-01T00:00:00.000Z",
    },
    {
      catalogId: "10000000_000000000002",
      title: "公共书目 二",
      author: "作者 二",
      publisher: null,
      publishYear: 2023,
      noteCount: 80,
      highlights: 50,
      thoughts: 25,
      reviews: 5,
      unknown: 0,
      activeMonths: 6,
      firstNoteAt: "2025-09-01T00:00:00.000Z",
      lastNoteAt: "2026-05-01T00:00:00.000Z",
    },
    {
      catalogId: "10000000_000000000003",
      title: "公共书目 三",
      author: "作者 三",
      publisher: null,
      publishYear: 2022,
      noteCount: 35,
      highlights: 25,
      thoughts: 8,
      reviews: 2,
      unknown: 0,
      activeMonths: 3,
      firstNoteAt: "2026-04-01T00:00:00.000Z",
      lastNoteAt: "2026-07-30T00:00:00.000Z",
    },
    {
      catalogId: "10000000_000000000004",
      title: "公共书目 四",
      author: "作者 四",
      publisher: null,
      publishYear: 2021,
      noteCount: 5,
      highlights: 4,
      thoughts: 1,
      reviews: 0,
      unknown: 0,
      activeMonths: 1,
      firstNoteAt: "2026-08-01T00:00:00.000Z",
      lastNoteAt: "2026-08-01T00:00:00.000Z",
    },
    {
      catalogId: "10000000_000000000005",
      title: "公共书目 五 无日期",
      author: "作者 五",
      publisher: null,
      publishYear: 2020,
      noteCount: 2,
      highlights: 1,
      thoughts: 1,
      reviews: 0,
      unknown: 0,
      activeMonths: 0,
      firstNoteAt: null,
      lastNoteAt: null,
    },
  ],
  links: [],
  meta: {
    monthsRequested: 36,
    monthsReturned: 36,
    topBooksRequested: 18,
    topBooksReturned: 5,
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

const AI_SUMMARY_RESPONSE = {
  ok: true,
  summary: {
    overview: "FORBIDDEN_OVERVIEW_BODY",
    themes: [
      { title: "城市记忆", summary: "FORBIDDEN_THEME_BODY_1", evidenceCount: 5 },
      { title: "现代叙事", summary: "FORBIDDEN_THEME_BODY_2", evidenceCount: 3 },
    ],
    keyPoints: ["FORBIDDEN_KEYPOINT"],
    reviewQuestions: ["FORBIDDEN_QUESTION"],
    readingDirections: ["近代史再阅读", "口述史延伸"],
  },
  meta: {
    itemsUsed: 8,
    totalCharacters: 1600,
    persisted: false,
    provider: "minimax",
  },
};

const TRENDS_RESPONSE = {
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
};

const NOTES_RESPONSE = {
  ok: true,
  items: [
    {
      type: "highlight",
      text: "FORBIDDEN_NOTE_TEXT_AAAA",
      comment: "FORBIDDEN_NOTE_COMMENT_BBBB",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: null,
      matched: true,
      catalogId: "10000000_000000000001",
      source: "private_weread",
    },
    {
      type: "thought",
      text: "FORBIDDEN_NOTE_TEXT_CCCC",
      comment: null,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: null,
      matched: true,
      catalogId: "10000000_000000000002",
      source: "private_weread",
    },
    {
      type: "review",
      text: "FORBIDDEN_NOTE_TEXT_DDDD",
      comment: null,
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: null,
      matched: true,
      catalogId: "10000000_000000000003",
      source: "private_weread",
    },
  ],
  pageInfo: { limit: 20, offset: 0, total: 3, hasMore: false },
  summary: {
    totalAfterFilter: 3,
    highlights: 1,
    thoughts: 1,
    reviews: 1,
    unknown: 0,
    matchedCount: 3,
    unmatchedCount: 0,
  },
  searchInfo: { enabled: false, queryLength: 0, termsCount: 0, matchedCount: 0 },
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
  console.log("[s27i-smoke] launching headless Chromium against", URL);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  let aiSummaryCalls = 0;
  let readingMapCalls = 0;
  let summaryCalls = 0;
  let trendsCalls = 0;
  let notesCalls = 0;
  let relatedBooksCalls = 0;

  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    try {
      const url = req.url();
      if (!url.includes("/api/private/weread/")) {
        return req.continue();
      }
      const auth = req.headers()["authorization"];
      if (url.includes("/reading-map")) {
        readingMapCalls += 1;
        if (!auth) {
          return req.respond({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Missing token." }) });
        }
        return req.respond({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(READING_MAP_RESPONSE),
        });
      }
      if (url.includes("/notes/summarize")) {
        aiSummaryCalls += 1;
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(AI_SUMMARY_RESPONSE) });
      }
      if (url.includes("/summary")) {
        summaryCalls += 1;
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(SUMMARY_RESPONSE) });
      }
      if (url.includes("/trends")) {
        trendsCalls += 1;
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(TRENDS_RESPONSE) });
      }
      if (url.includes("/notes")) {
        notesCalls += 1;
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(NOTES_RESPONSE) });
      }
      if (url.includes("/related-books")) {
        relatedBooksCalls += 1;
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, items: [], meta: { persisted: false } }) });
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
  await page.waitForSelector('[data-testid="weread-tab-notes"]', { timeout: 20000 });

  // 1. three workspace tabs render
  const tabCount = await page.evaluate(() =>
    ["weread-tab-notes", "weread-tab-map", "weread-tab-review"]
      .filter((id) => !!document.querySelector(`[data-testid="${id}"]`)).length
  );
  check("1. three workspace tabs render", tabCount === 3);

  // 2. default is notes workspace
  const defaultNotes = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="weread-tab-notes"]');
    return el && el.getAttribute("aria-selected") === "true";
  });
  check("2. default workspace is notes", defaultNotes === true);

  // 3. reading-map calls before review tab is opened = 0
  check("3. reading-map request count is 0 before review tab activation", readingMapCalls === 0);

  // Activate review tab.
  await page.click('[data-testid="weread-tab-review"]');
  await new Promise((r) => setTimeout(r, 1500));
  check("4. reading-map request count is 1 after review tab activation", readingMapCalls === 1);

  // 5. switch back to notes and return → still 1 (cached in component)
  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 400));
  await page.click('[data-testid="weread-tab-review"]');
  await new Promise((r) => setTimeout(r, 400));
  check("5. switching away and back does not re-fetch reading-map", readingMapCalls === 1);

  // 6. overview rendered
  const overviewRendered = await page.evaluate(() => !!document.querySelector('[data-testid="weread-review-calendar-overview"]'));
  check("6. review calendar overview rendered", overviewRendered);

  // 7. default horizon = 28
  const defaultHorizon = await page.evaluate(() => {
    const radio = document.querySelector('input[name="weread-review-horizon"][value="28"]');
    return radio && radio.checked;
  });
  check("7. default horizon is 28 days", defaultHorizon === true);

  // 8. switch to 14 days
  await page.click('input[name="weread-review-horizon"][value="14"]');
  await new Promise((r) => setTimeout(r, 300));
  const h14 = await page.evaluate(() => {
    const radio = document.querySelector('input[name="weread-review-horizon"][value="14"]');
    return radio && radio.checked;
  });
  check("8. horizon can switch to 14 days", h14 === true);

  // 9. switch to 42 days
  await page.click('input[name="weread-review-horizon"][value="42"]');
  await new Promise((r) => setTimeout(r, 300));
  const h42 = await page.evaluate(() => {
    const radio = document.querySelector('input[name="weread-review-horizon"][value="42"]');
    return radio && radio.checked;
  });
  check("9. horizon can switch to 42 days", h42 === true);

  // 10. recommend count options
  const recommendOptions = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[name="weread-review-recommend"]')).map((i) => i.value);
  });
  check("10. recommend count exposes 6 / 12 / 18", JSON.stringify(recommendOptions) === JSON.stringify(["6", "12", "18"]));

  // 11. book tasks render
  const bookTasks = await page.evaluate(() => document.querySelectorAll('.weread-review-task--book').length);
  check("11. book tasks render", bookTasks > 0);

  // 12. theme tasks render (need to first generate AI summary)
  // We start from notes tab to access the AI button.
  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /加载笔记|加载/.test(b.textContent || "")
    );
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="weread-ai-summary-button"]');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 800));

  await page.click('[data-testid="weread-tab-review"]');
  await new Promise((r) => setTimeout(r, 600));
  const themeTasks = await page.evaluate(() => document.querySelectorAll('.weread-review-task--theme').length);
  check("12. theme tasks render after AI summary", themeTasks > 0);

  // 13. high/medium/low classes present
  const priorities = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.weread-review-book-card'));
    return cards.map((c) => c.getAttribute("data-priority"));
  });
  const hasHigh = priorities.includes("high");
  const hasMedium = priorities.includes("medium");
  const hasLow = priorities.includes("low");
  check("13. priority classes high/medium/low all present", hasHigh && hasMedium && hasLow);

  // 14. book link href correct
  const linkHref = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="weread-review-book-link"]');
    return a && a.getAttribute("href");
  });
  check("14. book link href matches /books/:catalogId", /^\/books\/\d+_\d{12}$/.test(linkHref || ""));

  // 15. reason text rendered
  const reasonText = await page.evaluate(() => {
    const el = document.querySelector('.weread-review-book-card__reasons');
    return el ? el.textContent || "" : "";
  });
  check("15. reason codes render", /阅读|笔记|月份|会话/.test(reasonText));

  // 16. missing-date section rendered
  const missingDate = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="weread-review-calendar-unscheduled"]');
    return el && el.children.length >= 1;
  });
  check("16. missing-date section renders at least one book", missingDate === true);

  // 17. session book gets a boost / earlier date
  const sessionBookScore = await page.evaluate(() => {
    const session = document.querySelector('[data-testid="weread-review-book-session"]');
    if (!session) return null;
    const card = session.closest('.weread-review-book-card');
    if (!card) return null;
    return {
      dataPriority: card.getAttribute("data-priority"),
      href: card.querySelector('a') ? card.querySelector('a').getAttribute('href') : null,
    };
  });
  check("17. session-affected book is marked", sessionBookScore !== null);

  // 18. AI summary persists across tabs
  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 400));
  const summaryStillThere = await page.evaluate(() => !!document.querySelector('[data-testid="weread-ai-summary-body"]'));
  check("18. AI summary persists across tab switches", summaryStillThere);

  // 19. token clear wipes calendar
  // Use evaluateOnNewDocument so the removal survives the reload.
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.removeItem("book-id-search:weread-private-token"); } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 600));
  const tokenFormShown = await page.evaluate(() => !!document.querySelector('[data-testid="weread-token-form"]'));
  check("19. after token clear, calendar is gone (token form shown)", tokenFormShown);

  // 20. no AI summary call after rebuild
  const aiSummaryBeforeRebuild = aiSummaryCalls;
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"); } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 600));
  await page.click('[data-testid="weread-tab-review"]');
  await new Promise((r) => setTimeout(r, 600));
  check("20. no NEW AI summary endpoint call after rebuild", aiSummaryCalls === aiSummaryBeforeRebuild);

  // 21. no related-books endpoint called
  check("21. no related-books endpoint called", relatedBooksCalls === 0);

  // 22. ICP footer still present
  const footer = await page.evaluate(() => {
    const text = document.body.textContent || "";
    return /icp|备案|Beian/i.test(text);
  });
  check("22. ICP footer still present", footer);

  // 23. desktop 1440 has no horizontal overflow
  const horizScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("23. desktop 1440 has no horizontal overflow", horizScroll <= 1);

  // 24. mobile 360 has no horizontal overflow
  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 300));
  const mobileHoriz = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("24. mobile 360 has no horizontal overflow", mobileHoriz <= 2);

  // 25. DOM has no forbidden note text / token / private IDs (outside disclosure)
  const domCheck = await page.evaluate(() => {
    const disclosureSel =
      ".weread-privacy-card, .weread-reading-map__notice, .weread-reading-map__privacy-footnote, .weread-session-theme__notice, .weread-session-theme, .weread-review-calendar__notice, .weread-review-calendar__persistence";
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(disclosureSel).forEach((el) => el.remove());
    const text = clone.textContent || "";
    return {
      hasForbiddenText: /FORBIDDEN_NOTE_TEXT|FORBIDDEN_NOTE_COMMENT|FORBIDDEN_OVERVIEW|FORBIDDEN_KEYPOINT|FORBIDDEN_QUESTION|FORBIDDEN_THEME_BODY/.test(text),
      hasToken: /smoke-token-12345/.test(text),
      hasWereadBookId: /wereadBookId/.test(text),
      hasNoteId: /noteId/.test(text),
      hasHighlightId: /highlightId/.test(text),
    };
  });
  if (domCheck.hasForbiddenText || domCheck.hasToken || domCheck.hasWereadBookId || domCheck.hasNoteId || domCheck.hasHighlightId) {
    FAILURES.push(`25. DOM privacy check failed: ${JSON.stringify(domCheck)}`);
    console.log("  ✗ 25. DOM privacy check failed:", domCheck);
  } else {
    console.log("  ✓ 25. DOM has no note text / comment / token / forbidden IDs");
  }

  // 26. "不保存完成状态" disclaimer present
  const persistenceText = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="weread-review-calendar-persistence"]');
    return el ? el.textContent || "" : "";
  });
  check("26. no-persistence disclaimer rendered", /不保存完成状态/.test(persistenceText));

  // 27. privacy notice rendered
  const noticeText = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="weread-review-calendar-notice"]');
    return el ? el.textContent || "" : "";
  });
  check("27. privacy notice rendered", /复习日历仅使用/.test(noticeText));

  // Capture a single screenshot for local archival (NOT committed).
  try {
    const dir = path.resolve(__dirname, "..", "reports", "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    await page.setViewport({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(dir, "s27i-review-calendar.png"), fullPage: true });
    console.log(`  (screenshot: ${path.join(dir, "s27i-review-calendar.png")})`);
  } catch (e) {
    console.log("  (screenshot failed:", e.message, ")");
  }

  await browser.close();

  console.log("\n---");
  if (FAILURES.length === 0) {
    console.log(
      `STATUS: PASS (ai=${aiSummaryCalls} reading-map=${readingMapCalls} notes=${notesCalls} trends=${trendsCalls})`
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