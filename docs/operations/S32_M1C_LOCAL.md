# S32 M1-C local project bindings

Task: `S32_M1C_PROJECT_BINDING_R1`. Source baseline: `7295af6e991e2a5b1575b8c2a0b5d3662c093b9f`.
M1-C adds one explicitly selected catalog book to one existing project as an EDITION binding.
The server rereads catalog data through M1-A promotion; the project displays canonical Work/Edition
fields. Duplicate/concurrent adds reuse one binding. Removal deletes only that binding.

## Run locally

Use Node 22+, pnpm 10.33.0 and Docker. Retain the M1-B `.env.s32.local` (mode 600) and
`book-id-search-s32-local-pg` volume. See [M1-B local setup](S32_M1B_LOCAL.md).
Never run `down -v`, remove the volume, empty “北京古道研究”, or reapply migrations to its database.
An isolated worktree may use the original ignored env file by absolute path; never copy credentials
into tracked files or VITE variables. Keep API/PG/Meili on loopback.

Unlike M1-B project creation, **real browser add requires actual Meili catalog access**. Reuse the
local catalog, or populate a separate local index with only a few explicitly selected real catalog
records. Preserve their IDs and catalog snapshot fields. Do not bulk promote or copy the full index.
Do not point S32_DATABASE_URL at production. S32 private requests remain same-origin `/api/private/s32`.

```sh
corepack pnpm install --frozen-lockfile
# Start/restart the existing M1-B PG container; this preserves its named volume:
docker --host unix:///var/run/docker.sock start book-id-search-s32-local-postgres-1
corepack pnpm --filter @book-id-search/api build
# Substitute the actual absolute path of the ignored local env file:
node --env-file=/absolute/path/.env.s32.local apps/api/dist/index.js
# In another terminal, with VITE_S32_ENABLED=true in ignored apps/web/.env.local:
corepack pnpm --filter @book-id-search/web dev
```

Use `http://127.0.0.1:5173/` and `/research/projects`. The existing local config uses API port 3001
and PG loopback port 15432. Enter the independent S32 token via the research page, then return to search.
Do not reuse WeRead credentials. Tests use dev-only Testing Library/jsdom; no new product framework.

## Reproducible checks

```sh
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32 scripts/s32-schema-contract.test.ts --exclude '**/*.integration.test.ts'
corepack pnpm s32:m1c:check
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/search apps/api/src/handle-search.test.ts apps/web/src/EditionCompare.test.tsx apps/web/src/research apps/web/src/weread/WereadCenter.test.tsx
corepack pnpm --filter @book-id-search/api build
corepack pnpm --filter @book-id-search/web build
git diff --exit-code 7295af6e991e2a5b1575b8c2a0b5d3662c093b9f -- db/migrations/001_s32_core_schema.sql db/tests/001_s32_schema_assertions.sql db/tests/002_s32_negative_invariants.sql
git diff --check
```

`s32:m1c:check` starts its own PG16 container with tmpfs, a random loopback port, unique owner label
and random password. Only `S32_M1C_TEST_DATABASE_URL` is accepted, with database `s32_m1c_test` on
127.0.0.1. It applies the unchanged migration there, injects a deterministic catalog reader, exercises
real promotion/binding SQL and removes only its own container. It never uses the trial volume or
S32_DATABASE_URL. Integration cases skipped outside this runner are NOT_RUN, never PASS.

The plan assumed Testing Library was already installed; it was absent. Root devDependencies and
pnpm-lock.yaml therefore include Testing Library and jsdom26 for reproducible UI interaction tests.
Frozen SQL and application dependency versions remain unchanged; the lockfile is intentionally changed.

## Browser acceptance and evidence

Use existing “北京古道研究”; preserve its name, purpose, UUID and timestamps. In a real browser:

1. Search a real catalog book, click 加入研究 and choose 北京古道研究. Capture the selector.
2. Observe success; open project detail. Confirm title/publisher/date/ISBN and the actual count.
3. Refresh, then add the same book again from search. Confirm exactly one binding for that Edition.
4. Restart only the local API and development PG, retaining the volume. Reopen detail and confirm persistence.
5. Check at 390px width and capture the item. Cancel removal once, then confirm removal.
6. Check UI disappearance and SQL/API retention of Work, Edition, Source and ExternalIdentity.
7. Check wrong token, empty selector (temporary UI mock allowed; do not erase trial projects), catalog404,
   unknown binding404 and real DB503 by stopping/restarting only the development PG. A failed DELETE
   must keep the visible item. Separate browser evidence from HTTP-only probes.

Save screenshots in `/home/conanxin/codex-artifacts/s32-m1c/`, logs in ignored `logs/s32-m1c/`.
The per-plan ledger is ignored `.superpowers/sdd/2026-09-20-s32-m1c-project-binding/progress.md`.
Never commit screenshots, credentials or private catalog exports. Report actual commands, exit codes,
test counts, tested_commit and any later docs-only final_head separately.

No Note, project editing, bulk membership prefetch, automatic retry of POST, M1-D/E or production deployment.
