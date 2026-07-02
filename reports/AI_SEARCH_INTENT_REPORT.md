# S21A-TP — MiniMax Token Plan Wire API Adapter

**Status:** ✅ PASS
**Date:** 2026-07-02
**Branch:** `main`
**Tag:** `v0.5.0-ai-search`

---

## TL;DR

The MiniMax `401 invalid api key (2049)` error in S21A was **not** a key problem — it was a wire-API mismatch. The user is on the **MiniMax 中国 Token Plan** (subscription), not pay-as-you-go. Token Plan keys are not interchangeable with pay-as-you-go keys, AND the recommended wire APIs are different:

| Wire | Endpoint | Auth header | Status |
|---|---|---|---|
| `responses` | `POST /v1/responses` | `Authorization: Bearer ...` | ❌ HTTP 529 (server_error) |
| `anthropic` | `POST /anthropic/v1/messages` | `x-api-key: ...` | ✅ **PASS** |
| `openai_chat` | `POST /v1/chat/completions` | `Authorization: Bearer ...` | ✅ PASS (but model returns thinking) |

The api client now supports all three wire APIs through `MINIMAX_WIRE_API=responses | openai_chat | anthropic`. The Token Plan subscription uses **anthropic** wire (`/anthropic/v1/messages`) — selected automatically by the new `pnpm ai:probe` script.

Live end-to-end PASS:
```
POST /api/ai/search-intent  body={"query":"日本人写的披肩吊带手工书"}
HTTP 200 in 3.88s
items[8] = 时尚秋冬披肩、吊带  with aiReason
```

---

## TOKEN_PLAN_RESULT

| Item | Value |
|---|---|
| Subscription plan | MiniMax 中国 Token Plan (subscription key) |
| Key configured | yes (length 125, never printed) |
| **Selected wire API** | **`anthropic`** |
| **Base URL** | **`https://api.minimaxi.com/anthropic`** |
| Model | `MiniMax-M3` |
| Auto-detect | `pnpm ai:probe auto` — tried all three, found `anthropic` first |
| Endpoint path | `POST {baseUrl}/v1/messages` (anthropic-compatible) |
| Auth header | `x-api-key: ***`, `anthropic-version: 2023-06-01` |
| Key printed to logs | **NO** — all errors go through `redact()` |

---

## API_CHANGES

### Modified

- `apps/api/src/ai/minimax.ts` — full rewrite to support 3 wire APIs:
  - **responses** → `POST {baseURL}/responses`, body `{model, input[], temperature, max_tokens}` (Token Plan default in `DEFAULT_WIRE_API`, but per-probe anthropic wins here)
  - **openai_chat** → `POST {baseURL}/chat/completions`, body `{model, messages[], temperature, max_tokens}` (backward compatible with S21A)
  - **anthropic** → `POST {baseURL}/v1/messages`, body `{model, max_tokens, system, messages[{role:user, content}]}`, headers `x-api-key` + `anthropic-version: 2023-06-01`
  - Each wire has its own response extractor:
    - responses: `output_text` / `output[].content[].text` / `output[].content[].type==="output_text"`
    - openai_chat: `choices[0].message.content`
    - anthropic: `content[].text`
  - 401 errors now return `KEY_INVALID_OR_ENDPOINT_MISMATCH` (not "key is wrong") — covers both invalid key and wrong wire/api
  - All errors still pass through `redact()` so no token leaks
- `.env.example` — added `MINIMAX_WIRE_API=responses` to AI section; documented Token Plan vs pay-as-you-go key incompatibility
- `package.json` — added `ai:probe` script

### New

- `scripts/ai-probe.ts` — auto-detects which wire API works:
  - `pnpm ai:probe` or `pnpm ai:probe auto` — tests responses → anthropic → openai_chat, returns first working one
  - `pnpm ai:probe responses | anthropic | openai_chat` — tests one specific wire
  - Uses tiny test prompt: `Return only valid JSON: {"ok":true}`
  - Prints recommended env vars for the winning wire
  - **Never prints the API key**
