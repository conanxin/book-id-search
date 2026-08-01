# S27E — Private WeRead AI Notes Summarisation

## STATUS

PASS

## SCOPE

- **Input scope**: only the WeRead notes already loaded in the current browser view.
- **Input volume cap**: 30 items per AI call (`AI_SUMMARY_CLIENT_LIMITS.MAX_INPUT_ITEMS`).
- **Character cap**: per-item text/comment is trimmed and total request characters are bounded (server-side + client-side validation).
- **Authentication**: `WEREAD_PRIVATE_API_TOKEN` only; no other auth mechanism.
- **Provider**: MiniMax via the existing API AI client.
- **Trigger**: user-initiated button click only; no auto-run on mount, filter change, or token change.
- **Persistence**: none. The summary exists only in React component state and is never written to `localStorage`, `sessionStorage`, the server, or any index.
- **Index isolation**: summaries never enter Meilisearch or the public search index.

## API_RESULT

- **Endpoint**: `POST /api/private/weread/notes/summarize`
- **Auth**: `Authorization: Bearer <WEREAD_PRIVATE_API_TOKEN>`
  - Missing token → `401`
  - Invalid token → `403`
  - Valid token required for all requests.
- **Input validation**:
  - Empty `items` array → `400`
  - `items.length > 30` → `400`
  - Each item must have `type`, `text` (string); `comment` optional (string or null).
  - Non-ISO-8859-1 characters in the token are rejected by the browser `fetch` header validation before the request reaches the server.
- **Rate limit / concurrency**: reuses the existing AI limiter; one in-flight request per client session is enforced by the component via `AbortController`.
- **Timeout / error mapping**:
  - `504` / timeout → "AI 服务超时，请稍后再试。"
  - `502` / provider parse failure → "AI 服务暂时不可用，请稍后再试。"
  - `429` → "请求过于频繁（限流），请稍后再试。"
  - `413` → "笔记正文过大，请缩小整理范围。"
  - Client abort → silent cancellation, no state update.
- **Structured response**: `application/json` with `ok`, `summary` (`overview`, `themes[]`, `keyPoints[]`, `reviewQuestions[]`, `readingDirections[]`), and `meta` (`itemsUsed`, `totalCharacters`, `persisted: false`, `provider: "minimax"`).
- **Synthetic live smoke**:
  - Historical first attempt: provider returned `502` with an unparseable response.
  - Historical immediate retry: provider returned `200` with a valid structured summary (all 4 sections present, `itemsUsed=3`, `persisted=false`).
  - Scripted round 1: `200`, `ok=true`, `itemsUsed=3`, `persisted=false`, no forbidden keys, no echo of input text.
  - Scripted round 2: `200`, same structural guarantees.
- No synthetic input text or AI raw output is recorded in this report.

## FRONTEND_RESULT

- **Manual trigger**: the "AI 整理当前笔记" button is disabled when no eligible notes are loaded or when a request is already in flight.
- **Privacy notice**: always-visible text states that up to 30 loaded notes will be sent to MiniMax and that the output is not persisted, indexed, or saved to the server.
- **Sections rendered on success**: 主题概览, 主要主题, 关键观点, 待复习问题, 延伸阅读方向.
- **Actions after success**: "复制摘要" (writes Markdown to clipboard) and "清除摘要" (returns component to idle state).
- **Abort / stale clearing**:
  - `AbortController` cancels the in-flight request on unmount / token change.
  - `useEffect` resets the summary whenever the token or loaded items change.
  - Changing filters, search, sort, or per-page limit also clears the summary because the loaded notes array changes.
- **Responsive smoke**: verified at `1440×900` and `360×800`.
  - No horizontal scroll (`documentElement.scrollWidth === window.innerWidth`).
  - All required sections, copy/clear buttons, and the ICP footer rendered correctly in both sizes.
- **No `dangerouslySetInnerHTML`**: the AI summary is rendered as React children only.

## PRIVACY_RESULT

- **Data sent to the provider**: only the current view's `type`, `text`, and optional `comment` of up to 30 loaded notes.
- **Data excluded from the provider payload**:
  - `q` (search term)
  - `WEREAD_PRIVATE_API_TOKEN`
  - `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`, `catalogId`
  - `title`, `author`
  - `matched` flag
  - `createdAt`, `updatedAt`
  - current URL, user IP, and any other session metadata
- **Logs**: service logs captured during the live smoke contain no synthetic input text, no `Authorization` header, no token, no prompt, and no raw provider response.
- **Persistence**: no summary storage on disk, in the database, in Meilisearch, or in browser storage.
- **Public search / Meilisearch**: unchanged and untouched; no AI summary data enters these indexes.
- **Tracked source / build / report**: no real private IDs, tokens, keys, or synthetic test text committed. All forbidden-key scans on `apps/`, `docs/`, `reports/`, `README.md`, and `package.json` returned only expected synthetic test fixtures and documentation placeholders.
- **Temporary files**: `/tmp/s27e-*` request/response/log files removed after validation.

## REGRESSION_RESULT

- `vitest`: 648 passed (0 failed)
- `tsc -p apps/api/tsconfig.json --noEmit`: PASS
- `tsc -p apps/web/tsconfig.json --noEmit`: PASS
- `scripts/weread/validate-weread-snapshot.ts`: PASS
- `scripts/verify.ts`: PASS, `numberOfDocuments=5,115,734`
- `scripts/search-quality-regression.ts`: 17 PASS / 0 WARN / 0 FAIL
- `vite build` (apps/web): PASS, `dist/assets/index-*.css 45.53 kB`, `dist/assets/index-*.js 319.55 kB`

## DEPLOY_RESULT

- `api` container: rebuilt and Up (fresh instance).
- `web` container: rebuilt and Up (fresh instance).
- `meilisearch` container: not restarted; uptime preserved.
- Caddy, DNS, and nginx private `access_log` configuration: untouched.
- Public health endpoints (`/api/health`, `/api/stats`) return 200.

## LIMITATIONS

- Summaries only cover the notes currently loaded in the browser (up to 30 items).
- Provider availability is subject to transient errors (a `502` was observed on the first historical live attempt and succeeded on retry).
- AI output is not saved; refreshing the page loses the summary.
- AI output may contain inaccuracies and requires human review before use.
- Browser UI smoke used request interception with synthetic data and did not send real WeRead notes to the provider.

## NEXT_STEP

- Continue with S27F per-book Markdown export.
- Obtain the public security bureau filing number and populate `apps/web/src/siteCompliance.ts` when officially issued.
