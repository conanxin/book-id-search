# WeRead Batch Status Endpoint Report

STATUS: WARN

## SCOPE

- Add private `POST /api/private/weread/status/batch` endpoint.
- Frontend client now prefers batch and falls back to single status.
- No change to public `/api/search` behavior or ranking.
- No Meilisearch write.
- No note / highlight text displayed.

## API RESULT

- `POST /api/private/weread/status/batch` implemented.
- Max `catalogIds` = 100.
- Missing token returns `401`.
- Invalid token returns `403`.
- Invalid `catalogIds` (e.g. `"bad-id"`) returns `400`.
- Valid batch request with one confirmed and one unmatched catalogId returns `200` and `results` map with:
  - confirmed: `matched: true` plus redacted `weread` metadata
  - unmatched: `matched: false` plus `catalogId`

## FRONTEND RESULT

- `wereadPrivate.ts` client unit tests cover batch request URL, method, headers, body, deduplication, and fallback to single status.
- Production web bundle contains `/private/weread/status/batch` endpoint string (verified in `apps/web/dist/assets/index-*.js`).
- Browser network smoke test was attempted but the browser tooling timed out, so live UI verification is incomplete.
- Fallback to single `GET /api/private/weread/status?catalogId=...` is available when batch is unavailable.
- Existing `WereadBadge` / `WereadPrivatePanel` UI components still use `fetchWereadStatusesForBooks` unchanged.

## PRIVACY RESULT

- Live batch response scan found no `wereadBookId`, `noteId`, `highlightId`, `title`, `author`, `text`, or `comment`.
- No token or cookie/session leaked in live responses.
- No real token, Bearer value, or private id in tracked `apps/`, `docs/`, `reports/`, `package.json`, or `docker-compose.yml`.
- Build artifact scan (`apps/web/dist`) found no real token or private id.

## REGRESSION RESULT

| Check | Result |
|-------|--------|
| `npx vitest run` | 25 files / 410 tests PASS |
| `tsc -p apps/api/tsconfig.json` | PASS |
| `tsc -p apps/web/tsconfig.json` | PASS |
| `weread:validate` | PASS |
| `verify.ts` | PASS, docs count 5,115,734 |
| `search:quality` | 17 PASS / 0 WARN / 0 FAIL |
| `vite build` | PASS |

## DEPLOY RESULT

- `api` container rebuilt and running.
- `web` container rebuilt and running.
- `meilisearch` not restarted (still up 2 days).
- `Caddy` / security group untouched.

## REPO RESULT

- No commit/tag yet.
- Pending: commit and tag based on Git safety check.

## NEXT STEP

- Complete browser network smoke (if tooling recovers) to verify `/api/private/weread/status/batch` is actually called by the live UI.
- After successful smoke, apply tag `v0.8.2-weread-batch-status`.
- Then proceed to S26G (notes-count-only overlay) or confirm more matches.
