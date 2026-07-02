# S21A-TP2 — AI Search UX & Quality Polish

**Status:** ✅ PASS
**Date:** 2026-07-02
**Branch:** `main`
**Tag:** `v0.5.1-ai-search-polish`

---

## TL;DR

AI 找书 from "能跑" → "production-ready":

- **Cache**: 5 min in-memory TTL (100 entries, LRU) → 2nd identical request is 1.7ms vs 6.6s (3900× faster)
- **Evidence**: every candidate now carries `aiEvidence.matchedQueries` + `matchedQueryCount` + `source` + `rankScore`. Multi-query hits outrank single-query hits; `parseStatus=ok > weak > failed`. Best book now at **index 0** instead of index 8.
- **Graceful fallback**: AI plan chat failure / parse failure / 0 hits → automatically falls back to the raw user query. Never throws. UI shows friendly `fallbackUsed` hint.
- **Prompt hardening**: 1–4 queries, 2–12 CJK chars each, "基于书目信息", "禁止补充目录/评价", 40-char cap.
- **aiReason fallback**: if AI returns no per-item reason, deterministic `"这条记录来自真实书目库，命中了检索词：xxx。"`
- **Frontend**: disclaimer (AI only explains; ids are real), 4-section result layout, clickable `searchQuery` chips → switch to normal search, "Copy AI summary" with markdown-ish plain text, mobile-safe (chips wrap, no horizontal overflow).

---

## QUALITY_CHANGES

### Cache (`apps/api/src/ai/cache.ts` — new)

- `SimpleCache<T>` with TTL + LRU + injectable clock for tests
- Key: `${version}::${wireApi}::${model}::${normalizedQuery}`
- Module-level singleton `getDefaultCache()` (resets on container restart, by design)
- Response includes `cache: { hit: boolean, ttlSeconds?: 300 }`
- Skip caching when `chat_failed` warning present
- Skip caching when `items.length === 0` (avoid storing empty result that hides real hits)
- 12 new cache unit tests

### Evidence & ranking (`apps/api/src/ai/search-intent.ts`)

- `AiItem.aiEvidence = { matchedQueries, matchedQueryCount, source, rankScore }`
- Sort formula: `matchedCount * 100 + parseStatus * 10 - firstRank * 0.01`
  - **matchedCount**: how many AI searchQueries hit this id (multi-query wins)
  - **parseStatus**: `ok: 0, weak: -1, failed: -2`
  - **firstRank**: Meili's original order (tie-breaker; favors earlier hits)
- `aiEvidence.source = "ai_query" | "fallback_query"`
- aiReason still attached to whitelist ids only
- New tests: duplicate merge, multi-query outranks single, ok outranks weak, whitelist still works

### Fallback (no 500, no crash)

- AI plan `chatCompletion` failure → fall back to raw query (no throw)
- AI plan JSON parse failure → fall back to raw query
- All `searchQueries` yield 0 Meili hits → fall back to raw query
- All of the above ALSO 0 hits → 200 with `items: []` + warning `no_meili_hits`
- `response.ai.fallbackUsed: boolean` + `response.ai.fallbackReason?: string`
- aiReason fallback: when AI gives no per-item reason, the orchestrator writes
  `"这条记录来自真实书目库，命中了检索词：<head1> / <head2>。"`

### Prompt hardening

- `PLAN_SYSTEM`:
  - 1–4 queries, each 2–12 CJK chars / 词组
  - 优先生成可在书目库命中的名词短语
  - 保留原文书名/作者/出版社/年份线索
  - 禁止编 SSID/DXID/ISBN/书名/作者
  - 严格 JSON，不要 markdown
- `REASON_SYSTEM`:
  - 只能解释传入 items
  - 必须说"基于书目信息"
  - ≤ 40 字
  - 不要补充内容/目录/评价

---

## UX_CHANGES

### Frontend (`apps/web/src/AiSearchPanel.tsx` + `apps/web/src/styles.css` + `apps/web/src/api.ts`)

**New API types** (S21A-TP2):
```ts
AiEvidence { matchedQueries, matchedQueryCount, source, rankScore }
AiItem.aiEvidence?: AiEvidence
AiSearchResponse.ai.fallbackUsed, fallbackReason?
AiSearchResponse.cache?: { hit, ttlSeconds }
```

**Disclaimer** (top of panel, behind Sparkles icon):
> "AI 只帮助理解描述和解释候选，**SSID / DXID / ISBN** 均来自真实书目索引。"

