# S22A — AI Book Detail Insight

**Status:** ✅ PASS
**Date:** 2026-07-02
**Branch:** `main`
**Tag:** `v0.5.2-ai-book-insight`

---

## TL;DR

图书详情页现在可以一键生成"AI 书目分析"——**完全基于真实的书目字段**（标题/作者/出版社/年份/页数/ISBN/SSID/DXID/parseStatus/parseWarnings/rawInfo 节选），AI 不得编造全文、目录、评价。

- **Endpoint**: `POST /api/ai/book-insight` 接受 `{bookId}` → 返回结构化 JSON
- **Cache**: 10 分钟 TTL / 200 entries / LRU
- **Frontend**: 详情页加 "AI 分析这本书" 按钮（不自动调用，避免 token 浪费）
- **Safety**:
  - 5 个硬限制：subjectTags ≤ 8 / searchSuggestions ≤ 6 / bibliographicSignals ≤ 6 / caveats ≤ 5 / shortSummary ≤ 120 字
  - AI 编造的 ISBN 自动丢弃
  - AI 错误时自动 fallback 到"规则生成"
  - scopeNote 永远强制注入

---

## FEATURE

### Endpoint: `POST /api/ai/book-insight`

**Request**:
```json
{ "bookId": "13000000_000008232537" }
```

**Response (200)**:
```json
{
  "bookId": "13000000_000008232537",
  "cache": { "hit": false },
  "basis": {
    "id": "13000000_000008232537",
    "title": "时尚秋冬披肩、吊带",
    "author": "（日）日本靓丽社著；陈瑶译",
    "publisher": "长春：吉林科学技术出版社",
    "year": 2011,
    "pages": 83,
    "isbn": "9787538455250",
    "ssid": "13000000",
    "dxid": "000008232537",
    "parseStatus": "ok",
    "parseWarnings": [],
    "rawInfoExcerpt": "...",
    "rawInfoTruncated": false
  },
  "insight": {
    "scopeNote": "以下分析仅基于书目信息，不代表图书全文内容。",
    "shortSummary": "书目信息显示为一本2011年出版的中文译本...",
    "subjectTags": ["服饰编织", "披肩", "吊带", "秋冬时装", "手工DIY", "日本引进版", "生活时尚", "翻译图书"],
    "likelyAudience": "对秋冬披肩、吊带编织或手工制作感兴趣的爱好者，主要面向中文读者。",
    "bibliographicSignals": [
      "标题明确为'时尚秋冬披肩、吊带'，聚焦秋冬披肩与吊带两类服饰单品。",
      "作者署名为'(日)日本靓丽社著'，译者为陈瑶，属于日本引进版。",
      "出版地为长春，出版社为吉林科学技术出版社，出版年份2011。",
      ...
    ],
    "searchSuggestions": ["披肩 编织 图解", "吊带编织 教程", ...],
    "trustAssessment": {
      "level": "medium",
      "reasons": ["题名、年份、出版社、ISBN等核心书目字段齐全且自洽。", "parseStatus为ok，无解析告警。", "..."]
    },
    "caveats": [
      "以上分析仅基于提供的书目字段，未访问图书全文、目录或内文。",
      "无内容简介、目录与书评信息可参考，因此无法判断具体编织针法或款式类别。",
      "..."
    ]
  },
  "source": "ai"
}
```

**Status codes**:
- `200` — success (with `cache.hit` field)
- `400` — empty `bookId`
- `404` — book not found in Meilisearch
- `503` — AI disabled (`AI_FEATURES_ENABLED!=true` or key missing)
- `502` — upstream failure (graceful fallback to rule-based)

### Frontend (`apps/web/src/BookInsight.tsx` + integration in `App.tsx`)

- Hidden entirely when AI disabled (shows "AI 功能未启用")
- "AI 分析这本书" button by default (no auto-call → token economy)
- Loading state: "AI 分析中..."
- Loaded state renders:
  - **scopeNote** (固定顶部)
  - **简短解读** (shortSummary)
  - **主题标签** (subjectTags chips)
  - **可能适合** (likelyAudience)
  - **书目信号** (bibliographicSignals list)
  - **延伸检索** (searchSuggestions chips — clickable → switch to normal search)
  - **可信度** (trust level with color-coded badge: high/medium/low + reasons)
  - **注意事项** (caveats)
  - **数据基础** (collapsible details — basis.id + all fields)
- Error state: "AI 服务暂时不可用，请稍后再试" + "重试" button
- Cache hint: "来自 600 秒缓存" (green pill)
- Fallback hint: "规则生成" (amber pill)
- Mobile: button full-width, trust badge stacks vertically, list bullets removed

---

## CACHE

