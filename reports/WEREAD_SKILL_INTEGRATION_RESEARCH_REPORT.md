# WeRead Skill Integration — Research Report (S26A)

> **Stage:** S26A research scaffold closeout.
> **Date:** 2026-07-02.
> **Tag after this commit:** `v0.7.0-weread-snapshot-scaffold`.

---

## STATUS: **PASS**

All seven gates passed. No runtime integration, no public API, no frontend
changes, no deploy, no Meilisearch writes, no main search path touched.

---

## SCOPE_RESULT

| Aspect | State |
| ------ | ----- |
| Research scaffold only | ✓ |
| No runtime integration | ✓ |
| No public API | ✓ |
| No frontend changes | ✓ |
| No deploy | ✓ |
| Main `book-id-search` untouched | ✓ |

The production `/api/search` route, AI-search pipeline, query-cleanup,
intent-profile, and unified-rerank layers were not modified. No service was
restarted. No `books.txt`, no `meili_data/`, no `.env`, no `Caddyfile` was
touched.

---

## WEREAD_SKILL_FINDINGS

### Expected capabilities (per Skill description)

- 查阅书架 (browse personal bookshelf)
- 阅读统计 (personal reading statistics)
- 笔记和划线 (highlights and thoughts)
- 书籍搜索 (catalog search)
- 书籍详情 (book detail)
- 推荐好书 (recommendations)

### API key privacy

`WEREAD_API_KEY` is **account-bound**, must never appear in:

- Git (tracked files)
- `.env`, `.env.example`, any secret config committed
- Logs, health-check JSON, AI-quality regression output
- Public HTTP responses

The skill is **not auto-installed** in this scaffold. Manual investigation is
documented in [`docs/WEREAD_SKILL_RESEARCH_NOTES.md`](../docs/WEREAD_SKILL_RESEARCH_NOTES.md).

### Fields to confirm manually (S26B hand-off)

See the 14-item checklist in
`docs/WEREAD_SKILL_RESEARCH_NOTES.md`. In short:

- Whether bookshelf entries expose ISBN, author, publisher, category.
- Whether `readingStatus` and `progress` are populated.
- Whether `highlights` and `thoughts` carry `chapterTitle`, `createdAt`,
  `updatedAt`.
- Pagination, rate limits, field stability, public-readable URL format.

### Limitations

The Skill **was not exercised against a real account** in S26A. Schema
assumptions are based on the documented Skill description. S26B will
redact any real-account export before it can be tested by `weread:validate`.

---

## SNAPSHOT_SCHEMA_RESULT

| Artifact | Path | Purpose |
| -------- | ---- | ------- |
| Schema doc | `docs/WEREAD_INTEGRATION.md` | Schema + privacy boundary + data flow |
| Research notes | `docs/WEREAD_SKILL_RESEARCH_NOTES.md` | Manual research checklist + credential policy |
| Sample books | `samples/weread/weread-books.sample.json` | Synthetic bookshelf (3 entries) |
| Sample notes | `samples/weread/weread-notes.sample.json` | Synthetic notes (3 entries) |
| Sample matches | `samples/weread/weread-matches.sample.json` | Synthetic match candidates (3 entries) |

All sample data is fully synthetic — `wr_sample_book_*` IDs, `示例*` titles,
fake ISBNs that do not collide with the public catalog. No real WeRead data.

### Schema summary

- **weread-books**: `wereadBookId, title, author` required; `isbn, cover,
  rating, readingStatus, progress, noteCount, highlightCount, lastReadAt,
  updatedAt` optional. `readingStatus ∈ {unknown, not_started, reading,
  finished, abandoned}`. `progress ∈ 0..100`.
- **weread-notes**: `wereadBookId, noteId, type, text` required; `type ∈
  {highlight, thought, review}`.
- **weread-matches**: `wereadBookId, catalogId, ssid, dxid, matchMethod,
  matchConfidence` required; `matchMethod ∈ {isbn, title_author,
  title_similarity, manual}`; `matchConfidence ∈ {high, medium, low}`.
  `confirmedByUser` must default to `false` for auto-generated matches.

---

## VALIDATOR_RESULT

