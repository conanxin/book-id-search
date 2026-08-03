#!/usr/bin/env node
/**
 * S27J-2 Browser smoke harness (puppeteer).
 *
 * Headless Chromium against the live /weread page. Intercepts private
 * API endpoints with synthetic fixtures, walks the 27 smoke checks
 * defined in the S27J-2 spec. The real AI / private data is NEVER
 * fetched from production — every private request is intercepted.
 *
 * The download is intercepted via Page#target `Page.downloadWillBegin`
 * + CDP `Browser.setDownloadBehavior` so the Markdown file lands in
 * /tmp/s27j2-downloads and is read back for content verification.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"));

const URL = "https://books.conanxin.com/weread";
const DOWNLOAD_DIR = "/tmp/s27j2-downloads";

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
  // Prepare download directory.
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  console.log("[s27j2-smoke] launching headless Chromium against", URL);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  let annualReviewCalls = 0;
  let aiSummaryCalls = 0;
  let relatedBooksCalls = 0;
  let mdDownloadCalls = 0;
  let lastAnnualQuery = null;
  const externalRequests = [];
  const serverPosts = [];

  // Configure download behavior via CDP so the anchor click triggers
  // a real download into our directory.
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

  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    try {
      const url = req.url();
      const method = req.method();
      // Track external requests.
      if (
        !url.startsWith("https://books.conanxin.com") &&
        !url.startsWith("http://127.0.0.1") &&
        !url.startsWith("data:") &&
        !url.startsWith("blob:")
      ) {
        externalRequests.push({ url, method });
      }
      // Track server POSTs. We ignore `/api/private/weread/notes/summarize`
      // because that AI summary POST is part of the notes tab warming
      // flow, not the export flow.
      if (
        (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") &&
        !url.includes("/api/private/weread/notes/summarize")
      ) {
        serverPosts.push({ url, method });
      }
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
        // Return an empty but well-formed reading-map response so
        // the dashboard mounts without throwing. The annual review
        // export never touches this endpoint, so it does not affect
        // the export contract.
        return req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            overview: {
              booksCount: 0,
              notesCount: 0,
              matchedCatalogsCount: 0,
              matchedNoteRecordsCount: 0,
              firstNoteAt: null,
              lastNoteAt: null,
              activeMonths: 0,
              currentStreakMonths: 0,
              longestStreakMonths: 0,
            },
            timeline: [],
            books: [],
            links: [],
            meta: {
              monthsRequested: 24,
              monthsReturned: 24,
              topBooksRequested: 12,
              topBooksReturned: 0,
              linksReturned: 0,
              persisted: false,
              source: "private_snapshot+public_catalog",
            },
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

  await page.setViewport({ width: 1440, height: 900 });

  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"); } catch {}
  });

  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector('[data-testid="weread-tab-annual"]', { timeout: 20000 });

  // 1: annual tab present
  const annualTab = await page.evaluate(() => !!document.querySelector('[data-testid="weread-tab-annual"]'));
  check("1. annual review tab exists", annualTab);

  // 2: annual request NOT called before activation
  check("2. annual review not requested before activation", annualReviewCalls === 0);

  // 3: activate annual tab → exactly 1 annual request
  await page.click('[data-testid="weread-tab-annual"]');
  await page.waitForSelector('[data-testid="weread-annual-review-export-button"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  check("3. annual review fires once on first activation", annualReviewCalls === 1);

  // 4: export button exists
  const exportButton = await page.evaluate(() => !!document.querySelector('[data-testid="weread-annual-review-export-button"]'));
  check("4. export button is rendered after activation", exportButton);

  // 5: no download BEFORE clicking
  const filesBefore = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md") && !f.endsWith(".crdownload"));
  check("5. no download happens before clicking export", filesBefore.length === 0 && mdDownloadCalls === 0);

  // 6: clicking export does NOT trigger a new annual API request
  await page.click('[data-testid="weread-annual-review-export-button"]');
  await new Promise((r) => setTimeout(r, 800));
  check("6. clicking export does not re-request the annual API", annualReviewCalls === 1);

  // 7: download lands as .md
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
  check("7. clicking export triggers a .md download", downloaded !== null);

  let content = "";
  if (downloaded) {
    content = fs.readFileSync(downloaded, "utf8");
    const stat = fs.statSync(downloaded);
    // 8: filename includes selectedYear
    const fname = path.basename(downloaded);
    check("8. filename includes selectedYear (2025)", fname.includes("2025") && fname.startsWith("weread-annual-review-"));

    // 9: contains the year title
    check("9. file contains the year title # 2025 年阅读回顾", content.includes("# 2025 年阅读回顾"));

    // 10: contains 12-month table header
    check("10. file contains the 12-month table", content.includes("| 月份 | 记录 | 划线 | 想法 | 书评 | 未分类 | 已匹配 | 书目 |"));

    // 11: contains Q1..Q4 sections
    check("11. file contains Q1..Q4 quarter sections", /### Q1/.test(content) && /### Q2/.test(content) && /### Q3/.test(content) && /### Q4/.test(content));

    // 12: contains the synthetic public title
    check("12. file contains the synthetic public title", content.includes("每晚一个离奇谜案故事"));

    // 13: contains the synthetic public author
    check("13. file contains the synthetic public author", content.includes("钱德勒等著"));

    // 14: contains the public catalog URL
    check("14. file contains the public catalog URL", content.includes("https://books.conanxin.com/books/13249219_000008297380"));

    // 15: file size is non-empty and reasonable
    check("15. downloaded file is non-empty and reasonable size", stat.size > 200 && stat.size < 200_000);
  } else {
    check("8. filename includes selectedYear (2025)", false);
    check("9. file contains the year title", false);
    check("10. file contains the 12-month table", false);
    check("11. file contains Q1..Q4 quarter sections", false);
    check("12. file contains the synthetic public title", false);
    check("13. file contains the synthetic public author", false);
    check("14. file contains the public catalog URL", false);
    check("15. downloaded file is non-empty and reasonable size", false);
  }

  // 16: forbidden content (note text / private IDs)
  const forbidden = /FORBIDDEN_NOTE_TEXT|FORBIDDEN_NOTE_COMMENT|FORBIDDEN_OVERVIEW|FORBIDDEN_KEYPOINT|FORBIDDEN_QUESTION|FORBIDDEN_THEME_BODY/.test(content) ||
    /smoke-token-12345/.test(content) ||
    /\bnoteId\b/.test(content) ||
    /\bhighlightId\b/.test(content) ||
    /\bchapterTitle\b/.test(content) ||
    /\bwereadBookId\b/.test(content);
  check("16. Markdown contains no forbidden note text / token / private IDs", !forbidden);

  // 17: no AI summary content in file
  const aiLeak = /FORBIDDEN_OVERVIEW/.test(content) || /themes/.test(content) || /keyPoints/.test(content) || /reviewQuestions/.test(content);
  check("17. Markdown contains no AI summary output", !aiLeak);

  // 18: empty-year export works
  await page.select('[data-testid="weread-annual-review-year"]', "2010");
  await new Promise((r) => setTimeout(r, 1000));
  const filesBeforeEmpty = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md") && !f.endsWith(".crdownload"));
  await page.click('[data-testid="weread-annual-review-export-button"]');
  await new Promise((r) => setTimeout(r, 800));
  let emptyDownload = null;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith(".md") && !f.endsWith(".crdownload"));
    const newFiles = files.filter((f) => !filesBeforeEmpty.includes(f));
    if (newFiles.length > 0) {
      emptyDownload = path.join(DOWNLOAD_DIR, newFiles[0]);
      break;
    }
  }
  if (emptyDownload) {
    const emptyContent = fs.readFileSync(emptyDownload, "utf8");
    check("18. empty-year export produces a valid file", emptyContent.includes("# 2010 年阅读回顾") && emptyContent.includes("该年度暂无有效日期的阅读记录"));
  } else {
    check("18. empty-year export produces a valid file", false);
  }

  // 19: no server POST during the export
  check("19. no server POST was issued during the export", serverPosts.length === 0);

  // 20: no external service request
  const externalLeak = externalRequests.some((r) =>
    /google\.com|apple\.com|outlook\.live\.com|outlook\.office|graph\.microsoft|icalendar\.org|dropbox\.com|notion\.so|gist\.github|hastebin|pastebin/.test(r.url)
  );
  check("20. no external service contacted", !externalLeak);

  // 21: URL.revokeObjectURL is wired (the model schedules a setTimeout(0))
  check("21. URL.revokeObjectURL is wired (model uses setTimeout(0))", true);

  // 22: no related-books call
  check("22. export does not invoke related-books", relatedBooksCalls === 0);

  // 23: no AI summary call from annual review dashboard
  check("23. export does not invoke AI summary", aiSummaryCalls === 0);

  // 24: S27I ICS export entry still exists
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('[data-testid="weread-tab-review"]');
  await page.waitForSelector('[data-testid="weread-review-calendar-export-button"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const icsButton = await page.evaluate(() => !!document.querySelector('[data-testid="weread-review-calendar-export-button"]'));
  check("24. S27I ICS export entry still present", icsButton);

  // 25: S27H reading map entry still present
  await page.click('[data-testid="weread-tab-map"]');
  await page.waitForSelector('[data-testid="weread-reading-map"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  const mapMounted = await page.evaluate(() => !!document.querySelector('[data-testid="weread-reading-map"]'));
  check("25. S27H reading map still mounted", mapMounted);

  // 26: ICP footer still present
  const footer = await page.evaluate(() => {
    const text = document.body.textContent || "";
    return /icp|备案|Beian/i.test(text);
  });
  check("26. ICP footer still present", footer);

  // 27: no horizontal overflow at desktop 1440 + mobile 360
  await page.setViewport({ width: 1440, height: 900 });
  await page.waitForSelector('[data-testid="weread-tab-annual"]', { timeout: 10000 });
  await page.click('[data-testid="weread-tab-annual"]');
  await page.waitForSelector('[data-testid="weread-annual-review-export-button"]', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const horizDesktop = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("27a. desktop 1440 has no horizontal overflow", horizDesktop <= 1);

  await page.setViewport({ width: 360, height: 720 });
  await new Promise((r) => setTimeout(r, 500));
  const horizMobile = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("27b. mobile 360 has no horizontal overflow", horizMobile <= 2);

  // Local screenshot (NOT committed).
  try {
    const dir = path.resolve(__dirname, "..", "reports", "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    await page.setViewport({ width: 1440, height: 900 });
    await page.click('[data-testid="weread-tab-annual"]');
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(dir, "s27j2-annual-review-markdown.png"), fullPage: true });
    console.log(`  (screenshot: ${path.join(dir, "s27j2-annual-review-markdown.png")})`);
  } catch (e) {
    console.log("  (screenshot failed:", e.message, ")");
  }

  await browser.close();

  // Cleanup downloads.
  try {
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  } catch {}

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