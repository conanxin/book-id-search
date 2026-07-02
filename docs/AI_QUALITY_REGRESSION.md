# AI Quality Regression

## Why

S21A/S21A-TP2 and S22A introduced AI-driven features (AI 找书, AI 详情分析) whose
quality depends on:

- MiniMax model behavior (which can drift across versions)
- Prompt wording (small changes can produce large output variance)
- Sanitization logic (must keep forbidden phrases out of the response)
- Cache + fallback paths (must not regress)

This regression suite pins down a small, hand-curated set of cases so we can detect
regressions in any of the above without running a full import or re-indexing.

## When to run

- After any change to `apps/api/src/ai/` (prompts, sanitization, cache, fallback)
- After any change to the MiniMax `MINIMAX_MODEL` or `MINIMAX_WIRE_API` env vars
- After any change to the `AI_*` env section
- After upgrading the deployed MiniMax model
- Before tagging an AI-related release

## How to run

```bash
pnpm ai:quality
# or, with explicit public URL:
tsx scripts/ai-quality-regression.ts --public-url https://books.conanxin.com
# smoke mode (insight-weak-missing-isbn only, 1 AI call):
tsx scripts/ai-quality-regression.ts --case insight:insight-weak-missing-isbn
```

The script prints a terminal summary, then writes:

- `reports/ai-quality-regression-latest.json`
- `reports/AI_QUALITY_REGRESSION_LATEST.md`

If `pnpm` fails with a proxy error, use `tsx` directly via `./node_modules/.bin/tsx`
(see `scripts/ai-quality-regression.sh`).

## Status meanings

| Status | Meaning |
|--------|---------|
| **PASS** | All hard checks pass, ≤ 2 warnings, no failures. |
| **WARN** | No hard failures, but the model produced low-confidence output (e.g. unexpected ranking, weak semantic match). Investigate before tagging. |
| **FAIL** | Hard assertion failed: 5xx, key leak, forbidden full-text claim, multiple core misses, docs count anomaly. |
| **BLOCKED_AI_DISABLED** | `/api/ai/status` returned `enabled=false`; the script does not call any AI endpoint and exits. |

## Cases

### Search intent (`/api/ai/search-intent`)

| id | query | why |
|---|---|---|
| `japanese-shawl-camisole` | 日本人写的披肩吊带手工书 | S21A-TP canonical: should land 时尚秋冬披肩、吊带 at rank ≤ 5. |
| `isbn-description` | 帮我找 ISBN 是 978-7-5384-5525-0 的书 | ISBN normalization regression. |
| `scarf-fashion` | 想找关于围巾造型和服饰搭配的书 | Subjective semantic test. |
| `liao-architecture` | 有没有讲辽代佛塔或者古建筑的书 | Niche domain test. |
| `luxun-publisher` | 找一本人民文学出版社出版的鲁迅相关图书 | Publisher + author combined. |
| `low-confidence-weird-query` | 想找一本蓝色封面讲月球茶壶维修的中文书 | Must not 500, must degrade gracefully. |

### Book insight (`/api/ai/book-insight`)

| id | bookId | why |
|---|---|---|
| `insight-complete-book` | `13000000_000008232537` | Full book: scopeNote, subjectTags, caveats, basis fields, no forbidden claims. |
| `insight-weak-missing-isbn` | `13001363_000007809055` | Weak parseStatus + empty ISBN: trust level must downgrade to medium; ISBN 缺失 caveat must be present; no invented ISBN. |
| `insight-not-found` | `not_exist_000000` | 404 (not 500), no AI call. |

## Adding new cases

1. Identify a real edge case in the API or a real ambiguity the AI keeps misjudging.
2. Add a `live: true` case to `scripts/ai-quality-cases.ts` if you want it to actually
   call MiniMax. Add `live: false` for logic-only checks (404, shape, etc.).
3. Use `expected.*` fields to declare hard checks. Each check is PASS / WARN / FAIL.
4. Keep the case list small (≤ 12 live cases) so the regression stays within the
   `DEFAULT_MAX_AI_CALLS = 10` budget.

## Anti-fragility guidelines

- Use **WARN** for "model produced a sensible but unexpected ranking".
- Use **FAIL** only for: 5xx, key leak, invented full-text claims, multiple core misses,
  docs count anomaly.
- Tolerate minor wording variance — match on substrings, not full strings.
- Prefer `shouldContainAnyTerms` (OR) over `shouldContainTitle` (exact) when the AI
  may paraphrase the title in the matched-queries field.
- Never assert "trust level = low" — assert "trust level ≠ high" instead.

## Why this is NOT in the daily cron

- AI calls cost real money and rate-limited API quota.
- The model is deterministic enough across hours that daily runs are noisy.
- A weekly cadence (e.g. Sunday 03:00) is sufficient and far cheaper.
- If you need to confirm after a deployment, run it manually.

## When a case fails

1. Re-run the case in isolation: `tsx scripts/ai-quality-regression.ts --case <id>`.
2. If the failure reproduces, check whether the regression is in:
   - the **prompt** (try a slightly stronger wording in `INSIGHT_SYSTEM`)
   - the **sanitizer** (a forbidden phrase slipped through)
   - the **provider** (MiniMax changed wire API or model)
   - the **test case itself** (we asserted too strictly)
3. Fix the prompt / sanitizer, then re-run. If you change a case to be less
   strict, document why in the case comment.
4. Only commit + tag if the new run is `PASS` or `WARN` with no safety violations.
