# Book review evidence P4

Task: BOOK_REVIEW_EVIDENCE_P4. Base: PR87 7138bc7c248365a6c00c435d060d12cc023b95c5, including unmerged PR86. Development only; merge and deployment are separate.

## Product scope

Make explicit page-evidence questions identify the target work. In strict review mode, pass only the displayed public title, author and ISBN through the Web UI. Offer editable questions for work identity, review content and edition wording. Choosing a question fills the existing editor, invalidates obsolete evidence and makes no network request. The existing explicit Find action selects exact original passages from the current read snapshot. General research and legacy responses remain supported.

P3 candidate rules, model-selection prompts, public research/source API contracts and existing ISBN/text-context semantics stay byte-identical. Reading does not automatically promote a source or alter original cited IDs. No schema, dependencies, authentication or deployment configuration changes.

## Real-provider observation protocol

Before live search, freeze an actual-catalog task list from independently proposed new works: 枢纽, 祥瑞, The Great Divergence, A Little History of the World, Why Nations Fail. Missing catalog entries remain missing; no invented IDs or silent translation/edition substitutions. Before provider calls, explicitly include the two located English same-work records with different ISBNs and malformed title/author fields; preserve those fields exactly. The frozen protocol distinguishes them from the originally proposed reference editions. Three actual catalog tasks, two unlocated tasks; do not repair metadata in this phase. Use the current normal strict question and existing configured provider/model.

For each located work, allow one search request and at most one selection request, with no automatic retry. Capture the search client's actual parsed return before application truncation, the exact selector source snapshots, the selector reply, and the final source IDs separately. This is not a capture of raw HTTP, which is already normalized/deduplicated by the existing search client. Preserve all failed attempts and counts, including the internal web_search tool count.

Explicit CLI option --read-first 1 reads the first returned application source for each task, irrespective of candidate/selector outcome; failure is recorded and no next source is substituted. Use the actual existing reader. Save transient source/snapshot tokens neither in receipts nor committed reports. Full public text receipts stay in ignored progress; commit only provenance, hashes, summaries and provisional annotations.

Native local configuration is currently absent. Reusing the existing application's provider configuration may require one read-only ssh tencent operation; credentials remain in process memory and are not printed or saved. Stop on unavailable noninteractive access. No remote filesystem/container/configuration mutations. A blocked configuration or network trial remains blocked rather than becoming a fixture success.

## Evaluation and independence

P3 admission policy is frozen and not tuned in this phase. A separate evaluator sees title/excerpt evidence before any body text and without model/guard outcomes, then labels the fixed explicit-read outputs separately. Labels are assistant-provisional / human-review-pending. Unknown is not a negative. Report search, selector, guard and reader outcomes separately. No claim of online recall, verified edition, full-text accuracy or independent human evaluation.

## Verification

Run affected Native harness and Web tests plus API/Web builds, then existing CI on the final pushed commit. Preserve known PR86 full-root-suite failures; no unrelated broad test rerun. Keep PR/current Notion/overview task_id and tested_commit consistent. Do not post external messages or Issue comments. Keep progress logs ignored.
