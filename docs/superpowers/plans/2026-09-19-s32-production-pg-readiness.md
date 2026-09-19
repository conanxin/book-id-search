# S32 Production PostgreSQL Deployment Readiness Gate

**Date:** 2026-09-19  
**Baseline:** `main@630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d`  
**Status:** READINESS_AUDIT_IN_PROGRESS  
**Deployment:** NOT STARTED

## Goal

Determine whether the production host is ready to run a persistent PostgreSQL 16 service for S32 M1-A without expanding the public attack surface or degrading the existing BOOK-ID-SEARCH deployment.

This gate is **read-only first**. It does not authorize source checkout changes, Compose edits, API rebuild/restart, PostgreSQL startup, schema migration, feature enablement, or M1-B.

## Repository-side findings

### Already ready

- M1-A application code is merged to `main`.
- API package includes `pg@^8.23.0`.
- S32 write path is disabled by default:
  - `S32_FEATURES_ENABLED=false`
  - `S32_DATABASE_URL=`
  - `S32_PRIVATE_API_TOKEN=`
- API startup is fail-safe when PostgreSQL is absent:
  - no eager database connection on module import;
  - authenticated write returns 503 when DB is not configured/unavailable.
- S32 private writes are independent from WeRead auth.
- M0 PostgreSQL migration and verification harness are already validated on PostgreSQL 16.

### Not ready yet

Current `docker-compose.yml` has only:
- `meilisearch`
- `api`
- `web`

It does **not** define:
- PostgreSQL service;
- persistent PostgreSQL volume/bind mount;
- PostgreSQL healthcheck;
- production S32 DB credentials;
- production migration step;
- PostgreSQL backup/restore procedure.

Current production monitoring does **not** verify:
- PostgreSQL container health;
- S32 schema readiness;
- PostgreSQL persistence;
- PostgreSQL backup age/restore test;
- external exposure of port 5432.

Therefore repository evidence alone is insufficient for deployment readiness.

## Target production topology

Recommended target topology:

```text
Internet
  ↓
Caddy :443
  ↓
web :5173 loopback
  ↓
api :3001 loopback
  ├── Meilisearch :7700 (Compose internal + loopback host binding)
  └── PostgreSQL :5432 (Compose internal only; NO host port)
```

PostgreSQL must not publish `5432` on the host.

## Proposed PostgreSQL service contract

This is a design target only, not yet an implementation change:

```yaml
postgres:
  image: postgres:16-alpine
  restart: unless-stopped
  environment:
    POSTGRES_DB: ${S32_POSTGRES_DB}
    POSTGRES_USER: ${S32_POSTGRES_USER}
    POSTGRES_PASSWORD: ${S32_POSTGRES_PASSWORD}
  volumes:
    - ${S32_PG_DATA_DIR}:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
    interval: 10s
    timeout: 5s
    retries: 10
    start_period: 20s
```

No `ports:` entry.

The API should receive:
- `S32_FEATURES_ENABLED`
- `S32_DATABASE_URL`
- `S32_PRIVATE_API_TOKEN`

through production `.env` / Compose environment, never committed.

## Persistence decision gate

Before choosing `S32_PG_DATA_DIR`, production must report:

- filesystem for `/`;
- filesystem for `/data` and `/data/book-id-search` if present;
- free bytes and percentage used;
- available inode count;
- current Docker data-root;
- Docker images/volumes/build-cache footprint.

Preferred result:
- PostgreSQL data on a stable host path with explicit ownership and backup policy;
- enough headroom for image/build/cache growth plus DB WAL/data;
- not a temporary filesystem;
- not under a path that deployment scripts delete/recreate.

## Capacity gate

Existing formal floor remains:

```text
FREE_BYTES >= 21,474,836,480  (20 GiB)
USED_PERCENT <= 80
```

For an actual deployment, use a stronger **deployment headroom gate**:

```text
PREFERRED_FREE >= 22,549,755,904  (21 GiB)
```

Reason: the deployment can create a new API image layer, PostgreSQL metadata/WAL, logs, and temporary build/cache writes. Merely being a few hundred MiB above the 20 GiB emergency floor is not sufficient deployment margin.

