# S32 M1-D local Note revisions

Task: `S32_M1D_NOTE_REVISIONS_R1`. Source baseline: `51c63b1dc45890bd5989d6bf6442d8ab7aaccc74`.
Each Project EDITION binding has at most one Note. Saving appends an immutable MARKDOWN revision;
the client sends the current revision ID as its base. A stale base returns 409 without overwriting
the user's draft. An Edition with a Note cannot be removed. No Note deletion, autosave or HTML preview.

## Local services

Reuse the existing M1-B development volume `book-id-search-s32-local-pg` and independent S32 token
in the original ignored `.env.s32.local` (mode 600). Keep “北京古道研究” and its data. Never use
`down -v`, delete the volume, reapply the migration to this database, or point at production.
The isolated worktree may read the ignored env file by absolute path; credentials never belong
in tracked files, logs or VITE variables. API, PG and Meili listen on loopback.

M1-D requires an existing M1-C Edition item. Reuse local Meili's few real catalog records and the
existing local Meili key. If the project is empty, use Search → 加入研究 → 北京古道研究; do not insert
fake project items with SQL. Note reads and writes themselves do not query Meili.

From the M1-D worktree, with the existing local Meili key available to the API environment:

```sh
corepack pnpm install --frozen-lockfile
docker --host unix:///var/run/docker.sock start book-id-search-s32-local-postgres-1
corepack pnpm --filter @book-id-search/api build
API_HOST=127.0.0.1 MEILI_HOST=http://127.0.0.1:7700 node --env-file=/home/conanxin/codex-projects/book-id-search/.env.s32.local apps/api/dist/index.js
# In another terminal; ignored apps/web/.env.local enables VITE_S32_ENABLED=true.
corepack pnpm --filter @book-id-search/web dev
```

The shell assignments above are for this Linux worktree. The cross-platform API development
entry remains `corepack pnpm --filter @book-id-search/api dev`; supply environment values through
the platform's normal environment support. S32 private requests always use same-origin
`/api/private/s32`, independently of the public search API configuration.

Open `http://127.0.0.1:5173/research/projects`; API is on port 3001 and development PG on 15432.
Enter the existing S32 token using the page. Do not reuse WeRead credentials.

## Verification

```sh
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32 scripts/s32-schema-contract.test.ts --exclude '**/*.integration.test.ts'
corepack pnpm s32:m1d:check
corepack pnpm exec vitest run --maxWorkers=1 apps/web/src/research apps/web/src/EditionCompare.test.tsx apps/api/src/search apps/api/src/handle-search.test.ts
corepack pnpm --filter @book-id-search/api build
corepack pnpm --filter @book-id-search/web build
git diff --exit-code 51c63b1dc45890bd5989d6bf6442d8ab7aaccc74 -- db/migrations/001_s32_core_schema.sql db/tests/001_s32_schema_assertions.sql db/tests/002_s32_negative_invariants.sql
git diff --check
```

`s32:m1d:check` creates its own `postgres:16-alpine` container, tmpfs, random password and random
loopback port, applies the unchanged migration only there, and removes only its owned container.
Tests accept only `S32_M1D_TEST_DATABASE_URL` with database `s32_m1d_test` on 127.0.0.1. They do
not read `S32_DATABASE_URL` or the development volume. Ten real PG tests cover create/duplicate,
concurrent create, immutable R1→R2→R3/parents/stale append, cross-project access, protected and
normal removal, both lock orders in the create/remove race, rollback of create and append,
and no unrelated domain writes. Temporary fault triggers exist only in that disposable database.

## Browser acceptance

1. Open an actual Edition in 北京古道研究, click 研究笔记, create multiline R1, refresh and reopen.
2. Edit and save R2. Open history v1 and compare its original content.
3. Load R2 in two tabs. Save R3 in tab A. Save a different draft based on R2 in tab B:
   require 409, retained textarea, and unchanged server R3. Reload latest without replacing
   the draft; only “用最新版本重新编辑” may explicitly replace the textarea.
4. Restart the local API and PG container without removing its volume. Reopen current/history.
5. Attempt to remove the annotated Edition: require 409 and
   “这项资料已有研究笔记，暂不能直接移出项目。” Keep the Edition, Note and all revisions.
6. Add a different real Edition through Search, leave it without a Note and verify normal removal.
7. Check the editor/history at 390px. Check wrong token, blank/oversized UTF-8 body, foreign revision
   UUID, cancel edit, and real PG-stop GET/save 503 without empty-note or false-success UI.
   Restore PG/API afterward.
8. Record SQL/API receipts: ACTIVE Note; continuous revision numbers; latest current pointer;
   next = latest+1; exact NOTE binding subject metadata; R2→R1 and R3→R2 parents; unchanged
   old content/hash; no Claim/Assessment or other unrelated writes.

Evidence goes to ignored `logs/s32-m1d/` and `/home/conanxin/codex-artifacts/s32-m1d/`, not git.
The ignored plan ledger is `.superpowers/sdd/2026-09-20-s32-m1d-note-revisions/progress.md`.
Report actual commands, exits, test counts, `tested_commit` and later docs-only `final_head` separately.
Skipped integration suites and checks not executed in this task are NOT_RUN, never historical PASS.
No production changes, merge, registry publication or M1-E.
