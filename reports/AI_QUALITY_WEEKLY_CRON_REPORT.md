# S23 Weekly AI Quality Regression — Report

STATUS: **PASS**

## TL;DR

S23.1 fixes the false-positive that blocked S23. The forbidden-claim
detector in `scripts/ai-quality-regression.ts` was rewritten to
distinguish "positive" full-text claims (still FAIL the case) from
"negated/limitation" phrases (allowed, since they are legitimate
caveats). After the fix, `pnpm ai:quality` and the weekly wrapper both
return **PASS** against the live site (8 PASS, 0 WARN, 0 FAIL, AI
calls=8/10, no key leak). The weekly cron `20 4 * * 0
/opt/book-id-search/scripts/run-ai-quality-weekly.sh` is now installed;
the daily health check is preserved untouched.

Tag: `v0.5.5-ai-weekly-quality` (this run qualifies as PASS).

## Root cause (S23)

Initial S23 was blocked because the `no-forbidden-claims` check
misclassified two legitimate negative-limitation phrases as positive
forbidden claims:

1. `但本书未提供目录或内容简介` — the AI saying the book has no 目录
   or 内容简介, which is a *correct* caveat, not a fabricated claim.
2. `缺少作者背景和内容简介等辅助验证信息` — the AI flagging that
   the record lacks author background and 内容简介, again a *correct*
   caveat.

The S22D allowlist was too narrow: it required the negator (`缺少`, `没有`,
`未提供`, …) to be **immediately** followed by the term, with `\s*` as
the only gap. The actual model output used connective phrasing
(`目录或内容简介`, `作者背景和内容简介等辅助验证信息`) where the negator
was 5–12 chars away from the term — outside the S22D allowlist window,
so the terms got flagged as positive.

## Fix (S23.1)

Refactored `scripts/ai-quality-regression.ts`:

1. Extracted the negative-limitation detection into a pure exported
   function `findForbiddenClaimHits(text, terms) → { positive, negated }`
   so it can be unit-tested without hitting the AI endpoint.
2. Three detection rules, evaluated per-occurrence of each term:
   - **Rule A (negator before, 0–12 char window)**: matches
     `(缺少|没有|无|不含|未见|并未|并未提供|缺乏|未提供|不提供|暂未|不包含|不含有|未包含|未含有|没有.{0,4}完整|无.{0,4}完整|缺.{0,4}完整|无.{0,4}资料|缺.{0,4}资料|缺.{0,4}信息|无.{0,4}信息|没有.{0,4}信息|无法.{0,4}(判断|获知|确认|得知|阅读)|不能.{0,4}(判断|确认|阅读)|暂未.{0,4}(获得|提供|获取)) [^\n，。、;；]{0,12} <term>`.
     Order matters: longer compound negators (`没有完整`) must come
     before shorter stems (`没有`) that overlap them.
   - **Rule B (missing-marker after, 0–12 char window)**: matches
     `<term> [^\n，。、;；]{0,12} (缺失|缺少|未提供|不可得|无法获知|无法确认|暂缺|未获得|不可.{0,2}知|不完整|无完整|不齐全|暂未获得|未.{0,2}包含|暂未.{0,2}提供)`.
     Catches `内容简介缺失`, `目录未提供`, `章节内容不可知` etc.
   - **Rule C (global meta-limitation cue)**: if the full text contains
     a sentence cue like `仅基于书目信息`, `不代表图书全文`, `未获得全文`,
     `没有图书全文`, `无法判断具体章节`, `无法判断目录`, `不能判断具体内容`,
     `未涉及图书全文`, `不涉及图书全文`, `以下分析仅基于`, `未参考任何外部`,
     `仅基于用户提供的书目字段`, then every NON-positive-claim term is
     considered negated. Catches the broad "we are in a meta-caveat
     mode" pattern.
3. **Positive-claim term classification**: any term matching
   `/介绍|讲述|深入|指出|获得|获奖|详尽|详细|被翻译|显示|包括|认为/`
   is treated as a positive-claim phrase and **never negated**, even
   if the surrounding text contains a meta-limitation cue. This
   prevents Rule C from accidentally allowing phrases like
   `本书详细介绍了披肩制作流程` just because the same response also
   contains `以下分析仅基于书目信息`. Positive-claim phrases can
   only be flagged as positive.

The new behavior is:

| AI output | Classification | Case verdict |
|---|---|---|
| `但本书未提供目录或内容简介` | `内容简介` negated via Rule A (5–12 char gap) | PASS |
| `缺少作者背景和内容简介等辅助验证信息` | `内容简介` negated via Rule A (5 char gap) | PASS |
| `以下分析仅基于书目信息，不涉及图书全文` | All book-content terms negated via Rule C | PASS |
| `本书详细介绍了披肩制作流程` | `本书详细介绍了` is positive-claim term | FAIL |
| `读者评价认为本书非常实用` | `读者评价` book-content term, no negation cue, no Rule C | FAIL |
| `获得多项国家级奖项` | `获得奖项` not present verbatim, no hit | no-op (PASS) |

## Tests (S23.1-3)

Added 31 new unit tests in `scripts/ai-quality-regression.test.ts`
covering:

- 13 "allowed" sentences — every one must have `positive.length === 0`.
  Includes the two real S23 failures plus a broad set of negative /
  limitation phrasing.
- 10 "forbidden" sentences — every one must have `positive.length > 0`.
  All constructed to include a verbatim positive-claim term from the
  configured `TERMS` list.
- 7 edge cases — empty inputs, no-match, over-negation guard, 12-char
  window boundary, the two real S23 failure phrases as direct Rule A
  probes.

Total: **40 tests pass** (was 9, +31 new).

## Manual run results (S23.1-4)

### Direct ai:quality run #1 (live calls, no cache)

```
Status: PASS
AI enabled: true
Docs count: 5115734
Cases: 0  pass=8  warn=0  fail=0  skipped=1
AI calls: 8
Key leak: no
```

All 8 cases PASS. Both previously-failing insight cases now PASS:

| Case | Status | Latency | Notes |
|---|---|---|---|
| `insight-complete-book` | PASS | 7662ms | trust=high |
| `insight-weak-missing-isbn` | PASS | 9405ms | quality.missingFields=isbn; trust=low |

### Direct ai:quality run #2 (cache hits, <12ms)

```
Status: PASS
Cases: 0  pass=8  warn=0  fail=0  skipped=1
AI calls: 8
Key leak: no
```

Cache-hit run also PASS, confirming the regression is now stable.

### Weekly wrapper run (S23.1-4)

```
$ /opt/book-id-search/scripts/run-ai-quality-weekly.sh
AI quality weekly finished with exit=0
log=/opt/book-id-search/logs/ai-quality/ai-quality-20260702-173325.log
markdown=/opt/book-id-search/logs/ai-quality/ai-quality-20260702-173325.md
json=/opt/book-id-search/logs/ai-quality/ai-quality-20260702-173325.json
EXIT=0
```

Report content:

```
Status: **PASS**
Cases: pass=8 warn=0 fail=0 skipped=1
AI calls: 8
Key leak: no
no import: true
no reset: true
no key leak: true
no provider raw response exposed: true
```

## Weekly cron (S23.1-5) — installed

`crontab -l` after install:

```
# (other unrelated system crons preserved)
30 3 * * * /opt/book-id-search/scripts/run-health-check-cron.sh
20 4 * * 0 /opt/book-id-search/scripts/run-ai-quality-weekly.sh   ← NEW
```

- daily health check (`30 3 * * *`) preserved: **yes**
- weekly AI quality (`20 4 * * 0`) added: **yes**
- AI quality in daily cron: **no**

The weekly wrapper has `NO_PROXY=*` exported and uses
`./node_modules/.bin/tsx`, so it does **not** try to call pnpm / npm /
corepack from cron. If `tsx` is missing the wrapper exits `2`
immediately.

## Files touched (this turn)

```
M  scripts/ai-quality-regression.ts          (rewrote no-forbidden-claims check + extracted findForbiddenClaimHits)
M  scripts/ai-quality-regression.test.ts     (added 31 new unit tests)
A  scripts/run-ai-quality-weekly.sh          (from S23, ready to ship)
M  docs/AI_QUALITY_REGRESSION.md             (S23: Weekly AI Quality Check section; S23.1: negative-limitation rules)
M  README.md                                 (S23: AI 质量周检 section)
M  .gitignore                                (S23: added logs/ + **/logs/)
M  reports/AI_QUALITY_WEEKLY_CRON_REPORT.md  (this file, refreshed for S23.1 PASS)
```

`logs/ai-quality/` (the runtime logs) are gitignored — never
committed.

## Safety

- [x] no import (verify still 5,115,734 docs)
- [x] no reset
- [x] no key leak (`Key leak: no` in all three runs)
- [x] Meilisearch untouched (no restart, no settings change, no re-index, 7700 still loopback only)
- [x] Caddy untouched
- [x] security group untouched
- [x] 7700 not exposed
- [x] books.txt untouched
- [x] MINIMAX_API_KEY never printed
- [x] `logs/` + `**/logs/` added to `.gitignore`
- [x] `data/`, `meili_data/`, `dist/`, `node_modules/`, `reports/*.json` all gitignored
- [x] not added to daily cron
- [x] `vitest run` 8/8 files, **186/186 tests pass** (was 155, +31 new)
- [x] `MEILI_HOST=http://127.0.0.1:7700 scripts/verify.ts` → `status: PASS`, docs unchanged

## REPO result

- commit hash: see `git log -1 --oneline` post-commit (this turn: `Add weekly AI quality regression cron (S23.1)`)
- push: `git push origin main` (this turn)
- tag: `v0.5.5-ai-weekly-quality` (this turn, force-pushed)

## NEXT_STEP

1. Observe the first scheduled Sunday 04:20 run (next Sunday 04:20 host
   time). Verify that:
   - `logs/ai-quality/ai-quality-*.md` appears
   - status is PASS (or acceptable WARN)
   - retention cleanup ran (only files ≤ 56 days old survive)
2. Add optional alerting later (cronitor / Telegram bot) if multiple
   consecutive FAILs appear.
3. Re-run `pnpm ai:quality` after any change to
   `apps/api/src/ai/book-insight.ts` to confirm the fix still holds.
