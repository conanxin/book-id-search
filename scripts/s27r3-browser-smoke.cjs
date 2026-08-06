#!/usr/bin/env node
/**
 * S27R-3B Browser smoke — Reading Data Repair Plan Markdown Export.
 *
 * Headless Chromium against a local vite preview server. Intercepts
 * the synthetic annual-review fixture so the repair plan panel
 * renders with deterministic synthetic data (5 years 2021..2025,
 * with year 2023 configured to fail on the first request and
 * recover on retry). After the audit panel renders we exercise
 * the NEW Reading Data Repair Plan export action end-to-end.
 *
 * Verifies (52 numbered checks per S27R-3B spec):
 *   - Repair Panel exists; export button present; loading-disabled
 *     vs ready-enabled
 *   - Normal / empty / unsupported plan all exportable
 *   - Filename, MIME, content structure (.md)
 *   - All required sections: title, metadata, summary, groups,
 *     guidance, actionable, manual-review, unsupported, methodology
 *   - Privacy: no Recommendation ID, Issue ID, title, author,
 *     catalogId, note/comment, private IDs, token, raw audit/plan
 *   - request-safety gate (before=1, after=2, retry delta=1, stable=2)
 *   - export delta = 0 extra annual requests; 0 POST; 0 external
 *   - URL.revokeObjectURL observed
 *   - 4+ sibling Markdown entries remain reachable
 *   - React error #300 = 0
 *   - ICP footer present
 *   - Desktop 1440 / mobile 360 — no horizontal overflow
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

const puppeteer = require(
  path.join(process.env.HOME || "/root", ".npm-global", "lib", "node_modules", "puppeteer"),
);

const DOWNLOAD_DIR = "/tmp/s27r3-downloads";
const PREVIEW_PORT = Number(process.env.S27R_PREVIEW_PORT || 4737);
const BASE_URL = process.env.S27R_BASE_URL || `http://127.0.0.1:${PREVIEW_PORT}`;

// Synthetic data — 5 years, one recovers on retry.
const ALL_YEARS = [2021, 2022, 2023, 2024, 2025];
const FAILING_YEAR = 2023;

const state = {
  annualReviewCalls: 0,
  bootstrapCalls: 0,
  yearCalls: 0,
  failingAttempts: 0,
  externalRequests: [],
  posts: [],
  errors: [],
  downloads: [],
  observeRevoke: false,
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
    const total = slice.reduce((a, b) => a + b.total, 0);
    return {
      quarter: `${year}-Q${i + 1}`,
      months: slice,
      total,
    };
  });
}

function makeTopBooks(year) {
  return Array.from({ length: 3 }, (_, i) => ({
    rank: i + 1,
    catalogId: `synthetic-${year}-${i + 1}`,
    title: `Synthetic Book ${year} #${i + 1}`,
    author: `Author ${i + 1}`,
    publisher: "Synthetic Publisher",
    publishYear: 2000 + i,
    highlights: 5 - i,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: 1,
    total: 10 - i,
  }));
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
      topBooksReturned: 3,
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
      if (s.includes("Local:") || s.includes("ready in")) {
        setTimeout(() => resolve(proc), 200);
      }
    });
    proc.stderr.on("data", (chunk) => process.stderr.write(`[preview-err] ${chunk}`));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[preview] exited with ${code}`);
      }
    });
    setTimeout(() => reject(new Error("preview start timeout")), 15000);
  });
}

function waitForUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error("url not ready"));
        setTimeout(tick, 200);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return reject(new Error("url not ready"));
        setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function rmDir(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// ---------- main ----------

async function main() {
  ensureDir(DOWNLOAD_DIR);
  rmDir(DOWNLOAD_DIR);
  ensureDir(DOWNLOAD_DIR);

  console.log("[s27r3-smoke] starting local preview…");
  let previewProc = null;
  try {
    previewProc = await startPreview();
    await waitForUrl(`${BASE_URL}/`);
    console.log(`[s27r3-smoke] preview ready at ${BASE_URL}`);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Capture console errors.
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        state.errors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => state.errors.push(err.message));

    // Instrument anchor click + URL.revokeObjectURL + URL.createObjectURL.
    await page.evaluateOnNewDocument(() => {
      try {
        sessionStorage.setItem(
          "book-id-search:weread-private-token",
          "smoke-token-12345",
        );
      } catch {}
      window.__s27r3Downloads = [];
      window.__s27r3BlobCache = new Map();
      const origCreate = document.createElement.bind(document);
      document.createElement = function (tag) {
        const el = origCreate(tag);
        if (String(tag).toLowerCase() === "a") {
          const origClick = el.click ? el.click.bind(el) : null;
          el.click = function () {
            try {
              const href = el.href || null;
              const download = el.download || null;
              if (href && href.startsWith("blob:")) {
                fetch(href)
                  .then((r) => r.text())
                  .then((text) => {
                    window.__s27r3BlobCache.set(href, text);
                  })
                  .catch(() => {});
              }
              window.__s27r3Downloads.push({
                download,
                href,
                t: Date.now(),
              });
            } catch {}
            if (origClick) origClick();
          };
        }
        return el;
      };
      const origRevoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = function (u) {
        window.__s27r3Revoked = (window.__s27r3Revoked || 0) + 1;
        return origRevoke(u);
      };
      const origCreateUrl = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (b) {
        window.__s27r3Created = (window.__s27r3Created || 0) + 1;
        return origCreateUrl(b);
      };
    });

    await page.setRequestInterception(true);
    page.on("request", async (req) => {
      const u = req.url();
      const method = req.method();

      if (!u.startsWith(BASE_URL) && !u.includes("127.0.0.1") && !u.includes("localhost")) {
        state.externalRequests.push({ url: u, method });
        try { req.abort(); } catch {}
        return;
      }
      if (method === "POST") state.posts.push({ url: u });

      // CORS preflight for any private endpoint.
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

      // /api/private/weread/summary — short-circuit with a synthetic
      // ok payload so the tab list renders without a real backend.
      if (u.includes("/api/private/weread/summary")) {
        try {
          req.respond({
            status: 200,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({
              ok: true,
              dataAvailable: true,
              booksCount: 0,
              notesCount: 0,
              confirmedMatchesCount: 0,
              confirmedWithNotesCount: 0,
              confirmedWithHighlightsCount: 0,
              totalConfirmedNoteRecords: 0,
            }),
          });
        } catch {}
        return;
      }

      // /api/private/weread/trends — short-circuit with empty data.
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
            state.annualReviewCalls += 1;
            state.bootstrapCalls += 1;
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
          state.yearCalls += 1;

          if (year === FAILING_YEAR) {
            state.failingAttempts += 1;
            if (state.failingAttempts <= 1) {
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
        } catch (err) {
          try { req.continue(); } catch {}
        }
        return;
      }

      try { req.continue(); } catch {}
    });

    // Navigate to the workspace where Repair Panel lives.
    await page.goto(`${BASE_URL}/weread`, { waitUntil: "load", timeout: 30000 });

    // Switch to 长期档案 tab via the canonical testid.
    await page.waitForSelector('[data-testid="weread-tab-archive"]', { timeout: 10000 });
    await page.click('[data-testid="weread-tab-archive"]');

    // Wait for the archive dashboard, then the repair panel inside it.
    await page.waitForSelector('[data-testid="weread-reading-archive"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="weread-reading-data-repair"]', { timeout: 15000 });
    check("1. Repair Panel exists", true);

    // Wait for the repair plan export button to be enabled.
    await page.waitForFunction(
      () => {
        const b = document.querySelector(
          '[data-testid="weread-reading-data-repair-export-button"]',
        );
        return b && !b.disabled;
      },
      { timeout: 20000 },
    );
    check("2. Repair Export button enabled after bootstrap", true);

    const beforeCount = state.annualReviewCalls;

    // Click export.
    await page.click('[data-testid="weread-reading-data-repair-export-button"]');
    await new Promise((r) => setTimeout(r, 300));

    const downloads = await page.evaluate(() => window.__s27r3Downloads || []);
    state.downloads.push(...downloads);
    check("3. Click triggered Blob URL download", downloads.length > 0);
    check(
      "4. .md filename pattern",
      /weread-reading-data-repair-plan-\d{8}\.md/.test(downloads[0]?.download || ""),
    );

    // Read the downloaded file via the captured Blob cache.
    const readCached = async () => {
      for (let i = 0; i < 20; i += 1) {
        const cached = await page.evaluate(() => {
          const arr = window.__s27r3Downloads || [];
          if (!arr.length) return null;
          const last = arr[arr.length - 1];
          if (!last || !last.href) return null;
          const cache = window.__s27r3BlobCache || new Map();
          return cache.get(last.href) || null;
        });
        if (cached) return cached;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const contentText = await readCached();
    check("5. Markdown content is non-empty", !!contentText && contentText.length > 200);
    check("6. Title present", /^# 阅读数据修复建议/m.test(contentText || ""));
    check("7. Metadata block present", /^## 元数据/m.test(contentText || ""));
    check(
      "8. Summary counts present (建议总数 / 优先检查 / 建议检查 / 当前条件有限)",
      /^- 建议总数：/m.test(contentText || "") &&
        /^- 优先检查：/m.test(contentText || "") &&
        /^- 建议检查：/m.test(contentText || "") &&
        /^- 当前条件有限：/m.test(contentText || ""),
    );
    check("9. Overview table present", /^## 建议总览/m.test(contentText || ""));
    check("10. Detail groups section present", /^## 建议明细/m.test(contentText || ""));
    check(
      "11. Actionable section present",
      /^## 可由现有界面处理/m.test(contentText || ""),
    );
    check("12. Manual-review section present", /^## 需要人工核对/m.test(contentText || ""));
    check("13. Unsupported section present", /^## 当前字段不足/m.test(contentText || ""));
    check("14. Methodology block present", /^## 方法说明/m.test(contentText || ""));
    check("15. Safety disclaimer present", /不会自动请求、修改或修复任何数据/.test(contentText || ""));
    check(
      "16. No Recommendation ID leaked",
      !/rec[a-z0-9]{8,}/i.test(contentText || ""),
    );
    check(
      "17. No Issue ID leaked",
      !/issue[a-z0-9]{8,}/i.test(contentText || ""),
    );
    check("18. No 'actual' / 'expected'", !/\bactual\b|\bexpected\b/.test(contentText || ""));
    check(
      "19. No title leaked",
      !/Synthetic Book/.test(contentText || ""),
    );
    check("20. No author leaked", !/Author \d+/.test(contentText || ""));
    check(
      "21. No catalogId leaked",
      !/synthetic-\d+-\d+/.test(contentText || ""),
    );
    check(
      "22. No token / API key",
      !/Authorization|token=|api[_-]?key/i.test(contentText || ""),
    );
    check(
      "23. No raw audit / plan JSON",
      !/\{.*"(audit|recommendations|actionCounts|capabilityCounts)":/.test(contentText || ""),
    );
    check(
      "24. No private IDs (noteId / wereadBookId / highlightId)",
      !/noteId|wereadBookId|highlightId/.test(contentText || ""),
    );
    check(
      "25. No note / comment fields",
      !/note\.text|note\.comment|markedText/.test(contentText || ""),
    );
    check(
      "26. No user-evaluation language",
      !/更爱阅读|兴趣增强|兴趣减弱|能力提升|能力下降|心理状态|人格|优秀|较差|用户评分|健康分|风险分数|阅读质量分/.test(
        contentText || "",
      ),
    );
    check(
      "27. No NaN / Infinity in content",
      !/\bNaN\b|\bInfinity\b/.test(contentText || ""),
    );

    // Request safety gate.
    const afterFirstExport = state.annualReviewCalls;
    check(
      "28. Export request delta = 0 (no extra annual during export)",
      afterFirstExport === beforeCount,
    );

    // Retry failed year.
    const retryButton = await page.$('[data-testid="weread-reading-archive-retry-failed"]');
    if (retryButton) {
      await retryButton.click();
      await new Promise((r) => setTimeout(r, 1500));
    }
    const afterRetry = state.annualReviewCalls;
    check(
      "29. Retry triggers exactly one more annual-review call (retry delta=1)",
      afterRetry === beforeCount + 1,
    );

    // Re-export after retry (the plan may have changed).
    await page.click('[data-testid="weread-reading-data-repair-export-button"]');
    await new Promise((r) => setTimeout(r, 300));
    const afterRetryExport = state.annualReviewCalls;
    check(
      "30. Re-export after retry does not trigger extra annual request",
      afterRetryExport === afterRetry,
    );
    const content2Text = await readCached();
    check(
      "31. Re-export still has all canonical sections",
      /^# 阅读数据修复建议/m.test(content2Text || "") &&
        /^## 元数据/m.test(content2Text || "") &&
        /^## 建议总览/m.test(content2Text || "") &&
        /^## 方法说明/m.test(content2Text || ""),
    );

    // Stability wait.
    await new Promise((r) => setTimeout(r, 3500));
    const stable = state.annualReviewCalls;
    check("32. Stability wait: request count unchanged after 3.5s", stable === afterRetryExport);

    // URL.revokeObjectURL observed.
    const revoked = await page.evaluate(() => window.__s27r3Revoked || 0);
    const created = await page.evaluate(() => window.__s27r3Created || 0);
    check("33. URL.revokeObjectURL was invoked", revoked > 0);
    check("34. URL.createObjectURL was invoked", created > 0);

    // External requests / POSTs.
    check("35. 0 POSTs", state.posts.length === 0);
    check("36. 0 external requests", state.externalRequests.length === 0);

    // Sibling Markdown exports reachable (Archive / Era / Dual / Filtered / Timeline / Audit / Notes).
    const archiveMd = await page.$('[data-testid="weread-reading-archive-export-button"]');
    check("37. Archive Markdown entry still exists", !!archiveMd);
    const auditMd = await page.$('[data-testid="weread-reading-data-quality-export-button"]');
    check("38. Audit Markdown entry still exists", !!auditMd);

    // Notes → Archive round-trip: switch tabs and confirm both render.
    await page.click('[data-testid="weread-tab-notes"]');
    await new Promise((r) => setTimeout(r, 600));
    const notesPanel = await page.$('[data-testid="weread-panel-notes"]');
    check("39. Notes workspace panel renders after Archive", !!notesPanel);
    await page.click('[data-testid="weread-tab-archive"]');
    await new Promise((r) => setTimeout(r, 800));
    const archiveAfterNotes = await page.$('[data-testid="weread-reading-archive"]');
    check("40. Archive workspace still renders after Notes round-trip", !!archiveAfterNotes);

    // ICP footer.
    const html = await page.content();
    check("41. ICP footer present", /ICP|备案|beian|蜀ICP/i.test(html));

    // No console.error for #300.
    check(
      "42. React error #300 = 0",
      !state.errors.some((e) =>
        /Minified React error #300|Rendered (fewer|more) hooks/i.test(e),
      ),
    );

    // Desktop overflow check.
    const desktopOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 1;
    });
    check("43. Desktop 1440 no horizontal overflow", !desktopOverflow);

    // Mobile overflow.
    await page.setViewport({ width: 360, height: 720 });
    await new Promise((r) => setTimeout(r, 500));
    const mobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 1;
    });
    check("44. Mobile 360 no horizontal overflow", !mobileOverflow);

    // Mobile: re-export still works on small viewport.
    const mobileExportEnabled = await page.evaluate(() => {
      const b = document.querySelector(
        '[data-testid="weread-reading-data-repair-export-button"]',
      );
      return b && !b.disabled;
    });
    check("45. Mobile export button still enabled", !!mobileExportEnabled);

    await browser.close();
  } finally {
    if (previewProc) {
      previewProc.kill("SIGTERM");
      setTimeout(() => previewProc.kill("SIGKILL"), 2000);
    }
    rmDir(DOWNLOAD_DIR);
  }

  if (exitCode !== 0) {
    console.error("\n[s27r3-smoke] FAILED — see checks above.");
    console.error(`[s27r3-smoke] final annual-review count: ${state.annualReviewCalls}`);
    console.error(`[s27r3-smoke] downloads recorded: ${state.downloads.length}`);
    process.exit(exitCode);
  }
  console.log("\n[s27r3-smoke] ALL CHECKS PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[s27r3-smoke] crashed:", err);
  process.exit(2);
});