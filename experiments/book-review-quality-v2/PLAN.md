# Review evidence P3

Task: BOOK_REVIEW_EVIDENCE_P3. Parent is unmerged PR #86 at 3d796eaa7464def61a088142270729bdf99e52c0. Development only.

Implement a work-level candidate filter separating title/author cues, review/nonreview cues, and literal ISBN status. Keep the public bookClues/textContexts contract unchanged. The model still chooses IDs first; the filter can only remove those IDs. Preserve original sources. No new provider call or automatic full-text read.

Use limited normalization for explicit subtitle and author responsibility forms, visible English/traditional review cues, and negative document cues. Do not infer document type from a website, equate translations, verify editions from ISBN text, or infer nonexistence from rejection. Keep insufficient/conflicting evidence unselected. Pass per-field cut flags from snapshotSources.

Update API prompts and Web/copy scope text together: work-level commentary, version correspondence checked separately. No claim that every passed candidate is an independent review.

Validation: targeted matcher/service/routes/Web/evaluator tests and API/Web builds. Add new matcher and evaluator tests to existing library CI. Known unrelated root-suite failures from PR86 remain recorded; no repeat full-root run is planned without a new risk.

Evaluation: unchanged PR86 diagnostic inputs plus a new independently assembled set held back from the rule author until implementation is frozen. Freeze code and test hashes before disclosure, then report all results without tuning on that set. Labels stay assistant-provisional/human-review-pending; manual excerpts are not live search snippets. Keep old baseline policy and historical results reproducible. The separate 2026-11-18 source audit does not prove earlier browsing happened.

Deliver a draft PR targeting main and including the still-unmerged PR86 parent, with implementation, code/data hashes, test evidence and limitations. Update existing project/current records. No merge or production deployment is included in this phase.
