# Book review quality — P2 diagnostic casebook

**Task:** `BOOK_REVIEW_QUALITY_P2`. Production baseline: PR #85, `ce420a3c010b4a6bf1b261df374baf1d1cd85ef7`.

## Reproduce

From the repository root, using its existing frozen dependencies:

```bash
corepack pnpm exec vitest run experiments/book-review-quality-v1/evaluate.test.ts --maxWorkers=1
node --import tsx experiments/book-review-quality-v1/evaluate.ts
```

The evaluator imports the actual application clue extractor and candidate guard. No copied replacement regex, new dependency, network request, provider call, database access, or production write is used. `cases.json` stores inputs and annotation reasons; `results.json` stores every verdict plus input and application-source hashes. An alternate input/output path can be supplied as the first/second CLI arguments. Merely importing the evaluator does not run its CLI or create output files.

## What this measures

This is a **purposively selected diagnostic casebook**, not a representative search benchmark, held-out sample, or demonstration of improved retrieval. Labels were assessed by the assistant from reopened source pages and existing captures. **No human adjudicator has approved them.** `humanReview=pending` is explicit on every case.

The principal label asks whether the source is a focused independent review/commentary of the **work**, not whether it proves a particular ISBN/printing. Edition correspondence is a separate field. A source can be a real review of the work but discuss an older release. Rejecting it is then not necessarily a mistake under an exact-edition-only objective. No exact-edition precision/recall is claimed.

Three strata must not be confused:

- `historical_search`: 3 unchanged public provider source records, read from the prior user's local capture. Capture hash and source IDs are included; no tokens or personal material were copied.
- `page_excerpt`: 13 reopened public pages, represented by their visible titles and deliberately selected short verbatim evidence. These are **NOT live search-provider snippets**, not complete pages, and not assertions that all evidence was returned by the app.
- `synthetic`: 10 explicitly constructed controls isolating language, author responsibility labels, subtitle variants, incidental ISBNs and review-looking nonreview headings. They never enter observed-source rates.

Uncertain genre judgments are excluded from the confusion matrix. Precision is `null` when nothing is admitted; accepting nothing cannot earn 100% precision. Rates are descriptive only. Case labels, not URLs or website reputation, are the scoring target.

## Findings from this run

| Stratum | N | Judged / excluded | TP / FP / TN / FN | Precision | Work-review candidate recall |
|---|---:|---:|---|---:|---:|
| Unmodified prior search captures | 3 | 3 / 0 | 0 / 0 / 3 / 0 | undefined | undefined |
| Short public-page excerpts | 13 | 11 / 2 | 0 / 0 / 6 / 5 | undefined | 0/5 |
| Combined observed inputs | 16 | 14 / 2 | 0 / 0 / 9 / 5 | undefined | 0/5 |
| Constructed controls, separately | 10 | 10 / 0 | 2 / 3 / 0 / 5 | 2/5 | 2/7 |

Five book/work identities are covered: 梁思成 (2012), 置身事内, 叫魂, The Soul of a New Machine and Seeing Like a State. The actual guard rejects every observed input. This blocks the saved false recommendation but also prevents progression to further inspection for all five work-review positive examples in this small casebook. Two of those reviews concern older releases than the reference editions. These figures **do not mean the app's online recall is 0%, or that any book has no reviews**.

The strongest controlled failures are:

1. Adding `著` to the catalog author or storing both author/editor in one string can turn a candidate rejection on with unchanged source text.
2. A short catalog title and the same work's title including a subtitle behave differently under exact `《…》` matching.
3. English `Book Review` and traditional Chinese `書評` do not match the current simplified-Chinese cue set.
4. A title mentioning reviews plus a target ISBN can admit a catalog or interview. A mixed-ISBN source can pass even when its principal subject is another work.

These are reasons to redesign and test the gate, **not** to silently relax the production policy. The gate itself remains unchanged in this PR.

## Independently reproduced client defect

The strict response carries `scope=direct_book_review`. Request and view validation pass the expected scope, but `bookWebResearchContent` did not. Its second validation therefore rejected otherwise valid strict results during copying.

Three new tests first failed on the exact scope comparison (`web_research`, `insufficient_sources`, `unselected_sources`); unknown scope was already rejected. The minimal fix passes the response scope into copy-time validation and retains the strict-mode notice in exported text. Transport still validates response scope against the requested scope. Three sidebar copy journeys cover the actual React copy path and unchanged private draft text. No API behavior, database, auth rule or selection policy is changed.

## Evidence and limits

Every external source URL and annotation rationale is in `cases.json`; reference catalog sources are under `books`. Baseline captures remain in the original local release worktree. Test logs and operational receipts are in ignored `progress/review-quality-p2/`. `PLAN.md` records scope and alternatives.

The next research step is independent human review of labels and a larger **held-out** set covering genuine positive reviews without ISBNs, negative pages with review words, and explicit version ambiguity. Work identity, document genre and edition evidence should be measured independently before any new gate is deployed.

## Verification on 2026-11-17

- New copy regression first failed in all 3 valid strict-result states (unknown-scope rejection passed). Metric tests first failed on all 3 metric assertions. Both original failure logs are retained.
- Final targeted run: **351/351 tests in 4 files** (API 87, Web client 181, React component 73, evaluator 10). Web TypeScript/Vite build passed; its pre-existing large-bundle warning remains.
- Full root `TZ=Asia/Shanghai corepack pnpm test --maxWorkers=2`: **EXIT 1, 7,028 passed / 16 failed / 105 skipped, plus 1 unhandled error**. No repeat root run was used to erase this result.
- 15 failures are in `scripts/weread/audit-confirmed-matches.test.ts`, `scripts/weread/build-duplicate-catalog-review.test.ts`, and `scripts/weread/repair-confirmed-match-review.test.ts` with `spawnSync /bin/sh ENOENT`. One is `apps/web/src/components/S32Principles.test.tsx`, expecting a removed App import. The separate error is import-time `process.exit(1)` from `scripts/weread/apply-match-review.ts`. Each affected test and corresponding implementation/App source is byte-identical to the released baseline. Their root causes were not repaired or reclassified by this PR.
- The evaluator, API guard, client and new UI tests passed in both the focused and root runs. Passing selected checks is not a fully green repository claim.
- An initial baseline-only command exceeded its 30-second command budget before producing a final test summary; it is not counted as a passed baseline. The retained final focused run has a complete exit-0 receipt.
- No API selection code, frozen SQL, dependencies, deployment configuration, source prompts or production service changed.

## P3 provenance and frozen-comparator note — 2026-11-18

The original cases.json and results.json are retained byte-for-byte. P3 changes the application gate, so this P2 evaluator now imports baseline-guard.ts, a verbatim copy of the PR85 function, instead of silently measuring a changed policy while labelling it P2. The literal clue extractor is unchanged. New comparisons belong to ../book-review-quality-v2/; do not overwrite this historical report.

A separate assistant actually reopened all 13 page URLs on 2026-11-18 and recorded inspectable renderings in ../book-review-quality-v2/source-audit.json. This provides provenance for that date; it does not retroactively prove browsing on 2026-11-17. Four inputs join nonadjacent metadata fields, so they are selected excerpt segments, not single contiguous quotations. Page-level positive labels may have no genre evidence in the tiny evaluator input; absence of a cue is not a finding that the whole page is not a review. All annotations remain human-review-pending.
