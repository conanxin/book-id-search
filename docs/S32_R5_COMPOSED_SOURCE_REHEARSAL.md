# S32 R5 — Nonproduction composed-source integration rehearsal

**Research-only GitHub branch:** `research/s32-r5-combined-review`. **DO NOT MERGE THIS COMPOSED BRANCH.** It is not a substitute for independently reviewing and approving each upstream PR.

## Frozen source manifests

- Baseline included directly by ancestry: [PR #58](https://github.com/conanxin/book-id-search/pull/58) `32ba986d45dcfcc14cb2440363abdd46bfe37551` (Dossier).
- Direct parent commit (includes both #58 and R4): [PR #66](https://github.com/conanxin/book-id-search/pull/66) `ff92403b50f35089111ba0b3496973a05997bc8d` (auth scope + Run 404).
- Full exact per-file blob overlay of [PR #61](https://github.com/conanxin/book-id-search/pull/61) `7e0c3476736b11153953698858cf5e37b6e2b515`: **14 files** (P1-A Book Detail → Research).
- Full exact per-file blob overlay of [PR #62](https://github.com/conanxin/book-id-search/pull/62) `8995e43a710ca21e4fff5c134d51fa4a802d2dc2`: **11 files** (P1-B source-citation scope).
- Full exact per-file blob overlay of [PR #64](https://github.com/conanxin/book-id-search/pull/64) `055696468bd14996c26ebd420083228bb9a8573d`: **2 files** (CandidateClaims test-reliability fix).

These 27 paths are mutually disjoint and disjoint from the five file paths changed between #58 and #66. Compared to the parent #66 commit, GitHub returns exactly those 27 changed paths. Every file blob was retrieved by its exact recorded PR HEAD; the composed commit adds **no edits** to these 27 file contents.

## What this tests, and what it cannot prove

- This is **file-blob source composition**, not a Git merge commit, cherry-pick, or rebase. GitHub's `mergeable` indicator and zero overlapping changed paths are helpful but cannot prove semantic compatibility.
- Dedicated CI should test combined authorization generation, CandidateClaims canonical refresh, P1-A Book Detail and actual HTTP → disposable PostgreSQL16 insert/rollback, P1-B disclosure, Dossier/Run read-only flows, the historical Gate3 + Gate4 Chromium suites, scoped API/Auth/WeRead regression, and Web/API builds.
- No production environment, real personal data, normal PostgreSQL database, or Meilisearch index is part of this experiment. All PG16 and Owner fixtures are synthetic/disposable.
- This branch does not grant merge approval or relax existing release gates. A future **actually integrated** git HEAD requires its own review and exact-head CI; historical RED, retries, skips, full root WeRead 15 failures and unexecuted checks remain visible.
- CandidateClaims PR #64 is still an **independent open Draft** and its exact 12-repeat tests do not imply production Claim code changed.

## R5 decision protocol

1. Preserve each upstream PR's own exact HEAD/CI evidence.
2. Run dedicated combined CI and categorize failures as environment/startup, file-composition artifact, domain regression, or historical baseline.
3. If combined CI succeeds, record **integration rehearsal PASS** only; do not mark any PR `APPROVED`, `READY`, merged or production-deployed.
4. Proposed *separate authorized* merge order: #64 independent test fix (if approved); #58 Dossier parent; #66 R4 on top of #58; #61 P1-A and #62 P1-B as siblings, one by one with exact source retest after real integration. The #61/#62 order is not forced by file dependencies.
5. Update the canonical [S32 CURRENT_STATE](https://app.notion.com/p/3f434a28189a81adb352f5ce2a3e8afd), [S32 Issue #2](https://github.com/conanxin/book-id-search/issues/2), and the per-PR/Notion audit trail. In particular do **not** claim the complete repository root `pnpm test` passed when it was not run.

`TASK_ID=S32_R5_COMPOSED_SOURCE_CI_REHEARSAL | RELEASE=HOLD | MERGE=NO | PRODUCTION_CHANGED=NO`
