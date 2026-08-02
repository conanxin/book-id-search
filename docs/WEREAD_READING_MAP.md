# S27H — Private WeRead "Personal Reading Map" Dashboard

## Overview

S27H-2 adds a "session theme overlay" on top of the dashboard. The
overlay re-uses the AI summary already produced in the "notes & AI"
workspace — it never re-calls MiniMax and never touches note text. See
[`WEREAD_SESSION_THEME_OVERLAY.md`](./WEREAD_SESSION_THEME_OVERLAY.md)
for the privacy boundary, the UI states, and the state-sharing
pipeline.

`/weread` adds a second workspace tab — "个人阅读地图" — next to the
existing "笔记与 AI" tab. The new tab visualises the user's reading
history purely from aggregate counts and dates. **No note text, no
comment, no WeRead-internal ID, and no raw WeRead title/author ever
leave the private data directory**; the only metadata fetched from the
public catalogue is the four safe public fields (title, author,
publisher, year).

The feature ships as a single new private endpoint:

```
GET /api/private/weread/reading-map?months=24&topBooks=12
```

It powers the React dashboard in `apps/web/src/weread/ReadingMapDashboard.tsx`.

## Functional scope

| Capability | Source |
|-----------|--------|
| Reading-history overview (first / last note date, active months, current & longest streak) | `private-reading-map.ts → calculateReadingStreaks` |
| Monthly notes timeline (total + per-type + matched counts) | `buildReadingMapTimeline` |
| High-interaction books (public title / author / noteCount / activeMonths / first / last note dates) | `aggregateMatchedBooks` + `hydratePublicBookMetadata` |
| Contemporaneous-reading book network (nodes sized by noteCount, edges by shared months) | `buildReadingMapLinks` + `wereadReadingMapModel.ts → buildReadingMapNodeLayout` |
| Time-window switch (6 / 12 / 24 / 36 months) | client `fetchWereadReadingMap({ months })` |
| Top-books switch (6 / 12 / 18) | client `fetchWereadReadingMap({ topBooks })` |
| Refresh + retry | `ReadingMapDashboard` |

## Data sources

| Layer | Source | What it provides |
|-------|--------|------------------|
| Private snapshot (read-only) | `loadWereadOverlay` → `snapshots/latest/weread-notes.snapshot.json` + `derived/latest/weread-matches.confirmed.json` | Note timestamps, note types, the wereadBookId → public catalogId mapping |
| Public catalogue (read-only) | `index.getDocument(catalogId)` on Meilisearch `books` | `title`, `author`, `publisher`, `year` (other fields are stripped server-side) |
| Public search index | **NOT** used. The endpoint never calls `/api/search`. | n/a |

## Timeline algorithm (`buildReadingMapTimeline`)

1. Resolve the requested `months` (6 / 12 / 24 / 36) and `nowSeconds`.
2. Build the list of `months` YYYY-MM buckets ending at the current UTC month.
3. For each note, resolve its timestamp via `createdAt` → `updatedAt` (epoch-seconds or ISO string).
4. Notes with no parseable date are dropped silently.
5. Each bucket accumulates `total`, `highlights`, `thoughts`, `reviews`, `unknown`, and `matched` (note has a confirmed catalogId mapping).

Empty months still appear in the timeline with `total=0` so the chart
never has visual gaps.

## Streak algorithm (`calculateReadingStreaks`)

| Field | Definition |
|-------|------------|
| `activeMonths` | Total number of distinct YYYY-MM buckets that received at least one valid-date note. |
| `currentStreakMonths` | Count of contiguous active months ending at the most recent active month. |
| `longestStreakMonths` | Length of the longest contiguous run of active months in the user's history. |

Streaks are computed across the **full** history, not just the visible
window — switching the range does not retroactively erase older
streaks.

## Top-books aggregation (`aggregateMatchedBooks`)

* Group notes by **public catalogId** (one WeRead book id → one catalogId, but multiple WeRead book ids may share a catalogId).
* Same-body duplicates are NOT collapsed (legitimate re-highlights are common).
* Sort order is `(noteCount ↓, activeMonths ↓, lastNoteAt ↓, catalogId ↑)` to keep ties stable.
* Only the first `topBooks` (6–18) make it into the response.

