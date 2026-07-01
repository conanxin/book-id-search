# Search Empty Query Compatibility Report

## Status

PASS

## Root Cause

After the full import used --sortable-profile minimal, the books index no longer had year configured as a sortable attribute. The API still used sort: ["year:desc"] for empty queries, causing Meilisearch to return Attribute year is not sortable.

## Fix

- Empty query now returns a 200 response with an empty result payload.
- API no longer depends on year sortable for empty queries.
- Frontend skips empty-query search on initial load and shows the ready state.
- Existing ISBN/title/author/publisher searches remain unchanged.

## Verification

- /api/search?q= returns 200.
- /api/search?q=9787538455250 returns a hit.
- /api/search?q=时尚秋冬披肩 returns hits.
- /api/stats still reports the full index.
- Public stats remains compact and does not expose rawInfo, samples, internal paths, or checkpoint paths.
- No import/reset was run.

## Detailed before/after

### Before (S16D-lite reproduction)
- `curl -i http://127.0.0.1:3001/api/search?q=` → 500
  - body: `{"error":{"message":"搜索失败，请检查关键词或稍后重试。","detail":"Index `books`: Attribute `year` is not sortable. This index does not have configured sortable attributes."}}`
- `curl -i "https://books.conanxin.com/api/search?q="` (public) → 500, same body

### After (this release, both localhost and public via Caddy)
- `curl -i http://127.0.0.1:3001/api/search?q=` → 200
  - body: `{"query":"","page":1,"limit":20,"total":0,"items":[]}`
- `curl -i "https://books.conanxin.com/api/search?q="` → 200, same body
- `curl -i "http://127.0.0.1:3001/api/search?q=9787538455250"` → 200, 1 hit
- `curl -i "https://books.conanxin.com/api/search?q=9787538455250"` → 200, 1 hit
- `curl -i "http://127.0.0.1:3001/api/search?q=时尚秋冬披肩"` → 200, 2955 hits
- `curl -i "https://books.conanxin.com/api/search?q=时尚秋冬披肩"` → 200, 2955 hits
- `/api/stats` (both) → 200, numberOfDocuments=5,115,734, isIndexing=false

## Tests

- `npx vitest run` → 19/19 PASS
  - 6 new tests in `apps/api/src/handle-search.test.ts`:
    1. empty q returns 200 with empty payload and never calls meili.search
    2. whitespace-only q is treated as empty
    3. ISBN search delegates to meili.search
    4. title search returns correct total and items
    5. regression: no code path passes a sort parameter to meili.search
    6. meili errors return 500 with friendly message
  - 13 prior tests in scripts/

## Live verification (post-restart)

- `docker compose ps`: api Up 2 minutes, web Up 2 minutes, meilisearch Up 18 hours (untouched)
- Ports: 3001 / 5173 / 7700 loopback, 80/443 via Caddy
- Public stats compact, no rawInfo / samples / path leakage
- Books index docs count unchanged: 5,115,734
- No import / no reset was run during S16D-R

## Files changed

- `apps/api/src/index.ts` — handleSearch extraction, empty-q short-circuit
- `apps/api/tsconfig.json` — exclude `src/**/*.test.ts` from build
- `apps/api/src/handle-search.test.ts` — 6 new unit tests
- `apps/web/src/App.tsx` — empty-q short-circuit, currentQ helper
- `.gitignore` — ignore npm `package-lock.json` to keep pnpm as the single lockfile source
