# WeRead Private Snapshot Import — Report (S26B)

> **Stage:** S26B private snapshot import scaffold.
> **Date:** 2026-07-02.
> **Base commit:** `9811ab1` (v0.7.0-weread-snapshot-scaffold).

---

## STATUS: **BLOCKED_FOR_RAW_EXPORT**

The `private-data/weread/raw/latest/` directory is empty. No real WeRead
export has been provided, so the inspect → normalize → validate → match
pipeline halts at the very first step. Scaffold scripts and tests are
complete and PASS in isolation, but no real import was attempted.

---

## SCOPE

| Aspect | State |
| ------ | ----- |
| Private import only | ✓ (no public writes) |
| No runtime integration | ✓ |
| No public API | ✓ |
| No frontend changes | ✓ |
| No deploy | ✓ |
| Main `book-id-search` untouched | ✓ |

---

## RAW_IMPORT_RESULT

| Field | Value |
| ----- | ----- |
| raw files detected count | **0** |
| raw file names | (none) |
| inventory status | `BLOCKED_FOR_RAW_EXPORT` |
| sensitive warning count | 0 |

`pnpm weread:inspect --dir private-data/weread/raw/latest` exited with code 1
and the message:

```
[weread:inspect] no JSON files in /opt/book-id-search/private-data/weread/raw/latest;
                 place WeRead raw exports here and re-run
[weread:inspect] STATUS=BLOCKED_FOR_RAW_EXPORT
```

To unblock: run the WeRead Skill (or a hand-rolled equivalent) to dump
normalized JSON into `private-data/weread/raw/latest/`. Acceptable filenames
are listed in `docs/WEREAD_INTEGRATION.md` and surfaced by
`scripts/weread/inspect-weread-raw.ts` (`classifyFileRole` / role table).

---

## SNAPSHOT_RESULT

| Field | Value |
| ----- | ----- |
| books count | 0 (real); 3 (sample fallback PASS) |
| notes count | 0 (real); 3 (sample fallback PASS) |
| matches count | 0 |
| skipped records | 0 |
| field coverage | n/a (no raw input) |
| `pnpm weread:validate` (sample fallback) | **STATUS=PASS** |

`pnpm weread:normalize` correctly exits 1 with `STATUS=BLOCKED_FOR_RAW_EXPORT`
and **does not** write any snapshot files. No zero-byte placeholder files are
left behind — the snapshot directory stays empty, which is the safe state.

The validator is independently re-run against `samples/weread/` to confirm it
is still PASS, and that the new `inspect` / `normalize` scripts did not
regress the S26A baseline.

---

## MATCHING_RESULT

| Field | Value |
| ----- | ----- |
| high / medium / low / none | 0 / 0 / 0 / 0 (no real run) |
| isbn matches | 0 |
| title_author matches | 0 |
| title_similarity matches | 0 |
| no candidate | 0 |
| output path | `private-data/weread/derived/latest/` (gitignored, empty) |

A **smoke** match was run against `samples/weread/weread-books.sample.json`
to confirm the S26A `match-weread-catalog.ts` script still works end-to-end
through the public `https://books.conanxin.com/api/search`. As expected,
synthetic `示例*` titles produced 0 candidates. A summary record was written
to `private-data/weread/derived/latest/match-summary.json` and is also
gitignored. No real-data matching was attempted.

---

## VALIDATION_RESULT (regression)

| Gate | Result |
| ---- | ------ |
| `npx vitest run` (full suite, including new S26B tests) | **PASS** |
| `pnpm weread:validate` (samples/weread fallback) | **PASS** |
| `MEILI_HOST=http://127.0.0.1:7700 tsx scripts/verify.ts` | **PASS** |
| `pnpm search:quality` | **17 PASS / 0 WARN / 0 FAIL** |
| docs count | **5,115,734** (unchanged) |

New tests added in S26B:
- `scripts/weread/inspect-weread-raw.test.ts` — **15 tests PASS**
- `scripts/weread/normalize-weread-export.test.ts` — **27 tests PASS**

Combined with S26A's 39 tests, the weread/ suite totals **81 tests, all PASS**.

---

## SAFETY

| Check | Result |
| ----- | ------ |
| No `WEREAD_API_KEY` value in tracked files | ✓ grep clean |
| No `MINIMAX_API_KEY` value in tracked files | ✓ grep clean |
| No `private-data/` content tracked | ✓ git status clean for that path |
| No raw notes / highlights / quotes committed | ✓ raw dir is empty |
| No real `wereadBookId` / `noteId` / `highlightId` hex-like strings | ✓ all S26B-tracked content uses `wr_secret_*` placeholders in test fixtures, which never run against real data |
| `inspect` script never logs string values | ✓ test invariant enforced (`expect(stdout).not.toContain("EXAMPLE_HIGHLIGHT_TEXT_NEVER_LEAKED")`) |
| `normalize` script never logs string content | ✓ same invariant |
| Meilisearch untouched | ✓ no index reset, no settings change, no restart |
| api/web not rebuilt | ✓ no Docker build / image push |
| Cron unchanged | ✓ 3 book-id-search cron entries match pre-S26B baseline |
| Main `/api/search` unaffected | ✓ only `scripts/weread/`, `package.json` modified |

---

## NEXT_STEP

### S26B unblock path (requires user action)

1. Export WeRead raw data via the Skill / Agent with `WEREAD_API_KEY` set in
   your **local** shell. Do not commit the API key or the export.
2. Place the JSON into `private-data/weread/raw/latest/`. Acceptable file
   names: `bookshelf.json`, `books.json`, `weread-books.json`, `shelf.json`,
   `notes.json`, `highlights.json`, `thoughts.json`, `reviews.json`,
   `weread-notes.json`, `book-details.json`.
3. Re-run, in order:
   ```bash
   pnpm weread:inspect
   pnpm weread:normalize
   pnpm weread:validate -- --dir private-data/weread/snapshots/latest
   NO_PROXY="*" no_proxy="*" pnpm weread:match -- \
     --weread private-data/weread/snapshots/latest/weread-books.snapshot.json \
     --catalog-query-url https://books.conanxin.com/api/search \
     --out private-data/weread/derived/latest/weread-matches.generated.json
   ```
4. Inspect `private-data/weread/audit/raw-inventory.latest.md` to confirm
   the export shape matches the S26A schema. Re-run normalize with adjusted
   field mappings if `inspect` reports missing required fields.

### S26C (after S26B unblock)

- Improve matching quality (year / publisher / series signals, manual
  confirmation file).
- Add a `pnpm weread:match:confirm` that ingests a `confirmed-by-user.json`
  table and emits a deterministic `weread-matches.user-confirmed.json`.

### S26D (later)

- Token-gated private overlay API. Reads only
  `private-data/weread/derived/latest/weread-matches.user-confirmed.json`.
- Returns data only to the owning user's session.

### S26E (later)

- Frontend private reading badges — per-session only.

**Hard rules for S26B–S26E**: never commit personal WeRead data, never write
it to Meilisearch, never expose it through public endpoints, never print
API keys or session tokens in any log.