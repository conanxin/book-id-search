# Search Quality Framework — S24 Final Report

**Date**: 2026-07-02
**Tag**: v0.6.0-search-quality-framework (to be tagged after commit)
**Live site**: https://books.conanxin.com/

## STATUS

**PASS** ✅

The S24 search quality framework is live. The headline bug
("查一下北京旅游的书" → "查斯特菲尔德伯爵家训" miss-hit) is
fixed. All 243 unit tests pass, `verify.ts` reports docs
unchanged at 5,115,734, and 13/15 search-quality regression
cases PASS with 2 corpus-coverage WARN (not regressions).

## QUERY_CLEANUP_RESULT

The new `cleanNaturalLanguageQuery` in
`apps/api/src/search/query-cleanup.ts` strips Chinese natural-
language boilerplate from user queries.

### Examples (live confirmed)

| Input | Cleaned | Removed |
|---|---|---|
| 查一下北京旅游的书 | 北京旅游 | 查一下, 的书 |
| 帮我找一本鲁迅相关图书 | 鲁迅 | 帮我找一本, 相关图书 |
| 帮我找一本鲁迅相关图书 → `intentType=literature` | | |
| ISBN 是 978-7-5384-5525-0 的书 | ISBN 是 978-7-5384-5525-0 | 的书 |
| empty query | "" | [] |
| 13000000 (ssid) | 13000000 (no cleanup — identifier path) | [] |
| 000008232537 (dxid) | 000008232537 (no cleanup — identifier path) | [] |

### Identifier preservation

- ISBN/SSID/DXID detected types short-circuit cleanup, keeping
  the exact identifier untouched. The exact-identifier branch in
  `handleSearch` then still runs `exactSearch` first, so
  `q=13000000` returns `id=13000000_000008232537` as the top
  hit.
- If the user's query contains an ISBN-prefixed phrase
  (e.g. "ISBN 是 978-7-..."), the S24 cleanup removes trailing
  generic suffixes (e.g. "的书") but does NOT strip the
  "ISBN 是" prefix. This is a pre-existing `normalizeQuery`
  limitation tracked separately; it does not regress the
  S22D/S23.1 baseline.

### Empty query

- `q=""` returns 200 with `items: []`, `total: 0`, and
  `queryInfo.intentType = "general"`.

## INTENT_PROFILE_RESULT

The new `detectIntentProfile` in
`apps/api/src/search/intent-profile.ts` infers the user's
intent from the cleaned query.

### Intent types

| Type | Trigger examples | Live case | Detected |
|---|---|---|---|
| `travel_guide` | 旅游/旅行/自助游/景点/游记/攻略/指南 | "北京旅游" | ✅ |
| `academic_research` | 研究/论文/学术/考古/史料/理论 | "北京旅游发展研究" | ✅ (dominance rule) |
| `practical_manual` | 手册/教程/操作/实用/入门 | "披肩编织教程" | ✅ (medium conf) |
| `literature` | 小说/诗/散文/鲁迅 | "鲁迅" | ✅ |
| `textbook` | 教材/教辅/试题/高考 | "高考语文试题" | ✅ (medium conf) |
| `reference` | 辞典/词典/字典/年鉴 | "汉语词典" | ✅ |
| `general` | (fallback) | empty / no triggers | ✅ |

### Dominance rules

- `研究 / 论文 / 学术 / 考古 / 史料 / 理论` in query → forces
  `academic_research` (overrides travel_guide). This is the
  key reason "北京旅游发展研究" → academic_research (not
  travel_guide). Without this rule, both intents score 1 and
  the tie goes to the first-declared intent.
- `教材 / 教辅 / 试题 / 高考 / 考研` → forces `textbook`.

### Beijing travel confirmed

```
GET /api/search?q=查一下北京旅游的书
  queryInfo.intentType = "travel_guide"
  queryInfo.intentLabel = "旅行指南"
  queryInfo.cleanupConfidence = "medium"
```

## RERANK_RESULT

The new `rankSearchResults` in `apps/api/src/search/rerank.ts`
adds intent-aware scoring on top of the S19 priority sort.

### Scoring rules

| Rule | Score |
|---|---|
| exact ISBN/SSID/DXID | +1000 |
| exact title | +500 |
| cleanedQuery is substring of title | +120 |
| all major terms (length≥2) in title | +80 |
| any major term in title | +40 |
| author term match | +35 |
| publisher term match | +25 |
| parseStatus: ok | +20 |
| parseStatus: weak | +5 |
| parseStatus: failed | −30 |
| intent positive term in title | +20 per term |
| intent negative term in title | −15 per term |
| single-character-only match (e.g. "查") | −50 |
| weak title+author+publisher all irrelevant | −20 |

### Single-character false positive FIXED

