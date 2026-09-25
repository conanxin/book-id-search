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
API_TO_R0_ROLLBACK   # separate explicit rollback authorization
```

Forward rollout authorization never authorizes rollback. API rollback requires its own one-time `S32_PRODUCTION_ROLLBACK / API_TO_R0` artifact.

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

R1 must use fresh exact-candidate C/T/U sizes and exact filesystem byte facts.

The capacity planner must be given:
- the canonical S32 release manifest;
- the exact API candidate JSON;
- the exact Web candidate JSON;
- filesystem facts containing `totalBytes`, `usedBytes`, and `freeBytes`.

It verifies candidate image/tag/revision/lock/base/static identities against the release manifest before using the candidate C/T/U measurements. Rounded `df` percentages are not capacity identity and are not used to derive total bytes.

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

Release-scoped secret files:

```text
/opt/book-id-search-runtime/s32/<S32_RELEASE_FINGERPRINT>/postgres.env
/opt/book-id-search-runtime/s32/<S32_RELEASE_FINGERPRINT>/api.env
```

Both secret files must be regular, non-symlink, mode-600 files. R2–R5 use the same release-scoped `postgres.env`; do not create an alternate repo-local PostgreSQL secret file.

- no host PostgreSQL port;
- no auto-created bind path;
- `s32_admin` is bootstrap/admin only;
- API uses `s32_app`;
- PostgreSQL image identity is backend-compatible and fail-closed: the manifest digest in `pgImageRef` (`…@sha256:…`) is the canonical cross-backend pull identity; `pgImageId` is legacy/config identity evidence. Hosts running Docker with the containerd image store (e.g. Docker 29 `io.containerd.snapshotter.v1`) report `docker image inspect <digest> .Id` as the manifest digest, while classic image stores report the config digest — both are accepted observed values, anything else blocks (`PG_IMAGE_ID_MISMATCH`), and RepoDigests must independently carry the exact expected manifest digest (`PG_IMAGE_REPODIGEST_MISMATCH` otherwise);
- the R2 receipt records the host-local observed image ID (`PG_IMAGE_ID`) plus the non-secret `PG_MANIFEST_DIGEST`;
- R3 discovers the already-running PostgreSQL container by the exact Compose project/service labels, verifies its `docker inspect .Image` against the R2 receipt's host-local `PG_IMAGE_ID` (same-host runtime binding; never the manifest config ID) and requires health=healthy before any psql operation;
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
- R4/R5 failure: after separate explicit rollback authorization, run `scripts/rollback-s32-api-to-r0.sh --rollback-api-to-r0 <fingerprint> <release-source-sha> <control-plane-sha>`. It restores the exact R0 API compose/image identity, verifies legacy search, and retains PostgreSQL/schema.
- R6 failure: restore exact R0 Web image using the reviewed Web deploy path; do not roll API/PostgreSQL back unless independently required.
- Never alter Meilisearch as S32 rollback.

## R7 acceptance

R7 is two-phase and consumes the already-claimed `R7` stage authorization.

### Phase 1 — API canary

Run the guarded R7 executor in API mode:

```bash
scripts/execute-s32-r7-acceptance.sh \
  --execute-r7-api \
  <S32_RELEASE_FINGERPRINT> \
  <RELEASE_SOURCE_SHA> \
  <CONTROL_PLANE_SHA>
```

This creates/reuses exactly one retained project:

```text
[S32 Production Acceptance] <fingerprint-short>
```

and writes a mode-600 `R7.api.env` partial receipt. It does **not** write the terminal R7 receipt.

### Phase 2 — real Web/mobile evidence

Using the existing session-only S32 credential model, run an external real-browser acceptance against the public Web and the exact canary `PROJECT_ID` from `R7.api.env`.

The reviewed receipt producer is the only supported way to emit the Web receipt. Run it from the exact control-plane checkout and bind the receipt to that commit:

```bash
S32_R7_BROWSER_URL=https://books.conanxin.com \
node scripts/s32-r7-browser-receipt-producer.cjs \
  browser \
  "progress/s32-rollout-<fingerprint>-R7.web.env" \
  "<S32_RELEASE_FINGERPRINT>" \
  "<PROJECT_ID>" \
  "<CONTROL_PLANE_SHA>"
```

The producer records `RUNNER_VERSION=1`, `RUNNER_SOURCE_SHA=<CONTROL_PLANE_SHA>`, and a canonical `RECEIPT_SHA256`. Terminal R7 completion recomputes that hash and rejects wrong source, project, fingerprint, or modified receipt content.


The browser evidence must prove:

```text
S32_WEB_ACCEPTANCE=PASS
MOBILE_390x844=PASS
NO_HORIZONTAL_OVERFLOW=PASS
```

and write a mode-600, non-secret receipt:

```text
progress/s32-rollout-<fingerprint>-R7.web.env
```

bound to the same fingerprint and Project ID. The browser receipt must not contain token/password/database-url fields.

### Phase 3 — terminal completion

Only after both partial receipts exist:

```bash
scripts/execute-s32-r7-acceptance.sh \
  --complete-r7 \
  <S32_RELEASE_FINGERPRINT> \
  <RELEASE_SOURCE_SHA> \
  <CONTROL_PLANE_SHA>
```

The executor validates API canary identity plus the Web/mobile receipt and only then writes `R7.result.env`. The cross-stage planner cannot report `ROLLOUT_COMPLETE` before that terminal receipt exists.

The acceptance project is retained as persistence/audit evidence. Do not automatically delete it.

## Current execution boundary

Until a later explicit production-write approval:

```text
PRODUCTION_WRITE_AUTHORIZED=NO
PRODUCTION_CHANGED=NO
M2_E_STARTED=NO
```
