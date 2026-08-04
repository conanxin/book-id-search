# S27L-2 — Reading Archive Markdown Export Release Report

> Status: PASS — browser-local Markdown export for the WeRead Reading
> Archive workspace. Released as `v0.17.1-weread-reading-archive-markdown`.

---

## STATUS: PASS

All release gates passed on the first run; no rollback required.

---

## SCOPE

- **Source**: current in-memory `WereadReadingArchive` only (loaded by
  the existing archive state machine). No additional fetch.
- **Generation**: 100% browser-local. `Blob` + `URL.createObjectURL` +
  synthetic `<a download>` + `setTimeout(0) → URL.revokeObjectURL`.
- **Network**: no extra annual-review calls, no AI summary call, no
  related-books call, no POST/PUT/PATCH/DELETE.
- **Persistence**: nothing written to `localStorage` /
  `sessionStorage` / IndexedDB; nothing POSTed to the server; nothing
  indexed into Meilisearch.

---

## MARKDOWN_RESULT

- **Structure**:
  - `# 长期阅读档案` title + metadata (档案年份 / 当前范围 / Top N /
    请求年份 / 成功加载 / 失败 / 导出时间 / 数据来源 / 生成方式 /
    保存状态).
  - `## 档案总览` (first/latest/active years, totals, longest streak).
  - `## 跨年度趋势` table (年份 / 阅读记录 / 有效日期 / 匹配 / 年度书目
    / 活跃月份 / 最长连续 / 高峰 / 月均).
  - `## 年度档案目录` (one subsection per year).
  - `## 多年进入 Top N 高互动榜的书目` (recurring books from current
    Top N only).
  - `## 相邻年度榜单重合` (adjacent-year overlap table).
  - `## 数据完整性` (success message or partial-failure list).
  - `## 说明` (privacy / scope disclaimers).
- **Partial failure**: when any year is missing, file lists count and
  sorted failed years; once the user retries successfully, the next
  export shows "所有目标年份均已成功加载。" instead of the failure list.
- **Empty archive**: fallback filename `weread-reading-archive-empty-YYYYMMDD.md`,
  body only carries metadata + empty-archive disclaimer; no fabricated
  trends / books / overlaps.
- **Single year**: file contains one year subsection; recurring books
  and adjacent-year overlap empty with a one-line explanation.
- **Filename / MIME**:
  - Pattern: `weread-reading-archive-<first>-to-<latest>-YYYYMMDD.md`
    (ASCII only, ≤ 80 chars, no book titles / catalogId / tokens).
  - MIME: `text/markdown;charset=utf-8`.
- **Browser download**: 43 / 43 checks pass.

---

## STATE_MACHINE_REGRESSION

- `retry` before = **1** (failing-year first attempt).
- `retry` after = **2** (single manual retry adds exactly one request).
- `delta` = **1**.
- `stability wait` (3.5 s) = **2** (no auto-retry storm).
- `tab round-trip` delta = **0** (cache hit on tab switch).
- `range / Top N` cache respected — switching range or Top N does not
  re-fetch already-loaded keys.
- **Original archive smoke (S27L)**: 38 / 38 + bonus = PASS, network
  counters identical to pre-S27L-2 baseline.

---

## PRIVACY_RESULT

- **Included** (safe public fields only):
  - archive metadata (年份范围 / Top N / 范围 / 加载计数 / 失败计数 /
    导出时间 / 来源声明 / 隐私 + 口径 + 完整性 disclaimer).
  - year-level totals from `overview` (records / active months / streak
    / peak month).
  - `topBooks` catalogId + title + author + counts (these are already
    surfaced on the dashboard).
  - cross-year aggregation (recurring books, adjacent-year overlap).
- **Excluded** (deliberately stripped before writing the file):
  - `note.text`, `note.comment`, `markedText`.
  - `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`.
  - AI summary body (`summary.overview`, `summary.keyPoints`,
    `summary.reviewQuestions`, `summary.themes`).
  - private-API token / `wr_skey` / `wr_vid` / cookie / session.
  - cache / request / debug counters.
- **Network**: zero new requests on export (intercepted).
- **Persistence**: zero writes (no `localStorage` / `sessionStorage` /
  IndexedDB / server POST).
- **Committed artefacts**: only source files + smoke script + formal
  report + README + docs.

---

## REGRESSION_RESULT

| Gate | Result |
|------|--------|
| `vitest run` | **1564 / 1564 PASS** (58 files) |
| `tsc -p apps/web` | **PASS** (no errors) |
| `vite build` | **PASS** (88.21 kB CSS / 503.84 kB JS) |
| `verify.ts` (docs count) | **5,115,734** ✓ |
| `search-quality-regression` | **17 / 0 / 0** (PASS / WARN / FAIL) |
| S27L original smoke | **38 / 38 + bonus PASS** |
| S27L-2 download smoke | **43 / 43 PASS** |

---

## DEPLOY_RESULT

- **web**: rebuilt (`docker compose up -d --no-deps --build web`),
  fresh container (1 s uptime on closeout), serves
  `https://books.conanxin.com/weread` with S27L-2 code.
- **api**: untouched (34 h uptime preserved).
- **Meilisearch**: untouched (4 weeks uptime preserved).
- **Caddy / DNS / nginx / ICP compliance**: untouched.
- **api health**: `GET /api/health` → 200.
- **api stats**: `GET /api/stats` → `numberOfDocuments: 5,115,734`
  (matches `verify.ts` output).

---

## LIMITATIONS

- Hard cap of **20 years** (`WEREAD_READING_ARCHIVE_MAX_YEARS`).
- Recurring books and adjacent-year overlap only consider the
  **current Top N** (6 / 12 / 18), not the full yearly catalog.
- No exact cross-year unique-book count (only overlap ratios).
- No topic / psychological interpretation (deliberately excluded).
- No PDF / images / public sharing inside the Markdown file.
- The exported file is **not automatically updated**; user must
  re-export to refresh.

---

## NEXT_STEP

- **S27M — Reading Era Segmentation** (next milestone): segment the
  archive into reading eras using year-over-year volume and Top N
  overlap deltas; remains browser-local.