**Result sections (4)**:
1. **AI 理解** — single paragraph
2. **使用的搜索词** — each searchQuery is a **clickable button** → switches to normal search and prefills the query
3. **关键词** — chips
4. **候选图书 (N)** — per-item card with:
   - title (link to detail page)
   - **parseStatus badge** (弱解析 / 解析失败)
   - author / publisher / year
   - **ISBN / SSID / DXID** in monospace
   - **命中 N 个搜索词** label + matchedQueries chips
   - "回退查询" hint when source=fallback_query
   - aiReason with Sparkles icon

**Hint chips** (above sections):
- `来自 300 秒缓存` (green) when `cache.hit=true`
- `AI 检索词未命中，已回退到原始描述搜索。` (amber) when `fallbackUsed=true`

**Footer actions**:
- **复制 AI 搜索摘要** — clipboard with multi-line plain text (description + understanding + queries + keywords + top-5 items with id/isbn/aiReason)
- **用原始描述在普通搜索中查找** — handoff to `/` with `?q=...`
- **← 返回普通搜索** — link

**Empty state** (new copy):
> "没有找到候选书。可以尝试加入书名、作者、出版社、年份或 ISBN。"

**Error state**:
> "AI 服务暂时不可用，请稍后再试" (no provider details)

**Mobile** (≤480px): chips wrap, candidate card no horizontal overflow, footer buttons full-width.

---

## VERIFY

### Unit tests

```
$ npx vitest run
 ✓ apps/api/src/handle-search.test.ts       (38 tests)
 ✓ apps/api/src/ai/cache.test.ts            (12 tests)   ← new
 ✓ apps/api/src/ai/search-intent.test.ts    (47 tests)   ← +12 TP2
 ✓ scripts/parse-line.test.ts               (8 tests)
 Test Files  5 passed (5)
      Tests  105 passed (105)
```

### Build

```
api:  tsc 0 errors, 3.5s
web:  tsc 0 errors + vite 2.5s → 262.19 kB JS / 20.06 kB CSS (gzipped 84.5 / 4.45)
docker compose build api: PASS
docker compose build web: PASS
```

### Live verification (host loopback + Caddy 443)

**First AI request** (`日本人写的披肩吊带手工书`):
```
HTTP 200 in 6.65s
cache.hit = false
ai.fallbackUsed = false
ai.understanding = "用户想找日本作者编写的关于披肩和吊带的手工编织类书籍，侧重编织技法与花样。"
ai.searchQueries = ["披肩 吊带 日本 手工", "日本 编织 披肩 吊带", "披肩 吊带 手工编织"]
ai.keywords = ["披肩", "吊带", "手工编织", "日本"]
items[0] = 时尚秋冬披肩、吊带        ← RANKED TO TOP
  author:  （日）日本靓丽社著；陈瑶译
  aiReason: "日本靓丽社出版的披肩、吊带编织书，主题完全吻合"
  aiEvidence: matched=2 queries=[披肩 吊带 日本 手工, 披肩 吊带 手工编织]
              source=ai_query rankScore=200
  parseStatus: ok
  isbn: 9787538455250  ssid: 13000000  dxid: 000008232537
warnings: []
```

**Second identical request** (within 5 min):
```
HTTP 200 in 0.0017s (vs 6.65s)         ← 3900× faster
cache.hit = true
cache.ttlSeconds = 300
items[0] = 时尚秋冬披肩、吊带 (same body)
```

**Fallback test** (`xyzqq12345蓝月亮茶壶火星人维修手册完全绝版`):
```
HTTP 200 in 5.5s
ai.fallbackUsed = false (because Meili fuzzy-matched 12 items; that's fine)
items.length = 12
warnings = []
```

**Ordinary search regression**:
```
GET /api/stats               → 5,115,734 docs (unchanged)
GET /api/search?q=9787538455250 → total=1 detectedType=isbn top=时尚秋冬披肩、吊带
```

### Frontend bundle (public site)

```
$ curl -s https://books.conanxin.com/assets/index-D6rKT_6F.js | \
  grep -oE "ai-disclaimer|ai-section__title|ai-chip--query|ai-chip--matched|ai-hint--cache|ai-hint--fallback|ai-result__footer|ai-result__ids|ai-evidence"
ai-disclaimer
ai-section__title
ai-chip--query
ai-chip--matched
ai-hint--cache
ai-hint--fallback
ai-result__footer
ai-result__ids
ai-evidence
```

