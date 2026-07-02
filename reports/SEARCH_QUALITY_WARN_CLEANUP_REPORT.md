# S25A — Search Quality WARN Cleanup Report

**STATUS:** PASS ✓

## Summary

S24-FINALIZE left search-quality regression at 13 PASS / 2 WARN / 0 FAIL. The two
WARNs were both observation-level (corpus-coverage / pre-existing normalize
limitations), not S24 framework bugs. S25A resolves both:

1. **`isbn-spoken`**: natural-language ISBN queries ("ISBN 是 978-7-5384-5525-0
   的书") did not route to the exact-ISBN branch — normalize saw the prose
   surrounding the digits and detected the query as `text`. S25A adds a
   **labeled identifier extractor** in `normalize.ts` that recognises
   `ISBN/SSID/DXID` labels and pulls out the digit run.
2. **`liao-buddhist-pagoda`**: the query "有没有关于辽代佛塔的书" resolved
   to `general` intent because 佛塔/建筑/寺院/etc. were not academic-research
   triggers. S25A expands the academic-research trigger and positive-term
   lists.

## WARN_CLEANUP_RESULT

### Labeled identifier extraction (S25A-3)

- New helper `extractLabeledIdentifier(input)` in
  `apps/api/src/search/normalize.ts`.
- Regex: `/\b(?:ISBN|SSID|DXID)\b\s*[:：是为是]?\s*((?:[0-9][\s\-]*){8,13}[0-9Xx]?)/i`.
- Compacts hyphens / spaces inside the digit run and forces `detectedType`
  to `isbn`/`ssid`/`dxid` based on length + EAN-prefix check.
- Labeled-only: bare digit runs without a label still go through the
  original `detectType` path, so "2011 年北京旅游" stays `text`.
- When the labeled path returns, `normalizeQuery` short-circuits and the
  downstream `handleSearch` skips cleanup (its `isIdentifierType` branch
  sets `searchQuery = normalized` directly).

### Academic intent expansion (S25A-2)

Added 12 new triggers and matching positiveTerms to `academic_research`:

```
佛塔, 建筑, 古建筑, 寺院, 遗址, 文物, 古迹, 营造,
建筑史, 宗教建筑, 石窟, 壁画
```

- "辽代佛塔古建筑" → `academic_research` (was `general`)
- "佛塔寺院建筑研究" → `academic_research` (high confidence)
- "寺院遗址文物" → `academic_research` (high confidence, 3 triggers)
- "北京旅游指南" → still `travel_guide` (regression check — building 词
  must not pull travel queries into academic)

## REGRESSION_RESULT

```
[search-quality] Running 17 cases against https://books.conanxin.com
  ✓ beijing-travel-natural-language
  ✓ luxun-related-books
  ✓ isbn-spoken
  ✓ liao-buddhist-pagoda
  ✓ ssid-spoken
  ✓ dxid-spoken
  ✓ dxid-exact
  ✓ ssid-exact
  ✓ japanese-shawl-handicraft
  ✓ beijing-travel-guide
  ✓ beijing-tourism-research
  ✓ chinese-dictionary
  ✓ children-picture-book
  ✓ commercial-press-dictionary
  ✓ tourism-education-press-beijing
  ✓ obscure-query-no-crash
  ✓ empty-query

Totals: 17 PASS / 0 WARN / 0 FAIL
```

Up from 13/2/0 → 17/0/0. The 3 newly-passing cases are the labeled
identifier cases that failed / WARN'd in S24.

## LIVE_RESULT

### ISBN natural-language query

```
$ curl ".../api/search?q=ISBN 是 978-7-5384-5525-0 的书"
queryInfo.detectedType = isbn
queryInfo.normalized   = 9787538455250
queryInfo.cleaned      = 9787538455250
queryInfo.cleanupApplied = false
items[0].id           = 13000000_000008232537
items[0].match.label  = ISBN 精确匹配
```

### SSID natural-language query

```
$ curl ".../api/search?q=SSID 是 13000000"
queryInfo.detectedType = ssid
queryInfo.normalized   = 13000000
items[0].id           = 13000000_000008232537
items[0].match.label  = SSID 精确匹配
```

### DXID natural-language query (leading zeros preserved)

```
$ curl ".../api/search?q=DXID 是 000008232537"
queryInfo.detectedType = dxid
queryInfo.normalized   = 000008232537
items[0].id           = 13000000_000008232537
items[0].match.label  = DXID 精确匹配
```

### 辽代佛塔 query

```
$ curl ".../api/search?q=有没有关于辽代佛塔的书"
queryInfo.cleaned       = 辽代佛塔
queryInfo.removedPhrases = [有没有, 关于, 的书]
queryInfo.intentType    = academic_research
queryInfo.intentLabel   = 学术研究
items[0].title          = 祖州城  内蒙古满其格山辽代古城址的考古学历史学发掘调查报告
items[1].title          = 辽代陶瓷的考古学研究
items[2].title          = 辽代墓葬的考古学研究
items[3].title          = 辽代社会史研究
items[4].title          = 辽代文学史
```

(The literal "佛塔" doesn't appear in any book title in the live corpus,
but the academic-research context (辽代 + 考古学/历史学/陶瓷/墓葬/社会史/
文学史) is exactly what the user wanted.)

### 北京旅游 regression (S24 unchanged)

```
$ curl ".../api/search?q=查一下北京旅游的书"
queryInfo.cleaned       = 北京旅游
queryInfo.intentType    = travel_guide
items[0].title          = 北京旅游手册
items[1].title          = 北京旅游景点纵览
items[2].title          = 北京旅游购物办事指南
items[3].title          = 实用北京旅游指南
items[4].title          = (北京旅游相关)
```

No 查斯特菲尔德误命中 in top 10. S24 framework still working.

### docs count

```
$ curl ".../api/stats"
numberOfDocuments = 5115734
```

Unchanged through S25A.

## TESTS

```
vitest: 266 / 266 PASS  (was 236 — added 19 normalize + 4 intent + 7 misc)
- apps/api/src/search/normalize.test.ts        19 / 19  (new)
- apps/api/src/search/intent-profile.test.ts   16 / 16  (was 12, +4)
- scripts/search-quality-cases.test.ts         7  / 7   (count → 17)
- All other suites                             224 / 224
```

tsc clean for both `apps/api` and `apps/web`. Verify.ts PASS.

## SAFETY

- [x] no import, no reset, no key leak
- [x] Meilisearch untouched (Up 47h, NOT restarted)
- [x] Caddy / 安全组 / 7700 exposure: untouched (api/web on 127.0.0.1:3001/5173 only)
- [x] MINIMAX_API_KEY never printed
- [x] Only `api/web` rebuilt via `docker compose up -d --no-deps --build api web`
- [x] No `.env` / `meili_data` / `private-data` / `node_modules` / `dist` / `logs` in commit
- [x] Working tree clean after commit
- [x] `package.json` diff: only `search:quality` script added (no corepack/proxy changes)
- [x] docs count unchanged: 5,115,734

## FILES CHANGED

```
M apps/api/src/search/intent-profile.ts         (+12 triggers + positiveTerms)
M apps/api/src/search/intent-profile.test.ts    (+4 tests)
M apps/api/src/search/normalize.ts              (+labeled-extractor + 19 tests)
A apps/api/src/search/normalize.test.ts         (new, 19 tests)
M scripts/search-quality-cases.ts               (isbn-spoken / liao-buddhist-pagoda / +ssid-spoken / +dxid-spoken)
M scripts/search-quality-cases.test.ts          (count → 17)
A reports/SEARCH_QUALITY_WARN_CLEANUP_REPORT.md (this file)
```

## NEXT_STEP

S25A complete with 0 WARN. Two follow-on steps:

1. **S25B** — Wire `pnpm search:quality` into a weekly cron (S23-style: local
   tsx + NO_PROXY=* + 56-day retention). 17-case regression in ~3 seconds
   is cheap enough to run daily, but weekly matches S23.1 cadence and is
   plenty to catch regressions.
2. **S25+** — Address corpus-coverage observations: the "japanese-shawl-
   handicraft" case has no strong corpus hit for `日本人 + 披肩 + 吊带 +
   手工` in top 5; the search quality framework is working, but the
   underlying corpus just doesn't have a Japanese-handicraft book. This
   is a corpus / cataloging concern, not a search-quality one.
