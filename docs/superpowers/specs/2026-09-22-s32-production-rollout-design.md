# S32 Production Rollout Design

**Status:** Conversational design approved; written spec ready for internal self-review  
**Task ID:** `S32_PRODUCTION_ROLLOUT_DESIGN_R1`  
**Source baseline:** `main@3ddfce979ed3a2f73e75eab5f186944880c6ad4b`  
**Planning branch:** `plan/s32-production-rollout`

## 1. Purpose

BOOK-ID-SEARCH S32 development through M2-D is merged, reviewed, and closed in GitHub, but production at `https://books.conanxin.com/` is still the older Web/API/Meilisearch three-service stack.

The purpose of this rollout is:

> Deploy the merged S32 M0–M2-D capability to production without breaking the existing 5.1M-document search service, while keeping every high-risk transition separately verifiable and stoppable.

This is a production-rollout design, not a feature-design phase. M2-E is explicitly out of scope.

## 2. Verified production baseline

A read-only production audit on 2026-09-22 observed:

```text
PRODUCTION_CHECKOUT=9a18b2aa86c7cb1b27f6e99f9f5911e80b7b61ec
PRODUCTION_BRANCH=main

WEB_IMAGE=book-id-search-web:99a3702c64e5ae389800348dc7310f23eaed4a66
WEB_REVISION=99a3702c64e5ae389800348dc7310f23eaed4a66

API_IMAGE=book-id-search-api:3add9a60a20364fbd32b64a7d54197b75983d26e
API_REVISION=3add9a60a20364fbd32b64a7d54197b75983d26e

S32_ENV_NAMES=<none>
POSTGRES_SERVICE_PRESENT=NO
PUBLIC_HTTP_STATUS=200
PRODUCTION_CHANGED=NO
```

The audit proves that current production is healthy but does not contain the S32 PostgreSQL runtime or the M2-D backend.

## 3. Rollout strategy

The approved rollout strategy is **staged dark rollout**.

Rejected for this rollout:

- blue/green full-stack duplication, because current capacity is too constrained;
- big-bang Web+API+PostgreSQL activation, because failure isolation would be poor.

The rollout is divided into:

```text
R0  Production Baseline
R1  Capacity & Release Safety Gate
R2  PostgreSQL Dark Bootstrap
R3  Frozen Schema + Runtime Role Bootstrap
R4  New API Dark Rollout (S32 disabled)
R5  S32 Backend Activation
R6  New Web Rollout
R7  Production Acceptance & Closure
```

A later stage may begin only if every required receipt from earlier stages is present and bound to the same release fingerprint.

## 4. Hard safety rules

The following are forbidden unless separately and explicitly authorized outside this rollout design:

- global `docker compose down`;
- global `docker compose up --build`;
- build from the production checkout;
- Docker pull during a stage that is specified as `pull_policy: never`;
- automatic `docker system prune` or image prune;
- automatic deletion of old images;
- automatic deletion of `/data/book-id-search/postgres_data`;
- automatic database/schema drops;
- lowering the disk reserve policy;
- resizing the production filesystem;
- changing Meilisearch data;
- changing the 5,115,734-document search index as part of S32 rollout;
- automatic retry of a failed production-write stage;
- automatic rollback that destroys data;
- starting M2-E;
- deployment without stage-scoped production authorization.

Every production-write stage is fail-closed.

## 5. Capacity and storage model

### 5.1 PostgreSQL data path

The canonical PostgreSQL data bind is:

```text
/data/book-id-search/postgres_data
```

Compose must keep:

```yaml
bind:
  create_host_path: false
```

The directory is created only during an explicitly authorized R2 execution.

It must not be a symlink and must resolve under `/data/book-id-search/`.

If it already exists without a matching prior rollout receipt, R2 blocks.

### 5.2 PostgreSQL directory ownership

The production runtime UID/GID must be obtained from the exact approved PostgreSQL image.

Do not hardcode UID/GID.

The directory uses mode `0700` and the verified image runtime owner.

