# BOOK-ID-SEARCH status

- Phase/task: S32 release preparation / `S32_RELEASE_PREP_CODEX_R1`, **READY_FOR_REVIEW**, [PR #10](https://github.com/conanxin/book-id-search/pull/10).
- Baseline: main `630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d` (M0/M1-A merged); planning branch read, not merged.
- Built/tested code: `ce65f1a9bf105ca08b439595ffc3800f9efedbc8`. Later commits only record evidence/status; the image's source SHA remains this tested commit.
- Worktree: `/home/conanxin/codex-projects/book-id-search`, branch `feat/s32-release-packaging`; reuses the clone at `/mnt/d/home/conanxin/workspace/book-id-search`.
- Implemented/tested/committed/pushed: **YES**. Merged/deployed/production changed/M1-B started: **NO**.
- Tests: local Docker build + API typecheck PASS; image dependency/frozen-lock/default-off/auth/missing-DB smoke PASS; 11 files / 166 unit tests PASS; Compose fixture and actual sanitized four-layer production baseline PASS. No full-suite or real-PG rerun this round; M0 migration/two SQL files and Web unchanged.
- Image: `sha256:265e810e7fb120db01076171242b19d7c069548b9e51e67b8f001432573f0319`, 247,862,411 B; gzip archive 80,387,312 B. No registry publication/RepoDigest.
- Latest production observation: **2026-09-19 13:22:59 UTC**, via `ssh tencent`, `ubuntu@VM-0-4-ubuntu`; checkout `9a18b2aa86c7cb1b27f6e99f9f5911e80b7b61ec`. Web `99a3702c…`, API `3add9a60…`, Meili `v1.48.3` running, unchanged. Root free **21,784,965,120 B / 20.2888 GiB**, used 79%.
- Estimated new peak **1.9412 GiB**, resulting free **18.3476 GiB**; shortfall to keeping 20 GiB **1.6524 GiB**, to 21 GiB **2.6524 GiB**. Production execution remains **HOLD_CAPACITY_AND_AUTHORIZATION**. No cleanup, expansion or reserve waiver.
- Evidence and reproducible steps: [S32 release report](operations/S32_RELEASE_PREP.md). Logs/archive: ignored `logs/s32-release-prep/`; checkpoint/sync receipts: ignored `progress/S32_RELEASE_PREP_CODEX_R1.md`.
- Sync: [Issue #2](https://github.com/conanxin/book-id-search/issues/2), [Notion overview](https://www.notion.so/3dd34a28189a81d48f74ec74593dac5f), [Notion readiness](https://www.notion.so/3e034a28189a813591d5dc1da8412331). Final write receipts stay in the local checkpoint; do not infer synchronization from these links alone.
- **Unique next step: review PR #10.** Merge/deployment require separate explicit authorization.
