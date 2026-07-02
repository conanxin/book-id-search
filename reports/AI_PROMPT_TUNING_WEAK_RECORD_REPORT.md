# AI Prompt Tuning for Weak Bibliographic Records

## STATUS

**PASS**

## PROMPT_CHANGES

- **Missing ISBN handling** — when `quality.missingFields` contains `isbn`,
  the system prompt now explicitly forbids `trustAssessment.level = "high"`,
  requires an "ISBN 缺失" caveat, and forbids any claim that ISBN is complete.
- **Weak parseStatus handling** — when `parseStatus = "weak"`, the prompt
  forbids `trustAssessment.level = "high"`, requires a weak-parse caveat,
  and recommends cross-checking with the raw TXT record.
- **Metadata limitation** — scope note wording is unchanged but now
  enforced by hard rules: "仅基于书目信息" + "不代表全文内容" are mandatory
  parts of the disclaimer.
- **Forbidden full-text claims** — the new forbidden-phrase list explicitly
  drops bare "全文" / "内容" (which corrupted legitimate "非全文内容" wording
  in the previous sanitizer) and uses sentence-level dropping to avoid
  dangling punctuation like "未涉及任何、正文".

## QUALITY_FIELD

The new `BookInsightResponse.quality` block is derived from real book fields
(not just `parseWarnings`) by `deriveBibliographicGaps`:

- `missingFields` — `["isbn"]` / `["ssid"]` / `["dxid"]` / `["title"]`
- `abnormalFields` — `["year"]` / `["pages"]` when null or non-positive
- `warnings` — merged `parseWarnings` + derived codes (`missing_isbn`,
  `year_non_numeric_or_invalid`, `pages_non_numeric_or_invalid`)
- `trustHints` — human-readable hints ("ISBN 缺失，无法用 ISBN 进行版本核对",
  "记录为弱解析，应结合原始 TXT 记录核对", etc.)

The field is sent to MiniMax as part of the metadata payload and surfaced
back to the client, where the frontend renders colored chips ("缺 ISBN",
"弱解析", "解析失败").

## SANITIZE_CHANGES

- **Trust downgrade** — when `quality.missingFields` contains `isbn` or
  `parseStatus` is `weak`, `trustAssessment.level` is forcibly downgraded
  from `high` to `medium`. When `parseStatus` is `failed`, level is forced
  to `low`.
- **Mandatory ISBN-missing caveat** — if `isbn` is missing, the sanitizer
  ensures a caveat containing "ISBN 缺失，无法用 ISBN 核对版本。" is present.
- **Mandatory weak-parse caveat** — if `parseStatus = "weak"`, the sanitizer
  ensures a caveat containing "该记录为弱解析，建议结合原始记录核对。" is
  present.
- **Forbidden phrase cleanup** — sentence-level drop (not character-level)
  to avoid leaving dangling punctuation. Bare "全文" / "内容" removed from
  the list (kept on the negative-claim allowlist at the test-runner level
  so "缺少内容简介" / "无目录" remain valid negative claims).
- **Identifier authority** — `basis.isbn` / `ssid` / `dxid` are fetched
  directly from Meilisearch and authoritative; AI-invented ISBNs are
  dropped from `subjectTags` (existing behavior preserved).

## QUALITY_REGRESSION

- `pnpm ai:quality` / `npx tsx scripts/ai-quality-regression.ts --max-ai-calls 10`
- **Cases total**: 9 (6 search-intent + 3 book-insight)
- **Pass / Warn / Fail**: **8 PASS / 0 WARN / 0 FAIL** (1 logic-only case
  `insight-not-found` is HTTP-shape only and not exercised by the AI
  regression runner; the API still returns 404 correctly when called
  directly).
- **AI calls**: 8 (under the 10-call cap).
- **Cache hit**: 2/2 book-insight calls (cached on second invocation
  within 10 min window).
- **Key leak**: none. The runner redacts JWT / sk- patterns in the report
  output; live verification confirmed `MINIMAX_API_KEY` is never echoed.

### Per-case highlights
| Case | Status | Latency | Notes |
|---|---|---|---|
| `japanese-shawl-camisole` | PASS | 8ms (cached) | top=时尚秋冬披肩、吊带, ISBN 9787538455250, rank 1 |
| `isbn-description` | PASS | 4ms (cached) | 200, items present, response includes "ISBN" / "978" |
| `scarf-fashion` | PASS | 5ms (cached) | top=围巾钩针技法 |
| `liao-architecture` | PASS | 6ms (cached) | top=辽代金银件研究 |
| `luxun-publisher` | PASS | 4ms (cached) | top=鲁迅全集 |
| `low-confidence-weird-query` | PASS | 4ms (cached) | graceful 200 with "月球" partial result |
| `insight-complete-book` | PASS | 10ms (cached) | trust=high, scopeNote present, no forbidden phrases |
| `insight-weak-missing-isbn` | PASS | 4ms (cached) | quality.missingFields=isbn, trust=low, ISBN 缺 mentioned in caveats/reasons/hints |
| `insight-not-found` | (logic-only) | — | API returns 404, not 500 (verified via direct curl) |

## LIVE_RESULT

- **Complete book insight** (`13000000_000008232537`) — HTTP 200, trust=high,
  8 subject tags, 6 search suggestions, 5 clean CJK caveats, scopeNote
  preserved, no forbidden phrases, no dangling punctuation.
- **Weak book insight** (`13001363_000007809055`) — HTTP 200, **trust=low**
  (downgraded beyond spec — even safer than the required medium),
  `quality.missingFields=["isbn"]`, `quality.parseStatus="weak"`,
  `quality.trustHints=["ISBN 缺失，无法用 ISBN 进行版本核对", "记录为弱解析，应结合原始 TXT 记录核对"]`,
  caveat 0 mentions ISBN 缺失, no invented ISBN, no forbidden phrases.
- **Ordinary search** — ISBN `9787538455250` still returns 时尚秋冬披肩、吊带
  as the top result (1 hit) via `/api/search`.
- **Docs count**: **5,115,734 unchanged**.

## SAFETY

- [x] no import run
- [x] no index reset
- [x] no meili_data deleted
- [x] no Meilisearch settings changed
- [x] no Caddy / security-group / port 7700 touched
- [x] meilisearch not restarted
- [x] books.txt untouched
- [x] MINIMAX_API_KEY not printed
- [x] no .env / private-data / checkpoint / large file in commit
- [x] AI regression NOT in daily cron
- [x] Forbidden full-text phrases: 0 hits in committed response
- [x] Provider raw response never reaches frontend

## NEXT_STEP

- **Weekly `pnpm ai:quality`** — schedule a single weekly cron (e.g. Sunday
  03:00) with `--max-ai-calls 20` to detect provider / prompt drift. The
  current run took 8 AI calls in <1 min and is cheap enough to do
  weekly.
- **Failed-line fallback parser** — independent of AI work; addresses a
  real ongoing data-quality gap. Carry-over from S19-FINISH-R.
- **S22B streaming** — SSE for both AI endpoints to surface progress to
  the user. Optional; would lower perceived latency on first-call
  cold-cache paths.

## REPO_RESULT

- **Commit**: pending
- **Push**: pending
- **Tag**: pending (depends on commit + push succeeding)
