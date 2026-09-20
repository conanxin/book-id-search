# BOOK-ID-SEARCH status

- task_id: `S32_M1C_PROJECT_BINDING_R1`; **COMPLETE_ON_BRANCH_AWAITING_PR_REVIEW**.
- Worktree: `/home/conanxin/codex-projects/book-id-search-s32-m1c`; branch: `feat/s32-m1c-project-binding`.
- source_baseline: `7295af6e991e2a5b1575b8c2a0b5d3662c093b9f` (actual remote main, includes PR #11).
- Implemented: explicit search → M1-A promotion → one EDITION binding → canonical project materials → binding-only removal. Independent S32 auth, shared Pool, same-origin requests, no schema changes.
- Verified: backend **170 tests PASS**, affected search/Web/WeRead **253 tests PASS**, disposable PG16 **1 integration PASS**, API/Web builds PASS. Frozen migration and both M0 SQL files unchanged; diff check PASS.
- Browser PASS: real catalog “京西商旅古道” (`14624320_000030433335`) added to existing “北京古道研究”; first201, repeat200/same binding; detail/refresh and API/PG restart preserve identical item. Cancel remove and actual DB503 failed DELETE retain item; confirmed remove leaves Work1/Edition1/Source1/ExternalIdentity3. Original project UUID/purpose/timestamps and volume retained. 390px width checked, no overflow. Empty-project browser state used a temporary UI mock only; primary persistence flow used real API/Meili/PG.
- Local pages: `http://127.0.0.1:5173/`, `/research/projects/36c19d98-85ad-48d6-8515-9698f563e89a`. Meili contains only 3 actual public catalog snapshots, no full index copy. [Runbook](operations/S32_M1C_LOCAL.md).
- tested_commit: `9fb19d4bbac0fb30ab3f2c6e7eb9748b1f4ecefc`. Subsequent documentation commits do not change tested code.
- Whole-suite additional check: **FAILED**, 15 failures in unchanged WeRead tests hardcoding `/opt/book-id-search`, plus one import-time CLI exit error; identical failures reproduced on old M1-B baseline. See local logs. No claim of whole-repository PASS. Existing Web bundle >500KB warning; favicon404 and intentional403/503/404 probes recorded.
- NOT_RUN: M0 SQL assertion/negative execution and standalone historical M1-A/M1-B real-PG suites; Windows-native rerun in this M1-C phase (prior dev-entry compatibility evidence is historical).
- Rulings: added missing dev-only Testing Library/jsdom26 and lock entries; app dependencies unchanged. Binding transaction rechecks/locks mutable parents. Fixed Meili0.52 nested error cause mapping via RED→GREEN; promotion semantics unchanged. Actual negative SQL path is `db/tests/002_s32_negative_invariants.sql`.
- Evidence: ignored `.superpowers/sdd/2026-09-20-s32-m1c-project-binding/progress.md`, `logs/s32-m1c/`; screenshots `/home/conanxin/codex-artifacts/s32-m1c/`. No credentials/screenshots committed.
- Implemented/tested/committed/pushed: **YES**. [PR #12](https://github.com/conanxin/book-id-search/pull/12) OPEN; [Issue #2 checkpoint](https://github.com/conanxin/book-id-search/issues/2#issuecomment-5746717450) read-back VERIFIED. MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; M1_D_STARTED=NO.
- Notion read-back VERIFIED: [M1-C design](https://app.notion.com/p/3e134a28189a81e199bfdff18fc1b444), [Implementation Plan](https://app.notion.com/p/3e134a28189a815eb0abee796dc64063), [project overview](https://app.notion.com/p/3dd34a28189a81d48f74ec74593dac5f). Same task_id/tested_commit/PR and merge/deploy flags.
- Final branch review: Critical0 / Important0 / Minor1. Deferred Minor: MONTH precision displays a placeholder day following the plan; current M1-A generates YEAR precision. No product changes after tested_commit; final_head is the later documentation receipt commit.
- Last production observation remains historical release-prep 2026-09-19 13:22:59 UTC; HOLD_CAPACITY_AND_AUTHORIZATION. No production/SSH access in M1-C.
- Next: 审阅 M1-C PR。Do not merge, deploy or start M1-D.