## Contemporaneous-reading links (`buildReadingMapLinks`)

For every month, find which topBooks catalogIds have ≥1 valid-date note,
then for every unordered pair `(A, B)`:

* `sharedMonths += 1`
* `weight += min(A_count_in_month, B_count_in_month)`

After accumulation:
1. Drop self-pairs.
2. Normalise source/target ordering (`source` = lexicographically smaller).
3. Dedupe by unordered pair.
4. Sort by `(sharedMonths ↓, weight ↓, sourceCatalogId ↑, targetCatalogId ↑)`.
5. Cap at 24 edges.

Links are computed **only** within the chosen topBooks, so the network
is bounded and its interpretation is "books that were active in the
same months within your chosen window".

## Public-metadata source

* Reads `index.getDocument(catalogId)` directly on Meilisearch.
* Failure (404, transient upstream, etc.) → silent fallback to `书目 ${catalogId}` with empty ancillary fields.
* **Never** falls back to the raw WeRead title / author. The private snapshot carries those fields but the helper ignores them entirely.

## Privacy boundaries

| Boundary | Enforcement |
|----------|-------------|
| No note text / comment returned | `buildPrivateReadingMap` shape never includes `text`, `comment`, `markedText`, or `content`. Server-side filtering strips them before the helper sees the records. |
| No private IDs returned | Response shape does not contain `wereadBookId`, `noteId`, `highlightId`, or `chapterTitle`. |
| No raw WeRead title / author returned | Public metadata is read from Meilisearch. The fallback uses the placeholder `书目 ${catalogId}`. |
| No call to `/api/search` | Endpoint uses `index.getDocument` directly; never `fetch(...api/search)`. |
| No call to MiniMax | The dashboard contains no AI call; the response is fully aggregated server-side. |
| No write to Meilisearch / settings / index | The handler is read-only. |
| No persistence | Response shape carries `meta.persisted = false`. Nothing is written to disk, database, or local/session storage. |
| Response body never logged | Neither API nor Web layer logs request body, response body, seed text, token, or Meili raw errors. |
| Auth same as every other `/api/private/weread/*` endpoint | `checkPrivateAuth` (401 missing, 403 wrong, 404 disabled, 503 token-not-configured). |

## Known limitations

1. **Only matched books enter the star graph.** Notes whose WeRead book id has not been confirmed against the public catalog only contribute to the timeline's `total` and `type` counts. They never appear in the network or the high-interaction list.
2. **Contemporaneous ≠ semantically related.** Two books appearing in the same months only means the user was reading both at that time. The links carry no embedding or topic signal.
3. **No embeddings clustering.** Suggestions are out of scope for this release.
4. **Requires user interpretation.** The user must already know that "共同活跃 N 个月" means "we were both reading these in N months" and not "they're topically similar".
5. **24 edges cap.** For very active histories, only the 24 strongest contemporaneous pairs are returned; weaker edges are silently dropped.

## Endpoint contract

`GET /api/private/weread/reading-map?months=24&topBooks=12`

| Query | Type | Default | Constraint |
|-------|------|---------|-----------|
| `months` | number | 24 | one of `6`, `12`, `24`, `36` |
| `topBooks` | number | 12 | integer in `[6, 18]` |

| Response code | Meaning |
|---------------|---------|
| 200 | OK. The body is the documented response shape — empty `books`/`links` are valid. |
| 400 | Invalid `months` or `topBooks`. |
| 401 | Missing token. |
| 403 | Wrong token. |
| 404 | Private overlay disabled. |
| 429 | More than 20 GETs in the last 60s. |
| 500 / 502 | Unexpected aggregation / metadata failure. |

Rate limit: **20 GETs per 60 seconds per client IP** (sha-hashed before being used as the bucket key — the plain text IP never enters logs).
## 复习日历（S27I）复用

`reading-map` 端点的响应同时被「复习日历」工作区复用，用于派生确定性复习建议。详见 `docs/WEREAD_REVIEW_CALENDAR.md`。该复用不引入任何新的 API、不调用 AI、不改变返回结构。
