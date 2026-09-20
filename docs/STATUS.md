# BOOK-ID-SEARCH status

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