### 5.3 Capacity accounting domains

Before R2, identify the filesystems backing:

- DockerRootDir;
- `/opt/book-id-search`;
- `/opt/book-id-search-runtime`;
- `/data/book-id-search`.

If they are on one filesystem, use one combined capacity gate.

If `/data` is separate, use independent Docker/release and PostgreSQL-data gates.

### 5.4 Fresh candidate sizes

Old 2026-09-19 artifact sizes are historical evidence only.

R1 must measure fresh candidate artifacts for the final release source:

- API compressed transfer archive C;
- API saved tar T;
- API image logical bytes U;
- Web compressed transfer archive C;
- Web saved tar T;
- Web image logical bytes U.

### 5.5 Conservative peak

The gate uses:

```text
PEAK_INCREMENT =
  API_C + API_T + API_U
+ WEB_C + WEB_T + WEB_U
+ PG_INIT
+ PG_GROWTH_ALLOWANCE
+ LOG_ALLOWANCE
+ TRANSIENT_ALLOWANCE
```

Initial allowances:

```text
PG_INIT              = 128 MiB
PG_GROWTH_ALLOWANCE  = 1 GiB
LOG_ALLOWANCE        = 150 MiB
TRANSIENT_ALLOWANCE  = 128 MiB
```

These are planning allowances, not quotas.

### 5.6 Capacity policy

```text
HARD_FREE_RESERVE      = 20 GiB
PREFERRED_FREE_RESERVE = 21 GiB
MAX_USED_PERCENT       = 80%
```

Classification:

```text
FREE_AFTER_PEAK >= 21 GiB AND USED_AFTER_PEAK <= 80%
=> PASS_PREFERRED

20 GiB <= FREE_AFTER_PEAK < 21 GiB AND USED_AFTER_PEAK <= 80%
=> PASS_HARD_ONLY
=> requires explicit acceptance before R2

FREE_AFTER_PEAK < 20 GiB OR USED_AFTER_PEAK > 80%
=> BLOCKED_CAPACITY
```

Capacity remediation is a separate decision. The rollout planner must never perform cleanup, expansion, or reserve changes itself.

### 5.7 Stage re-checks

Re-check remaining headroom before R2, R4, and R6.

If current free space is less than remaining worst-case requirement plus the hard reserve, stop.

## 6. Release identity and provenance

### 6.1 Build once, deploy exact artifacts

```text
BUILD_ON_PRODUCTION=NO
BUILD_ONCE=YES
DEPLOY_SAME_IMAGE=YES
```

The production checkout is a deployment control plane, not a build source.

Do not run `git pull && docker compose up --build` as the S32 rollout mechanism.

### 6.2 Release source

The rollout uses one immutable:

```text
RELEASE_SOURCE_SHA=<exact 40-hex commit reachable from reviewed origin/main>
```

Do not use moving references such as `main`, `HEAD`, or `latest` as release identity.

The exact release SHA is frozen only after rollout tooling/spec implementation is complete and reviewed.

### 6.3 API identity

The API candidate must bind:

```text
API_IMAGE_TAG
API_IMAGE_ID
API_OCI_REVISION
```

and require:

```text
API_OCI_REVISION == RELEASE_SOURCE_SHA
```

### 6.4 Web identity

Before production rollout, the Web Dockerfile/build tooling must also add:

```dockerfile
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
```

The Web candidate binds:

```text
WEB_IMAGE_TAG
WEB_IMAGE_ID
WEB_OCI_REVISION
WEB_STATIC_MANIFEST_SHA256
```

and requires:

```text
WEB_OCI_REVISION == RELEASE_SOURCE_SHA
```

### 6.5 Final release parity

At R7:

```text
API_REVISION
==
WEB_REVISION
==
RELEASE_SOURCE_SHA
```

Temporary mismatch is allowed during R4/R5 because API rolls out before Web, but only as a declared intermediate state.

### 6.6 Other release-bound artifacts

The release manifest also binds:

```text
PNPM_LOCK_SHA256
MIGRATION_SHA256
ROLE_BOOTSTRAP_SHA256
S32_OVERRIDE_SHA256
PG_IMAGE_DIGEST
PG_IMAGE_ID
API_BASE_IMAGE_DIGEST
WEB_NODE_BASE_IMAGE_DIGEST
WEB_NGINX_BASE_IMAGE_DIGEST
```

Secrets are not included.

### 6.7 S32 Release Manifest v1

A canonical release manifest must contain the full non-secret artifact identity.

A canonical serialization is hashed to produce:

```text
S32_RELEASE_FINGERPRINT=SHA256(canonical release manifest)
```

R1 through R7 receipts must all reference the same fingerprint.

## 7. Control-plane synchronization

The production checkout may differ from the application release source.

Track separately:

```text
CONTROL_PLANE_SHA
RELEASE_SOURCE_SHA
```

Before R2, the production checkout must contain the exact reviewed rollout planner, override, role/bootstrap logic, and acceptance tooling.

Synchronizing the production checkout is a separate production write that must not:

- restart containers;
- change Docker images;
- change Compose runtime;
- change environment values;
- write the database.

After control-plane sync, the baseline Web/API/Meili CID, StartedAt, image IDs, and public HTTP/search checks must remain unchanged.

## 8. Authorization model

The existing Web-only production authorization pattern is reused conceptually but not reused as authority for S32.

Create a separate S32 rollout authorization contract bound to:

```text
AUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT
S32_RELEASE_FINGERPRINT
RELEASE_SOURCE_SHA
CONTROL_PLANE_SHA
ALLOWED_STAGES
```

Recommended authorization groups:

```text
A: R2 + R3
B: R4 + R5
C: R6
R7: explicit acceptance execution
```

No authorization artifact contains secret values.

Authorization is one-time, stage-scoped, and fail-closed.

## 9. PostgreSQL runtime topology

### 9.1 Database and roles

```text
DATABASE=book_id_search_s32

bootstrap/admin role=s32_admin
application role=s32_app
```

The API must never use `s32_admin`.

`s32_app` must be:

```text
SUPERUSER=false
CREATEROLE=false
CREATEDB=false
REPLICATION=false
DDL privileges=false
```

### 9.2 Public schema hardening

R3 applies:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

### 9.3 Runtime application grants

The first rollout keeps runtime permissions simple:

- CONNECT to `book_id_search_s32`;
- USAGE on `core`, `ops`, `derived`;
- required DML on `core` and `ops`;
- no schema/object ownership;
- no DDL.

Frozen constraints/triggers continue to enforce append-only and immutable object rules.

## 10. Secret lifecycle

Secrets:

```text
S32_ADMIN_PASSWORD
S32_APP_PASSWORD
S32_PRIVATE_API_TOKEN
```

Database passwords use 32 random bytes encoded as 64 lowercase hex characters.

Do not use UUIDs, timestamps, or human-readable passwords.

Secrets must not appear in:

- Git;
- release manifest;
- GitHub;
- Notion;
- STATUS;
- logs;
- shell history.

Runtime files live under:

```text
/opt/book-id-search-runtime/s32/{release-fingerprint}/
```

with root-owned directory and `0600` secret files.

Use separate files for PostgreSQL bootstrap and API activation.

### 10.1 Browser access credential

The production Web must **not** embed `S32_PRIVATE_API_TOKEN` in JavaScript, HTML, build-time Vite variables, or static assets.

The first rollout preserves the existing access model:

```text
operator/user manually enters the independent S32 credential
→ browser stores it in sessionStorage only
→ Web sends Authorization: Bearer <token>
→ closing the browser session discards the credential
```

This keeps the private S32 bearer secret out of the public Web image and static bundle.

R6/R7 acceptance must scan the built/static Web artifacts and prove that the private token value is absent.

## 11. R0 — Production Baseline

The 2026-09-22 read-only audit has already established the **runtime identity baseline**:

- production checkout;
- Web/API image tags/revisions;
- three-service Web/API/Meilisearch topology;
- public HTTP 200;
- absence of PostgreSQL;
- absence of S32 environment names.

Before any production write, R0 must be refreshed once more to capture:

- exact Web/API/Meili container IDs;
- StartedAt values;
- exact image IDs;
- fresh ISBN / SSID / DXID / title / author / publisher search smoke;
- current Meilisearch document count / indexing-health state.

Therefore:

```text
R0_RUNTIME_IDENTITY=PASS
R0_LEGACY_SEARCH_SMOKE=REFRESH_REQUIRED
R0_FINAL=NOT_YET_PASS
```

Only the refreshed R0 receipt becomes the rollback-reference identity for R2–R7.

## 12. R1 — Capacity & Release Safety Gate

R1 is read-only.

Required inputs:

- fresh storage/filesystem audit;
- fresh candidate API/Web artifact sizes;
- exact PG image identity;
- exact release manifest and fingerprint;
- exact control-plane baseline.

Output:

```text
CAPACITY_GATE=
  PASS_PREFERRED
  PASS_HARD_ONLY
  BLOCKED_CAPACITY
```

No production write may occur if R1 is blocked.

## 13. R2 — PostgreSQL Dark Bootstrap

R2 is the first production runtime write.

Only the PostgreSQL service may be targeted.

Do not restart or recreate Web/API/Meili.

Use the full ordered Compose chain plus the reviewed S32 override, but target only:

```text
postgres
```

with:

```text
--no-build
--no-deps
pull_policy=never
```

If Compose rendering requires `S32_API_IMAGE`, supply the current production API image identity for R2; do not deploy the future API yet.

R2 must prove:

```text
POSTGRES_HEALTH=PASS
POSTGRES_IMAGE_ID_MATCH=YES
POSTGRES_DATA_BIND=EXPECTED
POSTGRES_PUBLIC_PORT=NONE

WEB_IDENTITY_UNCHANGED=YES
API_IDENTITY_UNCHANGED=YES
MEILI_IDENTITY_UNCHANGED=YES

PUBLIC_HTTP=200
SEARCH_REGRESSION=PASS

S32_API_ENABLED=NO
SCHEMA_INSTALLED=NO
```

On PG failure, stop. A failed PG container may be removed, but PGDATA must not be deleted automatically.

## 14. R3 — Frozen Schema and role bootstrap

### 14.1 Precondition

Before migration:

```text
core schema absent
ops schema absent
derived schema absent
unexpected user objects absent
```

If any S32 schema exists without a matching prior receipt, block with unknown schema state.

### 14.2 Migration

Run exactly:

```text
db/migrations/001_s32_core_schema.sql
```

after verifying exact migration SHA.

Use `psql -X -v ON_ERROR_STOP=1`.

Do not wrap it in an additional `--single-transaction`; the migration already contains its own `BEGIN/COMMIT`.

The migration is not treated as idempotent and is never automatically rerun.

### 14.3 Production-safe verification

It is safe to run:

```text
db/tests/001_s32_schema_assertions.sql
```

against the production schema because it performs structural assertions only.

It is forbidden to run directly in production:

```text
db/tests/002_s32_negative_invariants.sql
```

because it inserts fixture data and does not wrap the complete file in rollback.

Negative invariants remain a disposable-PG release-candidate gate.

### 14.4 Role bootstrap

After migration + structural assertions:

- create `s32_app`;
- apply reviewed grants/revokes;
- verify role attributes;
- verify no DDL capability;
- verify all S32 business/runtime tables are empty.

### 14.5 R3 failure behavior

If the migration transaction fails, stop.

If migration commits but assertions fail, declare schema-integrity incident and stop. Do not drop or auto-repair schemas.

If role bootstrap fails, keep the schema and fix only the role-bootstrap stage later. Do not rerun migration.

R3 still leaves old Web/API/Meili untouched and S32 disabled.

## 15. R4 — API dark rollout

