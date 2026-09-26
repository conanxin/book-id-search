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

`CONTROL_PLANE_SYNC` is a repeatable control-plane maintenance stage within one release: tooling fixes merged to main can require a second sync under the same release fingerprint. Its authorization identity therefore binds release fingerprint + control-plane SHA (`s32-rollout-authorization-<FP>-CONTROL_PLANE_SYNC-<CTRL>.env` and its `-claim.env`). Historical sync authorizations/claims are retained for audit; a new sync never deletes or overwrites earlier evidence. A first-sync legacy claim (`…-CONTROL_PLANE_SYNC-claim.env` without the SHA suffix) remains usable only when its recorded `CONTROL_PLANE_SHA` exactly matches the requested target; legacy evidence bound to any other SHA is never reused, migrated, or rewritten. All other rollout stages remain one-shot authorizations keyed by release fingerprint + stage (`R2_R3`, `R4_R5`, `R6`, `R7` keep the fingerprint+stage paths).

Each sync execution is itself one-shot and forward-only. The executor writes `s32-rollout-<FP>-CONTROL_PLANE_SYNC-<CTRL>.start.env` (with `PRE_CONTROL_PLANE_SHA`) immediately before the checkout mutation and `…result.env` only after the post-reset baseline and runtime-unchanged checks pass; a START without a RESULT marks the attempt INCOMPLETE/UNKNOWN and is never auto-retried, and a terminal RESULT blocks re-execution for that FP+CTRL. A target equal to the current HEAD blocks (`CONTROL_PLANE_ALREADY_AT_TARGET`) and a target that is not a descendant of the current HEAD blocks (`CONTROL_PLANE_NON_FORWARD_TARGET`) — so no retained claim (scoped or legacy) can ever roll the control plane back to an older checkout.

Although CONTROL_PLANE_SYNC may repeat within one release, each CTRL authorization yields exactly one execution attempt: START without RESULT = incomplete/unknown (no retry); a terminal RESULT = consumed (no second execution); control-plane movement is only allowed from the current HEAD to a descendant target; and old retained claims never constitute rollback authorization.

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

## Runtime image identity across Docker backends

The release manifest remains the immutable build identity. Its `apiImageId`, `webImageId`, and `pgImageId` fields are config digests produced by the release builders.

Docker image stores do not expose a single portable `.Id` representation:

- classic Docker stores commonly expose the config digest;
- Docker with the containerd image store may expose the OCI manifest digest for the same loaded image.

Runtime executors must therefore never weaken identity to tag/revision-only checks and must never require `.Id == manifest config digest` across backends.

For API/Web images the reviewed verifier follows a fail-closed proof chain:

1. require the exact manifest-pinned tag and OCI revision;
2. if host-observed `.Id` equals the frozen config digest, accept `CONFIG_DIGEST` mode;
3. otherwise export the exact local tag with `docker image save` and parse the archive;
4. require the saved OCI manifest digest to equal the host-observed `.Id`;
5. require that manifest's config descriptor/blob digest to equal the frozen manifest config digest;
6. verify the config revision label and every referenced layer blob digest;
7. reject any other observed ID or archive ambiguity.

No release-manifest key or fingerprint changes for this backend representation difference.

Stage receipts distinguish the two identities:

- R4/R5: `API_CONFIG_DIGEST` = frozen manifest config digest; `API_IMAGE_ID` = same-host observed runtime ID.
- R6: `WEB_CONFIG_DIGEST` = frozen manifest config digest; `WEB_IMAGE_ID` = same-host observed runtime ID.
- R6 API parity consumes the R5 observed `API_IMAGE_ID`; PostgreSQL parity consumes the R2 observed `PG_IMAGE_ID`.

This keeps later-stage runtime comparisons on one host representation while preserving cryptographic linkage to the frozen release bytes.

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
