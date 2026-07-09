# WeRead Private Overlay API

Private, read-only API endpoints that expose a minimal, redacted view of your WeRead library based on confirmed catalog matches. This is **disabled by default** and must be explicitly enabled with a token.

## Endpoints

- `GET /api/private/weread/summary` — aggregate counts only.
- `GET /api/private/weread/status?catalogId=<catalogId>` — per-book reading status.
- `POST /api/private/weread/status/batch` — batch reading status for up to 100 catalogIds.
- `GET /api/private/weread/trends` — counts-only notes/highlights trend (S27B).
- `GET /api/private/weread/notes` — paginated note items with `text` / `comment` (S27C). S27D adds optional `?q=` full-text search over `text` / `comment` only.

## Authentication

All endpoints require a private token. Accepted header styles:

- `Authorization: Bearer <token>`
- `X-Private-Token: <token>`

If the feature is disabled or the token is missing/invalid, the API returns `404`/`401`/`403` without exposing private details.

## Environment variables

- `WEREAD_OVERLAY_ENABLED` — must be `true` to enable the endpoints.
- `WEREAD_PRIVATE_API_TOKEN` — token used for bearer / header auth.
- `WEREAD_PRIVATE_DATA_DIR` — absolute path inside the api container; defaults to `/app/private-data/weread`.

Never commit the token. The token is read from `.env` via docker compose env-file; it is not baked into the Docker image.

## Docker mount

The api container bind-mounts the private data directory read-only:

```yaml
volumes:
  - ./private-data/weread:/app/private-data/weread:ro
```

No private data is copied into the image.

## Privacy rules

The API response never includes:

- `wereadBookId`
- Book title or author
- Cookie, session, or raw WeRead tokens
- API keys

Response only includes aggregated counts and matched status metadata (`readingStatus`, `progress`, `noteCount`, `highlightCount`, `matchMethod`, `matchConfidence`, `decisionSource`).

## `GET /api/private/weread/notes` (S27C, S27D)

Returns paginated note items. **This is the only endpoint that exposes note text** — it is only accessible with a valid private token. There is no public notes endpoint, and the response never appears in Meilisearch or `/api/search`.

### Query parameters

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `all` \| `highlight` \| `thought` \| `review` | `all` | Note type filter. |
| `days` | `7` \| `30` \| `90` \| `all` | `all` | Time window based on `createdAt` (fallback `updatedAt`). Items without any date are excluded for non-`all` windows. |
| `matchedOnly` | `true` \| `false` | `false` | When `true`, only items whose WeRead book id joined to a confirmed catalogId are returned. |
| `hasComment` | `true` \| `false` | (unset) | Optional. When `true`, keeps only items with non-empty `comment`. |
| `limit` | 1..100 | 50 | Page size. Hard cap is 100. |
| `offset` | >= 0 | 0 | Pagination offset. |
| `sort` | `newest` \| `oldest` | `newest` | Sort by `createdAt`/`updatedAt` timestamp. |
| `q` | string (S27D) | (unset) | Optional full-text query. Max length **100** characters (longer values return `400`). Searches only `note.text` and `note.comment`. Empty / whitespace-only `q` is ignored and behaves identically to no `q` parameter. Case-insensitive substring matching; multi-word queries split on whitespace and use OR semantics (any term matches). |

Invalid values return `400` with a Chinese-language error message. Missing/invalid token returns `401`/`403`. Disabled overlay returns `404`.

### Response shape

```json
{
  "ok": true,
  "items": [
    {
      "type": "highlight",
      "text": "...",
      "comment": null,
      "createdAt": "2026-07-04T00:00:00.000Z",
      "updatedAt": null,
      "matched": true,
      "catalogId": "13000000_000000000001",
      "source": "private_weread"
    }
  ],
  "pageInfo": { "limit": 50, "offset": 0, "total": 1, "hasMore": false },
  "summary": {
    "totalAfterFilter": 1,
    "highlights": 1,
    "thoughts": 0,
    "reviews": 0,
    "unknown": 0,
    "matchedCount": 1,
    "unmatchedCount": 0
  },
  "searchInfo": {
    "enabled": true,
    "queryLength": 0,
    "termsCount": 0,
    "matchedCount": 1
  }
}
```