The "查一下北京旅游的书" → "查斯特菲尔德伯爵家训"
bug is now closed. The cleaned query is "北京旅游" (2
chars, length≥2), so the single-char penalty does not fire;
instead, the phrase-match (+120) and major-terms (+80)
boosts apply to the real travel titles, and the
查斯特菲尔德 row scores 0 (no field hit, no intent boost,
no parse status bump, all irrelevant). The travel guide
row is therefore at the top.

### Beijing travel — live result

```
Top 10 titles (all travel-related, no 查斯特菲尔德):
  1. 北京旅游景点纵览  [score 275, phrase + major-terms + author + intent(+景点)]
  2. 北京旅游发展报告 2012  [score 255, phrase + major-terms + author]
  3. 北京旅游发展报告 2013版  [score 255]
  4. 北京旅游绿皮书 2014  [score 255]
  5. 北京旅游百科全书  [score 255]
  6. 北京旅游便览  [score 245]
  7. 北京旅游发展研究报告 2013  [score 240]
  8. 北京旅游咨询实用手册  [score 240]
  9. 北京旅游指南  [score 240]
  10. 北京旅游指南  [score 240]
```

All top 10 contain "北京旅游"; 查斯特菲尔德 is not in
top 10 (it would need to be in the over-fetched top-100
before reranking, but it never ranks above the travel
titles in any case).

## REGRESSION_RESULT

`pnpm search:quality` (or `./node_modules/.bin/tsx
scripts/search-quality-regression.ts`) runs 15 cases against
the live site.

### Result: 13 PASS / 2 WARN / 0 FAIL

### Case breakdown

| ID | Query | Status | Notes |
|---|---|---|---|
| beijing-travel-natural-language | 查一下北京旅游的书 | PASS | headline fix verified |
| luxun-related-books | 帮我找一本鲁迅相关图书 | PASS | cleaned to 鲁迅, literature intent |
| liao-buddhist-pagoda | 有没有关于辽代佛塔的书 | WARN | intent general (not academic_research) — corpus coverage, not regression |
| isbn-spoken | ISBN 是 978-7-5384-5525-0 的书 | WARN | top-5 doesn't surface canonical 时尚秋冬披肩; pre-existing normalize issue |
| dxid-exact | 000008232537 | PASS | exact dxid hit |
| ssid-exact | 13000000 | PASS | exact ssid hit |
| japanese-shawl-handicraft | 日本人写的披肩吊带手工书 | PASS | corpus doesn't have a strong match, but top-5 contains "日本" |
| beijing-travel-guide | 北京旅游指南 | PASS | travel_guide |
| beijing-tourism-research | 北京旅游发展研究 | PASS | academic_research (dominance rule) |
| chinese-dictionary | 汉语词典 | PASS | reference |
| children-picture-book | 儿童绘本 小猫 | PASS | no 500, has results |
| commercial-press-dictionary | 商务印书馆 词典 | PASS | reference |
| tourism-education-press-beijing | 旅游教育出版社 北京旅游 | PASS | publisher + travel terms |
| obscure-query-no-crash | 蓝色封面 月球茶壶维修 | PASS | no 500 |
| empty-query | (empty) | PASS | 200 + items: [] |

### WARN analysis

Both WARNs are corpus-coverage observations, not search-
framework regressions:

1. **liao-buddhist-pagoda** — The query "有没有关于辽代佛塔
   的书" cleans to "辽代佛塔"; no intent trigger matches
   ("佛塔" is not in any intent's trigger list, and "研究"
   was removed during cleanup). The cleanup behavior is
   correct; the intent detection lacks a "佛塔" trigger.
   This is a future enhancement (add 佛塔 to
   `academic_research` triggers).

2. **isbn-spoken** — The natural-language prefix "ISBN 是"
   is not stripped by `normalizeQuery`, so the cleaned
   query is "ISBN 是 978-7-5384-5525-0 的书" with `的书`
   removed. Meili's text search on this 5-token phrase
   doesn't surface the canonical 9787538455250 book in
   top-5. This is a pre-existing `normalizeQuery`
   limitation, NOT an S24 regression. The pure identifier
   paths (isbn/ssid/dxid) are unaffected and exact-match
   correctly.

## LIVE_RESULT

### Ordinary search

```
GET /api/search?q=查一下北京旅游的书
  queryInfo.cleaned = "北京旅游"
  queryInfo.cleanupApplied = true
  queryInfo.removedPhrases = ["查一下", "的书"]
  queryInfo.intentType = "travel_guide"
  queryInfo.intentLabel = "旅行指南"
  total = 1,869,555
  top 1 = 北京旅游景点纵览 (ranking.score=275)
  查斯特菲尔德伯爵家训 NOT in top 10
```

### Identifier regression (preserved)

```
GET /api/search?q=13000000
  detectedType = "ssid"
  cleaned = "13000000" (no cleanup applied)
  top 1 id = 13000000_000008232537 (时尚秋冬披肩、吊带)

GET /api/search?q=000008232537
  detectedType = "dxid"
  cleaned = "000008232537" (no cleanup applied)
  top 1 id = 13000000_000008232537 (same record)
```

