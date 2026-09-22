# S32 Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Build and verify a fail-closed, stage-scoped production rollout toolchain that can safely deploy the already-merged S32 M0–M2-D stack without disrupting the existing BOOK-ID-SEARCH Web/API/Meilisearch service.

**Architecture:** Keep release preparation, production observation, authorization, stage execution, and acceptance as separate units. Bind every R1–R7 receipt to one immutable S32 release fingerprint; implement R2–R6 as narrowly targeted stage executors that refuse unrelated runtime drift and never destroy PostgreSQL or Meilisearch data automatically.

**Tech Stack:** Bash, Python 3, Docker/Compose v5, PostgreSQL 16/psql, Node 22, pnpm 10.33.0, Vitest, existing Express/Vite/React application, Git/GitHub.

**Spec:** \`docs/superpowers/specs/2026-09-22-s32-production-rollout-design.md\`

## Global Constraints

- Production source baseline for this planning cycle: \`3ddfce979ed3a2f73e75eab5f186944880c6ad4b\`.
- The final \`RELEASE_SOURCE_SHA\` is chosen only after this rollout tooling is implemented, reviewed, and merged.
- Build once; deploy exact artifacts. Do not build application images on production.
- PostgreSQL data bind: \`/data/book-id-search/postgres_data\`; Compose must keep \`create_host_path: false\`.
- Hard free-space reserve: 20 GiB; preferred reserve: 21 GiB; maximum modeled used percentage: 80%.
- No global \`docker compose down\`, no global \`up --build\`, no auto-prune, no automatic PGDATA deletion, no automatic database/schema drop.
- PostgreSQL is internal-only; no host port.
- \`db/migrations/001_s32_core_schema.sql\` and both frozen SQL tests remain byte-for-byte unchanged.
- \`db/tests/001_s32_schema_assertions.sql\` may be used read-only against production schema; \`002_s32_negative_invariants.sql\` is disposable-PG only.
- API runtime role is \`s32_app\`; the API must never use the bootstrap/admin role \`s32_admin\`.
- The S32 private bearer token must never be embedded in the public Web bundle.
- First rollout keeps session-only manual S32 credential entry.
- R7 retains one clearly named release-scoped acceptance project as audit/persistence evidence.
- Every production-write stage requires explicit stage-scoped authorization; implementation/testing of executors does not authorize execution.
- M2-E remains out of scope.

## Review Focus

1. **Release identity drift between preparation and execution** — changing any image ID, migration/override bytes, lockfile hash, or source SHA must make the stage refuse to run.
2. **Unexpected existing PostgreSQL state** — an existing/non-empty PGDATA or pre-existing S32 schema without a matching receipt must block instead of being overwritten or “repaired.”
3. **Legacy-service drift during a narrow stage** — R2/R3 must fail if Web/API/Meili identity changes; R4/R5/R6 must verify only the intended service changed.
4. **Secret leakage** — tests must prove passwords/private tokens do not appear in release manifests, candidate evidence, stdout/stderr, static Web artifacts, or receipts.
5. **Interrupted/ambiguous production stage** — a start artifact without a terminal receipt must report UNKNOWN/INCOMPLETE and require human inspection; it must not auto-retry.

---

## File map

New or modified units:

- \`scripts/s32-release-manifest.py\` — canonical S32 release manifest validation/fingerprinting.
- \`scripts/test-s32-release-manifest.py\` — manifest/fingerprint tests.
- \`scripts/build-s32-api-release-candidate.sh\` — exact-source API image/candidate evidence.
- \`scripts/test-build-s32-api-release-candidate.py\` — isolated builder contract tests.
- \`apps/web/Dockerfile\` and \`scripts/build-web-release-candidate.sh\` — add Web OCI revision provenance.
- \`scripts/test-build-web-release-candidate.py\` — Web provenance/static-secret checks.
- \`scripts/plan-s32-production-capacity.py\` — fresh capacity/storage gate.
- \`scripts/test-plan-s32-production-capacity.py\` — multi-filesystem and reserve tests.
- \`scripts/verify/s32_runtime_common.py\` — shared exact-KV parsing, receipt, identity, Docker/Compose helpers.
- \`scripts/test-s32-runtime-common.py\` — common-helper safety tests.
- \`scripts/plan-s32-production-baseline.py\` — fresh R0 read-only baseline/legacy-search receipt.
- \`scripts/test-plan-s32-production-baseline.py\` — fake-runtime baseline tests.
- \`scripts/authorize-s32-production-rollout.sh\` — one-time stage-scoped authorization artifact.
- \`scripts/claim-s32-production-rollout.sh\` — atomic one-time stage claim.
- \`scripts/test-s32-production-authorization.py\` — authorization/claim tests.
- \`deploy/s32-production-roles.sql\` — non-secret role/grant bootstrap template.
- \`scripts/execute-s32-r2-postgres.sh\` — PostgreSQL dark bootstrap.
- \`scripts/test-execute-s32-r2-postgres.py\` — isolated/fake R2 tests.
- \`scripts/execute-s32-r3-schema.sh\` — frozen schema + application-role bootstrap.
- \`scripts/test-execute-s32-r3-schema.py\` — disposable-PG R3 tests.
- \`scripts/execute-s32-r4-api-dark.sh\` — API replacement with S32 disabled.
- \`scripts/execute-s32-r5-activate.sh\` — S32 API activation only.
- \`scripts/test-execute-s32-r4-r5.py\` — API dark/activation/rollback tests.
- \`scripts/execute-s32-r6-web.sh\` — Web rollout bound to S32 release identity.
- \`scripts/test-execute-s32-r6-web.py\` — Web identity/rollback tests.
- \`scripts/verify-s32-production-acceptance.ts\` — R7 S32 + legacy acceptance harness.
- \`scripts/test-verify-s32-production-acceptance.ts\` — acceptance fixture and token tests.
- \`scripts/plan-s32-production-rollout.py\` — cross-stage planner/state machine.
- \`scripts/test-plan-s32-production-rollout.py\` — stage ordering/unknown-state tests.
- \`docs/operations/S32_PRODUCTION_ROLLOUT.md\` — operator contract and receipts.
- \`package.json\` — local test/check aliases only.

---

### Task 1: Canonical S32 Release Manifest v1

**Files:**
- Create: \`scripts/s32-release-manifest.py\`
- Create: \`scripts/test-s32-release-manifest.py\`

**Interfaces:**
- Consumes: a JSON document with exact release artifact identity fields.
- Produces: validated canonical JSON plus \`S32_RELEASE_FINGERPRINT=<sha256>\`; Python API \`canonicalize_manifest(data: dict) -> bytes\` and \`fingerprint_manifest(data: dict) -> str\`.

- [ ] **Step 1: Write failing manifest contract tests**

Test exact required keys, 40-hex source SHA, sha256 fields, image IDs, stage-neutral secret absence, deterministic key order, and mutation sensitivity.

\`\`\`python
class ReleaseManifestTests(unittest.TestCase):
    def test_fingerprint_changes_when_migration_changes(self):
        base = valid_manifest()
        first = mod.fingerprint_manifest(base)
        changed = {**base, "migrationSha256": "b" * 64}
        self.assertNotEqual(mod.fingerprint_manifest(changed), first)

    def test_secret_keys_are_rejected(self):
        data = valid_manifest() | {"s32PrivateApiToken": "secret"}
        with self.assertRaisesRegex(ValueError, "SECRET_FIELD_FORBIDDEN"):
            mod.fingerprint_manifest(data)
\`\`\`

- [ ] **Step 2: Run the tests and verify RED**

Run:

\`\`\`bash
python3 scripts/test-s32-release-manifest.py
\`\`\`

Expected: import/file missing failures.

- [ ] **Step 3: Implement canonical validation/fingerprint**

Use an explicit ordered tuple:

\`\`\`python
FIELDS = (
    "version", "sourceSha", "pnpmLockSha256",
    "apiImageTag", "apiImageId", "apiOciRevision", "apiBaseDigest",
    "webImageTag", "webImageId", "webOciRevision",
    "webStaticManifestSha256", "webS32Enabled",
    "webNodeBaseDigest", "webNginxBaseDigest",
    "pgImageRef", "pgImageId",
    "migrationPath", "migrationSha256",
    "roleBootstrapPath", "roleBootstrapSha256",
    "s32OverridePath", "s32OverrideSha256",
)
\`\`\`

Serialize only those fields, UTF-8, compact separators, newline-terminated; reject additional keys containing \`PASSWORD\`, \`TOKEN\`, \`SECRET\`, or \`DATABASE_URL\`.

- [ ] **Step 4: Run tests GREEN**

Run the exact test command plus a CLI smoke that prints the fingerprint twice from identical input and compares equality.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/s32-release-manifest.py scripts/test-s32-release-manifest.py
git commit -m "feat(s32): add canonical release manifest"
\`\`\`

---

### Task 2: Web OCI provenance and public-bundle secret guard

**Files:**
- Modify: \`apps/web/Dockerfile\`
- Modify: \`scripts/build-web-release-candidate.sh\`
- Create: \`scripts/test-build-web-release-candidate.py\`

**Interfaces:**
- Consumes: \`SOURCE_COMMIT\`/clean repository source.
- Produces: Web image with \`org.opencontainers.image.revision=<source sha>\`, existing static manifest, candidate JSON containing source/image identity but no secrets.

- [ ] **Step 1: Write RED tests**

Assert Dockerfile contains:

\`\`\`dockerfile
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
\`\`\`

Assert builder passes:

\`\`\`text
--build-arg SOURCE_COMMIT=$FULL_SHA
\`\`\`

and validates inspected OCI revision equals \`FULL_SHA\`.

Also create a fake static artifact containing a known sentinel private token and prove the candidate validator rejects it.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-build-web-release-candidate.py
\`\`\`

Expected: missing OCI revision/build arg/secret-scan behavior.

- [ ] **Step 3: Implement minimal provenance hardening**

Add build arg + label to final nginx image and update builder:

\`\`\`bash
--build-arg "SOURCE_COMMIT=$FULL_SHA"
\`\`\`

After build:

\`\`\`bash
OCI_REV="$($DOCKER_SUDO docker image inspect "$TAG" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
test "$OCI_REV" = "$FULL_SHA"
\`\`\`

Scan extracted static files for the runtime-provided private-token sentinel only in tests; production build must not accept any \`VITE_S32_PRIVATE_API_TOKEN\` mechanism.

- [ ] **Step 4: GREEN + existing Web tests/build**

\`\`\`bash
python3 scripts/test-build-web-release-candidate.py
pnpm vitest run apps/web/src/research
pnpm --filter @book-id-search/web build
\`\`\`

- [ ] **Step 5: Commit**

\`\`\`bash
git add apps/web/Dockerfile scripts/build-web-release-candidate.sh scripts/test-build-web-release-candidate.py
git commit -m "feat(s32): bind web release to source revision"
\`\`\`

---

### Task 3: Exact-source API release candidate builder

**Files:**
- Create: \`scripts/build-s32-api-release-candidate.sh\`
- Create: \`scripts/test-build-s32-api-release-candidate.py\`

**Interfaces:**
- Consumes: exact 40-hex \`SOURCE_SHA\`.
- Produces: \`book-id-search-api:s32-<sha>\`, image ID, OCI revision, lock hash, saved-tar size, compressed size, logical image size, base digest evidence under \`progress/s32-api-release-candidate-<sha>/\`.

- [ ] **Step 1: Write RED tests for dirty-tree independence and identity**

Test that the builder uses \`git archive "$SOURCE_SHA"\` as Docker stdin and never builds from production/worktree bytes.

Test candidate JSON fields:

\`\`\`json
{
  "sourceSha": "...",
  "imageTag": "...",
  "imageId": "sha256:...",
  "ociRevision": "...",
  "lockfileSha256": "...",
  "imageBytes": 1,
  "tarBytes": 1,
  "compressedBytes": 1
}
\`\`\`

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-build-s32-api-release-candidate.py
\`\`\`

- [ ] **Step 3: Implement exact-source build**

Core command:

\`\`\`bash
git archive "$SOURCE_SHA" |
  docker build -f apps/api/Dockerfile \
    --build-arg "SOURCE_COMMIT=$SOURCE_SHA" \
    -t "book-id-search-api:s32-$SOURCE_SHA" -
\`\`\`

Then inspect and require OCI revision equality; export tar + gzip in a controlled candidate directory and measure C/T/U.

- [ ] **Step 4: GREEN + API smoke**

Run unit tests plus:

\`\`\`bash
python3 scripts/check-s32-release-image.py \
  "book-id-search-api:s32-$SOURCE_SHA" "$SOURCE_SHA"
\`\`\`

Expected: PASS with S32 default disabled.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/build-s32-api-release-candidate.sh scripts/test-build-s32-api-release-candidate.py
git commit -m "feat(s32): build exact-source api release candidate"
\`\`\`

---

### Task 4: Shared production-runtime helpers and receipt contract

**Files:**
- Create: \`scripts/verify/s32_runtime_common.py\`
- Create: \`scripts/test-s32-runtime-common.py\`

**Interfaces:**
- Produces:
  - \`parse_unique_kv(text: str, required: set[str]) -> dict[str,str]\`
  - \`sha256_file(path: Path) -> str\`
  - \`write_receipt_atomic(path: Path, fields: dict[str,str]) -> str\`
  - \`read_receipt(path: Path) -> dict[str,str]\`
  - \`classify_attempt(start_path, result_path) -> "NOT_STARTED"|"INCOMPLETE"|"TERMINAL"\`
  - strict image/container identity comparison helpers.

- [ ] **Step 1: Write RED tests**

Cover duplicate keys, symlinks, mode mismatch, atomic temp+rename, receipt hash, incomplete attempt detection, and no secret-like keys.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-s32-runtime-common.py
\`\`\`

- [ ] **Step 3: Implement helpers**

Receipt write pattern:

\`\`\`python
tmp = path.with_name(path.name + ".tmp")
tmp.write_text(canonical_text, encoding="utf-8")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
return hashlib.sha256(path.read_bytes()).hexdigest()
\`\`\`

Reject keys matching \`PASSWORD|TOKEN|SECRET|DATABASE_URL\`.

- [ ] **Step 4: GREEN**

Run helper tests with symlink/duplicate/incomplete cases.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/verify/s32_runtime_common.py scripts/test-s32-runtime-common.py
git commit -m "feat(s32): add rollout receipt primitives"
\`\`\`

---

### Task 5: Fresh R0 production baseline planner

**Files:**
- Create: \`scripts/plan-s32-production-baseline.py\`
- Create: \`scripts/test-plan-s32-production-baseline.py\`

**Interfaces:**
- Consumes: read-only command adapter / real production when explicitly invoked.
- Produces: R0 receipt containing Web/API/Meili CID, StartedAt, image IDs/revisions, checkout SHA, HTTP result, six legacy-search smoke results, Meili count/indexing state, absence/presence of PostgreSQL/S32 env names.

- [ ] **Step 1: Write RED fake-runtime tests**

A passing fixture must include all six legacy searches. Missing SSID, duplicate container, or HTTP failure must block.

\`\`\`python
assert result["R0_RUNTIME_IDENTITY"] == "PASS"
assert result["R0_LEGACY_SEARCH_SMOKE"] == "PASS"
assert result["R0_FINAL"] == "PASS"
\`\`\`

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-plan-s32-production-baseline.py
\`\`\`

- [ ] **Step 3: Implement read-only planner**

Require identity gate \`ubuntu@VM-0-4-ubuntu\` when running remotely; never print env values, only S32 env names.

- [ ] **Step 4: GREEN + local fixture**

Verify the planner cannot invoke Docker mutation verbs (\`up\`, \`rm\`, \`restart\`, \`pull\`, \`build\`).

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/plan-s32-production-baseline.py scripts/test-plan-s32-production-baseline.py
git commit -m "feat(s32): add production baseline planner"
\`\`\`

---

### Task 6: R1 capacity and storage gate

**Files:**
- Create: \`scripts/plan-s32-production-capacity.py\`
- Create: \`scripts/test-plan-s32-production-capacity.py\`

**Interfaces:**
- Consumes: R0 receipt, API/Web candidate measurements, storage filesystem facts, release fingerprint.
- Produces: \`PASS_PREFERRED|PASS_HARD_ONLY|BLOCKED_CAPACITY\`, \`CURRENT_FREE_BYTES\`, \`PEAK_INCREMENT_BYTES\`, \`FREE_AFTER_PEAK_BYTES\`, \`USED_AFTER_PEAK_PERCENT\`.

- [ ] **Step 1: Write RED math/partition tests**

Cases:
- same filesystem, >21 GiB after peak => preferred;
- 20–21 GiB => hard-only;
- <20 GiB => blocked;
- used-after >80 => blocked;
- /data separate => independent PG-data gate;
- stale candidate source SHA != release manifest => block.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-plan-s32-production-capacity.py
\`\`\`

- [ ] **Step 3: Implement integer-byte accounting**

Use \`GiB = 1024**3\`; no float comparisons for reserves.

- [ ] **Step 4: GREEN**

Include the historical 20.2888 GiB / 1.9412 GiB scenario and assert \`BLOCKED_CAPACITY\`.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/plan-s32-production-capacity.py scripts/test-plan-s32-production-capacity.py
git commit -m "feat(s32): add production capacity gate"
\`\`\`

---

### Task 7: Control-plane sync planner and guarded executor

**Files:**
- Create: \`scripts/plan-s32-control-plane-sync.py\`
- Create: \`scripts/execute-s32-control-plane-sync.sh\`
- Create: \`scripts/test-s32-control-plane-sync.py\`

**Interfaces:**
- Planner consumes current production checkout SHA, target reviewed control-plane SHA, R0 runtime identities, and clean-worktree facts; produces a read-only sync plan.
- Executor consumes an explicit control-plane-sync authorization, exact target SHA, and frozen R0 identities; it updates only the production Git checkout and then proves Web/API/Meili runtime identities and public behavior did not change.

- [ ] **Step 1: Write RED tests**

Use a temporary Git repository plus fake Docker/HTTP readers.

Required cases:
- target SHA not reachable from reviewed \`origin/main\` => block;
- dirty production checkout outside allowed runtime/progress paths => block;
- branch not \`main\` => block;
- planner attempts a write => test fails;
- executor invoked without exact explicit sync authorization => block;
- post-sync Web/API/Meili CID, StartedAt, or image ID drift => \`CONTROL_PLANE_RUNTIME_DRIFT\`;
- sync succeeds only when checkout moves to exact target SHA while runtime identities remain byte-for-byte/fact-for-fact unchanged.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-s32-control-plane-sync.py
\`\`\`

Expected: missing planner/executor failures.

- [ ] **Step 3: Implement read-only planner**

The planner may run \`git fetch\` only when invoked in an explicitly designated planning environment; production-side planning defaults to reading existing refs. It emits:

\`\`\`text
STATUS=READY
CURRENT_CONTROL_PLANE_SHA=...
TARGET_CONTROL_PLANE_SHA=...
TARGET_REACHABLE_FROM_ORIGIN_MAIN=YES
RUNTIME_BASELINE_MATCH=YES
PRODUCTION_WRITE_EXECUTED=false
\`\`\`

It never changes checkout, Docker, Compose, env files, or database state.

- [ ] **Step 4: Implement guarded sync executor**

The only intended production Git mutation is an exact fast-forward/reset-to-reviewed-commit operation after explicit authorization; do not merge, rebase, cherry-pick, or build.

Immediately after the checkout update, re-read:

\`\`\`text
WEB_CID / WEB_STARTED_AT / WEB_IMAGE_ID
API_CID / API_STARTED_AT / API_IMAGE_ID
MEILI_CID / MEILI_STARTED_AT / MEILI_IMAGE_ID
PUBLIC_HTTP
\`\`\`

and require equality with the pre-sync R0 runtime receipt.

- [ ] **Step 5: GREEN**

\`\`\`bash
python3 scripts/test-s32-control-plane-sync.py
\`\`\`

Expected: all fake-repo/fake-runtime tests PASS and no Docker mutation command appears in planner/executor fixtures.

- [ ] **Step 6: Commit**

\`\`\`bash
git add scripts/plan-s32-control-plane-sync.py scripts/execute-s32-control-plane-sync.sh scripts/test-s32-control-plane-sync.py
git commit -m "feat(s32): add guarded control-plane sync"
\`\`\`

---

### Task 8: Stage-scoped S32 production authorization and claim

**Files:**
- Create: \`scripts/authorize-s32-production-rollout.sh\`
- Create: \`scripts/claim-s32-production-rollout.sh\`
- Create: \`scripts/test-s32-production-authorization.py\`

**Interfaces:**
- Consumes: release fingerprint, release source SHA, control-plane SHA, exact allowed stage group \`R2_R3|R4_R5|R6|R7\`.
- Produces: mode-600 authorization artifact and atomic hard-link claim.

- [ ] **Step 1: Write RED tests**

Reject:
- arbitrary stage lists;
- mismatched fingerprint;
- duplicate keys;
- symlink artifact;
- wrong file mode;
- reuse after claim;
- auth artifact containing secret-like fields.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-s32-production-authorization.py
\`\`\`

- [ ] **Step 3: Implement one-time artifact**

Canonical fields:

\`\`\`text
AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT
STAGE_GROUP=R2_R3
S32_RELEASE_FINGERPRINT=...
RELEASE_SOURCE_SHA=...
CONTROL_PLANE_SHA=...
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
PRODUCTION_WRITE_EXECUTED=false
\`\`\`

Claim via \`ln -- source claim\`; never source/eval artifact content.

- [ ] **Step 4: GREEN + concurrency test**

Run two simultaneous claim processes and assert exactly one succeeds.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/authorize-s32-production-rollout.sh scripts/claim-s32-production-rollout.sh scripts/test-s32-production-authorization.py
git commit -m "feat(s32): add stage-scoped rollout authorization"
\`\`\`

---

### Task 9: Non-secret PostgreSQL role bootstrap artifact

**Files:**
- Create: \`deploy/s32-production-roles.sql\`
- Create: \`scripts/test-s32-production-roles.py\`

**Interfaces:**
- Consumes psql variables \`:app_role\` and \`:app_password\`.
- Produces non-superuser \`s32_app\`, required grants, public-schema hardening.

- [ ] **Step 1: Write RED disposable-PG test**

Apply frozen migration, then role script; assert:

\`\`\`sql
SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication
FROM pg_roles WHERE rolname='s32_app';
\`\`\`

all false.

Attempt \`CREATE TABLE core.forbidden(...)\` as \`s32_app\` and require permission denied.

- [ ] **Step 2: Run RED**

Run against a disposable PostgreSQL 16 container.

- [ ] **Step 3: Implement role SQL without embedded password**

Use psql variable substitution and explicit grants; include:

\`\`\`sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";
GRANT USAGE ON SCHEMA core, ops, derived TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, ops TO :"app_role";
\`\`\`

- [ ] **Step 4: GREEN**

Also scan file for no literal password/token.

- [ ] **Step 5: Commit**

\`\`\`bash
git add deploy/s32-production-roles.sql scripts/test-s32-production-roles.py
git commit -m "feat(s32): add production application role bootstrap"
\`\`\`

---

### Task 10: R2 PostgreSQL dark-bootstrap executor

**Files:**
- Create: \`scripts/execute-s32-r2-postgres.sh\`
- Create: \`scripts/test-execute-s32-r2-postgres.py\`

**Interfaces:**
- Consumes: R0 PASS receipt, R1 acceptable receipt, R2_R3 claim, release manifest, exact PG image, baseline service identities.
- Produces: R2 terminal receipt and start marker.

- [ ] **Step 1: Write RED isolated/fake tests**

Test:
- existing non-empty PGDATA => block;
- symlink PGDATA => block;
- runtime UID/GID discovered from exact image;
- command targets only \`postgres\`;
- command includes \`--no-build --no-deps\`;
- Web/API/Meili identity drift => fail after write and mark incident;
- no host 5432;
- interrupted start artifact => subsequent invocation reports incomplete, no retry.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-execute-s32-r2-postgres.py
\`\`\`

- [ ] **Step 3: Implement narrow stage executor**

Before first write create start artifact; after success create terminal receipt.

The only Compose mutation command must be equivalent to:

\`\`\`bash
docker compose <ordered files> up -d --no-build --no-deps postgres
\`\`\`

No pull/build/prune/delete.

- [ ] **Step 4: GREEN with isolated Compose project**

Use a disposable temp project and PostgreSQL image; prove cleanup only touches isolated test resources.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/execute-s32-r2-postgres.sh scripts/test-execute-s32-r2-postgres.py
git commit -m "feat(s32): add postgres dark rollout executor"
\`\`\`

---

### Task 11: R3 frozen-schema and runtime-role executor

**Files:**
- Create: \`scripts/execute-s32-r3-schema.sh\`
- Create: \`scripts/test-execute-s32-r3-schema.py\`

**Interfaces:**
- Consumes: R2 PASS receipt, same R2_R3 claim lineage, exact migration/role SHA, admin/app credentials from mode-600 runtime files.
- Produces: R3 schema receipt with assertion PASS and empty baseline.

- [ ] **Step 1: Write RED disposable-PG tests**

Cases:
- schema already exists without receipt => block;
- migration SHA mismatch => block;
- migration failure => no schema remains due to internal transaction;
- assertion failure after commit => \`SCHEMA_INTEGRITY_INCIDENT\`, no drop;
- \`002_s32_negative_invariants.sql\` path passed as production assertion => hard block;
- role bootstrap failure => migration not rerun on next role-only recovery path;
- secret sentinel absent from stdout/stderr/receipt.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-execute-s32-r3-schema.py
\`\`\`

- [ ] **Step 3: Implement exact execution order**

\`\`\`text
verify empty target
verify migration SHA
psql -X -v ON_ERROR_STOP=1 -f 001_s32_core_schema.sql
psql -X -v ON_ERROR_STOP=1 -f 001_s32_schema_assertions.sql
apply role bootstrap with psql variables
verify role flags/privileges
verify S32 business/runtime row counts are zero
write receipt
\`\`\`

Never run negative-invariants file on the production DB.

- [ ] **Step 4: GREEN + disposable full R3**

Also separately run negative invariants against another disposable DB to preserve release-candidate proof.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/execute-s32-r3-schema.sh scripts/test-execute-s32-r3-schema.py
git commit -m "feat(s32): add frozen schema rollout executor"
\`\`\`

---

### Task 12: R4 API dark rollout and R5 S32 activation

**Files:**
- Create: \`scripts/execute-s32-r4-api-dark.sh\`
- Create: \`scripts/execute-s32-r5-activate.sh\`
- Create: \`scripts/test-execute-s32-r4-r5.py\`

**Interfaces:**
- R4 consumes R2/R3 receipts + R4_R5 claim + API candidate; produces API-dark receipt with S32 disabled.
- R5 consumes R4 PASS + same release identity + mode-600 API secret file; produces backend-activation receipt.

- [ ] **Step 1: Write RED state-transition tests**

R4:
- refuses API image whose OCI revision != source SHA;
- changes API service only;
- requires S32 disabled;
- validates six legacy search smokes and Meili count;
- records baseline API image for rollback.

R5:
- refuses missing database URL/token names;
- validates that runtime DB URL uses \`s32_app\`, not \`s32_admin\`;
- changes API only;
- private endpoint requires bearer token;
- failed backend acceptance disables S32/restores baseline API according to explicit operator-selected rollback path, never auto-deletes PG data.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-execute-s32-r4-r5.py
\`\`\`

- [ ] **Step 3: Implement R4 narrow API replacement**

Render full chain, target only API, no build/pull. Capture pre/post Web/Meili CID+StartedAt and require unchanged.

- [ ] **Step 4: Implement R5 activation**

Mount/use root-owned mode-600 API env file; never echo values. Run private backend acceptance via a token supplied through environment/stdin, not CLI argv.

- [ ] **Step 5: GREEN + existing S32 API suites**

\`\`\`bash
python3 scripts/test-execute-s32-r4-r5.py
pnpm vitest run apps/api/src/s32
pnpm s32:m2a:check
pnpm s32:m2b:check
pnpm s32:m2c:check
pnpm s32:m2d:check
\`\`\`

- [ ] **Step 6: Commit**

\`\`\`bash
git add scripts/execute-s32-r4-api-dark.sh scripts/execute-s32-r5-activate.sh scripts/test-execute-s32-r4-r5.py
git commit -m "feat(s32): add api dark rollout and activation"
\`\`\`

---

### Task 13: R6 Web rollout bound to the S32 release

**Files:**
- Create: \`scripts/execute-s32-r6-web.sh\`
- Create: \`scripts/test-execute-s32-r6-web.py\`
- Reuse/modify only if necessary: \`scripts/deploy-web-release-candidate.sh\`

**Interfaces:**
- Consumes: R5 PASS, R6 claim, same release fingerprint, approved Web candidate.
- Produces: R6 receipt with Web/API revision parity.

- [ ] **Step 1: Write RED tests**

Require:
- Web OCI revision == release source;
- API current revision == same release source;
- static-manifest hash matches release manifest;
- candidate bundle contains no private token sentinel;
- API/Postgres/Meili identity unchanged during Web switch;
- legacy HTTP/search smoke remains PASS;
- baseline Web identity is preserved for rollback.

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-execute-s32-r6-web.py
\`\`\`

- [ ] **Step 3: Implement Web-only stage**

Integrate the existing Web deploy executor by passing an already verified image identity; do not broaden the old authorization artifact to cover S32.

- [ ] **Step 4: GREEN + Web research tests**

\`\`\`bash
python3 scripts/test-execute-s32-r6-web.py
pnpm vitest run apps/web/src/research
pnpm --filter @book-id-search/web build
\`\`\`

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/execute-s32-r6-web.sh scripts/test-execute-s32-r6-web.py scripts/deploy-web-release-candidate.sh
git commit -m "feat(s32): add release-bound web rollout"
\`\`\`

---

### Task 14: R7 production acceptance harness and retained canary project

**Files:**
- Create: \`scripts/verify-s32-production-acceptance.ts\`
- Create: \`scripts/test-verify-s32-production-acceptance.ts\`
- Modify: \`package.json\`

**Interfaces:**
- Consumes: bearer token from environment, release fingerprint, public/API base URLs.
- Produces: R7 receipt facts; creates/reuses exactly one acceptance project named \`[S32 Production Acceptance] <fingerprint-short>\`.

- [ ] **Step 1: Write RED tests with HTTP fixture server**

Prove:
- acceptance project name is release-scoped;
- repeated invocation detects/reuses the exact canary instead of creating duplicates;
- full Project→Note→Issue→Claim→Evidence→Assessment flow works;
- response-unknown replay uses same idempotency key;
- acceptance project is not deleted;
- token does not appear in output;
- legacy six search checks are required;
- mobile browser acceptance can be called with 390×844 separately from API-only run.

- [ ] **Step 2: Run RED**

\`\`\`bash
pnpm vitest run scripts/test-verify-s32-production-acceptance.ts
\`\`\`

- [ ] **Step 3: Implement acceptance harness**

Read:

\`\`\`ts
const token = process.env.S32_PRIVATE_API_TOKEN;
const fp = process.env.S32_RELEASE_FINGERPRINT;
if (!token || !/^[a-f0-9]{64}$/.test(fp ?? "")) process.exit(2);
\`\`\`

Never print \`token\`.

- [ ] **Step 4: GREEN**

Add package alias:

\`\`\`json
"s32:production:acceptance": "tsx scripts/verify-s32-production-acceptance.ts"
\`\`\`

Run tests and a local disposable API/PG acceptance.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/verify-s32-production-acceptance.ts scripts/test-verify-s32-production-acceptance.ts package.json
git commit -m "feat(s32): add production acceptance harness"
\`\`\`

---

### Task 15: Cross-stage rollout planner, operator docs, and whole-branch verification

**Files:**
- Create: \`scripts/plan-s32-production-rollout.py\`
- Create: \`scripts/test-plan-s32-production-rollout.py\`
- Create: \`docs/operations/S32_PRODUCTION_ROLLOUT.md\`
- Modify: \`docs/STATUS.md\`
- Modify: \`AGENTS.md\`

**Interfaces:**
- Consumes: release manifest + stage receipts/start artifacts.
- Produces: next legal stage, or \`BLOCKED/INCOMPLETE/READY_FOR_<stage>\`; never executes production writes.

- [ ] **Step 1: Write RED state-machine tests**

Pin:

\`\`\`text
no R0 => BLOCK
R0 PASS + R1 blocked => BLOCKED_CAPACITY
R2 start without terminal => INCOMPLETE_R2
R3 PASS without R2 PASS => invalid receipt graph
R4 PASS + R5 missing => READY_FOR_R5 only
R5 PASS + R6 missing => READY_FOR_R6 only
R6 PASS + R7 missing => READY_FOR_R7 only
all PASS => ROLLOUT_COMPLETE
mixed release fingerprints => BLOCK
\`\`\`

- [ ] **Step 2: Run RED**

\`\`\`bash
python3 scripts/test-plan-s32-production-rollout.py
\`\`\`

- [ ] **Step 3: Implement read-only planner**

No Docker mutation, no auth claim, no secret reading.

- [ ] **Step 4: Write operator document**

Document exactly:
- architecture R0–R7;
- what each authorization permits;
- commands that are forbidden;
- receipt locations;
- how to interpret incomplete attempts;
- rollback identities;
- how to run R0/R1 read-only checks;
- explicit statement that planning/implementation does not authorize production execution.

- [ ] **Step 5: Run complete verification**

At minimum:

\`\`\`bash
python3 -m pytest \
  scripts/test-s32-release-manifest.py \
  scripts/test-build-s32-api-release-candidate.py \
  scripts/test-build-web-release-candidate.py \
  scripts/test-s32-runtime-common.py \
  scripts/test-plan-s32-production-baseline.py \
  scripts/test-plan-s32-production-capacity.py \
  scripts/test-s32-production-authorization.py \
  scripts/test-s32-production-roles.py \
  scripts/test-execute-s32-r2-postgres.py \
  scripts/test-execute-s32-r3-schema.py \
  scripts/test-execute-s32-r4-r5.py \
  scripts/test-execute-s32-r6-web.py \
  scripts/test-plan-s32-production-rollout.py -q

pnpm vitest run apps/api/src/s32 apps/web/src/research \
  scripts/test-verify-s32-production-acceptance.ts

pnpm s32:schema:static
pnpm s32:m2c:check
pnpm s32:m2d:check
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
git diff --check
\`\`\`

Also prove:

\`\`\`bash
git diff --exit-code <implementation-base> -- \
  db/migrations/001_s32_core_schema.sql \
  db/tests/001_s32_schema_assertions.sql \
  db/tests/002_s32_negative_invariants.sql
\`\`\`

Expected: frozen SQL unchanged.

- [ ] **Step 6: Isolated end-to-end rehearsal**

In a disposable Compose project:
1. generate release manifest/fingerprint;
2. create fake R0/R1 receipts;
3. authorize/claim R2_R3;
4. execute R2 + R3;
5. authorize/claim R4_R5;
6. execute API dark + activation;
7. authorize/claim R6;
8. execute Web switch;
9. run R7 acceptance;
10. verify only isolated resources were touched and clean them up.

Expected:

\`\`\`text
ISOLATED_ROLLOUT_E2E=PASS
PRODUCTION_TOUCHED=NO
AUTO_RETRY=NO
AUTO_DESTRUCTIVE_ROLLBACK=NO
\`\`\`

- [ ] **Step 7: Whole-branch self-review**

Review specifically against the five Review Focus items; verify every one has a test owner and no task relies on untracked secret/manual state.

- [ ] **Step 8: Commit**

\`\`\`bash
git add scripts docs/operations/S32_PRODUCTION_ROLLOUT.md docs/STATUS.md AGENTS.md package.json
git commit -m "docs(s32): complete production rollout toolchain plan"
\`\`\`

---

## Implementation completion gate

Implementation is complete only when all 15 tasks are committed on one feature branch, the isolated rollout E2E passes, frozen SQL is byte-identical to the approved baseline, and a final whole-branch review reports no unresolved Critical/Important finding.

Implementation completion still means:

\`\`\`text
PRODUCTION_WRITE_AUTHORIZED=NO
PRODUCTION_CHANGED=NO
M2_E_STARTED=NO
\`\`\`

The next gate after implementation/review is a **fresh R0 + R1 read-only production preflight**. Only after those receipts are reviewed may a separate stage-specific production-write authorization be requested.
