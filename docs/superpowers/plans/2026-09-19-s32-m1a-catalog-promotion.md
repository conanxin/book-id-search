# S32-M1A Catalog → Canonical Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first S32 application write path: explicitly promote one existing Meilisearch catalog book into the canonical PostgreSQL Work → Edition → Source chain, with idempotent ExternalIdentity binding, private authentication, fail-closed conflicts, and no production deployment.

**Architecture:** Keep BOOK-ID-SEARCH as a modular monolith. Meilisearch remains the discovery/catalog read model; S32 PostgreSQL becomes canonical truth only for explicitly promoted records. The HTTP route depends on an application command, which depends on a catalog reader and a promotion store interface; the PostgreSQL adapter owns transaction/concurrency behavior and explicit SQL against the already-frozen M0 schema.

**Tech Stack:** Node.js 24, TypeScript 5.9, Express 5, Meilisearch JS 0.52, PostgreSQL 16, node-postgres `pg@^8.23.0`, `@types/pg@^8.23.1`, Vitest 4.

**Spec:** https://app.notion.com/p/3e034a28189a816cbec4d050ed01ae5e

## Global Constraints

- Baseline source commit is `main@07e17731b42baa93419fe730ebdf3d6b1e13731d`.
- Do not modify `db/migrations/001_s32_core_schema.sql` or the two M0 SQL assertion files.
- Do not modify Production `/opt/book-id-search`, Docker Compose, Caddy, Web/API runtime containers, Meilisearch data, or production environment variables.
- Do not deploy PostgreSQL in Production during M1-A.
- Do not bulk-promote the 5,115,734 catalog records. Promotion is explicit and one catalog document at a time.
- Meilisearch is discovery/catalog input, not canonical truth.
- PostgreSQL `core.*` is canonical truth after promotion.
- Do not fuzzy-merge on title, author, publisher, or ISBN.
- Do not create Actor/Contribution rows from the catalog `author` string in M1-A.
- All catalog external identities created by M1-A bind to `target_type='SOURCE'`.
- `BOOK_ID_SEARCH / CATALOG_DOCUMENT / Book.id` is the primary idempotency identity.
- Non-empty SSID and DXID are secondary SOURCE identities using namespaces `SSID` and `DXID`.
- ISBN is stored only on Edition in M1-A; it is not an ExternalIdentity and does not trigger merge.
- M1-A canonical writes are private: route is `POST /api/private/s32/promotions/catalog-book`, disabled by default, and requires `S32_PRIVATE_API_TOKEN`.
- `S32_FEATURES_ENABLED=false` is the default.
- Missing `S32_DATABASE_URL` must not crash API startup.
- Do not reuse `WEREAD_OVERLAY_ENABLED` or `WEREAD_PRIVATE_API_TOKEN`; S32 auth/config is independent.
- Use explicit SQL and `pg`; do not introduce an ORM or a second migration owner.
- Dependency acquisition must not change global proxy/registry settings. If pinned `pg` packages cannot be acquired with the repository package manager, stop with `DEPENDENCY_ACQUISITION_BLOCKED` rather than mutating global network configuration.
- M1-B Project, M1-C ProjectBinding, M1-D Note/Revision, and M1-E Rediscover are out of scope for this plan.

## Review Focus

1. **Anonymous write attempt:** the private S32 route must reject unauthenticated requests before any catalog/DB call.
2. **Concurrent duplicate promotion:** two simultaneous promotions of the same catalog id must produce one canonical chain, not duplicate Work/Edition/Source rows.
3. **Catalog drift on repeat:** a repeated promotion must return the existing chain and must not silently overwrite canonical title/publisher/date/ISBN because the Meili row changed.
4. **Secondary identity collision:** SSID or DXID already bound to another SOURCE must fail with a conflict and leave zero partial rows from the new promotion.
5. **Mid-transaction failure:** any SQL failure after identity reservation must roll back all identities and canonical rows.

---

## File Structure

### New files