Manual visual check recommended:
- `https://books.conanxin.com/?mode=ai` → disclaimer visible
- search same query twice → second one shows "来自 300 秒缓存"
- click any 搜索词 chip → switches to `/` with that query prefilled
- click "复制 AI 搜索摘要" → clipboard contains description + understanding + queries + top-5 items
- mobile 390px: chips wrap, no horizontal scroll

---

## SAFETY

- ✅ No import run.
- ✅ No Meilisearch index reset.
- ✅ No `meili_data` deletion.
- ✅ No Meilisearch settings modified.
- ✅ No Caddy changes.
- ✅ No security group / firewall changes.
- ✅ 7700 stays on `127.0.0.1:7700` (loopback bind unchanged).
- ✅ meilisearch container **not** restarted (uptime 37h+).
- ✅ `books.txt` untouched.
- ✅ `package.json` `packageManager` field not modified.
- ✅ `.env` not tracked by git, not copied into image.
- ✅ **API key never printed in any commit, log, or response**.
- ✅ docs count: **5,115,734 (unchanged from S19, S20A, S21A-TP)**.
- ✅ Cache stores only response objects; never raw provider payloads or API keys.
- ✅ Cache size bounded at 100 entries; LRU eviction.
- ✅ Cache TTL bounded at 5 min; lazy + eager expiry.

---

## FILES TOUCHED

```
A  apps/api/src/ai/cache.ts                          3.4KB    (SimpleCache + key builder)
A  apps/api/src/ai/cache.test.ts                     12 tests
M  apps/api/src/ai/search-intent.ts                  +cache +evidence +fallback +prompts
M  apps/api/src/ai/search-intent.test.ts             +12 tests, fixed 3 stale tests
M  apps/web/src/api.ts                               +AiEvidence +fallbackUsed +cache types
M  apps/web/src/AiSearchPanel.tsx                    +disclaimer +sections +chips +footer +Copy
M  apps/web/src/styles.css                           +205 lines (TP2 UI styles)
A  reports/AI_SEARCH_POLISH_REPORT.md                (this file)
```

---

## GIT_PLAN

```bash
cd /opt/book-id-search

git add apps/api/src/ai/cache.ts apps/api/src/ai/cache.test.ts
git add apps/api/src/ai/search-intent.ts apps/api/src/ai/search-intent.test.ts
git add apps/web/src/api.ts apps/web/src/AiSearchPanel.tsx apps/web/src/styles.css
git add reports/AI_SEARCH_POLISH_REPORT.md

git commit -m "Polish AI-assisted search experience

- 5 min in-memory cache (LRU, 100 entries) → 2nd identical request 3900x faster
- Per-item aiEvidence: matchedQueries + matchedQueryCount + source + rankScore
- Multi-query hits outrank single-query hits; parseStatus=ok outranks weak/failed
- Graceful fallback: AI plan failure / 0 hits → auto fall back to raw query, never 500
- aiReason fallback when AI gives nothing: '这条记录来自真实书目库...'
- Prompt hardening: 1-4 queries, 2-12 CJK chars, no md, '基于书目信息', 40-char cap
- Frontend: disclaimer, 4-section result layout, clickable searchQuery chips
  → switch to normal search, 'Copy AI summary', 'Switch to normal search' handoff
- parseStatus badge, ISBN/SSID/DXID display, matchedQueryCount label
- Mobile-safe (chips wrap, no horizontal overflow, full-width footer)
- 105/105 vitest tests pass; live PASS in 6.65s, cached in 1.7ms"

git push origin main
git tag -f v0.5.1-ai-search-polish
git push origin v0.5.1-ai-search-polish --force
```

---

## NEXT_STEP (optional, after shipping v0.5.1)

1. **AI book detail insight** — for a single book page, ask the AI to summarize parseWarnings / rawInfo gaps.
2. **Failed-line fallback parser** (carried over from S19-FINISH-R S20 backlog).
3. **Per-query diagnostics** — surface which exact Meili query returned each item, so users can see the search strategy.
4. **Streaming** — SSE so users see Step 1 → Step 2 → Step 3 progress.
5. **Provider abstraction** — `minimax.ts` already provider-neutral; adding OpenAI / Anthropic-direct is a 50-line change.
6. **Keyword hard filter** — when AI plan's first query is too generic, use `keywords` as a hard Meili filter clause to reduce false positives.
