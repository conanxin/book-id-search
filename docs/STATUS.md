# BOOK-ID-SEARCH status

- Phase/task: S32 release preparation / `S32_RELEASE_PREP_CODEX_R1` (IN_PROGRESS).
- Baseline: remote main `630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d`; M0 and M1-A merged. Planning branch read only, not merged.
- Worktree: `/home/conanxin/codex-projects/book-id-search`, branch `feat/s32-release-packaging`, reuses the existing clone at `/mnt/d/home/conanxin/workspace/book-id-search`.
- Latest production observation: 2026-09-19 13:09 UTC via `ssh tencent`; identity `ubuntu@VM-0-4-ubuntu`, checkout `9a18b2aa86c7cb1b27f6e99f9f5911e80b7b61ec`; Web `99a3702c…`, API `3add9a60…`, Meili `v1.48.3` running. Root free 21,804,048,384 B, used 79%. Production unchanged.
- Current work: lockfile API image, final fifth-layer Compose template, targeted checks and incremental space budget. `tested_commit=NOT_YET_TESTED`; no PR yet.
- Next: build/test the committed release content locally, then push a review PR and synchronize evidence. Merge/deployment remain unauthorized; no M1-B.
- Evidence: [release preparation](operations/S32_RELEASE_PREP.md); local checkpoint `progress/S32_RELEASE_PREP_CODEX_R1.md` (ignored).
- Sync: [Issue #2](https://github.com/conanxin/book-id-search/issues/2), [Notion overview](https://www.notion.so/3dd34a28189a81d48f74ec74593dac5f), [Notion readiness](https://www.notion.so/3e034a28189a813591d5dc1da8412331).