- `apps/api/src/s32/config.ts` — S32 feature/database configuration parsing.
- `apps/api/src/s32/config.test.ts` — config defaults and fail-safe tests.
- `apps/api/src/s32/routes/private-auth.ts` — constant-time S32 token authentication.
- `apps/api/src/s32/routes/private-auth.test.ts` — auth status tests.
- `apps/api/src/s32/domain/catalog-promotion.ts` — catalog snapshot types, validation, normalization, and promotion candidate mapping.
- `apps/api/src/s32/domain/catalog-promotion.test.ts` — pure mapping tests.
- `apps/api/src/s32/catalog/meili-catalog-book-reader.ts` — read one Book document from the existing Meili index.
- `apps/api/src/s32/catalog/meili-catalog-book-reader.test.ts` — found/not-found/upstream error tests.
- `apps/api/src/s32/application/promote-catalog-book.ts` — application command and ports.
- `apps/api/src/s32/application/promote-catalog-book.test.ts` — command tests with fakes.
- `apps/api/src/s32/postgres/catalog-promotion-store.ts` — node-postgres transaction/idempotency adapter.
- `apps/api/src/s32/postgres/catalog-promotion-store.integration.test.ts` — real PostgreSQL 16 tests.
- `apps/api/src/s32/routes/catalog-promotion-route.ts` — private HTTP handler/router.
- `apps/api/src/s32/routes/catalog-promotion-route.test.ts` — request/auth/status mapping tests.
- `apps/api/src/s32/register.ts` — assemble M1-A dependencies and expose router.
- `scripts/s32-m1a-integration-check.ts` — disposable PostgreSQL 16 runner for M1-A integration tests.
- `docs/S32_M1A_PROMOTION.md` — operator/developer contract for the feature.

### Modified files

- `apps/api/package.json` — add `pg` and `@types/pg`.
- `pnpm-lock.yaml` — lock the new dependency graph.
- `.env.example` — add disabled-by-default S32 variables.
- `apps/api/src/index.ts` — mount the isolated private S32 router only.
- `package.json` — add an explicit `s32:m1a:check` script.

No Web files change in M1-A.

---

### Task 1: Add the S32 runtime/config and private-auth boundary

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.env.example`
- Create: `apps/api/src/s32/config.ts`
- Create: `apps/api/src/s32/config.test.ts`
- Create: `apps/api/src/s32/routes/private-auth.ts`
- Create: `apps/api/src/s32/routes/private-auth.test.ts`

**Interfaces:**
- Produces:
  - `readS32Config(env: NodeJS.ProcessEnv): S32Config`
  - `checkS32PrivateAuth(config, authorization, xPrivateToken): S32AuthResult`
  - `S32Config = { enabled: boolean; databaseUrl: string | null; privateToken: string | null }`

- [ ] **Step 1: Write failing config tests**

Create `apps/api/src/s32/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readS32Config } from "./config.js";

describe("readS32Config", () => {
  it("is disabled by default and does not require a database URL", () => {
    expect(readS32Config({})).toEqual({
      enabled: false,
      databaseUrl: null,
      privateToken: null,
    });
  });

  it("reads explicit S32 settings without falling back to WeRead settings", () => {
    expect(readS32Config({
      S32_FEATURES_ENABLED: "true",
      S32_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
      S32_PRIVATE_API_TOKEN: "secret",
      WEREAD_PRIVATE_API_TOKEN: "must-not-be-used",
    })).toEqual({
      enabled: true,
      databaseUrl: "postgresql://u:p@127.0.0.1:5432/db",
      privateToken: "secret",
    });
  });
});
```

- [ ] **Step 2: Run the config tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run apps/api/src/s32/config.test.ts
```

Expected: FAIL because `./config.js` does not exist.

- [ ] **Step 3: Implement minimal config parsing**

Create `apps/api/src/s32/config.ts`:

```ts
export interface S32Config {
  enabled: boolean;
  databaseUrl: string | null;
  privateToken: string | null;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function readS32Config(env: NodeJS.ProcessEnv): S32Config {
  return {
    enabled: env.S32_FEATURES_ENABLED === "true",
    databaseUrl: clean(env.S32_DATABASE_URL),
    privateToken: clean(env.S32_PRIVATE_API_TOKEN),
  };
}
```

- [ ] **Step 4: Write failing private-auth tests**

Create `apps/api/src/s32/routes/private-auth.test.ts` covering exactly:

```text
disabled => 404
enabled + no configured token => 503
enabled + no supplied token => 401
enabled + wrong token => 403
Authorization: Bearer correct token => ok
X-Private-Token correct token => ok
```

The test must also include a config containing `WEREAD_PRIVATE_API_TOKEN` and prove it never authenticates S32.

- [ ] **Step 5: Implement constant-time S32 auth**