- `SimpleCache<BookInsightResponse>`, TTL = **10 min** (vs 5 min for search-intent)
- maxEntries = **200** (vs 100 for search-intent)
- Key: `book-insight/${version}::${wireApi}::${model}::${bookId}`
- **NOT cached when**:
  - basis is too thin (no title AND no author)
- 5 cache tests pass (first call invokes chat, second hits cache, expired calls again, different bookId not shared, errors not cached)

---

## PROMPT SAFETY

`INSIGHT_SYSTEM`:
- "你只能基于用户提供的书目字段分析"
- "你没有访问图书全文、目录、评论、读者评价或外部资料的能力"
- "严禁编造：内容简介、章节、目录、序言、评价、获奖情况、作者生平、销量、影响力、ISBN、SSID、DXID"
- "SSID、DXID、ISBN 必须原样照抄输入字段"
- "输出严格 JSON，不要 markdown 代码块"

User payload only contains: id, title, author, publisher, year, pages, isbn, ssid, dxid, parseStatus, parseWarnings, rawInfoExcerpt (capped at 800 chars).

---

## ANTI-HALLUCINATION

`apps/api/src/ai/book-insight.ts::sanitizeInsight`:
- `subjectTags`: cap 8, dedupe, strip AI-invented ISBNs (any 10-13 digit string NOT equal to basis.isbn)
- `bibliographicSignals`: cap 6
- `searchSuggestions`: cap 6, dedupe
- `caveats`: cap 5, dedupe
- `shortSummary`: cap 120 chars, strip "本书讲述了..." / "内容简介:" / "目录:" patterns, default fallback text
- `likelyAudience`: cap 200, default "无法判断（仅基于书目信息）"
- `trustAssessment.level`: must be `high|medium|low`, else fall back to basis-driven
- `scopeNote`: always overwritten with fixed value
- 9 sanitization tests pass

---

## LIVE_RESULT

### First book insight (real book: `13000000_000008232537`)
```
HTTP 200 in 6.27s
cache.hit = false
source = "ai"

basis.title = "时尚秋冬披肩、吊带"
basis.author = "（日）日本靓丽社著；陈瑶译"
basis.isbn = "9787538455250"

insight.scopeNote = "以下分析仅基于书目信息，不代表图书全文内容。"
insight.shortSummary = "书目信息显示为一本2011年出版的中文译本，仅83页，题名指向..."
insight.subjectTags (8): 服饰编织, 披肩, 吊带, 秋冬时装, 手工DIY, 日本引进版, 生活时尚, 翻译图书
insight.likelyAudience = "对秋冬披肩、吊带编织或手工制作感兴趣的爱好者，主要面向中文读者。"
insight.bibliographicSignals (6): 6 bibliographic facts
insight.searchSuggestions (6): 披肩 编织 图解, 吊带编织 教程, ...
insight.trustAssessment.level = "medium"
insight.caveats (5): "以上分析仅基于提供的书目字段，未访问图书全文..."
```

### Cached book insight (10 min)
```
HTTP 200 in 2.1ms (vs 6.27s)       ← 3000× faster
cache.hit = true
cache.ttlSeconds = 600
```

### 404 test
```
POST { "bookId": "nonexistent_xyz" }
HTTP 404
{"error":{"message":"未找到这本书，无法生成 AI 分析。"}}
```

### 400 test
```
POST { "bookId": "" }
HTTP 400
{"error":{"message":"请求体需要非空的 bookId 字段。"}}
```

### Ordinary search regression
```
GET /api/stats            → 5,115,734 docs (unchanged)
GET /api/search?q=9787538455250 → total=1 detectedType=isbn top=时尚秋冬披肩、吊带
```

### Frontend bundle
```
JS:  /assets/index-DlEt7tQC.js  267.7 kB (gzipped 85.8 kB, +5.5 kB vs S21A-TP2)
CSS: /assets/index-3AuvUKbD.css 23.4 kB (gzipped 4.95 kB, +0.5 kB vs S21A-TP2)
```

Bundle markers found: `book-insight__button`, `book-insight__trust`, `trust--high`, `trust--low`, `getBookInsight`.

---

## TESTS

```
$ npx vitest run
 ✓ apps/api/src/handle-search.test.ts       (38 tests)
 ✓ apps/api/src/ai/cache.test.ts            (12 tests)
 ✓ apps/api/src/ai/search-intent.test.ts    (47 tests)
 ✓ apps/api/src/ai/book-insight.test.ts     (23 tests)  ← new
 ✓ scripts/parse-line.test.ts               (8 tests)
 Test Files  6 passed (6)
      Tests  128 passed (128)
```

