# S32 M1-B local projects

Task: `S32_M1B_PROJECTS_UI_R1`. Baseline: main `19c0209acb9445b505f918f13bce9e2dc82f7917` (PR #10).

Pages: `/research/projects` and `/research/projects/:projectId`. Creation accepts only a
name and optional research purpose, stored in `core.projects.name` and `metadata.description`.
Duplicate names get independent UUIDs. GET never writes; DB failures never become empty lists.

## Local setup

Use Node 22, pnpm 10.33.0, Docker and Compose. From the repository root, create ignored
`.env.s32.local`, mode `600`, with independent random password/token (e.g. `openssl rand -hex 24`):

```dotenv
S32_LOCAL_PG_PASSWORD=<local password>
S32_DATABASE_URL=postgresql://s32local:<same local password>@127.0.0.1:15432/s32local
S32_PRIVATE_API_TOKEN=<independent local token>
S32_FEATURES_ENABLED=true
API_HOST=127.0.0.1
API_PORT=3001
MEILI_HOST=http://127.0.0.1:7700
```

Create ignored `apps/web/.env.local` with only:

```dotenv
VITE_S32_ENABLED=true
VITE_API_BASE_URL=/api
```

Never put credentials in frontend source or `VITE_*` variables. Do not reuse production env.

```sh
corepack pnpm install --frozen-lockfile
docker compose --env-file .env.s32.local -f compose.s32-local.yml up -d --wait
corepack pnpm --filter @book-id-search/api build
node --env-file=.env.s32.local apps/api/dist/index.js
# Second terminal:
corepack pnpm --filter @book-id-search/web dev
```

Open `http://127.0.0.1:5173/research/projects` and enter the local S32 token. Access uses a
separate sessionStorage key with an in-memory fallback; clearing it also clears the view.
API/Web/PG listen on loopback. Vite proxies same-origin `/api` requests to port 3001.
Projects do not require Meili; existing search still requires its own Meili service.

For watch mode, `pnpm --filter @book-id-search/api dev` works in native Windows and POSIX
shells. Its TypeScript development entry loads the existing root/CWD `.env` configuration,
preserves an explicit `API_HOST`, and otherwise defaults to `127.0.0.1`. It adds no dependency
or global shell setting. The compiled production entry `node dist/index.js` still defaults
to `0.0.0.0` when no host is configured; keep the explicit local host in `.env.s32.local` above.

The named volume `book-id-search-s32-local-pg` persists trial data. The original migration
is mounted read-only and runs only when PG initializes an empty volume. For a restart:

```sh
docker compose --env-file .env.s32.local -f compose.s32-local.yml restart postgres
# Stop only your local API process, then repeat its node command.
```

Do not use `down -v`, remove the volume, or rerun migration SQL on the development database.
This Compose file is independent of production's layers.

## Verification

```sh
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32 apps/web/src/research scripts/s32-schema-contract.test.ts
corepack pnpm s32:m1b:check
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/search apps/api/src/handle-search.test.ts apps/web/src/EditionCompare.test.tsx apps/web/src/weread/WereadCenter.test.tsx
corepack pnpm --filter @book-id-search/api build
corepack pnpm --filter @book-id-search/web build
```

Development-entry compatibility can be checked independently, without PG or Meili:

```sh
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/api test:dev-entry
```

The five checks launch the real package dev script or compiled API from temporary copies
with the same dependencies, observe the actual TCP address and send an HTTP request. They
cover development default/explicit/dotenv hosts and production default/explicit hosts. They
do not read trial credentials or modify data; S32 is disabled and temporary processes are
removed. Run with native Windows Node/pnpm for Windows evidence; WSL alone does not prove it.

The M1-B runner uses a unique disposable PG16 container, a random loopback port and tmpfs.
It applies the unchanged migration once, runs real HTTP/SQL assertions, and removes only its
own container. It never uses `S32_DATABASE_URL` or mounts the development volume. Outside
the runner, integration tests are skipped: report NOT_RUN, not PASS. M1-A integration is
separate. M0 migration and both SQL assertion files remain unchanged.

Browser acceptance: create “北京古道研究” with a purpose, open detail, return to the list,
reload, restart local API and development PG retaining the volume, and confirm the same UUID,
purpose and timestamps. Also check invalid credentials, validation, unknown project, service
failure, clearing access and a narrow viewport. Keep logs/screenshots outside tracked source.

No deployment, book linking, notes, editing/deletion/archive, AI or team permissions are
included. Production changes and merging require separate authorization.