Create `apps/api/src/s32/routes/private-auth.ts` with a local constant-time comparator using `node:crypto.timingSafeEqual`.

Use this exact result type:

```ts
export type S32AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 503; message: string };
```

Rules:

```text
!config.enabled                  -> 404 "Not Found"
!config.privateToken             -> 503 "S32 private token not configured."
no supplied token                -> 401 "Missing token."
bad supplied token               -> 403 "Invalid token."
valid Bearer or X-Private-Token  -> ok
```

Never include the configured or supplied token in errors.

- [ ] **Step 6: Pin the PostgreSQL client dependency**

Modify `apps/api/package.json`:

```json
"dependencies": {
  "...": "...",
  "pg": "^8.23.0"
},
"devDependencies": {
  "...": "...",
  "@types/pg": "^8.23.1"
}
```

Update `pnpm-lock.yaml` using the repository package manager. Do not alter global proxy/registry settings.

Preferred commands:

```bash
corepack pnpm --filter @book-id-search/api add pg@^8.23.0
corepack pnpm --filter @book-id-search/api add -D @types/pg@^8.23.1
```

If those commands attempt network access through the broken global proxy and the packages are not locally available, stop and report:

```text
DEPENDENCY_ACQUISITION_BLOCKED
```

Do not switch the repository to npm/yarn and do not edit global proxy/registry configuration.

- [ ] **Step 7: Document disabled-by-default env**

Append to `.env.example`:

```dotenv
# --- S32 personal research canonical store (disabled by default) ---
S32_FEATURES_ENABLED=false
S32_DATABASE_URL=
S32_PRIVATE_API_TOKEN=
```

- [ ] **Step 8: Run Task 1 tests and API typecheck**

Run:

```bash
./node_modules/.bin/vitest run \
  apps/api/src/s32/config.test.ts \
  apps/api/src/s32/routes/private-auth.test.ts
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
```

Expected: all tests PASS; TypeScript exits 0.

- [ ] **Step 9: Commit Task 1**

```bash
git add apps/api/package.json pnpm-lock.yaml .env.example \
  apps/api/src/s32/config.ts apps/api/src/s32/config.test.ts \
  apps/api/src/s32/routes/private-auth.ts apps/api/src/s32/routes/private-auth.test.ts
git commit -m "feat(s32): add M1A private runtime boundary"
```

---

### Task 2: Define catalog snapshot → canonical promotion mapping

**Files:**
- Create: `apps/api/src/s32/domain/catalog-promotion.ts`
- Create: `apps/api/src/s32/domain/catalog-promotion.test.ts`

**Interfaces:**
- Produces:
  - `CatalogBookSnapshot`
  - `PromotionCandidate`
  - `InvalidCatalogBookError`
  - `mapCatalogBookToPromotion(book, observedAt): PromotionCandidate`
  - `normalizePromotionIsbn(value): string | null`

The candidate must not contain generated UUIDs; UUID creation belongs to the PostgreSQL store.

Use this shape:

```ts
export interface CatalogBookSnapshot {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  rawInfo: string;
  parseStatus: "ok" | "weak" | "failed";
  parseWarnings: string[];
}

export interface PromotionCandidate {
  catalogBookId: string;
  work: {
    workType: "BOOK";
    title: string;
    titleStatus: "KNOWN";
  };
  edition: {
    editionType: "BOOK_EDITION";
    publisher: string | null;
    publicationDate: string | null;
    publicationDatePrecision: "YEAR";
    isbn: string | null;
  };
  source: {
    sourceType: "DATABASE_RECORD";
    observedAt: string;
    metadata: {
      provider: "BOOK_ID_SEARCH";
      catalogDocument: CatalogBookSnapshot;
    };
  };
  secondaryIdentities: Array<{
    namespace: "SSID" | "DXID";
    externalId: string;
  }>;
}
```

- [ ] **Step 1: Write failing mapping tests**

Create cases for:

1. complete book maps to Work/Edition/Source;
2. blank title throws `InvalidCatalogBookError`;
3. publisher whitespace → `null`;
4. ISBN `978-7-5384-5525-0` → `9787538455250`;
5. structurally invalid ISBN → `null`;
6. valid year `1986` → `1986-01-01` + precision `YEAR`;
7. null/non-integer/out-of-range year → `publicationDate=null`;
8. blank SSID/DXID omitted;
9. author/rawInfo/parseStatus/parseWarnings preserved under Source metadata, not converted to Actor/Contribution data.