If fresh audit is:
- below 20 GiB: BLOCKED_CAPACITY;
- 20–21 GiB: HOLD_LOW_HEADROOM;
- >=21 GiB and <=80% used: capacity can proceed to the next gate.

No cleanup is authorized by this audit.

## Backup and restore gate

Before enabling the first production canonical write:

1. PostgreSQL schema is installed successfully.
2. Create a baseline custom-format dump:
   `pg_dump -Fc`.
3. Copy the dump to an off-container host path.
4. Ensure there is an off-host backup destination/process before canonical data becomes important.
5. Restore the dump into a disposable database.
6. Run M0 schema assertions against the restored DB.
7. Drop the disposable restore DB only after PASS.

Required state:

```text
PG_BASELINE_BACKUP=PASS
PG_RESTORE_REHEARSAL=PASS
```

A dump that has never been restored is not sufficient evidence.

## Migration gate

Production migration must be explicit, not hidden in container init magic.

Sequence:

1. Start PostgreSQL with persistent storage.
2. Wait for `pg_isready`.
3. Apply `db/migrations/001_s32_core_schema.sql` with `ON_ERROR_STOP=1`.
4. Run schema assertions.
5. Verify `core.external_identities` and the 22/4/0 table contract.
6. Do not enable S32 feature until this passes.

## Feature-enable gate

Use two phases:

### Phase A — database present, S32 disabled

```text
PostgreSQL running
schema installed
backup + restore rehearsal complete
S32_FEATURES_ENABLED=false
```

Rebuild/recreate API if required for the merged source, then run full existing production health checks.

### Phase B — private M1-A write enabled

Only after Phase A PASS:

```text
S32_FEATURES_ENABLED=true
S32_DATABASE_URL=...
S32_PRIVATE_API_TOKEN=<random secret>
```

Then perform one bounded private promotion smoke using a known catalog book and verify:

- HTTP 201;
- exactly one Work/Edition/Source chain;
- second request returns HTTP 200 existing;
- no anonymous access;
- public search/stats unchanged.

## Rollback strategy

### Feature rollback

Fastest rollback:

```text
S32_FEATURES_ENABLED=false
recreate/restart API only
```

PostgreSQL data remains untouched.

### Application rollback

Redeploy the previous API source/image while leaving PostgreSQL volume untouched.

### Database rollback

Do **not** delete the PostgreSQL data directory as an application rollback.

If DB service causes operational pressure:
- disable S32 first;
- stop PostgreSQL only after confirming no writes are in flight;
- preserve data directory and latest dump.

## Monitoring requirements

Before calling deployment complete, extend or supplement monitoring to verify:

- PostgreSQL service running/healthy;
- `pg_isready`;
- S32 schema exists;
- port 5432 is not publicly reachable;
- disk usage/headroom;
- most recent backup timestamp.

Existing production checker already covers:
- public frontend;
- API health;
- document count/indexing;
- search regression;
- public exposure of 3001/5173/7700;
- Compose services;
- root disk;
- Meili data;
- TLS certificate.

Do not weaken any of those checks.

## Server-side readiness audit

The next evidence must come from the production host and must remain read-only.

Collect:

- exact production git HEAD / dirty state;
- exact free bytes and used percentage for `/`, `/data`, and Docker data-root;
- inode usage;
- Docker root directory and `docker system df -v`;
- current Compose service/container state;
- whether `postgres:16-alpine` is present and its digest/size;
- whether any container currently publishes/listens on 5432;
- existing PostgreSQL-related volumes/directories;
- current production health check using the canonical direct-Node checker.

No `docker pull`, `docker prune`, `rm`, `git pull`, Compose mutation, package installation, or service restart.

## Current authoritative state

```text
S32_M0=MERGED
S32_M1_A=MERGED
PRODUCTION_PG_READINESS=IN_PROGRESS
PRODUCTION_POSTGRESQL=NO
PRODUCTION_DEPLOYMENT=NO
S32_M1_B_STARTED=NO
```

## Next decision

After the production read-only audit:

- `READY_FOR_DEPLOYMENT_PLAN` if capacity, storage, image, health, exposure, backup destination, and rollback prerequisites are acceptable;
- otherwise `BLOCKED_<reason>` with no production mutation.

Only a subsequent explicit deployment plan approval can authorize Compose/code/env/runtime changes.