| Item | Value |
| ---- | ----- |
| Script | `scripts/weread/validate-weread-snapshot.ts` |
| Test file | `scripts/weread/validate-weread-snapshot.test.ts` |
| Test count | 27 (unit + CLI integration) |
| Unit tests | 23 (validateBooks/Notes/Matches pure functions) |
| CLI integration tests | 4 (samples PASS, partial WARN, schema FAIL, empty-dir FAIL) |
| `pnpm weread:validate` (against `samples/weread/`) | **STATUS=PASS**, 3/3/3 counts |
| Failure modes | exit code `1` on FAIL, `0` on PASS or WARN |

---

## MATCHING_PROTOTYPE_RESULT

| Item | Value |
| ---- | ----- |
| Script | `scripts/weread/match-weread-catalog.ts` |
| Test file | `scripts/weread/match-weread-catalog.test.ts` |
| Test count | 12 (pure-function coverage: clean, dice, ISBN normalize, query construction, scoring) |
| Strategy | ISBN → title+author → title similarity (Dice coefficient) |
| Confidence tiers | high ≥ 0.7, medium ≥ 0.5, low ≥ 0.35 |
| Output path | `private-data/weread/derived/weread-matches.generated.json` (gitignored) |
| Production connection | **None.** No writes to Meilisearch, no edits to public catalog, no API mutation. |
| Network | Calls only `https://books.conanxin.com/api/search` (read-only public catalog search). |

Sample run against the synthetic fixtures produced 0 candidates (expected —
fake titles don't match real catalog entries) and the script exited cleanly.

---

## REGRESSION_RESULT

| Gate | Result |
| ---- | ------ |
| `vitest run` (full suite) | **PASS** |
| `pnpm weread:validate` | **PASS** (samples/weread) |
| `MEILI_HOST=http://127.0.0.1:7700 tsx scripts/verify.ts` | **PASS** |
| `pnpm search:quality` | **17 PASS / 0 WARN / 0 FAIL** |
| `curl https://books.conanxin.com/api/stats` docs count | **5,115,734** (unchanged from v0.6.2) |
| Meilisearch uptime | **2 days** — untouched this round |
| api/web uptime | **~1 hour** at last build, untouched this round |

---

## SAFETY

| Check | Result |
| ----- | ------ |
| `private-data/` ignored | ✓ all 3 sub-paths (`raw/`, `snapshots/`, `derived/`) confirmed ignored |
| No API keys committed | ✓ `grep` against tracked files clean |
| No real WeRead data committed | ✓ samples are fully synthetic |
| No raw notes/highlights committed | ✓ sample text is "示例高亮文本…" placeholders |
| No `MINIMAX_API_KEY` value | ✓ grep clean |
| `meili_data/` ignored | ✓ unchanged |
| `books.txt` untouched | ✓ not modified |
| `node_modules/`, `dist/`, `logs/` ignored | ✓ unchanged |
| No large files | ✓ largest sample file is 1205 bytes |
| Meilisearch untouched | ✓ no index reset, no settings change, no restart |
| api/web not rebuilt | ✓ no Docker build, no image push |
| Cron unchanged | ✓ `crontab -l` matches pre-S26A baseline |
| Main `/api/search` unaffected | ✓ no source file outside `docs/`, `samples/`, `scripts/weread/`, `reports/`, `package.json`, `.gitignore` |

---

## REPO_RESULT

| Item | Value |
| ---- | ----- |
| Base commit | `73cc27e` (v0.6.2-weekly-search-quality) |
| New commit | *to be filled by F7* |
| Tag | `v0.7.0-weread-snapshot-scaffold` (force-pushed, only after PASS) |
| Push | `origin main` |

---

## NEXT_STEP

| Stage | Scope | Public exposure? |
| ----- | ----- | ---------------- |
| **S26B** | User manually exports real WeRead raw data into `private-data/weread/raw/`, runs the normalizer (script TBD) into `private-data/weread/snapshots/<ts>/`, then runs `pnpm weread:validate --dir …` and `pnpm weread:match`. | **No** |
| **S26C** | Improve matching engine: incorporate year / publisher / series signals, add manual-confirm CLI. | **No** |
| **S26D** | Token-gated private overlay API; reads only `private-data/weread/derived/weread-matches.user-confirmed.json`. | **No** |
| **S26E** | Frontend private reading badges — per-session only, no shared responses. | **No** |

**Hard rule for S26B–S26E**: never commit personal WeRead data. Never write it
to Meilisearch. Never expose it through the public `https://books.conanxin.com`
endpoints. Never print API keys or session tokens in any log.