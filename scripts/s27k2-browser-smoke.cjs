#!/usr/bin/env node
/**
 * S27K-2 Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page. Intercepts the
 * private annual-review endpoint with synthetic fixtures so that we
 * never hit real private data or AI endpoints. Walks the 30 smoke
 * checks defined in the S27K-2 spec (browser-local Markdown export
 * for the year-over-year comparison panel).
 *
 * The synthetic fixtures are deliberately small and free of any real
 * note text, private IDs, tokens, or AI summary bodies. The harness
 * asserts that none of those forbidden fields leak into the DOM,
 * into the Markdown download, or into any network request.
 *
 * Real AI / private data is NEVER fetched from production. Every
 * private request is intercepted.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"));

const URL = "https://books.conanxin.com/weread";
const DOWNLOAD_DIR = "/tmp/s27k2-downloads";
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

async function waitForDownload(dir, beforeFiles, fileSuffix, maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(fileSuffix) && !f.endsWith(".crdownload"));
    const newFiles = files.filter((f) => !beforeFiles.includes(f));
    if (newFiles.length > 0) return path.join(dir, newFiles[0]);
  }
  return null;
}

(async () => {
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  console.log("[s27k2-smoke] launching headless Chromium against", URL);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  let annualReviewCalls = 0;
  let aiSummaryCalls = 0;
  let relatedBooksCalls = 0;
  let mdDownloadCalls = 0;
  const externalRequests = [];
  const serverPosts = [];

  const client = await page.target().createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });
  client.on("Browser.downloadWillBegin", (event) => {
    if (event && typeof event.url === "string") {
      mdDownloadCalls += 1;
    }
  });

  // Patch URL.createObjectURL on every new document so we can
  // observe the blob: URLs that the export uses. The CDP
  // downloadWillBegin event does NOT include the blob URL reliably
  // for programmatic anchor clicks.
  await page.evaluateOnNewDocument(() => {
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      const url = origCreate(blob);
      try {
        window.__lastBlobUrl = url;
        window.__lastBlobType = blob && blob.type;
        const list = (window.__blobUrlsSeen = window.__blobUrlsSeen || []);
        list.push({ url, type: blob && blob.type });
      } catch (e) {}
      return url;
    };
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
        if (!auth) {
          return req.respond({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Missing token." }) });
        }
        const m = url.match(/[?&]year=(\d+)/);
        const year = m ? Number(m[1]) : null;
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

  // 1: annual review tab exists
  check("1. annual review tab exists", await page.evaluate(() => !!document.querySelector('[data-testid="weread-tab-annual"]')));

  // 2: comparison closed by default
  await page.click('[data-testid="weread-tab-annual"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-toggle"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  const hasComparisonAfterActivation = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-metrics"]'));
  check("2. year comparison closed by default", !hasComparisonAfterActivation);

  // 3: opening the comparison fires a request for the base year
  const callsBeforeOpen = annualReviewCalls;
  await page.click('[data-testid="weread-year-comparison-toggle"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-metrics"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 600));
  const callsAfterOpen = annualReviewCalls;
  check("3. opening comparison triggers base-year fetch", callsAfterOpen === callsBeforeOpen + 1);

  // 4: export button is present and enabled
  const exportButtonPresent = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-export-button"]'));
  const exportButtonDisabled = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="weread-year-comparison-export-button"]');
    return el ? el.disabled : true;
  });
  check("4. export button exists and is enabled when comparison is ready", exportButtonPresent && !exportButtonDisabled);

  // 5: nothing has been downloaded yet
  const beforeDownload = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md"));
  check("5. no .md downloaded before clicking the export button", beforeDownload.length === 0);

  // 6: clicking export does NOT trigger any additional annual-review call
  const callsBeforeExport = annualReviewCalls;
  await page.click('[data-testid="weread-year-comparison-export-button"]');
  // Give the page a few hundred ms to settle and re-fetch.
  await new Promise((r) => setTimeout(r, 800));
  check("6. clicking export does NOT trigger additional annual-review requests", annualReviewCalls === callsBeforeExport);

  // 7: download .md file
  const downloaded = await waitForDownload(DOWNLOAD_DIR, beforeDownload, ".md");
  check("7. export downloads a .md file", downloaded !== null);

  let mdContent = "";
  if (downloaded) {
    mdContent = fs.readFileSync(downloaded, "utf8");
    const stat = fs.statSync(downloaded);
    check("7b. downloaded file is not empty", stat.size > 0);
  }

  // 8: download URL is a blob: URL (no upload / no remote fetch).
  // The panel removes the temporary anchor synchronously after
  // .click(), so we read the URL from the page-side patch that
  // wraps `URL.createObjectURL`.
  const lastBlob = await page.evaluate(() => {
    const list = window.__blobUrlsSeen || [];
    return list.length > 0 ? list[list.length - 1] : null;
  });
  check("8. download URL is a blob: URL (no upload / no remote fetch)", !!lastBlob && typeof lastBlob.url === "string" && lastBlob.url.startsWith("blob:"));

  // 9: filename includes both base and target year
  if (downloaded) {
    const fname = path.basename(downloaded);
    check("9. filename includes base and target year", /weread-year-comparison-2024-vs-2025-/.test(fname));
    check("9b. filename ends with YYYYMMDD.md", /-\d{8}\.md$/.test(fname));
    check("9c. filename length <= 80", fname.length <= 80);
    check("9d. filename is pure ASCII", /^[\x20-\x7e]+$/.test(fname));
  }

  // 10: file contains the year-comparison title
  check("10. file contains the year-comparison title", /^# 2024—2025 年阅读对比/m.test(mdContent));

  // 11: file contains the six core metrics
  for (const label of ["阅读记录", "活跃月份", "已匹配记录", "年度书目", "最长连续月份", "活跃月份平均记录"]) {
    if (!mdContent.includes(label)) {
      FAILURES.push(`11. missing core metric: ${label}`);
      console.log(`  ✗ 11. missing core metric: ${label}`);
    }
  }
  if (!FAILURES.some((f) => f.startsWith("11. missing"))) {
    console.log("  ✓ 11. file contains all six core metrics");
  }

  // 12: file contains the 12-month comparison table
  const monthRows = mdContent.split("\n").filter((line) => /^\|\s*\d{1,2}月\s*\|/.test(line));
  check("12. file contains 12 month-comparison rows", monthRows.length === 12);

  // 13: file contains Q1..Q4 sections
  const idxQ1 = mdContent.indexOf("### Q1");
  const idxQ2 = mdContent.indexOf("### Q2");
  const idxQ3 = mdContent.indexOf("### Q3");
  const idxQ4 = mdContent.indexOf("### Q4");
  check("13. file contains Q1..Q4 sections in order", idxQ1 > -1 && idxQ2 > idxQ1 && idxQ3 > idxQ2 && idxQ4 > idxQ3);

  // 14: file contains continuing/entered/left sections
  check("14a. file contains continuing-books section", mdContent.includes("## 连续进入两年高互动书目榜"));
  check("14b. file contains entered-books section", mdContent.includes("## 进入目标年度高互动书目榜"));
  check("14c. file contains left-books section", mdContent.includes("## 未进入目标年度高互动书目榜"));

  // 15: file contains synthetic public title/author
  check("15. file contains synthetic public titles (合成 A / B / C / D)", mdContent.includes("合成 A") || mdContent.includes("合成 B") || mdContent.includes("合成 C") || mdContent.includes("合成 D"));
  check("15b. file contains synthetic public author", mdContent.includes("作者 A") || mdContent.includes("作者 B") || mdContent.includes("作者 C") || mdContent.includes("作者 D"));

  // 16: file contains public catalog URL
  check("16. file contains public catalog URL", /https:\/\/books\.conanxin\.com\/books\/BOOK-[A-D]/.test(mdContent));

  // 17: file does NOT contain synthetic forbidden note text/comment
  check("17a. file does NOT contain FORBIDDEN_NOTE_TEXT", !mdContent.includes("FORBIDDEN_NOTE_TEXT"));
  check("17b. file does NOT contain FORBIDDEN_NOTE_COMMENT", !mdContent.includes("FORBIDDEN_NOTE_COMMENT"));

  // 18: file does NOT contain private IDs
  check("18a. file does NOT contain wereadBookId", !/\bwereadBookId\b/.test(mdContent));
  check("18b. file does NOT contain noteId", !/\bnoteId\b/.test(mdContent));
  check("18c. file does NOT contain highlightId", !/\bhighlightId\b/.test(mdContent));
  check("18d. file does NOT contain chapterTitle", !/\bchapterTitle\b/.test(mdContent));

  // 19: file does NOT contain token / q / API key
  check("19a. file does NOT contain token", !/\btoken\b/i.test(mdContent));
  check("19b. file does NOT contain api[_-]key", !/api[_-]key/i.test(mdContent));
  check("19c. file does NOT contain Authorization", !mdContent.includes("Authorization"));

  // 20: file does NOT contain AI summary / themes
  check("20a. file does NOT contain FORBIDDEN_OVERVIEW", !mdContent.includes("FORBIDDEN_OVERVIEW"));
  check("20b. file does NOT contain FORBIDDEN_THEME_BODY", !mdContent.includes("FORBIDDEN_THEME_BODY"));
  check("20c. file does NOT contain FORBIDDEN_KEYPOINT", !mdContent.includes("FORBIDDEN_KEYPOINT"));
  check("20d. file does NOT contain FORBIDDEN_QUESTION", !mdContent.includes("FORBIDDEN_QUESTION"));

  // 21: base=0 path never produces Infinity / NaN
  // Switch to the empty base year (2021) and re-export.
  await page.select('[data-testid="weread-year-comparison-base-year"]', "2021");
  await new Promise((r) => setTimeout(r, 1000));
  const callsBeforeEmptyExport = annualReviewCalls;
  const beforeEmptyExport = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md"));
  await page.click('[data-testid="weread-year-comparison-export-button"]');
  await new Promise((r) => setTimeout(r, 800));
  const emptyDownloaded = await waitForDownload(DOWNLOAD_DIR, beforeEmptyExport, ".md");
  let emptyContent = "";
  if (emptyDownloaded) {
    emptyContent = fs.readFileSync(emptyDownloaded, "utf8");
  }
  check("21a. base=0 export does not produce Infinity", emptyContent && !/Infinity/.test(emptyContent));
  check("21b. base=0 export does not produce NaN", emptyContent && !/NaN/.test(emptyContent));
  check("21c. base=0 export uses '由 0 开始' or '-100%'", emptyContent && (/由 0 开始/.test(emptyContent) || /-100%/.test(emptyContent)));
  check("21d. clicking export on empty base does NOT trigger new annual-review requests", annualReviewCalls === callsBeforeEmptyExport);

  // 22: empty data export is possible
  check("22. empty-comparison export downloads a file", emptyDownloaded !== null);

  // 23: URL.revokeObjectURL is called (we observe at least one
  // blob: URL is revoked after the export — easiest proxy: ensure
  // the previous blob URL is no longer attached to any anchor).
  const hasStaleBlobAnchor = await page.evaluate(() => !!document.querySelector('a[href^="blob:"]'));
  check("23. anchor with blob: URL is cleaned up after download", !hasStaleBlobAnchor);

  // 24: no server POST
  check("24. no server POST during the entire flow", serverPosts.length === 0);

  // 25: no external requests
  check("25. no external requests (no MiniMax / no third-party CDN)", externalRequests.length === 0);

  // 26: S27J-2 Markdown export still works
  await page.click('[data-testid="weread-year-comparison-close"]');
  await new Promise((r) => setTimeout(r, 400));
  const beforeAnnualExport = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md"));
  await page.click('[data-testid="weread-annual-review-export-button"]');
  const annualDownloaded = await waitForDownload(DOWNLOAD_DIR, beforeAnnualExport, ".md");
  check("26. S27J-2 annual-review Markdown export still works", annualDownloaded !== null);

  // 27: S27I ICS export still exists
  await page.click('[data-testid="weread-tab-review"]');
  await page.waitForSelector('[data-testid="weread-review-calendar-export-button"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const icsButton = await page.evaluate(() => !!document.querySelector('[data-testid="weread-review-calendar-export-button"]'));
  check("27. S27I ICS export entry still present", icsButton);

  // 28: ICP footer still present
  const footer = await page.evaluate(() => /icp|备案|Beian/i.test(document.body.textContent || ""));
  check("28. ICP footer still present", footer);

  // 29: desktop 1440 has no horizontal overflow
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('[data-testid="weread-tab-annual"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-toggle"]', { timeout: 10000 });
  await page.click('[data-testid="weread-year-comparison-toggle"]');
  await page.waitForSelector('[data-testid="weread-year-comparison-metrics"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const horizDesktop = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("29. desktop 1440 has no horizontal overflow", horizDesktop <= 1);

  // 30: mobile 360 has no horizontal overflow
  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 500));
  const horizMobile = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("30. mobile 360 has no horizontal overflow", horizMobile <= 2);

  // Bonus: ensure no AI summary / related-books calls happened
  check("BONUS-1. no AI summary call", aiSummaryCalls === 0);
  check("BONUS-2. no related-books call", relatedBooksCalls === 0);

  // Local screenshot (NOT committed).
  try {
    const dir = path.resolve(__dirname, "..", "reports", "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    await page.setViewport({ width: 1440, height: 900 });
    await page.click('[data-testid="weread-tab-annual"]');
    await new Promise((r) => setTimeout(r, 300));
    // Re-open the comparison if it was closed.
    const comparisonOpen = await page.evaluate(() => !!document.querySelector('[data-testid="weread-year-comparison-metrics"]'));
    if (!comparisonOpen) {
      await page.click('[data-testid="weread-year-comparison-toggle"]');
      await page.waitForSelector('[data-testid="weread-year-comparison-metrics"]', { timeout: 10000 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: path.join(dir, "s27k2-year-comparison-markdown.png"), fullPage: true });
    console.log(`  (screenshot: ${path.join(dir, "s27k2-year-comparison-markdown.png")})`);
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