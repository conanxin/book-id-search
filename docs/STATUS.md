# BOOK-ID-SEARCH status

## M2-D Assessment — implementation checkpoint

- task_id: `S32_M2D_ASSESSMENT_EXECUTION_R1`; branch `feat/s32-m2d-assessment`; implementation base `eddc0c1ef2d89870ffe9c5a40e0c5e881b5bc627` (approved spec+plan atop `main@59476a97739c13ed039ab315cad8e29c85acf94a`); exact verified implementation head before this status-doc commit `995b328e231c2f3a1fad2325531e29eed8cb0e73`; PR #18 draft.
- Implemented CQRS-lite Assessment flow: shared Project evidence authorization; 1..100 Manifest bound; strict Assessment domain/application contracts; SERIALIZABLE atomic Manifest+Items+Assessment command store with idempotent replay; REPEATABLE READ Project-scoped history/detail with visibility-before-integrity and keyset pagination; private routes; strict Web client; sessionStorage pending committed-intent receipt; Claim-card Evidence → Assessment Composer → History → Detail surfaces with independent degradation.
- Fresh GitHub exact-head gates at `995b328e...`: API S32 scoped **585 PASS / 70 SKIP** (43 files PASS / 9 SKIP); Web research **306 PASS** (22 files); M2-C real PG16 **13/13 PASS**; M2-D real PG16 **13/13 PASS**; schema static **23/23 PASS**; `FROZEN_SQL_CHANGED=NO`; API build PASS; Web build PASS.
- Fresh real Firefox acceptance at the same head: **1/1 PASS (10.4s)**; response-unknown same-key replay returned 200 with the exact Assessment; `M2_D_REAL_BROWSER=PASS`; `M2_D_MOBILE_390x844=PASS`; disposable browser PG container removed.
- Full repository suite at the same head: **4258 PASS / 16 FAIL / 70 SKIP**, 154 passed / 4 failed / 9 skipped files; `FULL_SUITE_EXIT=1`. The 16 failures remain the unrelated Weread set already documented (three shell/cwd suites plus the reading-archive timezone assertion); they are reported exactly and are not relabeled as PASS.
- Final whole-branch review: self-review because this harness has no reviewer-subagent tool. Reviewed command/read privacy boundaries, idempotency replay, stale-preview/atomic write path, browser receipt/recovery, and Review Focus cases; **0 Critical / 0 Important** findings. CI exposed an acceptance-harness/product interaction around post-commit evidence reuse; RED browser failures were resolved by preserving selected evidence while consuming only the preview, then re-previewing for the next Assessment intent.
- `M2_D_IMPLEMENTATION=COMPLETE_ON_BRANCH`; `M2_E_STARTED=NO`; `FROZEN_SQL_CHANGED=NO`; `PRODUCTION_CHANGED=NO`; `PRODUCTION_DEPLOYED=NO`. This status-doc commit still requires the exact-head CI smoke before merge review.

## M2-C Evidence Selection — current checkpoint

- task_id: `S32_M2C_EVIDENCE_SELECTION_EXECUTION_R1`; branch `feat/s32-m2c-evidence-selection`; baseline `8f5b4829b172ebae6a0f99201237da0e5666a33b`; spec `23f47490cb5fc9bd872409c98ca24c27f14c0af5`; plan `951ae496ea01bad05897bba65ac52d50ef1b009b`. See the PR for tested_commit and full evidence.
- Implemented evidence manifest draft domain (canonical fixed-order JSON + server-authoritative SHA-256), selection application service, read-only REPEATABLE READ Postgres store (candidates + preview authorization in one query each), private routes on the shared Pool, strict Web client, and a page-local EvidenceEditor with explicit roles and preview invalidation.
- Gates: targeted API 43 PASS; API S32 scoped 500 PASS/52 SKIP; targeted Web 65 PASS; Web research 247 PASS; Web broad 2842 PASS; API/Web builds PASS; schema static PASS; real PG16 8 PASS (disposable container removed); ZERO_WRITE_PG_GATE=PASS; frozen SQL unchanged; diff check clean. Full suite fresh: 4115 PASS / 15 known unrelated weread FAIL / 1 known weread unhandled rejection.
- Real Firefox 146.0.1 acceptance: candidates PASS (no storage_key/remote_uri/note content leakage); explicit roles PASS (no default role); preview PASS (persisted=false, no Manifest ID); preview invalidation PASS (5 mutations); old immutable NoteRevision preview PASS; cross-Project rejected with foreign≡nonexistent identical 404s; independent degradation PASS; no browser persistence, reload discards draft; archived read PASS; DB zero-write PASS (six-table counts unchanged); mobile 390×844 no overflow PASS.
- Whole-branch review PASS (self-review, no fresh reviewer): 11 inspections, 0 Critical/Important, 1 Minor deferred (declared-source-missing asymmetry between candidates vs preview authorization paths).
- MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; M2_D_STARTED=NO. Next: PR review.

## M2-B Candidate Claims — current checkpoint