For ISBN, accept only these normalized structures:

```text
ISBN-10: ^[0-9]{9}[0-9X]$
ISBN-13: ^[0-9]{13}$
```

No checksum validation in M1-A.

For year, accept an integer in `1..9999`; otherwise treat it as unknown.

- [ ] **Step 2: Run and verify RED**

```bash
./node_modules/.bin/vitest run apps/api/src/s32/domain/catalog-promotion.test.ts
```

Expected: FAIL because implementation does not exist.

- [ ] **Step 3: Implement the pure mapper**

Implement only deterministic normalization/validation. Do not query Meili or PostgreSQL here.

Important rule:

```ts
if (!book.title.trim()) {
  throw new InvalidCatalogBookError("CATALOG_TITLE_MISSING");
}
```

Secondary identities use trimmed non-empty values exactly; do not case-fold SSID/DXID.

- [ ] **Step 4: Run tests and typecheck**

```bash
./node_modules/.bin/vitest run apps/api/src/s32/domain/catalog-promotion.test.ts
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
```

Expected: PASS / exit 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/api/src/s32/domain/catalog-promotion.ts \
  apps/api/src/s32/domain/catalog-promotion.test.ts
git commit -m "feat(s32): map catalog books to promotion candidates"
```

---

### Task 3: Add the catalog reader and application command

**Files:**
- Create: `apps/api/src/s32/catalog/meili-catalog-book-reader.ts`
- Create: `apps/api/src/s32/catalog/meili-catalog-book-reader.test.ts`
- Create: `apps/api/src/s32/application/promote-catalog-book.ts`
- Create: `apps/api/src/s32/application/promote-catalog-book.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CatalogBookReader {
  getById(id: string): Promise<CatalogBookSnapshot | null>;
}

export interface CatalogPromotionStore {
  promote(candidate: PromotionCandidate): Promise<PromotionResult>;
}

export interface PromotionResult {
  status: "created" | "existing";
  workId: string;
  editionId: string;
  sourceId: string;
  catalogBookId: string;
}

export class CatalogBookNotFoundError extends Error {}
export class CatalogReadUnavailableError extends Error {}
export class IdentityConflictError extends Error {}
export class CanonicalStoreUnavailableError extends Error {}
```

- [ ] **Step 1: Write failing Meili reader tests**

The reader factory should accept an injected lookup dependency:

```ts
type GetDocument = (id: string) => Promise<unknown>;
```

Tests:

- valid document → exact `CatalogBookSnapshot`;
- thrown object with `code === "document_not_found"` → `null`;
- any other thrown error → `CatalogReadUnavailableError`;
- malformed returned document missing string `id` → `CatalogReadUnavailableError`.

Do not catch all Meili failures as “not found”.

- [ ] **Step 2: Implement the Meili reader**

The adapter may trust other Book fields as optional/coercible source fields, but `id` must be a non-empty string.

It must not perform any canonical mapping.

- [ ] **Step 3: Write failing application-command tests**

Use fake reader/store objects.

Cases:

1. blank request `bookId` → input error before reader call;
2. missing catalog row → `CatalogBookNotFoundError`;
3. reader unavailable → propagated `CatalogReadUnavailableError`;
4. invalid catalog title → `InvalidCatalogBookError`, store not called;
5. complete row → mapper called and store result returned;
6. only `bookId` drives lookup; no caller-supplied title/publisher/isbn fields exist in the command input.

Command signature:

```ts
export function createPromoteCatalogBookCommand(deps: {
  reader: CatalogBookReader;
  store: CatalogPromotionStore;
  now?: () => Date;
}): {
  execute(input: { bookId: string }): Promise<PromotionResult>;
}
```

- [ ] **Step 4: Implement the command**

Algorithm:

```text
trim bookId
if empty -> InvalidPromotionRequestError
reader.getById(bookId)
if null -> CatalogBookNotFoundError
mapCatalogBookToPromotion(book, now().toISOString())
store.promote(candidate)
return result
```

The command does not know SQL and does not use fuzzy matching.

- [ ] **Step 5: Run Task 3 tests**

```bash
./node_modules/.bin/vitest run \
  apps/api/src/s32/catalog/meili-catalog-book-reader.test.ts \
  apps/api/src/s32/application/promote-catalog-book.test.ts
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
```

Expected: PASS / exit 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/api/src/s32/catalog apps/api/src/s32/application
git commit -m "feat(s32): add catalog promotion application command"
```