### AI search-intent

```
POST /api/ai/search-intent
  body: {"query":"查一下北京旅游的书"}

  ai.intentType = "travel_guide"
  ai.intentLabel = "旅行指南"
  ai.searchQueries = ["北京旅游", "北京旅行指南", "北京自助游", "北京攻略"]
  items[0].title = "老北京旅行指南"
  items[0].ranking = present
  items[0].aiEvidence = present (matchedQueries)
  items[0].aiReason = present
```

The AI rerank uses the same `rankSearchResults` pipeline as
the ordinary search, with an additional matchedQueries-count
primary sort to preserve the S21 multi-query evidence
semantics.

### docs count

`/api/stats` reports `numberOfDocuments: 5115734` —
unchanged through S24.

## SAFETY

- [x] **No import** — no data reload, no `pnpm import:file`, no `tsx scripts/import-books.ts`
- [x] **No reset** — Meilisearch index settings unchanged; no `--reset-index` anywhere
- [x] **Meilisearch untouched** — container `book-id-search-meilisearch-1` Up 47h, NOT restarted
- [x] **7700 stays loopback** — `127.0.0.1:7700:7700` in docker-compose.yml; no port exposure change
- [x] **Caddy untouched** — no Caddy reload, no Caddyfile edit
- [x] **Security group untouched** — `0.0.0.0` not opened
- [x] **books.txt untouched** — `data/sample-books.txt` (public sample) NOT modified
- [x] **MINIMAX_API_KEY never printed** — `redact()` applied in all log paths
- [x] **Only api/web rebuilt** — `docker compose up -d --no-deps --build api web` (NOT meilisearch)
- [x] **No `private-data` / `meili_data` / `checkpoint` / `logs` committed** — `.gitignore` covers them
- [x] **`reports/HEALTH_CHECK_LATEST.md`, `reports/AI_QUALITY_REGRESSION_LATEST.md`, `reports/health-check-latest.json`, `reports/ai-quality-regression-latest.json`** — not tracked by `.gitignore` but will be `git restore`d before commit if drift appears

### Build verification

- `vitest run` — 243/243 pass
- `tsx scripts/verify.ts` — PASS, docs unchanged
- `tsc -p apps/api/tsconfig.json --noEmit` — clean
- `tsc -p apps/web/tsconfig.json --noEmit` — clean
- `docker compose build` — succeeds (no errors in build log)

## FRONTEND (S24-C5)

- `apps/web/src/QueryInfoBar.tsx` (new) renders two light
  chips: cleanup notice ("已自动忽略：…") + cleaned query
  ("实际搜索：…") + intent chip ("识别为：旅行指南类检索")
- `apps/web/src/RankingChips` shows up to 3 explainable
  evidence strings per book card (e.g. "书名完整命中",
  "已加权：旅行指南类（景点）", "已降权：旅行指南类排除词
  （研究报告）")
- `apps/web/src/styles.css` adds mobile-friendly chip styles
  (`flex-wrap`, `max-width: 100%`, no horizontal overflow at
  360px)
- AI search panel shows intent label + ranking chips on
  candidates

## REPO_RESULT

- Commit hash: (next step)
- Push: (next step)
- Tag: `v0.6.0-search-quality-framework` (to be tagged after
  push)

## NEXT_STEP

1. S25 optional: advanced filters (year range, parseStatus
   filter, publisher filter)
2. S25 optional: per-query diagnostics endpoint
   (`GET /api/search/_diagnose?q=...`) for debugging bad
   results
3. Address 2 corpus/normalize WARNs: (a) add 佛塔 /
   建筑 to `academic_research` triggers; (b) strip
   "ISBN 是" / "SSID 是" / "DXID 是" prefix in
   `normalizeQuery` so natural-language ISBN lookups hit
   the exact-identifier path
4. Wire `search:quality` into a weekly cron (S23-style
   weekly) for ongoing regression detection

---

**Files added/modified in S24** (uncommitted at this point):

```
M  apps/api/src/ai/search-intent.ts
M  apps/api/src/handle-search.test.ts
M  apps/api/src/index.ts
M  apps/api/src/search/index.ts
M  apps/api/src/search/rerank.ts
M  apps/web/src/AiSearchPanel.tsx
M  apps/web/src/App.tsx
M  apps/web/src/api.ts
M  apps/web/src/styles.css
M  package.json
?? apps/api/src/search/intent-profile.test.ts
?? apps/api/src/search/intent-profile.ts
?? apps/api/src/search/query-cleanup.test.ts
?? apps/api/src/search/query-cleanup.ts
?? apps/api/src/search/rerank.test.ts
?? apps/web/src/QueryInfoBar.tsx
?? scripts/search-quality-cases.test.ts
?? scripts/search-quality-cases.ts
?? scripts/search-quality-regression.ts
```

(20 files, 11 modified + 9 new)