### `searchInfo` (S27D)

Returned only when the request carries a `q` parameter (including the case where `q` is present but trims to empty — `enabled: true, termsCount: 0` then means "search was requested but no terms to match"). When `q` is omitted, `searchInfo` is also omitted.

| Field | Type | Notes |
|-------|------|-------|
| `enabled` | boolean | `true` when a `q` was present on the request, `false` otherwise. |
| `queryLength` | number | Character length of the **trimmed** `q`. The raw `q` and individual terms are never echoed. |
| `termsCount` | number | Number of whitespace-split terms in `q` after trimming. |
| `matchedCount` | number | Number of items that satisfied the search filter (i.e. `items.length` would be `matchedCount` minus any subsequent pagination offset). |

`searchInfo` is the only place the server communicates that a search happened. It contains **no `q` field, no `terms` array, no snippets, no match offsets** — only counts. Reports, logs, and downstream caches that ingest this response therefore never see the raw query.

### Items — what is returned vs. what is NOT

| Field | Returned? | Notes |
|-------|-----------|-------|
| `type` | ✅ | `highlight` / `thought` / `review` / `unknown` |
| `text` | ✅ | The highlight/thought/review body. |
| `comment` | ✅ (nullable) | The user's own annotation. |
| `createdAt` | ✅ (nullable) | ISO-8601 string. |
| `updatedAt` | ✅ (nullable) | ISO-8601 string. |
| `matched` | ✅ | True iff a confirmed `catalogId` exists. |
| `catalogId` | ✅ (nullable) | Public book-id-search catalog id. `null` unless `matched === true` (or `matchedOnly=true`). |
| `source` | ✅ | Always `"private_weread"`. |
| `wereadBookId` | ❌ | Never returned. |
| `noteId` / `highlightId` | ❌ | Never returned. |
| `chapterTitle` | ❌ | Never returned (avoid leaking reading structure). |
| `title` / `author` | ❌ | Never returned. The matched `catalogId` is the only public-side metadata. |

`summary` aggregates the *filtered* list (before pagination), not the entire snapshot, so it always reflects the active query.

## Search privacy boundary (S27D)

Full-text search over `note.text` and `note.comment` is exposed **only** through the private token endpoint documented above. To make the privacy contract auditable, the implementation explicitly observes the following constraints:

- `q` is never returned to the client. `searchInfo` carries `queryLength` (count only), never the raw string.
- `q` is never logged. `queryPrivateNotes` makes no `console.log`/`console.warn`/`console.error` calls with `q` or note text — the function is covered by a unit test that asserts this.
- Error responses for `q` never echo the value. The `400 q 不能超过 100 个字符。` message is generic Chinese with no user input embedded.
- `q` does **not** enter `/api/search`. The public search endpoint is unmodified and continues to read only the `books` Meilisearch index.
- `q` is **not** written to Meilisearch. There is no write path from `queryPrivateNotes` to Meilisearch — the function is read-only against `private-data/weread/snapshots/latest/weread-notes.snapshot.json`.
- `q` is not persisted in any new file. There is no client-side cache of note bodies; the response is held only in component state for the lifetime of the React tree.
- The Markdown export of the current page contains note text + matched state but **no `q` field**. The export filename is `weread-notes-export-YYYYMMDD.md`, identical to pre-search exports.
- Reports / logs must not include raw `q` or note text. The report in `reports/WEREAD_NOTES_SEARCH_REPORT.md` records only counts and HTTP status codes.

