# BOOK-ID-SEARCH status

- task_id: `S32_M1C_MONTH_PRECISION_FIX_R1`; **FIX_VERIFIED_AWAITING_PR_REVIEW**.
- Worktree: `/home/conanxin/codex-projects/book-id-search-s32-m1c`; branch: `feat/s32-m1c-project-binding`; existing [PR #12](https://github.com/conanxin/book-id-search/pull/12).
- Fix base: `6b04f960241cf671f83bb1b425888cbff5b9e04f`; original M1-C source_baseline: `7295af6e991e2a5b1575b8c2a0b5d3662c093b9f`.
- Fix: MONTH `2001-02-01` displays `2001年2月`, never placeholder day `2001/2/1`; YEAR shows year, DAY full actual date, null `日期未知`. Only ProjectItems display and targeted tests changed.
- Actual RED: MONTH assertion received `<dd>2001/2/1</dd>`; exit1, 1 failed / 11 passed. GREEN: ProjectItems **12/12 PASS**; research scoped **39/39 PASS (3 files)**; Web build **PASS**; all exit0. Existing >500KB bundle warning remains.
- fix_tested_commit / tested_commit: `96aad3efb7f562282292e7fdfe254bcbe7da7628`; subsequent commit only updates this status document. Tested product source/tests are committed and pushed.
- **NOT_RUN_THIS_FIX**: real PG, full browser add/remove acceptance, disk audit, M0/M1-A, API build, full repository suite. No historical PASS is a rerun of this fix.
- Historical M1-C evidence at `9fb19d4bbac0fb30ab3f2c6e7eb9748b1f4ecefc`: 423 scoped PASS, real PG16 integration PASS, browser persistence/remove/390px PASS; whole-suite 15 legacy WeRead failures +1 CLI import error. Detailed original evidence remains in PR #12 and ignored `logs/s32-m1c/`.
- Unchanged by this fix: API, PostgreSQL store, schema/frozen SQL, promotion, binding transaction, same-origin/VITE_API_BASE_URL contract, dependencies, trial project and persistent volume. No service or database operations.
- Fix evidence/ledger: ignored `logs/s32-m1c-month-fix/`; [local runbook](operations/S32_M1C_LOCAL.md).
- GitHub: [PR #12](https://github.com/conanxin/book-id-search/pull/12) remains OPEN/unmerged; [Issue #2 fix checkpoint](https://github.com/conanxin/book-id-search/issues/2#issuecomment-5746897920) read-back VERIFIED.
- Notion read-back VERIFIED: [M1-C design](https://app.notion.com/p/3e134a28189a81e199bfdff18fc1b444), [Implementation Plan](https://app.notion.com/p/3e134a28189a815eb0abee796dc64063), [project overview](https://app.notion.com/p/3dd34a28189a81d48f74ec74593dac5f). Same fix task_id/tested_commit/PR and flags; earlier review's MONTH issue is fixed and awaits re-review.
- IMPLEMENTED=YES; TESTED=PASS_FIX_SCOPED; COMMITTED=YES; PUSHED=YES; MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; M1_D_STARTED=NO.
- Last production observation remains historical release-prep 2026-09-19 13:22:59 UTC; HOLD_CAPACITY_AND_AUTHORIZATION. No production access in this fix.
- Next: 复核 PR #12。Do not merge, deploy or start M1-D.
