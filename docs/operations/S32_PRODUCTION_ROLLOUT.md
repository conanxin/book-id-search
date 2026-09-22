# S32 Production Rollout Operator Contract

Task: `S32_PRODUCTION_ROLLOUT_EXECUTION_R1`

This runbook describes the staged rollout tooling only. It does **not** authorize production writes.

## Architecture

```text
R0  fresh production baseline (read-only)
R1  capacity + release gate (read-only)
CP  control-plane sync (separate explicit authorization)
R2  PostgreSQL dark bootstrap
R3  frozen schema + runtime role bootstrap
R4  API dark rollout, S32 disabled
R5  S32 backend activation
R6  Web rollout
R7  production acceptance + retained release-scoped canary
```

Every R1-R7 receipt is bound to one `S32_RELEASE_FINGERPRINT`.

## Authorization boundaries

Production-write authorizations are stage scoped:

```text
CONTROL_PLANE_SYNC
R2_R3
R4_R5
R6
R7
```

Planning, candidate building, tests, or merge approval never imply production-write authorization.

## Hard forbidden operations

Do not run as part of this rollout:

- global `docker compose down`;
- global `docker compose up --build`;
- build application images on production;
- automatic `docker system prune` / image prune;
- automatic deletion of old images;
- automatic deletion of PostgreSQL data;
- automatic database/schema drops;
- Meilisearch data/index mutation;
- automatic retry after an ambiguous production stage;
- destructive automatic rollback.

## Release identity

The release manifest binds:

- exact release source SHA;
- pnpm lock hash;
- API image tag/ID/OCI revision/base digest;
- Web image tag/ID/OCI revision/static manifest/S32 enablement/base digests;
- PostgreSQL image digest/ID;
- frozen migration SHA;
- role bootstrap SHA;
- S32 Compose override SHA.

Secrets are never part of the manifest or receipts.

## Control-plane sync bootstrap

The current production checkout may predate the rollout tooling. Therefore `CONTROL_PLANE_SYNC` must be launched from a reviewed external tool bundle containing at least:

```text
execute-s32-control-plane-sync.sh
plan-s32-production-baseline.py
```

The bundle bytes/commit identity must correspond to the reviewed control-plane SHA. The sync executor uses the baseline planner from its own `SCRIPT_DIR` before and after changing the checkout, so it never assumes the old checkout already contains the new rollout scripts.

The control-plane sync changes Git checkout state only. Web/API/Meilisearch CID, StartedAt, image ID, and public HTTP state must remain unchanged.

## R0 / R1 read-only preflight

R0 must freshly record:

- checkout SHA;
- Web/API/Meili CID, StartedAt, image ID/revision;
- HTTP health;
- ISBN / SSID / DXID / title / author / publisher search smoke;
- Meilisearch document count and indexing state;
- PostgreSQL/S32 runtime presence.

R1 must use fresh exact-candidate C/T/U sizes and filesystem facts.

Capacity policy:

```text
HARD_FREE_RESERVE=20 GiB
PREFERRED_FREE_RESERVE=21 GiB
MAX_USED_PERCENT=80
```

`PASS_HARD_ONLY` is not enough by itself; it requires explicit hard-only acceptance recorded in the release/authorization chain.

## PostgreSQL / schema

Canonical PGDATA:

```text
/data/book-id-search/postgres_data
```

- no host PostgreSQL port;
- no auto-created bind path;
- `s32_admin` is bootstrap/admin only;
- API uses `s32_app`;
- production may run `db/tests/001_s32_schema_assertions.sql`;
- production must **not** run `db/tests/002_s32_negative_invariants.sql`.

## Browser credential

The first rollout keeps the existing model:

```text
manual S32 credential entry
→ sessionStorage only
→ Authorization: Bearer <token>
```

The private token must never be embedded in the public Web image/static bundle.

## Incomplete attempts

A `*.start` artifact without a matching terminal receipt means:

```text
INCOMPLETE / UNKNOWN
```

Do not auto-resume or auto-retry. Inspect production state first.

## Rollback identities

R0 is the rollback reference.

- R2 failure: stop/remove PG container only; retain PGDATA.
- R3 failure: stop rollout; retain schema/PGDATA for inspection.
- R4/R5 failure: restore exact R0 API image/config or disable S32.
- R6 failure: restore exact R0 Web image.
- Never alter Meilisearch as S32 rollback.

## R7 acceptance

Run:

```bash
S32_PRIVATE_API_TOKEN='<runtime secret>' \
S32_RELEASE_FINGERPRINT='<64 hex>' \
S32_API_BASE_URL='https://books.conanxin.com' \
S32_PUBLIC_URL='https://books.conanxin.com' \
pnpm s32:production:acceptance
```

The harness retains exactly one project named:

```text
[S32 Production Acceptance] <fingerprint-short>
```

as persistence/audit evidence. Do not automatically delete it.

## Current execution boundary

Until a later explicit production-write approval:

```text
PRODUCTION_WRITE_AUTHORIZED=NO
PRODUCTION_CHANGED=NO
M2_E_STARTED=NO
```
