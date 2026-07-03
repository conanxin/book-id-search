# WeRead Notes Count-Only Overlay Report

STATUS: WARN

## SCOPE

- notes-count-only overlay for private WeRead data.
- No note/highlight text exposed.
- No `chapterTitle`, `wereadBookId`, `noteId`, `highlightId`.
- No public `/api/search` behavior change.
- No Meilisearch write.

## API RESULT

| Endpoint | Result |
|----------|--------|
| `GET /api/private/weread/status` | ✅ returns `notesSummary` |
| `POST /api/private/weread/status/batch` | ✅ returns `notesSummary` per result |
| `GET /api/private/weread/summary` | ✅ returns aggregate counts |
| Response redacted | ✅ no private content |

## DATA RESULT

| Metric | Value |
|--------|-------|
| booksCount | 1586 |
| notesCount | 6989 |
| confirmedMatchesCount | 323 |
| confirmedWithNotesCount | 37 |
| confirmedWithHighlightsCount | 34 |
| totalConfirmedNoteRecords | 281 |

## FRONTEND RESULT

| Item | Result |
|------|--------|
| Badge updated | ✅ shows counts-only: 有笔记 / 划线 / 想法 / 书评 / 笔记 N |
| Batch endpoint | ✅ still used |
| Clear token | ✅ unchanged (browser smoke not re-verified) |
| Browser smoke | ⚠️ tool timeout; not verified manually |

## PRIVACY RESULT

| Check | Result |
|-------|--------|
| No token in build | ✅ |
| No note/highlight text in response | ✅ |
| No `wereadBookId`/`noteId`/`highlightId` | ✅ |
| No title/author/chapterTitle | ✅ |
| No private data committed | ✅ |

## REGRESSION RESULT

| Check | Result |
|-------|--------|
| vitest | ✅ 444 tests PASS |
| tsc api | ✅ PASS |
| tsc web | ✅ PASS |
| weread:validate | ✅ PASS |
| verify | ✅ PASS, docs=5,115,734 |
| search:quality | ✅ 17 PASS / 0 WARN / 0 FAIL |
| build | ✅ PASS (via local vite binary) |

## DEPLOY RESULT

| Item | Result |
|------|--------|
| api rebuilt | ✅ Up |
| web rebuilt | ✅ Up |
| Meilisearch restarted | ❌ No, uptime preserved |
| Caddy changed | ❌ No |

## LIMITATIONS

- Only confirmed matches show a badge.
- Duplicate `catalogId` known WARN remains (1 group).
- No note text is returned by design.
- Browser smoke was blocked by environment timeout; frontend behavior was unit-tested.

## NEXT STEP

- Manually verify the badge on https://books.conanxin.com/ after entering the private token.
- If manual smoke passes, run the tag step:
  - `git tag -f v0.8.6-weread-notes-count-overlay`
  - `git push origin v0.8.6-weread-notes-count-overlay --force`
- Alternatively, resolve the duplicate `catalogId` in the next iteration.
