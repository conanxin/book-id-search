# BOOK-ID-SEARCH status

- Task: `S32_M1B_PROJECTS_UI_R1` / local project create-list-detail, **READY_FOR_REVIEW**, [PR #11](https://github.com/conanxin/book-id-search/pull/11).
- Baseline: actual main `19c0209acb9445b505f918f13bce9e2dc82f7917` (PR #10 merged). Worktree `/home/conanxin/codex-projects/book-id-search`, branch `feat/s32-m1b-projects-ui`; previous work preserved.
- Implemented/tested: **YES**. 108 unit/static + 216 search/WeRead regression + 1 real PG16 integration PASS; API/Web builds PASS. Real browser create/detail/list/refresh and API/PG restart persistence PASS; desktop/mobile screenshots recorded. M0 migration and both SQL files unchanged.
- Browser project: `36c19d98-85ad-48d6-8515-9698f563e89a` (“北京古道研究”). Name, purpose, UUID and both timestamps match before/after restart. Dev volume `book-id-search-s32-local-pg` retained; initialization skipped on restart; disposable test container removed.
- Local page: `http://127.0.0.1:5173/research/projects`. Server credentials only in ignored `.env.s32.local`; enter S32 token via the page. [Local guide](operations/S32_M1B_LOCAL.md).
- Additional root scripts typecheck: **FAILED**, six errors in unchanged AI/search/WeRead scripts. Full repository suite, M1-A real-PG rerun and M0 SQL assertion/negative rerun: **NOT_RUN**. Web build warns about existing large main bundle; browser favicon 404 remains, expected 403/503/404 probes observed; no uncaught application JS error observed.
- tested_commit: `1b7eaacf0199edbfceb76ac24c9311ab0f2c5ad2`; committed/pushed: **YES**. Later status commits change only this receipt, not tested product code. Merged/deployed/production changed: **NO**. Latest production observation remains release-prep **2026-09-19 13:22:59 UTC**; free 20.2888 GiB, deployment HOLD_CAPACITY_AND_AUTHORIZATION. No production access this task.
- Evidence: ignored `logs/s32-m1b/`, `progress/S32_M1B_PROJECTS_UI_R1.md`; screenshots `/home/conanxin/codex-artifacts/s32-m1b/`.
- Sync **VERIFIED** with the same task_id/tested_commit/PR: [Issue #2 receipt](https://github.com/conanxin/book-id-search/issues/2#issuecomment-5743171309), [Notion overview](https://www.notion.so/3dd34a28189a81d48f74ec74593dac5f), [Notion M1-B](https://www.notion.so/3e034a28189a81aa920afaf70bd6201b).
- Unique next step: review PR #11; do not merge or deploy automatically.
