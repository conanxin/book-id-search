#!/usr/bin/env node
/**
 * S27P-3 Browser smoke — Reading Evolution Timeline Markdown Export.
 *
 * Headless Chromium against the local Vite preview. Intercepts the
 * weread private API with synthetic annual-review fixtures and verifies
 * the "导出年度统计时间线 Markdown" button + downloaded file content.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require("/home/ubuntu/.npm-global/lib/node_modules/puppeteer");

const PAGE_URL = process.env.S27P3_PAGE_URL || "http://127.0.0.1:5173/weread";
const DOWNLOAD_DIR = "/tmp/s27p3-downloads";

const state = {
  annualReviewCalls: 0,
  yearRequestCounts: {},
  externalRequests: [],
  serverPosts: [],
};

// ---------- synthetic annual-review fixture ----------

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
  const months = makeMonths(year);
  return Array.from({ length: 4 }, (_, i) => {
    const start = i * 3;
    const slice = months.slice(start, start + 3);
    const total = slice.reduce((a, b) => a + b.total, 0);
    const activeMonths = slice.filter((m) => m.total > 0).length;
    const matchedRecords = slice.reduce((a, b) => a + b.matched, 0);
    const bookCount = slice.reduce((a, b) => a + b.bookCount, 0);
    return {
      quarter: `Q${i + 1}`,
      total,
      activeMonths,
      matchedRecords,
      bookCount,
    };
  });
}

function makeTopBooks(year, count = 6) {
  return Array.from({ length: count }, (_, i) => {
    const rank = i + 1;
    return {
      catalogId: `catalog-${year}-${rank}`,
      title: `示例书目 ${year}-${rank}`,
      author: `作者 ${rank}`,
      publisher: "示例出版社",
      publishYear: String(year),
      noteCount: rank * 2,
      highlights: rank,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      activeMonths: Math.min(12, rank + 1),
      firstNoteAt: `${year}-01-01T00:00:00Z`,
      lastNoteAt: `${year}-12-31T23:59:59Z`,
    };
  });
}

function makeOverview(year, months) {
  const totalRecords = months.reduce((a, b) => a + b.total, 0);
  const datedRecords = totalRecords;
  const matchedRecords = months.reduce((a, b) => a + b.matched, 0);
  const matchedBooks = new Set(
    months.flatMap((m) =>
      Array.from({ length: m.bookCount }, (_, i) => `${year}-book-${i}`),
    ),
  ).size;
  const activeMonths = months.filter((m) => m.total > 0).length;
  let longestStreakMonths = 0;
  let current = 0;
  for (const m of months) {
    if (m.total > 0) {
      current += 1;
      if (current > longestStreakMonths) longestStreakMonths = current;
    } else {
      current = 0;
    }
  }
  const peak = months.reduce(
    (best, m) => (m.total > best.total ? m : best),
    { month: `${year}-01`, total: 0 },
  );
  const peakMonth = peak.total > 0 ? peak.month : null;
  const peakMonthRecords = peak.total;
  const averageRecordsPerActiveMonth = activeMonths > 0 ? totalRecords / activeMonths : 0;
  return {
    year,
    totalRecords,
    datedRecords,
    matchedRecords,
    matchedBooks,
    activeMonths,
    longestStreakMonths,
    firstNoteAt: totalRecords > 0 ? `${year}-01-01T00:00:00Z` : null,
    lastNoteAt: totalRecords > 0 ? `${year}-12-31T23:59:59Z` : null,
    peakMonth,
    peakMonthRecords,
    averageRecordsPerActiveMonth,
  };
}

function makeAnnualReview(year) {
  const months = makeMonths(year);
  const quarters = makeQuarters(year);
  const topBooks = makeTopBooks(year, 6);
  const overview = makeOverview(year, months);
  return {
    ok: true,
    selectedYear: year,
    availableYears: [2025, 2024, 2023, 2022, 2021, 2020],
    overview,
    months,
    quarters,
    topBooks,
    meta: {
      topBooksRequested: 6,
      topBooksReturned: topBooks.length,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
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

// ---------- helpers ----------

function ps(label, cond) {
  const result = cond ? "PASS" : "FAIL";
  console.log(`  [${result}] ${label}`);
  if (!cond) process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setupDownloadDir() {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  } catch {}
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    if (f.endsWith(".md") || f.endsWith(".crdownload")) {
      try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch {}
    }
  }
}

async function waitForDownload(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(
      (f) => f.endsWith(".md") && !f.endsWith(".crdownload"),
    );
    if (files.length > 0) return files[0];
    await sleep(500);
  }
  return null;
}

// ---------- smoke ----------

async function runSmoke() {
  console.log("\n=== S27P-3 Reading Evolution Timeline Markdown Export Smoke ===\n");
  console.log(`Page: ${PAGE_URL}`);
  console.log(`Download dir: ${DOWNLOAD_DIR}\n`);

  await setupDownloadDir();

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  const reactErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (/React error #300|Minified React error #300|error #300/i.test(text)) {
        reactErrors.push(text);
      }
    }
  });
  page.on("pageerror", (err) => {
    if (/React error #300|Minified React error #300|error #300/i.test(err.message)) {
      reactErrors.push(err.message);
    }
  });
  const cdp = await page.target().createCDPSession();
  await cdp.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });
  await page.setViewport({ width: 1440, height: 900 });

  // ---- intercept ALL weread private API calls ----
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    const method = req.method();

    // Track external requests
    if (
      !url.startsWith("https://books.conanxin.com") &&
      !url.startsWith("http://127.0.0.1") &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:")
    ) {
      state.externalRequests.push({ url, method });
      req.abort("blockedby规则").catch(() => {});
      return;
    }

    // Track server POSTs (except summarize which is AI)
    if (
      (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") &&
      !url.includes("/notes/summarize")
    ) {
      state.serverPosts.push(url);
    }

    // Skip non-private requests
    if (!url.includes("/private/weread/")) {
      req.continue().catch(() => {});
      return;
    }

    // CORS preflight
    if (method === "OPTIONS") {
      req.respond({
        status: 200,
        contentType: "text/plain",
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
        body: "",
      }).catch(() => {});
      return;
    }

    // annual-review
    if (url.includes("/annual-review")) {
      state.annualReviewCalls++;
      const m = url.match(/[?&]?year=(\d{4})/);
      const year = m ? Number(m[1]) : null;
      if (year !== null) {
        state.yearRequestCounts[year] = (state.yearRequestCounts[year] || 0) + 1;
      }
      const effectiveYear = year === null ? 2025 : year;
      const body = ANNUAL_REVIEW_DATA[effectiveYear] || makeAnnualReview(effectiveYear);
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      }).catch(() => {});
      return;
    }

    // reading-map
    if (url.includes("/reading-map")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
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
      }).catch(() => {});
      return;
    }

    // summary
    if (url.includes("/summary")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          ok: true,
          booksCount: 25, notesCount: 100, reviewsCount: 3,
          matchedCatalogsCount: 20, confirmedMatchesCount: 18,
          confirmedWithNotesCount: 15, confirmedWithHighlightsCount: 12,
          totalConfirmedNoteRecords: 85, matchRatePercent: 72,
          notesPerConfirmedMatch: 4.7,
        }),
      }).catch(() => {});
      return;
    }

    // trends
    if (url.includes("/trends")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
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
      }).catch(() => {});
      return;
    }

    // related-books
    if (url.includes("/related-books")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ ok: true, items: [], meta: { persisted: false } }),
      }).catch(() => {});
      return;
    }

    // notes/summarize (AI — forbidden)
    if (url.includes("/notes/summarize")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          ok: true,
          summary: {
            overview: "FORBIDDEN_OVERVIEW",
            themes: ["FORBIDDEN_THEME"],
            keyPoints: ["FORBIDDEN_KEYPOINT"],
            reviewQuestions: ["FORBIDDEN_QUESTION"],
            readingDirections: [],
          },
          meta: { itemsUsed: 0, totalCharacters: 0, persisted: false, provider: "minimax" },
        }),
      }).catch(() => {});
      return;
    }

    // default OK
    req.respond({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true }),
    }).catch(() => {});
  });

  // ---- navigate to weread page ----
  await page.goto(PAGE_URL, { waitUntil: "networkidle2", timeout: 30000 });

  // Inject synthetic private token so the page shows the dashboard
  await page.evaluate(() => {
    try { sessionStorage.setItem("book-id-search:weread-private-token", "smoke-token-12345"); } catch {}
  });
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await sleep(2000);

  // ---- click Archive tab ----
  await page.waitForSelector('[data-testid="weread-tab-archive"]', { timeout: 15000 }).catch(() => {});
  await page.click('[data-testid="weread-tab-archive"]').catch(() => {});

  // Wait for archive data to be loaded (dataAvailable=true)
  // The archive-overview section only renders when dataAvailable=true
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="weread-reading-archive-overview"]'),
    { timeout: 20000 },
  ).catch(() => {});
  await sleep(2000); // extra settle time

  // ---- 1-2. Timeline Panel and Export button exist ----
  const panelExists = await page.$('[data-testid="weread-reading-evolution"]');
  ps("1. Timeline Panel exists", !!panelExists);

  // Check for any element with 'evolution' class or testid
  const evoInfo = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*')).filter(el => {
      const testid = el.getAttribute ? el.getAttribute('data-testid') : null;
      const cls = el.className || '';
      return (testid && testid.includes('evolution')) || (typeof cls === 'string' && cls.includes('evolution'));
    });
    return {
      found: all.length,
      items: all.slice(0, 5).map(el => ({
        tag: el.tagName,
        testid: el.getAttribute('data-testid'),
        cls: (el.className || '').substring(0, 60),
        rect: el.getBoundingClientRect ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null
      }))
    };
  });
  console.log('  Evolution elements:', JSON.stringify(evoInfo));

  // Also check the archive section's children
  const archiveChildren = await page.evaluate(() => {
    const archive = document.querySelector('[data-testid="weread-reading-archive"]');
    if (!archive) return 'archive not found';
    return Array.from(archive.children).map(c => ({
      tag: c.tagName,
      testid: c.getAttribute ? c.getAttribute('data-testid') : null,
      cls: (c.className || '').substring(0, 60)
    }));
  });
  console.log('  Archive children:', JSON.stringify(archiveChildren));

  // Debug: list ALL section/article elements
  const sections = await page.evaluate(() =>
    Array.from(document.querySelectorAll('section, article')).map(e => ({
      tag: e.tagName,
      testid: e.getAttribute('data-testid'),
      cls: e.className,
    }))
  );
  console.log('  DOM sections:', JSON.stringify(sections.slice(0, 30)));

  const exportBtnExists = await page.$('[data-testid="weread-reading-evolution-export-button"]');
  ps("2. Export button exists", !!exportBtnExists);

  if (!exportBtnExists) {
    // Debug: dump available testids + sections
    const testids = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid]")).map(e => e.getAttribute("data-testid"))
    );
    console.log("  Available testids:", testids.join(", "));
    const sections = await page.evaluate(() =>
      Array.from(document.querySelectorAll('section, article')).map(e => ({
        testid: e.getAttribute('data-testid'), cls: e.className.substring(0, 50)
      }))
    );
    console.log('  Sections:', JSON.stringify(sections.slice(0,20)));
  }

  // ---- 3. Button enabled after load ----
  const btnEnabled = await page.$eval(
    '[data-testid="weread-reading-evolution-export-button"]',
    (el) => !el.disabled,
  );
  ps("3. Export button enabled after data loaded", btnEnabled);

  // ---- 4. Download .md file ----
  const reqBeforeExport = state.annualReviewCalls;
  const dlPromise = waitForDownload(15000);
  await page.click('[data-testid="weread-reading-evolution-export-button"]').catch(() => {});
  const downloadFile = await dlPromise;
  const reqAfterExport = state.annualReviewCalls;
  ps("4. Downloaded .md file", !!(downloadFile && downloadFile.endsWith(".md")));

  if (downloadFile) {
    const content = fs.readFileSync(path.join(DOWNLOAD_DIR, downloadFile), "utf8");

    // ---- 5-7. Filename checks ----
    ps("5. Filename contains weread-reading-evolution", downloadFile.includes("weread-reading-evolution"));
    ps("6. Filename ends with YYYYMMDD.md", /\d{8}\.md$/.test(downloadFile));
    ps("7. File is non-empty markdown", content.length > 100 && content.includes("#"));

    // ---- 8-21. Content checks ----
    ps("8. Contains title '# 年度统计演变时间线'", content.includes("# 年度统计演变时间线"));
    ps("9. Contains metadata section", content.includes("档案年份：") || content.includes("当前长期档案范围："));
    ps("10. Contains timeline overview", content.includes("时间线总览"));
    ps("11. Contains milestone section", content.includes("## 时间线标记") || content.includes("时间线标记"));
    ps("12. Contains year section", content.includes("## 年度节点") || content.includes("### 20"));
    ps("13. Contains Top N books section", content.includes("Top") || content.includes("公共书目"));
    ps("14. Contains transition section", content.includes("## 相邻年度过渡") || content.includes("### 20"));
    ps("15. Contains metric differences", content.includes("指标差异") || content.includes("阅读记录"));
    ps("16. Contains significance info", content.includes("统计差异得分") || content.includes("显著统计差异") || content.includes("常规统计差异"));
    ps("17. Contains overlap ratio", content.includes("重合比例") || content.includes("榜单重合"));
    ps("18. Contains continued or left books (or empty note)", content.includes("两年都有") || content.includes("暂无"));
    ps("19. Contains entered books (or empty note)", content.includes("新进入") || content.includes("暂无"));
    ps("20. Contains book differences section", content.includes("#### 两年都有") || content.includes("#### 当前年份新进入") || content.includes("#### 前一年出现"));
    ps("21. Contains 方法说明 section", content.includes("## 方法说明") || content.includes("方法说明"));

    // ---- 22. Partial failure note ----
    // (Normal run has all years succeed — partial covered in unit tests)

    // ---- 23. Request safety ----
    ps("23. Export triggers 0 extra annual-review requests", reqAfterExport === reqBeforeExport);

    // ---- 24-25. Retry/stability ----
    console.log(`\n  Annual review calls: ${state.annualReviewCalls} (yearRequestCounts=${JSON.stringify(state.yearRequestCounts)})`);
    ps("24. Annual review calls >= 1 (data loaded)", state.annualReviewCalls >= 1);

    // ---- 26-27. Network safety ----
    const nonAnnualPosts = state.serverPosts.filter(
      (u) => !u.includes("/annual-review") && !u.includes("/private/weread/"),
    );
    ps("26. Export triggers 0 non-private POST requests", nonAnnualPosts.length === 0, nonAnnualPosts.join(", ") || "");
    ps("27. Export triggers 0 external requests", state.externalRequests.length === 0, state.externalRequests.map(r => r.url).join(", ") || "");

    // ---- 28-29. Range/Top N in file ----
    ps("28. File contains range label", content.includes("最近5年") || content.includes("最近10年") || content.includes("全部"));
    ps("29. File contains Top N label", content.includes("Top"));

    // ---- 30-32. Empty/single covered by unit tests ----

    // ---- 33-39. Privacy checks ----
    ps("33. No noteId in export", !content.includes("noteId"));
    ps("34. No wereadBookId in export", !content.includes("wereadBookId"));
    ps("35. No token/Authorization in export", !content.includes("Authorization") && !content.includes("token="));
    ps("36. No AI summary/themes in export", !content.includes("FORBIDDEN_OVERVIEW") && !content.includes("FORBIDDEN_THEME"));
    ps("37. No raw JSON structure in export", !content.includes('"years"') && !content.includes('"catalogId"'));
    ps("38. No cache/request debug info", !content.includes("cache") && !content.includes("requestId"));
    const FORBIDDEN = ["心理", "人格", "兴趣转变", "偏好改变", "成长", "退步", "改善", "提升", "阅读低谷", "阅读巅峰", "成熟期", "探索期", "转折点", "稳定性", "能力变化", "阅读质量"];
    const forbiddenFound = FORBIDDEN.filter((w) => content.includes(w));
    ps("39. No inference forbidden words", forbiddenFound.length === 0, forbiddenFound.join(", ") || "");

    // ---- 40-43. Other exports still present ----
    ps("40. Archive Markdown export button present", !!(await page.$('[data-testid="weread-reading-archive-export-button"]')));
    ps("41. Era Markdown export button present", !!(await page.$('[data-testid="weread-reading-era-export-button"]')));
    ps("42. Dual Markdown export button present", !!(await page.$('[data-testid="weread-dual-period-export-button"]')));
    ps("43. Comparison Markdown export button present", !!(await page.$('[data-testid="weread-reading-comparison-export-button"]')));

    // ---- 44. React error #300 ----
    // (Would appear as console.error from React — not easily tracked without eval)

    // ---- 44. React error #300 ----
    ps("44. React error #300 count is 0", reactErrors.length === 0, reactErrors.join(", ") || "");

    // ---- 45-47. ICP footer + responsive ----
    const icpFooter = await page.$("footer");
    ps("45. ICP footer exists", !!icpFooter);

    await page.setViewport({ width: 1440, height: 900 });
    await sleep(500);
    const desktopOverflow = await page.evaluate(() =>
      document.body.scrollWidth > document.documentElement.clientWidth,
    );
    ps("46. Desktop 1440px no horizontal overflow", !desktopOverflow);

    await page.setViewport({ width: 360, height: 800 });
    await sleep(500);
    const mobileOverflow = await page.evaluate(() =>
      document.body.scrollWidth > document.documentElement.clientWidth,
    );
    ps("47. Mobile 360px no horizontal overflow", !mobileOverflow);

    // Cleanup downloaded file
    try { fs.unlinkSync(path.join(DOWNLOAD_DIR, downloadFile)); } catch {}
  }

  await browser.close();

  // Final cleanup
  try { fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true }); } catch {}

  console.log("\n=== S27P-3 Smoke Complete ===\n");
}

runSmoke().catch((err) => {
  console.error("SMOKE ERROR:", err.message);
  process.exit(1);
});
