# Book review evidence P3

**Task:** BOOK_REVIEW_EVIDENCE_P3. Development candidate, not merged or deployed.
This branch includes the still-unmerged PR #86 parent (3d796eaa7464def61a088142270729bdf99e52c0), including its strict-copy fix. The PR targets main so the combined candidate is covered by the existing library and S32 workflows. The released baseline remains PR #85 (ce420a3c010b4a6bf1b261df374baf1d1cd85ef7).

## Product change

The old filter conflated three different questions: whether the text identifies the work, whether the page looks like a review, and whether an ISBN appears. Its ISBN alternative could admit a different-work review or a review-looking catalog, while exact author/title formatting rejected reasonable candidates.

The new internal assessment separates:

- **Work cues:** a headline title anchor plus author text; explicit colon-delimited main-title/subtitle compatibility needs an author cue. An exact full title can alternatively use a single visible target ISBN. Explicit author responsibility segments are recognized; editors/translators do not replace authors.
- **Document cues:** explicit review wording in the headline or selected excerpt, with visible catalog, sales, interview, roundup or conflicting-title text kept for manual checking. A book name containing “Review” or “Interview” is masked before genre detection. Neither URLs nor website reputation establish genre.
- **Edition text:** the existing literal ISBN status is reported independently. Other-only/mixed/absent ISBNs do not automatically disqualify an otherwise supported work candidate, nor do matched ISBNs verify an edition.

This is still a conservative heuristic, not proof of work identity or independent critical content. The model selects source IDs first; the filter can only remove IDs. It cannot retrieve missing sources or add an unselected source. All original sources remain available; public bookClues and textContexts keep their original literal meanings, and the internal assessment is not added to the API schema.

The service supplies exact title/excerpt cut flags while building snapshots. A page-age truncation does not hide an otherwise complete candidate. Cut headlines, incomplete authors or positive genre terms touching a known cut boundary are not completed from unseen text.

Search/selection prompts and the Web/clipboard notice now say work-level review with edition correspondence checked separately. The strict notice remains visible even with matched/mixed ISBN text. PR #86's request/response scope validation and copying fix remain intact.

## Freeze and independent sample protocol

A separate agent assembled 10 real public-page samples for five previously unused works without seeing the new rule implementation. The rule author did not see their titles, excerpts or labels before freezing the implementation.

- Sample freeze: **2026-11-18 07:37:40 Asia/Shanghai**.
- Raw sample SHA256: **97fc786e0928dd2ab19a1be6808d9c44a211c9201e36af5d4fdc523ad5e5f90f**.
- Rule freeze: **2026-11-18 07:53:06 Asia/Shanghai**, commit **8899d3092df5fbbcbbc397cffc259c68c736a7da**.
- rule-freeze.json records the policy, evaluator and test hashes before disclosure.
- holdout-frozen.json preserves the exact delivered bytes. adapt-holdout.py only maps field layout into holdout-cases.json; it never inserts label reasons, axes or page-level edition evidence into title/excerpt inputs.

After disclosure, one internal diagnostic field was renamed from work.multipleQuotedTitles to work.titleAmbiguous, because the flag also covers malformed brackets and conflicting subtitles. **No eligibility condition or evidence matching rule changed.** Reversing this field-name-only edit reproduces every one of the 13 frozen file hashes. All 36 case decisions and metrics match the first frozen evaluation; evaluation-receipt.json records the verification. The first frozen reports and test logs are retained in ignored progress/review-evidence-p3/.

No rules were tuned on the revealed sample. These samples are now known development data and must not be called unseen data for a future revision.

## Results

Labels are **assistant-provisional / human-review-pending**, not independent human gold labels. Samples are deliberately selected, not random, and inputs are short selected public-page fragments rather than actual new provider search results. The original dataset also contains three unchanged historical provider snapshots.

TP/FP/TN/FN below concern **work-level review candidate admission**, not live retrieval, the model's ID selection, final recommendations, or exact-edition verification.

| Set | Scored / excluded | PR85 TP / FP / TN / FN | P3 TP / FP / TN / FN |
| --- | --- | --- | --- |
| Original observed diagnostic inputs | 14 / 2 | 0 / 0 / 9 / 5 | 2 / 0 / 9 / 3 |
| Original synthetic controls, separately | 10 / 0 | 2 / 3 / 0 / 5 | 7 / 0 / 3 / 0 |
| Newly held-back public-page inputs | 10 / 0 | 0 / 1 / 4 / 5 | 2 / 0 / 5 / 3 |