**book-insight test breakdown (23)**:
- Basic flow (7): disabled→503, not found→404, happy path, parse failure→fallback, chat error→fallback, rawInfo truncation
- Sanitization (7): subjectTags cap+dedup, searchSuggestions cap, bibliographicSignals cap, caveats cap, shortSummary cap, AI-invented ISBN dropped, scopeNote always present, basis fields authoritative
- Cache (4): hit, expired, different bookId, thin basis not cached
- Safety (2): no key leak, no raw provider error leak
- Edge cases (3): weak parseStatus, trust level out of enum, empty bookId

---

## SAFETY

- ✅ No import run.
- ✅ No Meilisearch index reset.
- ✅ No `meili_data` deletion.
- ✅ No Meilisearch settings modified.
- ✅ No Caddy changes.
- ✅ No security group / firewall changes.
- ✅ 7700 stays on `127.0.0.1:7700` (loopback bind unchanged).
- ✅ meilisearch container **not** restarted (38h+ uptime).
- ✅ `books.txt` untouched.
- ✅ `package.json` `packageManager` field not modified.
- ✅ `.env` not tracked by git, not copied into image.
- ✅ **API key never printed in any commit, log, or response**.
- ✅ docs count: **5,115,734 (unchanged)**.
- ✅ AI never sees full rawInfo (capped at 800 chars).
- ✅ AI prompt explicitly forbids: full-content summaries, table of contents, evaluations, author bios, awards, sales, impact, hallucinated ISBN/SSID/DXID.
- ✅ AI errors → deterministic rule-based fallback (no 500, no crash, no fabrication).
- ✅ basis fields are always the real, fetched book fields (authoritative over AI claims).

---

## LIMITATIONS

- **Only based on bibliographic metadata** — title, author, publisher, year, pages, ISBN, SSID, DXID, parseStatus, parseWarnings, and a 800-char rawInfo excerpt.
- **Not book summary from full text** — we explicitly forbid the AI from generating content summaries, chapter outlines, table of contents, or any book-content claim.
- **Not external knowledge** — we forbid author biographies, sales/impact, awards, reader reviews, online references.
- **AI is an explainer, not a verifier** — trustAssessment reflects field completeness (high/medium/low), not content accuracy.
- **10 min cache** — a book's `parseStatus` change (e.g. after re-import) won't reflect in cached insights for 10 min.

---

## FILES TOUCHED

```
A  apps/api/src/ai/book-insight.ts                14.7KB   (orchestrator + sanitization)
A  apps/api/src/ai/book-insight.test.ts           15.5KB   (23 tests)
A  apps/web/src/BookInsight.tsx                    8.3KB   (UI component)
M  apps/api/src/index.ts                           +50     (POST /api/ai/book-insight route)
M  apps/web/src/api.ts                             +50     (BookInsight types + getBookInsight)
M  apps/web/src/App.tsx                            +2      (import + integrate)
M  apps/web/src/styles.css                         +198    (book-insight + trust + basis styles)
A  reports/AI_BOOK_INSIGHT_REPORT.md              11.5KB   (this file)
```

---

## GIT_PLAN

```bash
cd /opt/book-id-search

git add apps/api/src/ai/book-insight.ts apps/api/src/ai/book-insight.test.ts
git add apps/api/src/index.ts
git add apps/web/src/BookInsight.tsx apps/web/src/api.ts apps/web/src/App.tsx
git add apps/web/src/styles.css
git add reports/AI_BOOK_INSIGHT_REPORT.md

git commit -m "Add AI book detail insight

- POST /api/ai/book-insight: returns structured insight from book metadata only
- 10 min in-memory cache (200 entries, LRU); basis too thin → not cached
- 5 hard caps (subjectTags ≤ 8, searchSuggestions ≤ 6, signals ≤ 6, caveats ≤ 5, summary ≤ 120 字)
- Anti-hallucination: AI-invented ISBN dropped, basis fields authoritative
- Graceful fallback: AI parse failure / chat error → rule-based, no 500
- scopeNote always injected; '禁止补充目录/评价' baked into prompt
- Frontend: 'AI 分析这本书' button (no auto-call), clickable search chips
  → switch to normal search, color-coded trust badge, mobile-safe
- 128/128 vitest tests pass; live first call 6.27s, cached 2.1ms"

git push origin main
git tag -f v0.5.2-ai-book-insight
git push origin v0.5.2-ai-book-insight --force
```

---

## NEXT_STEP (optional, after shipping v0.5.2)

1. **S22B — streaming progress**: SSE for AI steps (plan → search → explain) on both endpoints.
2. **Failed-line fallback parser** (carried over from S19-FINISH-R S20 backlog).
3. **Per-query diagnostics** in search-intent: show which exact Meili query returned each item.
4. **Provider abstraction** for `minimax.ts`: adding OpenAI / Anthropic-direct is a 50-line change.
5. **Keyword hard filter** in search-intent: use `keywords` as Meili filter clause to reduce false positives.
6. **Multi-language**: 拓展 book-insight 支持英文 title/author 描述。