R4 replaces only the API service with the approved API candidate.

Initial S32 state:

```text
S32_FEATURES_ENABLED=false
```

The old Web and Meilisearch remain unchanged.

R4 proves that the new API is backward-compatible with the existing production product before S32 is enabled.

Required acceptance:

- exact API image/revision/fingerprint;
- existing search endpoint behavior;
- ISBN search;
- SSID;
- DXID;
- title;
- author;
- publisher;
- public HTTP healthy;
- Meili document count unchanged;
- Web container unchanged;
- Meili container unchanged;
- private S32 routes remain disabled.

Failure action: restore the exact R0 API image/configuration. PostgreSQL and schema are retained.

## 16. R5 — S32 backend activation

After R4 passes, activate S32 on the new API:

```text
S32_FEATURES_ENABLED=true
S32_DATABASE_URL=<s32_app URL>
S32_PRIVATE_API_TOKEN=<secret>
```

Only the API service may be recreated/restarted for this stage.

The Web remains old.

R5 validates the private S32 backend independently of the new Web.

Required backend acceptance includes:

- Project create/read;
- Note/revision flow;
- Research Issue create/read;
- Candidate Claim create/list;
- Evidence candidate/preview;
- Assessment create;
- Assessment history/detail;
- idempotency replay;
- stale preview;
- archived reads;
- privacy-safe 404;
- restart persistence;
- PostgreSQL persistence.

Old public search behavior must remain healthy.

Failure action: disable S32 or restore the R0 API image/configuration. PostgreSQL data is retained.

## 17. R6 — Web rollout

R6 replaces only the Web service with the approved Web candidate.

Precondition: R5 backend acceptance PASS.

Required identity:

```text
WEB_REVISION=RELEASE_SOURCE_SHA
API_REVISION=RELEASE_SOURCE_SHA
```

The new Web exposes the reviewed Research Project / Issue / Claim / Evidence / Assessment surfaces.

Failure action: restore the exact R0 Web image. Keep API/PostgreSQL unless a backend failure is independently proven.

## 18. R7 — Production acceptance and closure

R7 performs a complete production vertical slice using one clearly named production acceptance project:

```text
[S32 Production Acceptance] <release-fingerprint-short>
```

The acceptance project and its child research data are **retained as an audit fixture** after a successful rollout. They are not automatically deleted, because destructive cleanup would weaken the proof of persistence and could accidentally remove canonical S32 data.

The vertical slice is:

```text
Search
→ Add to Research
→ Acceptance Project
→ Note
→ Research Issue
→ Candidate Claim
→ Evidence selection
→ Manifest preview
→ Assessment
→ History
→ Detail
```

Required S32 behavior:

- acceptance fixture is uniquely identifiable by the release fingerprint and is not reused as ordinary research data;
- response-unknown same-key replay;
- stale-preview recovery;
- archived readability;
- cross-Project privacy;
- restart persistence;
- mobile 390×844;
- no unexpected horizontal overflow;
- exact Assessment/Manifest persistence.

Required legacy regression:

- public HTTP 200;
- ISBN;
- SSID;
- DXID;
- title;
- author;
- publisher;
- Meilisearch document count and healthy state.

Final release identity:

```text
API_REVISION
==
WEB_REVISION
==
RELEASE_SOURCE_SHA
```

PostgreSQL remains internal-only.

A production logical backup is created only as an explicitly authorized R7 action and recorded by checksum. Backup implementation is not required to introduce a new backup subsystem in this rollout.

## 19. Rollback model

Rollback is layer-specific.

| Failure | Allowed rollback |
| --- | --- |
| R2 PostgreSQL | stop/remove PG container; retain PGDATA |
| R3 migration/assertions | stop rollout; retain PGDATA/schema for inspection |
| R4 API dark | restore exact baseline API |
| R5 S32 activation | disable S32 and/or restore baseline API |
| R6 Web | restore exact baseline Web |
| R7 | restore only the proven failing layer |

Never:

- delete PostgreSQL data automatically;
- drop S32 database/schema automatically;
- alter Meilisearch as rollback;
- global-compose-down the stack;
- prune Docker automatically.

## 20. Receipts and audit trail

Each stage emits a non-secret receipt bound to the same `S32_RELEASE_FINGERPRINT`.

At minimum:

```text
R0 baseline receipt
R1 capacity receipt
R2 PostgreSQL bootstrap receipt
R3 schema bootstrap receipt
R4 API dark receipt
R5 backend activation receipt
R6 Web rollout receipt
R7 acceptance receipt
```

The schema receipt records:

- release fingerprint;
- migration SHA;
- role-bootstrap SHA;
- PostgreSQL image ID;
- database name;
- schema assertion PASS;
- empty-baseline PASS;
- receipt SHA.

Do not add a schema-migrations table solely for deployment tracking; the frozen schema remains unchanged.

## 21. Production-write authorization boundaries

This design does not itself authorize any production write.

The following still require explicit stage authorization:

- control-plane synchronization;
- R2/R3;
- R4/R5;
- R6;
- R7 write acceptance / backup.

The plan must always state the exact stages being authorized.

## 22. Required pre-rollout implementation work

Before production execution can be requested, the rollout tooling must implement and test:

1. S32 Release Manifest v1 + fingerprint;
2. Web OCI revision label;
3. API/Web exact-source candidate builders;
4. fresh capacity auditor;
5. control-plane sync guard;
6. S32 stage authorization contract;
7. PostgreSQL dark-bootstrap executor;
8. schema + role bootstrap executor;
9. production-safe schema assertions runner;
10. API dark rollout and rollback guard;
11. S32 activation guard;
12. Web rollout integration with S32 release identity;
13. R7 production acceptance harness;
14. receipt/readback verification;
15. secret leakage tests;
16. production acceptance-fixture tests proving that successful R7 retains exactly one release-scoped canary project and never performs destructive cleanup.

Implementation must follow TDD and use isolated/disposable environments for destructive tests.

## 23. Success definition

The rollout is complete only when:

```text
M2_D_PRODUCTION_DEPLOYED=YES

POSTGRES_SERVICE_PRESENT=YES
POSTGRES_PUBLIC_PORT=NO

S32_SCHEMA_INSTALLED=YES
S32_APP_ROLE_READY=YES

API_REVISION=RELEASE_SOURCE_SHA
WEB_REVISION=RELEASE_SOURCE_SHA

S32_BACKEND_ACCEPTANCE=PASS
S32_WEB_ACCEPTANCE=PASS
LEGACY_SEARCH_REGRESSION=PASS

PRODUCTION_PERSISTENCE=PASS
ROLLBACK_IDENTITIES_RECORDED=YES

M2_E_STARTED=NO
```

## 24. Current gate

```text
TASK_ID=S32_PRODUCTION_ROLLOUT_DESIGN_R1

SOURCE_BASELINE=3ddfce979ed3a2f73e75eab5f186944880c6ad4b
PLANNING_BRANCH=plan/s32-production-rollout

CONVERSATIONAL_DESIGN=APPROVED
WRITTEN_SPEC=SELF_REVIEW_IN_PROGRESS

R0_RUNTIME_IDENTITY=PASS
R0_LEGACY_SEARCH_SMOKE=REFRESH_REQUIRED
R0_FINAL=NOT_YET_PASS
R1_CAPACITY=NOT_EXECUTED
R2_POSTGRES=NOT_EXECUTED
R3_SCHEMA=NOT_EXECUTED
R4_API_DARK=NOT_EXECUTED
R5_S32_ACTIVATION=NOT_EXECUTED
R6_WEB=NOT_EXECUTED
R7_ACCEPTANCE=NOT_EXECUTED

PRODUCTION_WRITE_AUTHORIZED=NO
PRODUCTION_CHANGED=NO
M2_E_STARTED=NO

NEXT_ACTION=SELF_REVIEW_AND_USER_DECISION_SUMMARY
```