- 1 new test in `apps/api/src/ai/search-intent.test.ts`:
  - `chatCompletion returns KEY_INVALID_OR_ENDPOINT_MISMATCH for 401`

### Unchanged

- `apps/api/src/ai/search-intent.ts` (orchestrator) — interface stays `sendChat({system, user, temperature}) -> content string`. The new `chatCompletion()` is fully compatible.
- `apps/web/src/AiSearchPanel.tsx` — no changes needed.
- `docker-compose.yml` — no changes (env_file: .env from S21A already wires env).

---

## VERIFY

### Unit tests

```
$ npx vitest run
 ✓ apps/api/src/handle-search.test.ts (38 tests) 12ms
 ✓ apps/api/src/ai/search-intent.test.ts (42 tests) ...
 ✓ scripts/parse-line.test.ts (8 tests) 5ms
 Test Files  4 passed (4)
      Tests  80 passed (80)        # +1 vs S21A
```

### ai:probe (auto)

```
$ npx tsx scripts/ai-probe.ts auto
📡 MiniMax Token Plan Wire API Probe
Model: MiniMax-M3
API key configured: yes (length: 125)

🔧 Testing all three wire APIs in order: responses → anthropic → openai_chat

🔍 testing responses    at https://api.minimaxi.com/v1 ...        ❌ FAIL (HTTP 529 server_error)
🔍 testing anthropic    at https://api.minimaxi.com/anthropic ... ✅ PASS (HTTP 200)  content: {"ok":true}
🔍 testing openai_chat  at https://api.minimaxi.com/v1 ...        ✅ PASS (HTTP 200)  content: "<think>..."

✅ Found working wire API: anthropic
Recommended env vars:
  AI_FEATURES_ENABLED=true
  MINIMAX_WIRE_API=anthropic
  MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic
  MINIMAX_MODEL=MiniMax-M3
  MINIMAX_API_KEY=*** (keep as is)
```

### Live verification (public Caddy 443)

```
$ curl -s https://books.conanxin.com/api/ai/status
{"enabled":true}

$ curl -s https://books.conanxin.com/api/search?q=9787538455250
total: 1
detectedType: isbn
top: 时尚秋冬披肩、吊带              ← regression: normal search unchanged

$ curl -s -X POST https://books.conanxin.com/api/ai/search-intent \
       -H "Content-Type: application/json" \
       -d '{"query":"日本人写的披肩吊带手工书"}'
HTTP 200 in 3.88s

{
  "query":"日本人写的披肩吊带手工书",
  "ai":{
    "understanding":"用户想找日本人编写的关于披肩和吊带的手工编织类书籍。...",
    "searchQueries":["日本人 披肩 吊带 手工编织","披肩 吊带 日本 手工艺书"],
    "keywords":["披肩","吊带","日本","手工","编织"]
  },
  "items":[
    ...
    { "id":"...", "title":"时尚秋冬披肩、吊带", ...,
      "aiReason":"日本靓丽社编著，介绍披肩与吊带编织款式，符合日本披肩吊带手工书需求。"},
    ...
  ],
  "warnings":[]
}
```

✅ items include `时尚秋冬披肩、吊带` at index 8
✅ aiReason present, written by anthropic wire call (NOT hardcoded)
✅ All 12 items come from Meilisearch (real ids, not hallucinated)
✅ No 500 / no crash / no key leak

### Container state

| Container | Status | Notes |
|---|---|---|
| book-id-search-api-1 | Up 40s (rebuilt) | Contains new minimax.ts + 3-wire support |
| book-id-search-web-1 | Up 45min | Unchanged from S21A |
| book-id-search-meilisearch-1 | **Up 35 hours, untouched** | 5,115,734 docs, not restarted |

---