On the held-back set, P3 admits two of five positive labels and no negative labels; PR85 admits only one negative. P3 descriptive precision is 2/2 and positive coverage is 2/5 **on this small set only**. Neither is an online quality estimate. In the original observed baseline, precision is undefined because no source is admitted, not 100%.

The two held-back admitted sources are the selected reader reviews of 江城 and 可能性的艺术. The same-ISBN bookstore page whose title contains 书评 is rejected, as are the author interview, publisher pages and a review of another work.

All three held-back English positives remain unselected. Their titles contain the site name “Kirkus Reviews”, and their excerpts contain authors and brief evaluations; the frozen rule does not treat that brand or those generic evaluation sentences as an explicit article-genre cue. The underlying pages are provisionally labelled reviews from page inspection. This is a real remaining coverage limitation; it is not evidence that those reviews do not exist. Three similar Kirkus templates also limit structural diversity.

Two held-back positive pages describe earlier releases than the reference paperback editions; edition evidence outside the excerpt is retained as annotation only. The app does not receive it through this benchmark.

## Diagnostic development and provenance

Before freezing, an independent code review identified malformed book brackets, unquoted conflicting subtitles, cut genre words, prefixed non-author roles and inconsistent title masking. Ten new cases first failed (27 existing cases passed), then were corrected. An initial broad validation had a patch-generated syntax error; that failed log is retained and the syntax was fixed before the completed validation.

The original historical catalog W5 was initially admitted because its synopsis said the book offered “评述”. The candidate was revised before freezing so generic commentary words in a synopsis do not establish the document genre, and visible inventory/rating sections conflict with independent-review selection. This is training feedback, not held-back evidence.

The original cases.json and historical results.json remain byte-identical to PR86. baseline-guard.ts preserves the PR85 function verbatim as an experimental comparator; it is no longer application policy. The existing literal clue extractor is unchanged.

source-audit.json records an actual separate-agent revisit of all 13 original page_excerpt URLs on **2026-11-18**, retaining five yes, six no and two uncertain labels. It does not retroactively prove browsing on the previous date. Four inputs combine nonadjacent metadata fields. Several whole-page positives have no genre evidence in the tiny input; full-page labels and available input evidence must not be conflated.

## Verification

Completed Native verification before disclosure:

- **433 tests / 8 files passed:** candidate 39, service 90, routes 18, literal clues 18, Web client 181, React 73, P2 evaluator 10, P3 evaluator 4.
- API TypeScript and Web TypeScript/Vite builds passed. The existing large Web bundle warning remains.
- The field-name-only correction subsequently passed all 39 matcher tests, reproduced all 13 frozen file hashes after reversing that name, and preserved all 36 admission decisions.
- Service tests verify that only model-selected IDs are filtered, all sources survive, page-age truncation does not suppress a valid candidate, internal assessments stay out of the response, and general research behavior stays unchanged.
- React/client tests retain strict scope and version text in all three copy states, including matched/mixed ISBN examples and unchanged private drafts.
- New matcher plus both evaluators are included in the existing library CI test command. Current final-commit remote results are reported in the PR.

The full root suite was not repeated: PR86's 16 failures and one import-time unhandled error remain uncorrected and must not be described as a green repository. This change does not touch those WeRead/S32Principles cases. No frozen SQL, schema, dependency, authentication or deployment setting changed. New live model calls, production access, merge and deployment: **0**.

## Reproduce

Use the existing frozen workspace dependencies:

```bash
python3 experiments/book-review-quality-v2/adapt-holdout.py
node --import tsx experiments/book-review-quality-v2/evaluate.ts experiments/book-review-quality-v1/cases.json /tmp/review-p3-diagnostic.json
node --import tsx experiments/book-review-quality-v2/evaluate.ts experiments/book-review-quality-v2/holdout-cases.json /tmp/review-p3-holdout.json
corepack pnpm exec vitest run apps/api/src/ai/book-web-review-candidate.test.ts apps/api/src/ai/book-web-research.test.ts apps/api/src/ai/book-web-research-routes.test.ts apps/api/src/ai/book-web-source-clues.test.ts apps/web/src/library/bookWebResearch.test.ts apps/web/src/library/BookWebResearch.test.tsx experiments/book-review-quality-v1/evaluate.test.ts experiments/book-review-quality-v2/evaluate.test.ts --maxWorkers=2
```

Every case URL, input fragment, provisional reason and version annotation is inspectable in the JSON files. More useful next evidence is real provider-returned snippets across additional books, with fuller article evidence where explicit user-requested reading is available, and an independently prepared new sample for any further policy revision.