---

### Task 4: Implement the PostgreSQL promotion transaction and concurrency contract

**Files:**
- Create: `apps/api/src/s32/postgres/catalog-promotion-store.ts`
- Create: `apps/api/src/s32/postgres/catalog-promotion-store.integration.test.ts`
- Create: `scripts/s32-m1a-integration-check.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `CatalogPromotionStore`, `PromotionCandidate`, `PromotionResult`.
- Produces:

```ts
export function createPostgresCatalogPromotionStore(pool: Pool): CatalogPromotionStore;
```

Use `crypto.randomUUID()` for canonical ids. Do not add a PostgreSQL UUID extension.

#### Transaction algorithm

The unique partial index already present in M0 is:

```sql
CREATE UNIQUE INDEX uq_external_identities_active_binding
ON core.external_identities (provider, namespace, external_id)
WHERE binding_state <> 'RETIRED';
```

Use it as the concurrency arbiter.

Primary catalog identity values are exact:

```text
provider    = BOOK_ID_SEARCH
namespace   = CATALOG_DOCUMENT
external_id = candidate.catalogBookId
target_type = SOURCE
```

- [ ] **Step 1: Write the initial integration test file**

The test connects only when `S32_TEST_DATABASE_URL` is set by the disposable harness.

Before each test, clear only M1-A tables in dependency-safe order:

```sql
DELETE FROM core.external_identities;
DELETE FROM core.sources;
DELETE FROM core.editions;
DELETE FROM core.works;
```

Do not truncate unrelated S32 tables.

- [ ] **Step 2: Add the “created” integration test**

Assert exactly:

```text
works=1
editions=1
sources=1
CATALOG_DOCUMENT identity=1
nonblank SSID identity=1
nonblank DXID identity=1
all three identities target_type=SOURCE and target_id=returned sourceId
source.edition_id=returned editionId
edition.work_id=returned workId
```

Also query `source.metadata` and prove catalog author/rawInfo/parse fields were preserved.

- [ ] **Step 3: Implement primary identity reservation**

Inside one `PoolClient` transaction:

1. generate `workId`, `editionId`, `sourceId`, and identity UUIDs;
2. `BEGIN`;
3. reserve the primary catalog identity first:

```sql
INSERT INTO core.external_identities (
  id, target_type, target_id, provider, namespace, external_id,
  binding_state, observed_at, metadata
)
VALUES ($1, 'SOURCE', $2, 'BOOK_ID_SEARCH', 'CATALOG_DOCUMENT', $3,
        'ACTIVE', $4, $5::jsonb)
ON CONFLICT (provider, namespace, external_id)
WHERE binding_state <> 'RETIRED'
DO NOTHING
RETURNING id;
```

If one row is returned, this transaction owns creation.

If zero rows are returned, query the existing identity and canonical chain:

```sql
SELECT
  ei.target_type,
  ei.target_id AS source_id,
  s.edition_id,
  e.work_id
FROM core.external_identities ei
LEFT JOIN core.sources s
  ON ei.target_type = 'SOURCE' AND s.id = ei.target_id
LEFT JOIN core.editions e ON e.id = s.edition_id
WHERE ei.provider = 'BOOK_ID_SEARCH'
  AND ei.namespace = 'CATALOG_DOCUMENT'
  AND ei.external_id = $1
  AND ei.binding_state <> 'RETIRED';
```

Accept the existing path only when:

```text
target_type == SOURCE
source_id != null
edition_id != null
work_id != null
```

Otherwise throw `IdentityConflictError("CATALOG_IDENTITY_INVALID_BINDING")`.

Do not update Work/Edition/Source on the existing path.

- [ ] **Step 4: Reserve secondary SSID/DXID identities for new promotions**

For each non-empty secondary identity, use the same partial conflict target.

If the insert returns zero rows, throw:

```text
IdentityConflictError("SECONDARY_IDENTITY_CONFLICT:SSID")
IdentityConflictError("SECONDARY_IDENTITY_CONFLICT:DXID")
```

Do not auto-merge with the source that already owns the identifier.

For an existing primary catalog identity, only check whether a present SSID/DXID binding conflicts with the returned source. Do not add newly observed secondary identities on an existing promotion; repeated promotion must be read-idempotent, not silent canonical mutation.

- [ ] **Step 5: Insert canonical rows only after identity reservations succeed**

Insert:

```sql
INSERT INTO core.works (
  id, work_type, title, title_status
) VALUES ($1, 'BOOK', $2, 'KNOWN');