- task_id: `S32_M2B_CANDIDATE_CLAIMS_EXECUTION_R1`; branch `feat/s32-m2b-candidate-claims`; tested_commit `495c75f5cffdcbffa5d3b6bb5173f039d0f0da64`; baseline `beb3888600c6c9520624093da00619d74a15d68f`; spec `98e521c1962ef9c6152badef541ac3ab1fa1bd99`; plan `eb334d756d07b06a7cb6703d0cf56aa7922b9a8f`.
- Implemented Claim domain (normalize/hash, 1-4000 chars), application service, atomic Postgres store (idempotency-scoped create/replay, lifecycle gates, fail-closed dangling checks), private routes on the shared Pool, Web client with three-state pending-receipt authority, and a separately degradable claims section in Issue Detail.
- Gates: targeted API 55 PASS; API S32 scoped 455 PASS/44 skipped; targeted Web 49 PASS; Web research 202 PASS; Web broad 2797 PASS; API/Web builds PASS; schema static 23 PASS; real PG16 12 PASS (disposable container removed); frozen SQL unchanged; diff check clean.
- Real Firefox 146.0.1 hard acceptance (external runner, no repo dependency changes): normal create PASS; response-unknown PASS (same idempotency key replay 201→200, same claim id, 1 claim/1 relation, statement frozen); read-only replay PASS (archived project + resolved/archived issue: list 200, new key 409, completed key 200 same claim); independent degradation PASS; mobile 390×844 no overflow PASS; API+PG restart persistence PASS; acceptance temp data cleaned, dev fixture preserved.
- Final whole-branch review PASS (lifecycle drift replay, cross-Project privacy/idempotency namespace, historical Claim compatibility, dangling fail-closed, storage asymmetry). Full suite fresh recount: 4025 PASS / 15 known unrelated weread FAIL (3 files, spawnSync cwd assumption, first-commit 2026-07-03) / 1 known weread unhandled rejection.
- MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; M2_C_STARTED=NO. Next: PR review.

## PR #15 review fixes — current checkpoint

- task_id: `S32_M2A_PR15_REVIEW_FIX_R1`; FIX_BASE: `84fbb58a585de1c60dc0cd2a24f71719d4a491d3`; FIX_TESTED_COMMIT: `5c145811f8b88d660ff5fb7123127714b45a6103`; [PR #15](https://github.com/conanxin/book-id-search/pull/15) awaits rereview.
- Fixed unconfirmed draft locking, memory receipt fallback, duplicate Materials section, and literal Unicode White_Space normalization with matching server/Web hashes. Targeted RED demonstrated the defects before implementation.
- Targeted API 67 PASS; targeted Web 51 PASS; API S32 400 PASS / 32 SKIP; Web research 155 PASS; Web broad 2750 PASS. API/Web builds and schema static 23 PASS. PG16 7 PASS, container removed. Frozen SQL unchanged; diff check PASS.
- Real browser dropped the response after a committed 201, confirmed both fields disabled, then replayed identical payload/key with 200 and the same Issue. SQL confirmed one Issue and one owner binding. Ready Materials has one heading/section. Evidence: `logs/s32-m2a-review-fix/` and `/home/conanxin/codex-artifacts/s32-m2a/pr15-fix-*.png`.
- Full suite: 3923 PASS / 32 SKIP / 15 known unrelated FAIL plus the known CLI-import error, unchanged from baseline. Initial parallel suites hit three resource-contention timeouts; sequential `--maxWorkers=1` reruns passed without product changes.
- MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; M2_B_STARTED=NO. Next: rereview PR #15.

## Original implementation evidence (historical)

- task_id: `S32_M2A_RESEARCH_ISSUES_NATIVE_R1`; implementation is complete on branch `feat/s32-m2a-research-issues` in `/home/conanxin/codex-projects/book-id-search-s32-m2a`.
- source_baseline: `4204815f8a550ad8ce9fa0ab7bdf4afe486f1e56`; spec: `35f3b422ad46972d0af8fcbd95e0d8d7d26b508e`; plan: `b8f966209ec2cbcfd55d60f464edcbe236f3f392`; tested_commit: `35c9daac6e558e0be6a5136510645454d04de23e`.
- Implemented Project-owned Research Issues with OPEN-only idempotent creation, canonical single-owner integrity checks, independent list/detail reads, archived read-only behavior, pending browser receipts, Project Issues UI, and a dedicated Issue Detail route. M2-B was not started.
- API S32 scoped: **399 PASS / 32 SKIP** (28 passed / 6 skipped files). Web research: **152 PASS** (11 files). Web broad: **2747 PASS** (67 files). API/Web builds, schema static (**23 PASS**), frozen SQL diff, and `git diff --check` passed.
- Disposable PostgreSQL 16: **7 PASS**; `S32_M2A_REAL_PG=PASS`; `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`. It proved concurrent idempotent create, key conflict, archived completed replay, rollback atomicity, integrity failures, and cross-Project privacy using only the frozen M0 migration.
- Real browser ACTIVE acceptance created `刘祥店迁出时间`, opened its dedicated detail, returned to the canonical list, and preserved it after refresh. Response-unknown acceptance committed the POST while the browser response was deliberately dropped, showed the unconfirmed state, retried the same idempotency key, recovered the exact Issue, and left one Issue/owner binding.
- Real browser ARCHIVED acceptance kept list/detail readable, hid creation, returned `409 PROJECT_READ_ONLY` for a new key, replayed a completed key with `200`, and left counts unchanged. The local Project was restored to ACTIVE.
- Independent degradation passed in both directions: Issue failure did not hide Materials, and Overview failure did not hide Issues. Restarting the local API and development PostgreSQL container preserved list/detail and completed replay. Firefox at 390×844 had no horizontal overflow on the Project section, create form, or Issue Detail.
- Evidence is ignored under `logs/s32-m2a/` and `/home/conanxin/codex-artifacts/s32-m2a/`.
- Full repository test: **3919 PASS / 32 SKIP / 15 FAIL**, 129 passed / 6 skipped / 3 failed files, plus one unhandled error. Failures exactly matched the known unrelated 15 WeRead cwd failures and the `apply-match-review.ts` import-time exit; no new scoped failure appeared.
- IMPLEMENTED=YES; TESTED=PASS_WITH_KNOWN_UNRELATED_FULL_SUITE_FAILURES; COMMITTED=YES; MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; PRODUCTION_DEPLOYED=NO; M2_B_STARTED=NO.
- Next: open and review the single M2-A PR. Do not merge, deploy, or start M2-B.
