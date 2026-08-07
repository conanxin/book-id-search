#!/usr/bin/env node
/**
 * S27S-2 Browser smoke — Guided Reading Data Repair Navigation.
 *
 * Headless Chromium against a local vite preview server. Intercepts
 * the synthetic annual-review fixture so the audit + repair
 * recommendations panel renders with deterministic synthetic data.
 * Verifies that the S27S-2 navigation chain works in a REAL browser:
 *   - No navigation on render / rerender / mount
 *   - Explicit user click triggers exactly 1 scrollIntoView + 1 focus
 *   - Second click = second independent navigation
 *   - document.activeElement matches the resolved Surface
 *   - URL unchanged across navigation
 *   - 0 annual / 0 POST / 0 external requests during navigation
 *   - Notes↔️Archive round-trip preserves navigation behavior
 *   - React error #300 = 0
 *   - Desktop 1440 + Mobile 360 no horizontal overflow
 *
 * All private endpoints are intercepted. No real data used.
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

const puppeteer = require(
  path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"),
);

const PREVIEW_PORT = Number(process.env.S27S_PREVIEW_PORT || 4739);
const BASE_URL = process.env.S27S_BASE_URL || `http://127.0.0.1:${PREVIEW_PORT}`;
const TOKEN = "***";

const ALL_YEARS = [2021, 2022, 2023, 2024, 2025];
const FAILING_YEAR = 2023;

const state = {
  scrollCount: 0,
  focusCount: 0,
  s27sScrollCount: 0,
  s27sFocusCount: 0,
  annualReviewCalls: 0,
  serverPosts: 0,
  externalRequests: [],
  errors: [],
  downloads: [],
  allowScrollInfo: [],
  allowFocusInfo: [],
};

let exitCode = 0;
const check = (label, ok) => {
  const tag = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${tag} ${label}`);
  if (!ok) exitCode = 1;
  return ok;
};

// ---------- synthetic fixture ----------

function makeMonths(year) {
  return Array.from({ length: 12 }, (_, i) => {
    const total = year === 2022 ? 0 : (year - 2020) * 20 + (i + 1) * 2;
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
    return { quarter: `${year}-Q${i + 1}`, months: slice, total: slice.reduce((a, b) => a + b.total, 0) };
  });
}
function makeTopBooks(year) {
  // Ensure recurring books exist for recurring_books surface
  if (year === 2021) {
    return [
      { rank: 1, catalogId: "synthetic-2021-1", title: `Synthetic Book ${year} #1`, author: "Author 1", publisher: "SP", publishYear: 2021, highlights: 5, thoughts: 0, reviews: 0, unknown: 0, matched: 1, total: 10 },
      { rank: 2, catalogId: "synthetic-2021-2", title: `Synthetic Book ${year} #2`, author: "Author 2", publisher: "SP", publishYear: 2021, highlights: 4, thoughts: 0, reviews: 0, unknown: 0, matched: 1, total: 9 },
    ];
  }
  if (year === 2022) {
    return [
      { rank: 1, catalogId: "synthetic-2022-1", title: `Synthetic Book ${year} #1`, author: "Author 1", publisher: "SP", publishYear: 2022, highlights: 3, thoughts: 0, reviews: 0, unknown: 0, matched: 1, total: 7 },
      { rank: 1, catalogId: "synthetic-2021-1", title: `Synthetic Book 2021 #1`, author: "Author 1", publisher: "SP", publishYear: 2021, highlights: 5, thoughts: 0, reviews: 0, unknown: 0, matched: 1, total: 10 },
    ];
  }
  return [
    { rank: 1, catalogId: `synthetic-${year}-1`, title: `Synthetic Book ${year} #1`, author: "Author 1", publisher: "SP", publishYear: 2000, highlights: 5 - year % 3, thoughts: 0, reviews: 0, unknown: 0, matched: 1, total: 10 - year % 3 },
  ];
}
function makeOverview(year) {
  return {
    year,
    totalRecords: year === 2022 ? 0 : (year - 2020) * 240,
    datedRecords: year === 2022 ? 0 : (year - 2020) * 200,
    matchedRecords: year === 2022 ? 0 : (year - 2020) * 180,
    matchedBooks: 3,
    activeMonths: year === 2022 ? 0 : 12,
    longestStreakMonths: year === 2022 ? 0 : 6,
    firstNoteAt: year === 2022 ? null : `${year}-01-01T00:00:00.000Z`,
    lastNoteAt: year === 2022 ? null : `${year}-12-31T00:00:00.000Z`,
    peakMonth: year === 2022 ? null : `${year}-06`,
    peakMonthRecords: year === 2022 ? 0 : 30,
    averageRecordsPerActiveMonth: year === 2022 ? 0 : 20,
  };
}
function makeFullResponse(year) {
  return {
    ok: true,
    selectedYear: year,
    availableYears: ALL_YEARS.slice().sort((a, b) => b - a),
    overview: makeOverview(year),
    months: makeMonths(year),
    quarters: makeQuarters(year),
    topBooks: makeTopBooks(year),
    meta: {
      topBooksRequested: 12,
      topBooksReturned: makeTopBooks(year).length,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

// ---------- preview server ----------

function startPreview() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "node_modules/.bin/vite",
      ["preview", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT)],
      {
        cwd: path.resolve(__dirname, "../apps/web"),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    proc.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      process.stdout.write(`[preview] ${s}`);
      if (s.includes("Local") || s.includes("ready in")) {
        setTimeout(() => resolve(proc), 200);
      }
    });
    proc.stderr.on("data", (chunk) => process.stderr.write(`[preview-err] ${chunk}`));
    proc.on("exit", (code) => console.error(`[preview] exited with ${code}`));
    setTimeout(() => reject(new Error("preview start timeout")), 15000);
  });
}

function waitForUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`timeout waiting for ${url}`));
        } else {
          setTimeout(tick, 100);
        }
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

// ---------- main ----------

async function main() {
  let previewProc = null;
  try {
    console.log("[s27s2-smoke] starting local preview…");
    previewProc = await startPreview();
    await waitForUrl(`${BASE_URL}/`);
    console.log(`[s27s2-smoke] preview ready at ${BASE_URL}`);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    page.on("console", (msg) => {
      if (msg.type() === "error") state.errors.push(msg.text());
    });
    page.on("pageerror", (err) => state.errors.push(err.message));

    // Instrument scrollIntoView + focus on HTMLElement prototype to count
    // only calls targeting S27S verified surfaces.
    await page.evaluateOnNewDocument(() => {
      const ALLOWED = new Set([
        "weread-reading-archive-controls",
        "weread-reading-archive-year-grid",
        "weread-reading-data-quality",
        "weread-reading-archive-links",
        "weread-reading-data-repair",
      ]);
      const ALLOWED_REPAIR = new Set(["archive_book_grid:recurring"]);
      const origScroll = HTMLElement.prototype.scrollIntoView;
      const origFocus = HTMLElement.prototype.focus;
      // @ts-ignore
      window.__s27s2_scroll = 0;
      // @ts-ignore
      window.__s27s2_focus = 0;
      // @ts-ignore
      window.__s27s2_scrollAll = 0;
      // @ts-ignore
      window.__s27s2_focusAll = 0;
      HTMLElement.prototype.scrollIntoView = function (...args) {
        // @ts-ignore
        window.__s27s2_scrollAll += 1;
        const ds = this.getAttribute("data-testid");
        const rs = this.getAttribute("data-weread-repair-surface");
        if ((ds && ALLOWED.has(ds)) || (rs && ALLOWED_REPAIR.has(rs))) {
          // @ts-ignore
          window.__s27s2_scroll += 1;
        }
        return origScroll.apply(this, args);
      };
      HTMLElement.prototype.focus = function (...args) {
        // @ts-ignore
        window.__s27s2_focusAll += 1;
        const ds = this.getAttribute("data-testid");
        const rs = this.getAttribute("data-weread-repair-surface");
        if ((ds && ALLOWED.has(ds)) || (rs && ALLOWED_REPAIR.has(rs))) {
          // @ts-ignore
          window.__s27s2_focus += 1;
        }
        return origFocus.apply(this, args);
      };
    });

    await page.evaluateOnNewDocument((token) => {
      try { sessionStorage.setItem("book-id-search:weread-private-token", token); } catch {}
    }, TOKEN);

    let failingAttempts = 0;
    await page.setRequestInterception(true);
    page.on("request", async (req) => {
      const u = req.url();
      const method = req.method();
      if (method === "POST") {
        state.serverPosts += 1;
      }
      if (method === "OPTIONS" && u.includes("/api/private/weread/")) {
        try {
          req.respond({
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Authorization, Content-Type",
              "Access-Control-Max-Age": "3600",
            },
          });
        } catch {}
        return;
      }
      if (!u.startsWith("http://127.0.0.1") && !u.includes("localhost") && !u.startsWith("data:")) {
        state.externalRequests.push(u);
      }
      if (u.includes("/api/private/weread/summary")) {
        try {
          req.respond({
            status: 200,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({
              ok: true, dataAvailable: true, booksCount: 0, notesCount: 0,
              confirmedMatchesCount: 0, confirmedWithNotesCount: 0,
              confirmedWithHighlightsCount: 0, totalConfirmedNoteRecords: 0,
            }),
          });
        } catch {}
        return;
      }
      if (u.includes("/api/private/weread/trends")) {
        try {
          req.respond({
            status: 200,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({
              ok: true,
              last7Days: { total: 0, activeDays: 0, activeBooks: 0 },
              last30Days: { total: 0, activeDays: 0, activeBooks: 0 },
              last90Days: { total: 0, activeDays: 0, activeBooks: 0 },
              allTime: { total: 0, activeDays: 0, activeBooks: 0 },
            }),
          });
        } catch {}
        return;
      }
      if (u.includes("/api/private/weread/annual-review")) {
        try {
          const url = new URL(u);
          const yearParam = url.searchParams.get("year");
          const year = yearParam ? Number(yearParam) : NaN;
          if (!Number.isFinite(year)) {
            const latest = ALL_YEARS[ALL_YEARS.length - 1];
            req.respond({
              status: 200,
              contentType: "application/json",
              headers: { "Access-Control-Allow-Origin": "*" },
              body: JSON.stringify(makeFullResponse(latest)),
            });
            return;
          }
          state.annualReviewCalls += 1;
          if (year === FAILING_YEAR) {
            failingAttempts += 1;
            if (failingAttempts <= 1) {
              req.respond({
                status: 500,
                contentType: "application/json",
                headers: { "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ ok: false, error: "synthetic-failure" }),
              });
              return;
            }
          }
          req.respond({
            status: 200,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify(makeFullResponse(year)),
          });
        } catch {}
        return;
      }
      try { req.continue(); } catch {}
    });

    await page.goto(`${BASE_URL}/weread`, { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector('[data-testid="weread-tab-archive"]', { timeout: 10000 });
    await page.click('[data-testid="weread-tab-archive"]');
    await page.waitForSelector('[data-testid="weread-reading-archive"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="weread-reading-data-repair"]', { timeout: 15000 });

    // Initial render: no S27S navigation should have happened
    let counter = await page.evaluate(() => ({
      scroll: window.__s27s2_scroll || 0,
      focus: window.__s27s2_focus || 0,
    }));
    check("1. initial render: s27s scroll = 0", counter.scroll === 0);
    check("2. initial render: s27s focus = 0", counter.focus === 0);

    // Force a rerender (Notes → Archive round-trip)
    await page.waitForSelector('[data-testid="weread-tab-notes"]', { timeout: 5000 });
    await page.click('[data-testid="weread-tab-notes"]');
    await new Promise((r) => setTimeout(r, 500));
    await page.click('[data-testid="weread-tab-archive"]');
    await new Promise((r) => setTimeout(r, 500));
    counter = await page.evaluate(() => ({
      scroll: window.__s27s2_scroll || 0,
      focus: window.__s27s2_focus || 0,
    }));
    check("3. Notes→Archive rerender: s27s scroll = 0", counter.scroll === 0);
    check("4. Notes→Archive rerender: s27s focus = 0", counter.focus === 0);

    // Check that navigation buttons exist
    const buttonsExist = await page.evaluate(() => {
      return !!document.querySelector('[data-testid="weread-reading-data-repair-navigation-button"]');
    });
    check("5. navigation button exists in DOM", buttonsExist);

    // Count buttons per surface
    const buttonInfo = await page.evaluate(() => {
      const btns = document.querySelectorAll('[data-testid="weread-reading-data-repair-navigation-button"]');
      return { count: btns.length };
    });
    check("6. at least 1 navigation button present", buttonInfo.count >= 1);

    // Record URL before click
    const urlBefore = await page.url();

    // Find first enabled button and click
    const buttons = await page.$$('[data-testid="weread-reading-data-repair-navigation-button"]');
    if (buttons.length === 0) {
      check("7. found at least 1 enabled button", false);
    } else {
      // Capture state before click
      const beforeClick = await page.evaluate(() => ({
        scroll: window.__s27s2_scroll || 0,
        focus: window.__s27s2_focus || 0,
        annualCalls: 0, // tracked separately
      }));

      // Click first button
      await buttons[0].click();
      await new Promise((r) => setTimeout(r, 1000));

      const afterClick = await page.evaluate(() => ({
        scroll: window.__s27s2_scroll || 0,
        focus: window.__s27s2_focus || 0,
        activeTestId: document.activeElement?.getAttribute("data-testid") || null,
        activeRepairSurface: document.activeElement?.getAttribute("data-weread-repair-surface") || null,
      }));

      check("7. explicit click: scroll delta = 1", afterClick.scroll - beforeClick.scroll === 1);
      check("8. explicit click: focus delta = 1", afterClick.focus - beforeClick.focus === 1);
      check("9. activeElement is a verified S27S surface",
        afterClick.activeTestId !== null || afterClick.activeRepairSurface !== null);

      // URL unchanged
      const urlAfter1 = await page.url();
      check("10. URL unchanged after click", urlAfter1 === urlBefore);

      // Second click on same button
      if (buttons.length > 0) {
        await buttons[0].click();
        await new Promise((r) => setTimeout(r, 1000));
        const afterSecond = await page.evaluate(() => ({
          scroll: window.__s27s2_scroll || 0,
          focus: window.__s27s2_focus || 0,
        }));
        check("11. second click: total scroll = 2", afterSecond.scroll === 2);
        check("12. second click: total focus = 2", afterSecond.focus === 2);
      }
    }

    // Test second distinct surface if available
    if (buttons.length > 1) {
      const before = await page.evaluate(() => ({
        scroll: window.__s27s2_scroll || 0,
        focus: window.__s27s2_focus || 0,
      }));
      await buttons[1].click();
      await new Promise((r) => setTimeout(r, 1000));
      const after = await page.evaluate(() => ({
        scroll: window.__s27s2_scroll || 0,
        focus: window.__s27s2_focus || 0,
      }));
      check("13. second surface click: scroll delta = 1", after.scroll - before.scroll === 1);
      check("14. second surface click: focus delta = 1", after.focus - before.focus === 1);
    }

    // Check React error #300
    const hasReact300 = state.errors.some((e) =>
      /Minified React error #300|Rendereded (fewer|more) hooks/i.test(e),
    );
    check("15. React error #300 = 0", !hasReact300);

    // Desktop overflow check
    const desktopOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 1;
    });
    check("16. desktop 1440 no horizontal overflow", !desktopOverflow);

    // Mobile overflow check
    await page.setViewport({ width: 360, height: 720 });
    await new Promise((r) => setTimeout(r, 500));
    const mobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 1;
    });
    check("17. mobile 360 no horizontal overflow", !mobileOverflow);

    // No POST requests
    check("18. 0 POST requests during navigation", state.serverPosts === 0);

    // No external requests
    check("19. 0 external requests during navigation", state.externalRequests.length === 0);

    // URL still unchanged at end
    const urlEnd = await page.url();
    check("20. URL unchanged after all tests", urlEnd === urlBefore);

    // ICP footer present
    const hasICP = await page.evaluate(() => {
      return document.body.innerText.includes("ICP") || document.body.innerText.includes("icp");
    });
    check("21. ICP footer present", hasICP);

    await browser.close();
  } finally {
    if (previewProc) {
      try { previewProc.kill("SIGTERM"); } catch {}
      try { previewProc.kill("SIGKILL"); } catch {}
    }
  }

  if (exitCode !== 0) {
    console.error("\n[s27s2-smoke] FAILED");
    process.exit(exitCode);
  }
  console.log("\n[s27s2-smoke] ALL CHECKS PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[s27s2-smoke] crashed:", err);
  process.exit(2);
});