INSERT INTO core.editions (
  id, work_id, edition_type, publisher,
  publication_date, publication_date_precision, isbn
) VALUES ($1, $2, 'BOOK_EDITION', $3, $4, 'YEAR', $5);

INSERT INTO core.sources (
  id, source_type, edition_id, observed_at, metadata
) VALUES ($1, 'DATABASE_RECORD', $2, $3, $4::jsonb);
```

Then `COMMIT`.

On every thrown error, execute `ROLLBACK` before releasing the client.

- [ ] **Step 6: Add idempotency and catalog-drift tests**

Test A: same candidate twice:

```text
first.status  = created
second.status = existing
IDs identical
counts remain 1/1/1
```

Test B: promote once, then call again with the same catalog id but a changed title/publisher/year/isbn:

```text
status=existing
IDs identical
original Work.title unchanged
original Edition fields unchanged
no extra Source row
```

- [ ] **Step 7: Add concurrent duplicate test**

Run:

```ts
const [a, b] = await Promise.all([
  store.promote(candidate),
  store.promote(candidate),
]);
```

Assert:

```text
statuses are one "created" + one "existing"
same workId/editionId/sourceId
counts remain 1/1/1
one active CATALOG_DOCUMENT identity
```

This test is required; sequential idempotency is not a substitute.

- [ ] **Step 8: Add SSID and DXID conflict tests**

Promote candidate A.

Then promote candidate B with a different `catalogBookId` but the same SSID; expect `IdentityConflictError`.

Repeat separately for DXID.

After each rejected promotion:

```text
no Work/Edition/Source for candidate B
no CATALOG_DOCUMENT identity for candidate B
candidate A remains intact
```

- [ ] **Step 9: Add rollback-on-SQL-failure test**

Pass a repository-level candidate whose `publicationDate` is intentionally `"not-a-date"` using a narrow test-only type cast.

Expected PostgreSQL insert failure.

Then assert:

```text
0 work rows
0 edition rows
0 source rows
0 external identity rows for that catalog id/SSID/DXID
```

This proves identity reservations roll back with the failed canonical write.

- [ ] **Step 10: Implement connection error classification**

Connection-level failures such as `ECONNREFUSED`, `ENOTFOUND`, or SQLSTATE class `08` become `CanonicalStoreUnavailableError`.

Do not convert arbitrary constraint/programming errors into “unavailable”; unexpected SQL errors remain unexpected and will map to HTTP 500 later.

- [ ] **Step 11: Create the disposable PG16 integration runner**

Create `scripts/s32-m1a-integration-check.ts` that:

1. verifies `postgres:16-alpine` is already present; no pull by default;
2. starts one disposable container with `--rm`, tmpfs data dir, and random loopback host port;
3. waits for `pg_isready`;
4. applies `db/migrations/001_s32_core_schema.sql` with `ON_ERROR_STOP=1`;
5. runs only `catalog-promotion-store.integration.test.ts` with `S32_TEST_DATABASE_URL`;
6. removes the container in a synchronous/fail-closed finally path;
7. exits non-zero if tests fail or cleanup unexpectedly fails.

Add root script:

```json
"s32:m1a:check": "tsx scripts/s32-m1a-integration-check.ts"
```

Do not modify `scripts/s32-schema-check.ts`; M0's schema gate stays independent.

- [ ] **Step 12: Run Task 4 real integration**

Run:

```bash
./node_modules/.bin/tsx scripts/s32-m1a-integration-check.ts
```

Expected:

```text
PG_READY=YES
M1A_CREATED=PASS
M1A_IDEMPOTENT=PASS
M1A_CONCURRENT_IDEMPOTENT=PASS
M1A_SSID_CONFLICT=PASS
M1A_DXID_CONFLICT=PASS
M1A_ROLLBACK=PASS
M1A_INTEGRATION_OK
```

Then verify no M1-A test container remains.

- [ ] **Step 13: Commit Task 4**

```bash
git add apps/api/src/s32/postgres \
  scripts/s32-m1a-integration-check.ts package.json