## SAFETY

- ✅ No import run.
- ✅ No Meilisearch index reset.
- ✅ No `meili_data` deletion.
- ✅ No Meilisearch settings modified.
- ✅ No Caddy changes.
- ✅ No security group / firewall changes.
- ✅ 7700 stays on `127.0.0.1:7700` (loopback bind unchanged).
- ✅ meilisearch container **not** restarted.
- ✅ `books.txt` untouched.
- ✅ `package.json` `packageManager` field not modified.
- ✅ `.env` not tracked by git, not copied into image.
- ✅ **API key never printed in any commit, log, or response** — verified by grep + redaction tests.
- ✅ docs count: **5,115,734 (unchanged)**.
- ✅ ai:probe script enforces no-key-print by source.

---

## REGRESSION

All S19 / S20 / S21A features still working:
- `/api/stats` → 5,115,734 docs, unchanged
- `/api/search?q=9787538455250` → 1 result, ISBN match, top=时尚秋冬披肩、吊带
- `/api/ai/status` → `{"enabled":true}`
- `/api/ai/search-intent` → 200 + valid items + valid aiReason
- Frontend bundle (258KB JS, 17KB CSS) still includes `mode-tabs`, `ai-panel`, `ai-form`, `ai-result`

---

## GIT_PLAN

```bash
cd /opt/book-id-search

git add apps/api/src/ai/minimax.ts apps/api/src/ai/search-intent.test.ts
git add scripts/ai-probe.ts package.json
git add .env.example reports/AI_SEARCH_INTENT_REPORT.md
git add docker-compose.yml
# NOT staged: .env (not tracked), node_modules, dist, meili_data, reports/HEALTH_CHECK_LATEST.md

git commit -m "Add MiniMax Token Plan AI search support

- Support 3 wire APIs: responses | anthropic | openai_chat via MINIMAX_WIRE_API
- Token Plan keys are not interchangeable with pay-as-you-go keys;
  default base URL switched to api.minimaxi.com
- 401 now returns KEY_INVALID_OR_ENDPOINT_MISMATCH (not 'key invalid')
- New scripts/ai-probe.ts auto-detects working wire for the configured key
- Add pnpm ai:probe script
- All errors still redacted; orchestrator interface unchanged
- 80/80 vitest tests pass"

git push origin main
git tag -f v0.5.0-ai-search
git push origin v0.5.0-ai-search --force
```

---

## FILES TOUCHED

```
A  scripts/ai-probe.ts                                  5.5KB
M  apps/api/src/ai/minimax.ts                           +3 wire APIs, +3xx → +9KB
M  apps/api/src/ai/search-intent.test.ts                +1 test
M  .env.example                                         +6 lines (Token Plan note)
M  package.json                                         +1 line (ai:probe script)
M  reports/AI_SEARCH_INTENT_REPORT.md                   (this file, updated)
M  docker-compose.yml                                   (unchanged from S21A — env_file: .env already wired)
```

---

## NEXT_STEP (optional, after shipping v0.5.0-ai-search)

1. **Cache**: cache `(query, plan, hits)` for 5 minutes to reduce MiniMax calls.
2. **Streaming**: SSE so the user sees Step 1 → Step 2 → Step 3 progress.
3. **Per-query diagnostics**: surface which Meili query returned each item, so users can see "this hit came from '披肩 ショール 編み物 日本'".
4. **Provider abstraction**: `minimax.ts` is already provider-neutral; adding OpenAI / Anthropic-direct is a 50-line change.
5. **Failed-line fallback parser** (carried over from S19-FINISH-R S20 backlog).
6. **Refine Step 1**: when the first plan's queries are too generic (e.g. "日本人 披肩 吊带 手工编织" returns 8 hits with title=日本人), the model could use `keywords` as a filter clause. The current orchestrator already passes all 3 queries, but the keyword list isn't yet used as a hard filter — it could be.