The forbidden-IDs contract (`wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / `title` / `author`) continues to apply with `q` set — there is a dedicated unit test asserting the serialised response contains none of these keys.

## Notes counts-only overlay

For matched books, the status response includes a counts-only summary of the WeRead notes associated with that book. This is computed from `weread-notes.snapshot.json` and is never written to Meilisearch.

### `notesSummary` fields

| field | meaning |
|-------|---------|
| `total` | total number of note/highlight/thought/review records |
| `highlights` | records with `type: "highlight"` |
| `thoughts` | records with `type: "thought"` |
| `reviews` | records with `type: "review"` |
| `unknown` | records with any other type (including `type: "note"`) |
| `hasNotes` | `true` if `total > 0` |

### Duplicate catalogId aggregation

If more than one WeRead record is confirmed to the same catalogId, `matchedRecordsCount` reports how many records were matched, and `notesSummary` aggregates the counts from **all** of those records. The response still does **not** contain any `wereadBookId`, note text, or title.

### No note content endpoint

There is no endpoint to retrieve note text, highlight text, comments, chapter titles, or `noteId`/`highlightId`. The overlay intentionally only exposes counts.

## Summary aggregate fields

`GET /api/private/weread/summary` now also returns:

| field | meaning |
|-------|---------|
| `confirmedWithNotesCount` | matched catalogIds with at least one note record |
| `confirmedWithHighlightsCount` | matched catalogIds with at least one highlight |
| `totalConfirmedNoteRecords` | sum of all note records across matched catalogIds |

## Relationship to public search

This overlay has no effect on `/api/search`, `/api/stats`, `/api/health`, or AI search. It is a separate, authenticated route.

## Batch endpoint

`POST /api/private/weread/status/batch`

### Request

```json
{
  "catalogIds": [
    "13000000_000000000001",
    "00000000_000000000000"
  ]
}
```

- `catalogIds` must be an array of valid catalogIds.
- Length must be between 1 and 100 (inclusive).
- Duplicate catalogIds are allowed in the request but are deduplicated before processing.

### Response

```json
{
  "ok": true,
  "results": {
    "13000000_000000000001": {
      "matched": true,
      "catalogId": "13000000_000000000001",
      "weread": {
        "readingStatus": "finished",
        "progress": 100,
        "noteCount": 12,
        "highlightCount": 34,
        "matchedRecordsCount": 1,
        "notesSummary": {
          "total": 46,
          "highlights": 34,
          "thoughts": 8,
          "reviews": 0,
          "unknown": 4,
          "hasNotes": true
        },
        "matchMethod": "isbn",
        "matchConfidence": "high",
        "decisionSource": "auto_seed"
      }
    },
    "00000000_000000000000": {
      "matched": false,
      "catalogId": "00000000_000000000000"
    }
  }
}
```

### Error responses

- `401` — missing token.
- `403` — invalid token.
- `404` — overlay disabled.
- `400` — invalid `catalogIds` (not array, empty, >100, or malformed id).
- `500` — server error reading private data.

Error responses only contain a short `error` string; no token or private data is returned.

## `GET /api/private/weread/trends`

返回 7/30/90 天窗口和全部时间窗口的笔记/划线统计，仅统计数量，不返回任何正文、章节标题或微信读书内部 ID。

响应字段：

- `generatedAt` — 聚合时间（ISO 字符串）。
- `windows.days7` / `days30` / `days90` — 窗口计数对象，包含 `total` / `activeDays` / `activeBooks` / `highlights` / `thoughts` / `reviews` / `unknown`，以及 `daily`（仅 days7/30/90 含，每个元素 `{date, total, highlights, thoughts, reviews, unknown}`）。
- `windows.allTime` — 全部时间窗口（不含 `daily`）。
- `confirmedOnly` — 仅统计已确认匹配书籍的笔记：`total` / `activeBooks` / `highlights` / `thoughts` / `reviews` / `unknown`。
- `coverage` — `notesWithDate` / `notesWithoutDate` / `dateCoverageRatio`。

日期聚合规则：

- 优先 `note.createdAt`，缺失时回退到 `note.updatedAt`；两者皆缺或解析失败计入 `notesWithoutDate`。
- 按 UTC 日期 `YYYY-MM-DD` 聚合，避免时区歧义。
- 全部时间窗口 `daily` 字段不返回，避免响应过大。

错误响应与其它 `/api/private/weread/*` 端点一致：`401` 缺 token，`403` token 无效，`404` overlay 未启用，`500` 读数据失败。

## Frontend usage

The frontend client prefers `POST /api/private/weread/status/batch` and falls back to per-catalogId `GET /api/private/weread/status` when the batch endpoint is unavailable (e.g. `404` from an older deployment). Authentication errors (`401`/`403`) are re-thrown and handled by the UI so the user can clear/re-enter the token.

## How to disable

Set `WEREAD_OVERLAY_ENABLED=false` in `.env` and restart the api container. The endpoints will return `404 Not Found`.
