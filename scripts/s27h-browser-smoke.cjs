#!/usr/bin/env node
/**
 * S27H Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page, intercepts private
 * API endpoints with synthetic fixtures, walks the 19 smoke checks
 * from the S27H spec. The real reading-map is NEVER fetched from
 * production — every private request is intercepted.
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
  ],
  meta: {
    monthsRequested: 24,
    monthsReturned: 24,
    topBooksRequested: 12,
    topBooksReturned: 12,
    linksReturned: 3,
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

const TRENDS_RESPONSE = {
  ok: true,
  trends: {
    generatedAt: new Date().toISOString(),
    windows: {
      days7: { total: 0, activeDays: 0, activeBooks: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0 },
      days30: { total: 0, activeDays: 0, activeBooks: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0 },
      days90: { total: 0, activeDays: 0, activeBooks: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0 },
      allTime: { total: 0, activeDays: 0, activeBooks: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0 },
    },
    confirmedOnly: { total: 0, activeBooks: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0 },
    coverage: { notesWithDate: 0, notesWithoutDate: 0, dateCoverageRatio: 1 },
  },
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
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();

  let readingMapCalls = 0;
  let summaryCalls = 0;
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
      if (url.includes("/summary")) {
        summaryCalls += 1;
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(SUMMARY_RESPONSE) });
      }
      if (url.includes("/trends")) {
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(TRENDS_RESPONSE) });
      }
      if (url.includes("/notes")) {
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, items: [], pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false }, summary: { totalAfterFilter: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 0, unmatchedCount: 0 } }),
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

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  await page.waitForSelector('[data-testid="weread-tab-notes"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="weread-tab-map"]', { timeout: 15000 });
  check("1. tab switcher rendered", true);

  await new Promise((r) => setTimeout(r, 500));
  const initialState = await page.evaluate(() => ({
    notesHidden: document.querySelector('[data-testid="weread-panel-notes"]')?.hasAttribute("hidden"),
    mapHidden: document.querySelector('[data-testid="weread-panel-map"]')?.hasAttribute("hidden"),
  }));
  check("2. default = notes panel visible, map panel hidden", initialState.notesHidden === false && initialState.mapHidden === true);

  const initialReadingMapCalls = readingMapCalls;
  check("3. no reading-map request before switching to map tab", initialReadingMapCalls === 0);

  await page.click('[data-testid="weread-tab-map"]');
  await new Promise((r) => setTimeout(r, 1000));
  check("4. reading-map requested exactly once after switching", readingMapCalls === 1);

  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 300));
  await page.click('[data-testid="weread-tab-map"]');
  await new Promise((r) => setTimeout(r, 400));
  check("5. switching tabs does not re-fetch (component cache)", readingMapCalls === 1);

  await page.select("#weread-reading-map-months", "12");
  await new Promise((r) => setTimeout(r, 700));
  check("6. changing months to 12 re-fetches", readingMapCalls === 2);

  await page.select("#weread-reading-map-months", "24");
  await new Promise((r) => setTimeout(r, 700));
  check("7. switching back to 24 re-fetches", readingMapCalls === 3);

  const renders = await page.evaluate(() => ({
    overview: !!document.querySelector(".weread-reading-map__overview"),
    timeline: !!document.querySelector(".weread-reading-map__timeline-svg"),
    network: !!document.querySelector(".weread-reading-map__network-svg"),
  }));
  check("8. overview panel rendered", renders.overview);
  check("9. timeline SVG rendered", renders.timeline);
  check("10. network SVG rendered", renders.network);

  const nodeHref = await page.evaluate(() => {
    const a = document.querySelector(".weread-reading-map__network-svg a");
    return a ? a.getAttribute("href") : null;
  });
  check("11. node click navigates to /books/:catalogId", !!nodeHref && /^\/books\/\d+_\d{12}$/.test(nodeHref));

  const bookCards = await page.$$(".weread-reading-map__book-card");
  check("12. high-interaction book grid populated (12 cards)", bookCards.length === 12);

  const linkItems = await page.$$(".weread-reading-map__links-list li");
  check("13. contemporaneous-reading links list populated (3 edges)", linkItems.length === 3);

  const disclosureCheck = await page.evaluate(() => {
  // Compute body text minus the two known disclosure containers. Anything
  // that mentions "wereadBookId" / "noteId" / "highlightId" / "chapterTitle"
  // outside of those disclosure containers would be a real leak.
  const disclosureSel = ".weread-privacy-card, .weread-reading-map__notice, .weread-reading-map__privacy-footnote";
  const disclosureText = Array.from(document.querySelectorAll(disclosureSel))
    .map((el) => el.textContent || "")
    .join("\n");
  // Clone the body, strip the disclosure elements, and read text.
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll(disclosureSel).forEach((el) => el.remove());
  const rest = (clone.textContent || "").trim();
  const patterns = [/wereadBookId/g, /noteId/g, /highlightId/g, /chapterTitle/g];
  const offenders = patterns
    .map((p) => ({ pat: p.toString(), count: (rest.match(p) || []).length }))
    .filter((entry) => entry.count > 0);
  return { offenders, rest, disclosureText };
});
check("14. DOM contains no note text / private IDs (outside disclosure)", disclosureCheck.offenders.length === 0);

  await page.click('[data-testid="weread-tab-notes"]');
  await new Promise((r) => setTimeout(r, 400));
  const notesLoaded = await page.$('[data-testid="weread-notes-card"]');
  check("15. notes workspace still mounted after tab switch", !!notesLoaded);

  await page.evaluate(() => sessionStorage.removeItem("book-id-search:weread-private-token"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 700));
  const mapAfterClear = await page.evaluate(() => {
    const tabs = document.querySelector('[data-testid="weread-tab-map"]');
    const dash = document.querySelector('[data-testid="weread-reading-map"]');
    return { hasTabs: !!tabs, hasDashboard: !!dash };
  });
  check("16. after token clear, dashboard disappears (no leak)", mapAfterClear.hasDashboard === false);

  const s27fEntry = await page.$('[data-testid="weread-notes-card"]');
  check("17. S27F/S27G workspace still accessible", !!s27fEntry);

  const footer = await page.evaluate(() => {
    const text = document.body.textContent || "";
    return /icp|备案|Beian/i.test(text);
  });
  check("18. ICP footer still present", footer);

  const horizScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("19. desktop 1440 has no horizontal overflow", horizScroll <= 1);

  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 300));
  const mobileHoriz = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("20. mobile 360 has no horizontal overflow", mobileHoriz <= 2);

  await browser.close();

  console.log("\n---");
  if (FAILURES.length === 0) {
    console.log(`STATUS: PASS (${summaryCalls} summary / ${readingMapCalls} reading-map intercepted)`);
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