git commit -m "feat(s32): persist catalog promotions transactionally"
```

---

### Task 5: Add the authenticated HTTP route and mount it without changing existing search behavior

**Files:**
- Create: `apps/api/src/s32/routes/catalog-promotion-route.ts`
- Create: `apps/api/src/s32/routes/catalog-promotion-route.test.ts`
- Create: `apps/api/src/s32/register.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Route: `POST /api/private/s32/promotions/catalog-book`
- Request:

```json
{ "bookId": "existing-meili-document-id" }
```

- Success response:

```json
{
  "status": "created",
  "workId": "uuid",
  "editionId": "uuid",
  "sourceId": "uuid",
  "catalogBookId": "string"
}
```

Created uses HTTP 201; existing uses HTTP 200.

- [ ] **Step 1: Write failing handler tests**

Do not import `apps/api/src/index.ts` in tests because it calls `app.listen`.

Export a testable handler/router factory from the new route module.

Required cases:

```text
S32 disabled                           -> 404; command not called
enabled, token not configured          -> 503; command not called
missing token                          -> 401; command not called
bad token                              -> 403; command not called
enabled/authenticated, DB unconfigured -> 503; command not called
body missing/blank bookId              -> 400
created                                -> 201 + exact result body
existing                               -> 200 + exact result body
CatalogBookNotFoundError               -> 404
InvalidCatalogBookError                -> 422
IdentityConflictError                  -> 409
CatalogReadUnavailableError            -> 503
CanonicalStoreUnavailableError         -> 503
unexpected error                       -> 500 generic message
```

Also send:

```json
{
  "bookId": "abc",
  "title": "attacker title",
  "publisher": "attacker publisher"
}
```

and prove the command receives only:

```json
{ "bookId": "abc" }
```

- [ ] **Step 2: Implement fail-closed route mapping**

Authentication/config checks happen before invoking the command.

Do not echo DB errors, Meili errors, tokens, connection strings, or catalog rawInfo in responses.

- [ ] **Step 3: Assemble dependencies in `register.ts`**

Use `readS32Config(process.env)`.

When disabled:

```text
router exists but all M1-A writes are hidden as 404
no PostgreSQL query is attempted
```

When enabled but `databaseUrl` is absent:

```text
authenticated M1-A write returns 503
API startup still succeeds
```

When fully configured:

```text
Meili reader wraps existing index.getDocument
pg.Pool uses S32_DATABASE_URL
application command wires reader + store
```

The Pool must not connect eagerly at module import time; connection happens on command execution.

- [ ] **Step 4: Mount only the new router in the existing API**

In `apps/api/src/index.ts`, add one focused import and one mount near existing route setup.

Target shape:

```ts
app.use(
  "/api/private/s32",
  createS32Router({
    env: process.env,
    getCatalogDocument: (id) => index.getDocument(id),
  }),
);
```

Do not move or rewrite existing search/AI/WeRead handlers in M1-A.

- [ ] **Step 5: Run route tests and existing search regression tests**

Run:

```bash
./node_modules/.bin/vitest run \
  apps/api/src/s32/routes/catalog-promotion-route.test.ts \
  apps/api/src/handle-search.test.ts \
  apps/api/src/search/normalize.test.ts \
  apps/api/src/search/query-cleanup.test.ts \
  apps/api/src/search/query-interpretation.test.ts \
  apps/api/src/search/intent-profile.test.ts \
  apps/api/src/search/rerank.test.ts
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
```

Expected: all listed tests PASS, TypeScript exit 0.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/api/src/s32/routes \
  apps/api/src/s32/register.ts apps/api/src/index.ts
git commit -m "feat(s32): expose private catalog promotion endpoint"
```

---

### Task 6: Close the M1-A implementation gate and document the exact boundary

**Files:**
- Create: `docs/S32_M1A_PROMOTION.md`
- Modify only if needed for script registration already described: `package.json`

**Interfaces:**
- Produces the final M1-A validation record.
- Does not deploy Production.

- [ ] **Step 1: Write the developer/operator document**

`docs/S32_M1A_PROMOTION.md` must record:

```text
Route: POST /api/private/s32/promotions/catalog-book
Default: disabled
Required env to enable:
  S32_FEATURES_ENABLED=true
  S32_DATABASE_URL=...
  S32_PRIVATE_API_TOKEN=...

Primary identity:
  provider=BOOK_ID_SEARCH
  namespace=CATALOG_DOCUMENT
  target_type=SOURCE

Secondary identities:
  SSID / DXID -> SOURCE

