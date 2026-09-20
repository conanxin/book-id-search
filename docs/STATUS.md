# BOOK-ID-SEARCH status

- task_id: `S32_M1D_NOTE_REVISIONS_R1`; **LOCAL_VERIFIED_PENDING_BRANCH_REVIEW**.
- Worktree: `/home/conanxin/codex-projects/book-id-search-s32-m1d`; branch: `feat/s32-m1d-note-revisions`; source_baseline: `51c63b1dc45890bd5989d6bf6442d8ab7aaccc74`.
- Implemented: one Note per Project EDITION binding; normalized ≤65536 UTF-8 bytes + SHA256; immutable revision append/history; stale-write conflict; Note-aware Edition removal guard; private same-origin API/shared Pool; on-demand Note UI with retained stale drafts.
- tested_commit: `1a7aa59115957748f62ea8a3447d451bfb928e55`. Later changes currently documentation only.
- Backend scoped **284/284 PASS (18 files)**; Web/search affected **281/281 PASS (12 files)**, including research **75/75 PASS (5 files)**; API/Web builds **PASS**. Existing >500KB Web bundle warning remains.
- Independent tmpfs PG16 **10/10 PASS**, own container removed. Covers both create/remove lock orders, concurrent create/stale append, immutable history/ownership and create/append rollback. Frozen migration/two SQL checks unchanged; diff check PASS.
- Real headed Chromium: actual catalog → 北京古道研究 → R1 → refresh → R2/history R1 → two tabs R3/stale409 with retained draft → local API/PG restart preserving volume → persisted current/history. Annotated removal409 retains both material and Note; unannotated removal204 works. 390px editor/history fit.
- Actual HTTP/browser failures: wrong token403; blank/ASCII65537/multibyte65538/malformed JSON400; foreign existing revision404; PG stopped GET/save503 with no false empty/success and retained draft. Local PG/API restored; cancel creates no revision.
- SQL receipt: ACTIVE Note; revisions1/2/3; latest current; next4; exact NOTE subject metadata; parentsR2→R1/R3→R2; old rows/content/hash unchanged; original project unchanged; no unrelated domain writes. Canonical data retained after removal.
- Full repository suite: **3704 PASS / 15 FAIL / 19 SKIP, 1 unhandled CLI-import error**; exit1. Failures are unchanged WeRead tests using `/opt/book-id-search` and `apply-match-review.ts` import-time `process.exit(1)`. They are not counted as M1-D PASS.
- NOT_RUN: separate legacy M0/M1-A/M1-B/M1-C real-PG runners; production operations; real mobile device. M1-D real PG ran separately from the full-suite skipped integration cases.
- Evidence: ignored `logs/s32-m1d/`, `/home/conanxin/codex-artifacts/s32-m1d/` (10 screenshots), per-plan `.superpowers/sdd/2026-09-20-s32-m1d-note-revisions/progress.md`; [runbook](operations/S32_M1D_LOCAL.md).
- GitHub PR/Issue #2 and existing Notion design/plan/overview: **PENDING** until branch review, push and read-back verification.
- IMPLEMENTED=YES; TESTED=PASS_SCOPED_PG_BROWSER; COMMITTED=YES; PUSHED=NO; MERGED=NO; DEPLOYED=NO; PRODUCTION_CHANGED=NO; M1_E_STARTED=NO.
- Last production observation remains historical release-prep 2026-09-19 13:22:59 UTC. This task performed no production access.
- Next: complete whole-branch review, then open one M1-D PR for user review. No automatic merge/deploy/M1-E.
