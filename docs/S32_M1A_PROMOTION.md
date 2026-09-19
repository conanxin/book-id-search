# S32-M1A Catalog → Canonical Promotion

## Status

M1-A implements the first S32 canonical write path on the feature branch only.

It does **not** deploy PostgreSQL to Production, does not change Docker Compose, and does not start M1-B.

## Route

```http
POST /api/private/s32/promotions/catalog-book
Authorization: Bearer <S32_PRIVATE_API_TOKEN>
Content-Type: application/json

{ "bookId": "<existing Meilisearch catalog document id>" }
```

The client supplies only `bookId`. The API re-reads the current catalog document from Meilisearch before mapping it into S32.

Caller-supplied bibliographic fields such as `title`, `publisher`, `isbn`, `author`, or `year` are not accepted as canonical input.

## Default state and required configuration

S32 writes are disabled by default.

```dotenv
S32_FEATURES_ENABLED=false
S32_DATABASE_URL=
S32_PRIVATE_API_TOKEN=
```

To enable M1-A in an isolated/dev environment:

```dotenv
S32_FEATURES_ENABLED=true
S32_DATABASE_URL=postgresql://...
S32_PRIVATE_API_TOKEN=<private-token>
```

S32 authentication is independent from the WeRead private overlay. Do not substitute:

```text
WEREAD_OVERLAY_ENABLED
WEREAD_PRIVATE_API_TOKEN
```

for S32 settings.

Missing `S32_DATABASE_URL` does not prevent API startup. An authenticated promotion attempt returns 503 until a database is configured.

## Canonical mapping

A new promotion writes one chain:

```text
core.works
  ↓
core.editions
  ↓
core.sources
  ↓
core.external_identities
```

### Work

```text
work_type   = BOOK
title       = trimmed catalog title
title_status= KNOWN
```

A blank catalog title is rejected.

### Edition

```text
edition_type                = BOOK_EDITION
publisher                   = trimmed publisher or NULL
publication_date            = YYYY-01-01 when a valid integer year 1..9999 exists
publication_date_precision  = YEAR
isbn                        = structurally normalized ISBN-10/ISBN-13 or NULL
```

M1-A does not validate ISBN checksums and does not use ISBN for automatic identity merging.

### Source

```text
source_type = DATABASE_RECORD
edition_id  = promoted Edition
observed_at = promotion observation time
```

`Source.metadata.catalogDocument` preserves the catalog snapshot, including ambiguous or not-yet-canonicalized fields such as:

```text
author
pages
rawInfo
parseStatus
parseWarnings
```

M1-A does not create Actor or Contribution rows from the raw `author` string.

## External identity contract

All identities created by M1-A bind to:

```text
target_type = SOURCE
```

### Primary idempotency identity

```text
provider    = BOOK_ID_SEARCH
namespace   = CATALOG_DOCUMENT
external_id = Book.id
target_type = SOURCE
```

The M0 partial unique index on `(provider, namespace, external_id)` for non-retired bindings is the concurrency arbiter.

Repeated promotion of the same catalog id returns the existing canonical Work/Edition/Source chain and does not create duplicates.

A repeated promotion does not silently rewrite canonical title, publisher, publication date, or ISBN when the current Meilisearch row has drifted.

### Secondary identities

Non-empty catalog identifiers are stored as:

```text
provider=BOOK_ID_SEARCH, namespace=SSID, target_type=SOURCE
provider=BOOK_ID_SEARCH, namespace=DXID, target_type=SOURCE
```

If SSID or DXID is already actively bound to another Source, the new promotion fails with an identity conflict and the entire transaction rolls back.

M1-A never fuzzy-merges by title, author, publisher, or ISBN.

## HTTP status mapping

| Situation | Status |
|---|---:|
| S32 disabled | 404 |
| S32 private token not configured | 503 |
| Missing request token | 401 |
| Invalid request token | 403 |
| Authenticated but database not configured | 503 |
| Missing/blank `bookId` | 400 |
| Catalog book not found | 404 |
| Catalog metadata not promotable | 422 |
| Canonical/secondary identity conflict | 409 |
| Meilisearch catalog read unavailable | 503 |
| PostgreSQL canonical store unavailable | 503 |
| Unexpected internal failure | 500 |
| New promotion created | 201 |
| Existing promotion returned | 200 |

Error responses are generic and must not expose tokens, PostgreSQL connection strings, raw SQL errors, Meilisearch provider errors, or `rawInfo`.

## Transaction and concurrency behavior

The PostgreSQL adapter:

1. begins one transaction;
2. reserves the primary `CATALOG_DOCUMENT` identity with the M0 partial unique index;
3. when the primary identity already exists, validates and returns its existing Source → Edition → Work chain;
4. for a new promotion, reserves SSID/DXID secondary identities;
5. creates Work, Edition, and Source;
6. commits only when every step succeeds;
7. rolls back on any failure.

Two simultaneous promotions of the same catalog id must converge on one canonical chain: one request reports `created`, the other `existing`.

A later SQL failure after identity reservation must leave zero partial Work/Edition/Source/ExternalIdentity rows from the rejected promotion.

## Validation commands

### M1-A unit/application/route tests

```bash
./node_modules/.bin/vitest run \
  apps/api/src/s32/config.test.ts \
  apps/api/src/s32/routes/private-auth.test.ts \
  apps/api/src/s32/domain/catalog-promotion.test.ts \
  apps/api/src/s32/catalog/meili-catalog-book-reader.test.ts \
  apps/api/src/s32/application/promote-catalog-book.test.ts \
  apps/api/src/s32/routes/catalog-promotion-route.test.ts
```

### Real disposable PostgreSQL 16 integration

Requires the `postgres:16-alpine` image to already be available.

```bash
./node_modules/.bin/tsx scripts/s32-m1a-integration-check.ts
```

Expected gate markers include:

```text
PG_READY=YES
M1A_SCHEMA_READY=YES
M1A_CREATED=PASS
M1A_IDEMPOTENT=PASS
M1A_CONCURRENT_IDEMPOTENT=PASS
M1A_SSID_CONFLICT=PASS
M1A_DXID_CONFLICT=PASS
M1A_ROLLBACK=PASS
M1A_INTEGRATION_OK
TEST_CONTAINER_REMOVED=YES
```

### M0 schema regression

```bash
./node_modules/.bin/tsx scripts/s32-schema-check.ts
```

Expected:

```text
s32_test_a install+assertions OK
s32_test_b install+assertions OK
SCHEMA_OK
```

### API typecheck

```bash
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
```

## Explicitly not implemented in M1-A

- Project creation/list/get
- ProjectBinding
- Note / NoteRevision application flow
- Rediscovery/project UI
- Any Web UI changes
- Bulk promotion/import of the 5,115,734 catalog documents
- Author → Actor/Contribution identity resolution
- Fuzzy canonical merge
- Claim / Assessment / IssueResolution UI
- EvidenceManifest / ResearchRun automation
- Vector / embedding storage
- Notion or Drive two-way synchronization
- Production PostgreSQL deployment
- Production Compose changes
- M1-B

## Deployment boundary

Passing the M1-A implementation gate means the application code is reviewable; it does **not** authorize Production deployment.

A future Production PostgreSQL deployment must have a separate gate covering capacity, volume persistence, backup/restore, secrets, Compose changes, API failure behavior, health checks, and rollback.