Explicitly not implemented:
  project creation/binding
  notes
  rediscovery UI
  bulk catalog import
  author resolution
  production deployment
```

Include the status/error mapping table.

- [ ] **Step 2: Run all M1-A unit tests**

Run:

```bash
./node_modules/.bin/vitest run \
  apps/api/src/s32/config.test.ts \
  apps/api/src/s32/routes/private-auth.test.ts \
  apps/api/src/s32/domain/catalog-promotion.test.ts \
  apps/api/src/s32/catalog/meili-catalog-book-reader.test.ts \
  apps/api/src/s32/application/promote-catalog-book.test.ts \
  apps/api/src/s32/routes/catalog-promotion-route.test.ts
```

Expected: 0 failed tests.

- [ ] **Step 3: Run the real PG16 M1-A integration gate**

```bash
./node_modules/.bin/tsx scripts/s32-m1a-integration-check.ts
```

Expected: `M1A_INTEGRATION_OK`, exit 0, no residual M1-A container.

- [ ] **Step 4: Re-run M0 schema verification to prove no regression**

```bash
./node_modules/.bin/tsx scripts/s32-schema-check.ts
```

Expected:

```text
s32_test_a install+assertions OK
s32_test_b install+assertions OK
SCHEMA_OK
```

No manual container cleanup should be required.

- [ ] **Step 5: Run API build/typecheck**

```bash
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
```

Expected: exit 0.

Do not require the unrelated Puppeteer browser smoke, global pnpm bootstrap, or historical WeRead whole-suite failure to pass this M1-A gate; record them separately if still present.

- [ ] **Step 6: Verify repository scope before final commit**

Required clean-scope checks:

```bash
git diff --name-only main...HEAD
git status --short
sha256sum db/migrations/001_s32_core_schema.sql \
  db/tests/001_s32_schema_assertions.sql \
  db/tests/002_s32_negative_invariants.sql
```

Requirements:

```text
M0 migration unchanged
M0 assertion SQL unchanged
M0 negative SQL unchanged
no apps/web changes
no docker-compose changes
no production files
no secrets
```

- [ ] **Step 7: Commit docs/final gate**

```bash
git add docs/S32_M1A_PROMOTION.md
git commit -m "docs(s32): document M1A catalog promotion contract"
```

- [ ] **Step 8: Push and open one M1-A PR**

PR title:

```text
feat(s32): add M1A catalog-to-canonical promotion
```

PR body must include these gates:

```text
M1A_UNIT_TESTS=PASS
M1A_PG16_INTEGRATION=PASS
M1A_CONCURRENT_IDEMPOTENCY=PASS
M1A_IDENTITY_CONFLICT=PASS
M1A_ROLLBACK=PASS
M0_SCHEMA_REGRESSION=PASS
API_TYPECHECK=PASS
PRODUCTION_DEPLOYED=NO
M1_B_STARTED=NO
```

Do not merge automatically. Final code review is a separate gate.

---

## Plan Self-Review

### Spec coverage

- Explicit promotion only: covered by application command + private route.
- Catalog authoritative reread by `bookId`: covered by Meili reader + command.
- Work/Edition/Source/ExternalIdentity mapping: covered by domain mapper + PG adapter.
- Existing promotion returns same chain without overwrite: covered by sequential + drift integration tests.
- Secondary SSID/DXID conflict: covered by separate integration tests.
- No fuzzy merge: no code path or repository method exists for it.
- Author remains source provenance: mapper tests pin this.
- No bulk catalog import: no batch API/command exists.
- Production deployment separate: no Compose/runtime changes in plan.
- M1-B…E excluded: no Project/Note/Web implementation files in plan.
- Security gap discovered during planning: spec amended to private, default-disabled S32 write route and pinned here.

### Placeholder scan

No implementation step contains TBD/TODO/“similar to”. Every task names exact files, interfaces, commands, and expected outcomes.

### Type consistency

`CatalogBookSnapshot → PromotionCandidate → CatalogPromotionStore.promote() → PromotionResult` is the only write-path data flow. HTTP passes only `bookId`; generated UUIDs exist only inside the PostgreSQL adapter.

### Review Focus coverage

1. Anonymous write attempt → Task 5 route tests.
2. Concurrent duplicate promotion → Task 4 Step 7.
3. Catalog drift on repeat → Task 4 Step 6.
4. SSID/DXID collision → Task 4 Step 8.
5. Mid-transaction failure → Task 4 Step 9.