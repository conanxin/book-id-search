# BOOK-ID-SEARCH status

- task_id: `S32_M1D_NUL_INPUT_FIX_R1`; **FIX_READY_FOR_REVIEW**; existing [PR #13](https://github.com/conanxin/book-id-search/pull/13).
- Worktree: `/home/conanxin/codex-projects/book-id-search-s32-m1d`; branch: `feat/s32-m1d-note-revisions`; original source_baseline: `51c63b1dc45890bd5989d6bf6442d8ab7aaccc74`; fix_base: `4c5f5d2415439f72b074c286c3bfd582297794a9`.
- NUL content is rejected after newline normalization, before hashing/store, using `InvalidNoteInputError`. Create and append share this domain validation and return HTTP400 / `NOTE_INVALID_INPUT` without store calls.
- fix_tested_commit / tested_commit: `c3cd9af2119b47b272a04548ceb69daa249459e6`. Subsequent commit is status documentation only; final_head is the current PR head.
- TDD: domain RED **1 failed / 19 passed**; HTTP RED **2 failed / 30 passed** (create/append reached test store). GREEN targeted **52/52 PASS** (domain20 + HTTP32); S32 scoped **264 PASS / 19 SKIP** (17 passed / 4 skipped files); API build and `git diff --check` **PASS**. All GREEN commands exit0; both RED commands exit1.
- Product diff: `domain/note.ts` and two targeted tests only. Store, Note/Revision transactions, binding removal, schema/frozen SQL, frontend, JSON body limit and dependencies unchanged. No trial DB/volume or production operations.
- **NOT_RUN_THIS_FIX**: real PG16, full browser acceptance, Web build, M0/M1-A/B/C runners, full repository suite. Skipped integrations are not PASS. Historical M1-D PG/browser/Web results and unrelated full-suite failures remain historical, detailed in PR; none are claimed as rerun.
- Current evidence/ledger: ignored `logs/s32-m1d-nul-fix/`. Historical M1-D evidence: `logs/s32-m1d/`, `/home/conanxin/codex-artifacts/s32-m1d/`, original plan ledger; [local runbook](operations/S32_M1D_LOCAL.md).
- GitHub **SYNCED / read-back verified**: [PR #13](https://github.com/conanxin/book-id-search/pull/13), [original NUL discussion reply](https://github.com/conanxin/book-id-search/pull/13#discussion_r4056329571), [Issue #2 checkpoint](https://github.com/conanxin/book-id-search/issues/2#issuecomment-5748198803).
- Notion **SYNCED / read-back verified**: [design](https://app.notion.com/p/3e134a28189a811db24af230e365488a), [implementation plan](https://app.notion.com/p/3e134a28189a811d8d99d10ea485ee8e), [overview](https://app.notion.com/p/3dd34a28189a81d48f74ec74593dac5f); same task_id/tested_commit/PR/flags. No duplicate pages.
- IMPLEMENTED=YES; TESTED=PASS_NUL_FIX_SCOPED; COMMITTED=YES; PUSHED=YES; MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; M1_E_STARTED=NO.
- Last production observation remains historical release-prep 2026-09-19 13:22:59 UTC. This fix performed no production access.
- Next: review PR #13. No automatic merge/deploy/M1-E.
