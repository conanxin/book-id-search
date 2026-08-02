#!/usr/bin/env node
/**
 * S27H-2 Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page. Intercepts private
 * API endpoints with synthetic fixtures, walks the 21 smoke checks
 * defined in the S27H-2 spec. The real AI / private data is NEVER
 * fetched from production — every private request is intercepted.
 */

const path = require("path");
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
  links: [
    { sourceCatalogId: "10000000_000000000001", targetCatalogId: "10000000_000000000002", sharedMonths: 8, weight: 18 },
    { sourceCatalogId: "10000000_000000000001", targetCatalogId: "10000000_000000000003", sharedMonths: 5, weight: 12 },
    { sourceCatalogId: "10000000_000000000002", targetCatalogId: "10000000_000000000003", sharedMonths: 4, weight: 9 },
    { sourceCatalogId: "10000000_000000000003", targetCatalogId: "10000000_000000000004", sharedMonths: 2, weight: 4 },
  ],
  meta: {
    monthsRequested: 24,
    monthsReturned: 24,
    topBooksRequested: 12,
    topBooksReturned: 12,
    persisted: false,
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

// Synthetic notes — only the `matched: true` items surface as catalogIds.
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
      matched: false,
      catalogId: null,
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
    matchedCount: 2,
    unmatchedCount: 1,
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
  console.log("[s27h2-smoke] launching headless Chromium against", URL);
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
        // Respect matchedOnly so the filter test can actually shrink the list.
        const matchedOnly = /matchedOnly=true/.test(url);
        const body = matchedOnly
          ? {
              ...NOTES_RESPONSE,
              items: NOTES_RESPONSE.items.filter((it) => it.matched),
              summary: { totalAfterFilter: 2, highlights: 2, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 2, unmatchedCount: 0 },
            }
          : NOTES_RESPONSE;
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
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

  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"); } catch {}
  });

  await page.goto(URL, { waitUntil: "load", timeout: 30000 });

  await page.waitForSelector('[data-testid="weread-tab-notes"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="weread-tab-map"]', { timeout: 15000 });
  check("1. default notes workspace rendered", true);

  // Load synthetic notes.
  await page.click('button[title="加载最近一批笔记"], button[title="按当前筛选重新加载"]', { timeout: 1000 }).catch(() => {});
  // The NotesLibrary default renders a "加载笔记" button; click whichever is present.
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const target = buttons.find((b) => /加载笔记|加载/.test(b.textContent || ""));
    if (target) target.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const notesLoaded = await page.evaluate(() => {
    const cards = document.querySelectorAll(".weread-note-card");
    return cards.length;
  });
  check("2. synthetic notes loaded", notesLoaded >= 2);

  // Generate synthetic AI summary.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="weread-ai-summary-button"]');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const summaryReady = await page.evaluate(() => !!document.querySelector('[data-testid="weread-ai-summary-body"]'));
  check("3. synthetic AI summary generated", summaryReady);
  check("3b. AI summary endpoint called exactly once", aiSummaryCalls === 1);

  // Switch to map tab.
  await page.click('[data-testid="weread-tab-map"]');
  await new Promise((r) => setTimeout(r, 1000));
  const mapShown = await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-map"]'));
  check("4. switching to map tab renders reading map", mapShown);

  // Theme chips rendered.
  const chipCount = await page.evaluate(() => document.querySelectorAll('[data-testid="weread-session-theme-chip"]').length);
  check("5. theme chips rendered (themes + directions)", chipCount >= 2);

  // Notice that says "doesn't call MiniMax again".
  const noRecomputeText = await page.evaluate(() => {
    const el = document.querySelector(".weread-session-theme__notice");
    return el ? el.textContent || "" : "";
  });
  check(
    "6. overlay notice mentions no re-call to MiniMax",
    /不会再次调用|MiniMax/.test(noRecomputeText)
  );

  // Default mode: complete map, no dimming.
  const initialDimmed = await page.evaluate(() =>
    document.querySelectorAll(".weread-reading-map__node--dimmed, .weread-reading-map__link--dimmed").length
  );
  check("7. default map mode has no dimmed nodes/links", initialDimmed === 0);

  // Click focus toggle.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="weread-session-theme-focus-toggle"]');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const dimmedAfter = await page.evaluate(() =>
    document.querySelectorAll(".weread-reading-map__node--dimmed").length
  );
  check("8. session focus dims non-session nodes", dimmedAfter > 0);
  const sessionCount = await page.evaluate(() =>
    document.querySelectorAll(".weread-reading-map__node--session").length
  );
  check("9. at least one node marked as session", sessionCount > 0);
  const sessionLinks = await page.evaluate(() =>
    document.querySelectorAll(".weread-reading-map__link--session").length
  );
  check("10. session-related links marked", sessionLinks > 0);

  // Node hrefs still valid.
  const nodeHrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".weread-reading-map__network-svg a")).map((a) =>
      a.getAttribute("href")
    );
  });
  const allHrefsOk = nodeHrefs.length > 0 && nodeHrefs.every((h) => /^\/books\/\d+_\d{12}$/.test(h || ""));
  check("11. node hrefs still resolve to /books/:catalogId", allHrefsOk);

  // Switch back to notes — summary still there.
  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 400));
  const summaryStillThere = await page.evaluate(() => !!document.querySelector('[data-testid="weread-ai-summary-body"]'));
  check("12. AI summary persists across tab switches", summaryStillThere);

  // Back to map — overlay still present.
  await page.click('[data-testid="weread-tab-map"]');
  await new Promise((r) => setTimeout(r, 500));
  const overlayStillThere = await page.evaluate(() => !!document.querySelector('[data-testid="weread-session-theme"]'));
  check("13. session overlay persists across tab switches", overlayStillThere);

  // Change filter to clear summary → overlay goes away.
  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 300));
  await page.select('select[aria-label="匹配筛选"]', "matched");
  await new Promise((r) => setTimeout(r, 300));
  // Trigger a reload so the items list actually shrinks (matched-only).
  await page.evaluate(() => {
    const btn = document.querySelector('button[title="加载最近一批笔记"], button[title="按当前筛选重新加载"]');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1200));
  const summaryAfterFilter = await page.evaluate(() => !!document.querySelector('[data-testid="weread-ai-summary-body"]'));
  check("14. filter change + reload clears the AI summary body", !summaryAfterFilter);
  await page.click('[data-testid="weread-tab-map"]');
  await new Promise((r) => setTimeout(r, 400));
  const overlayAfterFilter = await page.evaluate(() => {
    const empty = document.querySelector('[data-testid="weread-session-theme-empty"]');
    const chips = document.querySelector('[data-testid="weread-session-theme-chips"]');
    return !!empty || !chips;
  });
  check("15. overlay cleared when AI summary was cleared", overlayAfterFilter);

  // Token clear: map disappears entirely.
  await page.evaluate(() => sessionStorage.removeItem("book-id-search:weread-private-token"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 700));
  const mapAfterClear = await page.evaluate(() => {
    const tabs = document.querySelector('[data-testid="weread-tab-map"]');
    const dash = document.querySelector('[data-testid="weread-reading-map"]');
    return { hasTabs: !!tabs, hasDashboard: !!dash };
  });
  check("16. after token clear, dashboard disappears", mapAfterClear.hasDashboard === false);

  // Re-arm token + intercept — ensure no extra AI / related calls fired.
  await page.evaluate(() => sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 600));
  await page.click('[data-testid="weread-tab-map"]');
  await new Promise((r) => setTimeout(r, 500));
  check("17. no related-books request after rebuild", relatedBooksCalls === 0);
  check("18. only one AI summary call across lifecycle", aiSummaryCalls <= 1);

  const footer = await page.evaluate(() => {
    const text = document.body.textContent || "";
    return /icp|备案|Beian/i.test(text);
  });
  check("19. ICP footer still present", footer);

  const horizScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("20. desktop 1440 has no horizontal overflow", horizScroll <= 1);

  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 300));
  const mobileHoriz = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("21. mobile 360 has no horizontal overflow", mobileHoriz <= 2);

  // Privacy check: no forbidden substrings in DOM, excluding
  // the disclosure containers (which deliberately explain what we don't store).
  const domCheck = await page.evaluate(() => {
    const disclosureSel = ".weread-privacy-card, .weread-reading-map__notice, .weread-reading-map__privacy-footnote, .weread-session-theme__notice, .weread-session-theme";
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
    FAILURES.push(`21b. DOM privacy check failed: ${JSON.stringify(domCheck)}`);
    console.log("  ✗ 21b. DOM privacy check failed:", domCheck);
  } else {
    console.log("  ✓ 21b. DOM has no note text / comment / forbidden IDs");
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