# Web Release Production Deployment Execution Contract

**Date:** 2026-08-12
**Phase:** S27T-5A Production Deployment Execution Contract Audit and State-Machine Plan
**Status:** PASS_CONTRACT_DEFINED
**HEAD:** `243347e4b2f7876f62a1c61b1cd71fb0a271a691` (main = origin/main)
**Stable tag:** `v0.24.0-weread-guided-repair-navigation` → `a2f7bc982119a4aa27bba3d589d3ca80bf855f8c` (unchanged)
**Production Web Image:** `sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce` (1ab120c4)
**Authorization state:** S27T-4D-A5 cleared; **NO live authorization** exists for this fingerprint.

---

## 1. CURRENT CAPABILITIES

| Component | Production-capable? | Notes |
|-----------|---------------------|-------|
| `scripts/plan-web-production-release.sh` | **NO** | read-only; forced real isolated E2E |
| `scripts/authorize-web-production-release.sh` | **NO** | only writes auth artifact (mode 600) |
| `scripts/claim-web-production-release-authorization.sh` | **NO** | only atomic hard-link of auth → claim |
| `scripts/orchestrate-web-production-release.sh` (`isolated-e2e`, `authorized-isolated-e2e`) | **NO** | only isolated project compose up/down |
| `scripts/deploy-web-release-candidate.sh` | **YES** (script-level) | performs production `docker compose up`; not currently wrapped behind execution-intent + claim-bound authorization |
| `scripts/verify-web-release-readiness.sh` | **NO** | acceptance oracle |
| `scripts/verify-web-release-runtime-acceptance.py` | **NO** | L2 acceptance oracle |

**CURRENT_PRODUCTION_EXECUTION_ENTRYPOINT_EXISTS = false.**

Production write capability exists at the script level, but **no production executor**
combines: (a) explicit execution intent, (b) atomic claim-bound authorization, and
(c) production project (`/opt/book-id-search`) `docker compose up`. The current
orchestrator is isolated-only by design.

---

## 2. NON-GOALS (this contract does NOT define)

- Production read-only monitoring / observability tooling
- Multi-image / canary / blue-green deployments
- Automatic rollback (see §11)
- API or Meili deploys (Web only at this stage)
- Production-mode flag inside the existing orchestrator
- Re-issue / reset of consumed authorization (see §17)

---

## 3. ENTRY POINT DECISION

**Decision:** Create a **dedicated production executor** at
`scripts/execute-web-production-release.sh` (filename to be finalized in S27T-5B).

**Rejected alternative:** adding a `--production` mode to the existing
orchestrator script.

**Rationale:**
1. **Capability isolation:** production write must be visible at the file boundary.
   Grep-ability for "this file is the production executor" is a security primitive.
2. **Auditability:** dedicated entry point has one purpose; review surface shrinks.
3. **Backward compatibility:** existing orchestrator remains the L3 acceptance
   oracle for `authorized-isolated-e2e`. It MUST NOT acquire production capability.
4. **Hard gates are easier to stack:** a dedicated entry point can require
   `--execute-production-deploy` flag PLUS preflight PLUS claim PLUS production
   identity snapshot, each as a separate explicit contract clause.
5. **No silent upgrade path:** an attacker (or operator mistake) cannot trick the
   isolated orchestrator into writing production by toggling an environment
   variable.

The existing orchestrator continues to be `isolated-e2e` /
`authorized-isolated-e2e` only. **It will never gain production mode.**

---

## 4. INPUT CONTRACT

Future executor CLI:

```
scripts/execute-web-production-release.sh \
    --execute-production-deploy \
    <SOURCE_SHA>
```

**Required inputs:**
- `--execute-production-deploy` (explicit execution intent)
- `<SOURCE_SHA>` (40 hex; must resolve to a commit)

**Forbidden inputs (will cause BLOCK):**
- `IMAGE_TAG`
- `IMAGE_ID`
- `MANIFEST_SHA`
- `LOCKFILE_SHA`
- `RELEASE_PLAN_FINGERPRINT`
- authorization artifact path
- claim artifact path
- environment-variable identity override

**Allowed environment variables (infrastructure only, no identity impact):**
- `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TMPDIR`
- `ORCHESTRATOR_SUDO` (default `/bin/sudo`); `ORCHESTRATOR_DOCKER` (default `/usr/bin/docker`)
- `ORCHESTRATOR_PRODUCTION_DIR` (default `/opt/book-id-search`, read-only infra override)
- `BOOK_ID_SEARCH_PRODUCTION_PROJECT` (production compose project name; default
  derived from `docker-compose.yml` basename)
- **Any other env var is stripped** at executor entry, mirroring the
  versioned gate's `build_clean_env` semantics.

**Three distinct intents (NEVER conflatable):**
| Intent | CLI flag | Owner script | Effect |
|--------|----------|--------------|--------|
| APPROVAL | `--approve-production-deploy` | `authorize-web-production-release.sh` | writes mode-600 auth artifact |
| CLAIM | `--claim-production-deploy` | `claim-web-production-release-authorization.sh` | atomic hard-link → consumes authorization |
| EXECUTION_INTENT | `--execute-production-deploy` | `execute-web-production-release.sh` (new) | runs full preflight + claim + deploy |

---

## 5. READ-ONLY PREFLIGHT (must all PASS before atomic claim)

```
01. Repo state        branch=main; working-tree clean; HEAD == origin/main
02. L2 Runtime Gate   scripts/verify-web-release-runtime-acceptance.py --profile quick → STATUS=PASS
03. L2 pipeline SHA   recorded: GATE_SHA256, AUTHORIZE_SHA256, CLAIM_SHA256, ORCHESTRATE_SHA256, EXECUTOR_SHA256 (self)
04. Fresh Plan        scripts/plan-web-production-release.sh <SOURCE_SHA> → STATUS=PASS
05. Plan re-validation 12 mandatory fields, fingerprint re-computed from disk, identity re-checked
06. Auth exists       progress/web-release-authorization-${FP}.env exists, mode=600, 12 keys present
07. Auth identity     SOURCE_SHA / FP / IMAGE_TAG / IMAGE_ID / MANIFEST_SHA / LOCKFILE_SHA all match Plan
08. Auth unclaimed    progress/web-release-authorization-claim-${FP}.env does NOT exist
09. Image preflight   docker image inspect ${IMAGE_TAG} → ImageID == Plan IMAGE_ID
10. Candidate evidence progress/web-release-candidate-${SOURCE_SHA}/ exists; candidate.json; static-manifest.tsv
11. Production snapshot PRE_WEB_CID, PRE_WEB_STARTED_AT, PRE_WEB_CONFIG_IMAGE, PRE_WEB_IMAGE_ID
12. API/Meili snapshot PRE_API_CID/StartedAt, PRE_MEILI_CID/StartedAt (invariance baseline)
13. Optional isolated  scripts/orchestrate-web-production-release.sh authorized-isolated-e2e <SOURCE_SHA> → PASS
14. Re-read production confirm preflight did NOT change PRE_WEB_*/PRE_API_*/PRE_MEILI_* values
```

**Mandatory vs recommended:**
- 01–12: **mandatory** for every production attempt.
- 13: **mandatory before each production attempt** (decision in §13).
- 14: **mandatory** integrity guard.

**Hard rule:** no check that can fail early is allowed to slip into the
post-claim phase.

---

## 6. AUTHORIZATION / CLAIM BOUNDARY

**Atomic claim is the FIRST irreversible deployment-state transition.**

Future executor invokes `scripts/claim-web-production-release-authorization.sh`
**internally**. Users MUST NOT pre-claim manually; doing so leaves the
authorization consumed but unattached to an execution attempt, and the executor
will refuse on `AUTHORIZATION_ALREADY_CLAIMED`.

After claim PASS, executor MUST parse the Claim machine output and confirm:
```
SOURCE_SHA, RELEASE_PLAN_FINGERPRINT, IMAGE_TAG, IMAGE_ID
```
all match the Fresh Plan.

If Claim FAIL → `production_write_invocation_count = 0`. Authorization
remains reusable. Manual review.

**Post-claim minimal revalidation (mandatory, non-extensible):**
- `docker image inspect ${IMAGE_TAG}` → ImageID must still equal Plan
- no candidate evidence re-validation beyond SHA equality of `candidate.json`

Any post-claim failure transitions state to `CLAIMED_NOT_DEPLOYED` and BLOCKS
automatic retry. Manual incident required.

---

## 7. FIRST PRODUCTION WRITE

The **first production write** is exactly:

```
BOOK_ID_SEARCH_WEB_IMAGE=${IMAGE_TAG} \
sudo -E scripts/deploy-web-release-candidate.sh \
    ${IMAGE_TAG}
```

where `IMAGE_TAG` came **only** from the Fresh Plan output, never from the
operator or any environment variable.

The deploy script:
- continues with `--no-build` (no `docker build`, no `docker compose build`)
- no `docker pull` (image is locally present)
- uses the production repo at `/opt/book-id-search`
- operates against the **production docker compose project**

**No additional flags** may be passed to the deploy script by the executor
beyond the documented infrastructure overrides.

---

## 8. ATTEMPT ARTIFACTS

Two immutable mode-600 audit artifacts, atomic create:

### `progress/web-release-production-attempt-${FINGERPRINT}.start.env`

Created **after Claim PASS** and **before** the first production write.

```
ATTEMPT_VERSION=1
SOURCE_SHA=<40hex>
RELEASE_PLAN_FINGERPRINT=<64hex>
IMAGE_TAG=<tag>
IMAGE_ID=sha256:<64hex>
PIPELINE_HEAD=<40hex>
PIPELINE_EXECUTOR_SHA256=<64hex>
PIPELINE_PLAN_SHA256=<64hex>
PIPELINE_CLAIM_SHA256=<64hex>
PIPELINE_DEPLOY_SHA256=<64hex>
PIPELINE_RUNTIME_GATE_SHA256=<64hex>
AUTHORIZED=true
CLAIMED=true
PRODUCTION_DEPLOY_STARTED=true
STARTED_AT=<ISO-8601>
PRE_WEB_CID=<full sha>
PRE_WEB_STARTED_AT=<ISO-8601>
PRE_WEB_CONFIG_IMAGE=<tag>
PRE_WEB_IMAGE_ID=sha256:<64hex>
PRE_API_CID=<full sha>
PRE_API_STARTED_AT=<ISO-8601>
PRE_MEILI_CID=<full sha>
PRE_MEILI_STARTED_AT=<ISO-8601>
```

### `progress/web-release-production-attempt-${FINGERPRINT}.result.env`

Created **after** deploy returns and post-deploy verification completes.

```
RESULT_VERSION=1
SOURCE_SHA=<40hex>
RELEASE_PLAN_FINGERPRINT=<64hex>
DEPLOY_EXIT_CODE=<int>
DEPLOY_SCRIPT_SHA256=<64hex>
PRODUCTION_TOUCHED=<true|false>
POST_WEB_CID=<full sha>
POST_WEB_CONFIG_IMAGE=<tag>
POST_WEB_IMAGE_ID=sha256:<64hex>
IMAGE_IDENTITY_VERIFIED=<true|false>
STATIC_IDENTITY_VERIFIED=<true|false>
DIRECT_PRODUCTION_SMOKE=<PASS|FAIL|INCOMPLETE>
DIRECT_PRODUCTION_SMOKE_REPORT=<path>
API_UNCHANGED=<true|false>
MEILI_UNCHANGED=<true|false>
FINAL_STATUS=<PASS|FAILED>
FINAL_FAILURE_REASON=<enum|NONE>
FINALIZED_AT=<ISO-8601>
```

**Properties:**
- mode 600, owned by the executor's user
- **atomic create** (write-temp + rename); never overwrite
- not used as identity input; **purely audit evidence**

---

## 9. STATE MACHINE

```
CANDIDATE_READY                  (evidence present, plan would PASS)
        │
        ▼
RUNTIME_ACCEPTED                 (L2 certify PASS recorded at release acceptance)
        │
        ▼
AUTHORIZED_UNCLAIMED             (auth artifact present, claim absent)
        │
        ▼
EXECUTION_PREFLIGHT_PASS         (steps 01–14 of §5)
        │
        ▼  (atomic)
CLAIMED                          (claim artifact present; auth consumed)
        │
        ▼
ATTEMPT_STARTED                  (start.env atomic written; deploy invocation issued)
        │
        ▼
DEPLOY_COMMAND_RETURNED          (deploy script exited; rc captured)
        │
        ▼
POST_DEPLOY_IDENTITY_VERIFIED    (Image ID exact; static identity exact; PRE vs POST compared)
        │
        ▼
PRODUCTION_SMOKE_VERIFIED        (mandatory direct-production smoke PASS)
        │
        ▼
DEPLOYMENT_ACCEPTED              (result.env atomic written; FINAL_STATUS=PASS)
```

**Failure states (terminal until manual intervention):**

```
PRE_CLAIM_BLOCKED                 (preflight failed; auth reusable; no production touch)
CLAIMED_NOT_STARTED              (claim succeeded; start artifact absent; manual review)
ATTEMPT_STATUS_UNKNOWN           (start present; result absent; manual incident)
DEPLOY_FAILED                    (deploy script nonzero; production partially touched; manual incident)
POST_VERIFY_FAILED               (deploy rc=0 but identity/smoke/API/Meili check failed; manual incident)
PRODUCTION_SCOPE_VIOLATION       (API or Meili CID/StartedAt changed; manual incident)
DEPLOYMENT_REJECTED              (manual operator rejected the result; auth consumed; no rollback)
```

**State × capability matrix:**

| State | auth_reusable | production_touched | auto_retry | auto_rollback |
|-------|---------------|--------------------|------------|---------------|
| CANDIDATE_READY | n/a | false | n/a | n/a |
| RUNTIME_ACCEPTED | n/a | false | n/a | n/a |
| AUTHORIZED_UNCLAIMED | yes | false | n/a | n/a |
| EXECUTION_PREFLIGHT_PASS | yes | false | n/a | n/a |
| CLAIMED | **no** | false | **false** | false |
| ATTEMPT_STARTED | no | **true** (in progress) | false | false |
| DEPLOY_COMMAND_RETURNED | no | true (unknown finality) | false | false |
| POST_DEPLOY_IDENTITY_VERIFIED | no | true | false | false |
| PRODUCTION_SMOKE_VERIFIED | no | true | false | false |
| DEPLOYMENT_ACCEPTED | no (consumed) | true (accepted) | n/a | n/a |
| PRE_CLAIM_BLOCKED | yes | false | false | false |
| CLAIMED_NOT_STARTED | no | false | false | false |
| ATTEMPT_STATUS_UNKNOWN | no | **true (unknown)** | **false** | false |
| DEPLOY_FAILED | no | true | **false** | **false** |
| POST_VERIFY_FAILED | no | true | **false** | **false** |
| PRODUCTION_SCOPE_VIOLATION | no | true (scope violation) | **false** | false |
| DEPLOYMENT_REJECTED | no | true | false | false |

---

## 10. RETRY POLICY

**`AUTO_RETRY = false`** in all cases:
- claim race failure → manual decision
- deploy script nonzero → manual incident
- HTTP smoke failure → manual incident
- post-deploy identity mismatch → manual incident
- API/Meili restart detected → manual incident

There is **no `sleep + retry` loop**, **no automatic second `docker compose up`**,
**no batched re-attempt**. Each subsequent attempt requires:
1. A new explicit operator invocation
2. A new authorization (since the prior one was consumed)
3. The full preflight sequence

---

## 11. ROLLBACK POLICY

**`AUTO_ROLLBACK = false`.**

Reason: rollback is itself a new production write. Rolling back "automatically"
after a failed deploy introduces a second, parallel, harder-to-trace mutation.

Required for any future rollback:
- a separate **explicit operator command** (e.g. `--execute-production-rollback`)
- a separately-designed rollback contract
- new preflight (rollback is not "free")
- recorded `attempt-rollback.env` artifact

The `PRE_WEB_*` fields recorded in `start.env` and the executor's emission of
`PREVIOUS_IMAGE_ID=<post-state-immediately-before-failure>` (when computed)
are the **human-only** inputs to a future rollback workflow.

---

## 12. POST-DEPLOY IDENTITY VERIFICATION

A successful `deploy-web-release-candidate.sh` exit is necessary but **NOT**
sufficient. The executor MUST additionally verify, in order:

1. `docker inspect book-id-search-web-1` →
   - `.Config.Image == ${IMAGE_TAG}` (Plan)
   - `.Image == ${IMAGE_ID}` (Plan)
2. candidate static-manifest SHA matches running static-manifest
   (`book-id-search-web-1:/usr/share/nginx/html/assets/...` SHA from candidate
   vs container extraction)
3. at least one direct-production smoke (currently
   `scripts/health-check.ts` → `status: up`) returns PASS
4. `PRE_API_CID == POST_API_CID` (invariance)
5. `PRE_API_STARTED_AT == POST_API_STARTED_AT` (invariance)
6. `PRE_MEILI_CID == POST_MEILI_CID` (invariance)
7. `PRE_MEILI_STARTED_AT == POST_MEILI_STARTED_AT` (invariance)

Identity checks must use current real evidence tooling — no fabricated SHA
formats.

---

## 13. PRODUCTION SMOKE CONTRACT

`MANDATORY_DIRECT_PRODUCTION_SMOKE_SET` (audited, not yet executed):

| Script | direct-production compatible | mandatory postdeploy |
|--------|------------------------------|----------------------|
| `scripts/health-check.ts` | YES (read-only HTTP GET) | **YES** |
| `scripts/run-health-check-cron.sh` | YES (wrapper around health-check) | NO (cron-only) |

`s27*` browser smokes are **preview-only** (talk to live URL but not part of
deployment verification contract). They are not part of the deployment gate
and MUST NOT be relied on for post-deploy identity.

The postdeploy smoke set MUST be re-audited before each release cycle and the
mandatory list recorded in `result.env`'s `DIRECT_PRODUCTION_SMOKE_REPORT`
field. **No "20/20 production" claim is permitted** without enumerating the
direct-production subset.

---

## 14. API / MEILI INVARIANCE (hard gate)

`POST_API_CID == PRE_API_CID` AND `POST_API_STARTED_AT == PRE_API_STARTED_AT`
AND similarly for Meili is **mandatory**. Violation → `FINAL_STATUS = FAILED`
with `FINAL_FAILURE_REASON = PRODUCTION_SCOPE_VIOLATION`. The deployment is
NOT accepted.

---

## 15. PIPELINE PROVENANCE

Each attempt must record (in `start.env`):
- `PIPELINE_HEAD` = current `HEAD` of the executing repo
- `PIPELINE_EXECUTOR_SHA256` = `scripts/execute-web-production-release.sh` bytes
- `PIPELINE_PLAN_SHA256` = `scripts/plan-web-production-release.sh` bytes
- `PIPELINE_CLAIM_SHA256` = `scripts/claim-web-production-release-authorization.sh` bytes
- `PIPELINE_DEPLOY_SHA256` = `scripts/deploy-web-release-candidate.sh` bytes
- `PIPELINE_RUNTIME_GATE_SHA256` = `scripts/verify-web-release-runtime-acceptance.py` bytes

These are **not** part of the Release Plan fingerprint. They are deployment
attempt provenance so a future question ("which pipeline version deployed
image X to production?") is answerable.

---

## 16. SUCCESS CONTRACT

Future production deployment is `STATUS=PASS` only if **all** hold:

```
claim_passed = true
attempt_start_recorded = true                  (start.env atomic written)
deploy_script_exit_code = 0
running_image_id == plan_image_id
running_static_manifest == candidate_static_manifest
mandatory_direct_production_smoke == PASS
api_cid_unchanged && api_started_at_unchanged
meili_cid_unchanged && meili_started_at_unchanged
result_env_atomic_written
```

Final machine output:
```
STATUS=PASS
PRODUCTION_DEPLOY_EXECUTED=true
PRODUCTION_DEPLOY_VERIFIED=true
AUTHORIZATION_CONSUMED=true
AUTO_RETRY=false
AUTO_ROLLBACK=false
```

---

## 17. FAILURE SEMANTICS (summary; full table in progress/)

Distinction by failure point:

| Class | Auth reusable | Production touched | Required next action |
|-------|---------------|--------------------|----------------------|
| `PRE_CLAIM_BLOCKED` | yes | false | fix and re-authorize |
| `CLAIMED_NOT_STARTED` | no | false | manual incident; do NOT re-authorize |
| `DEPLOY_FAILED` | no | true (partial) | manual incident |
| `POST_VERIFY_FAILED` | no | true | manual incident; manual recovery using PREVIOUS_IMAGE_ID |
| `PRODUCTION_SCOPE_VIOLATION` | no | true (scope violation) | manual incident; rollback separately-authorized |
| `ATTEMPT_STATUS_UNKNOWN` | no | unknown | manual incident; reconcile docker state |

---

## 18. CRASH RECOVERY

```
state = inspect_attempt_artifacts(${FINGERPRINT})

if state == (auth exists, claim absent):     CLAIMED_NOT_STARTED → manual review
if state == (claim exists, start absent):    ATTEMPT_STATUS_UNKNOWN (claim used; start missing) → manual incident
if state == (start exists, result absent):   ATTEMPT_STATUS_UNKNOWN → manual incident
if state == (result present, FINAL_STATUS=PASS):  ACCEPTED, no action
if state == (result present, FINAL_STATUS=FAILED): REJECTED, manual recovery
```

Crashed executor leaves the system in one of the above inspectable states.
The recovery tool is **read-only** and never resumes; it only reports state.

---

## 19. AUTHORIZATION REISSUE

**`REISSUE_SUPPORT = NOT_IMPLEMENTED`.**

A consumed authorization for fingerprint F cannot be re-issued. A new
authorization requires:
- a new candidate evidence (new fingerprint), or
- a separately-designed re-issue contract (not yet defined)

**Bypasses are forbidden.** No "reset claim artifact" tool. No
"unlink authorization" tool. These would defeat the atomic-consumption
invariant that runtime acceptance depends on.

---

## 20. SECURITY BOUNDARIES

- Production executor MUST strip all non-allowlisted environment variables at entry.
- Production executor MUST refuse if stdin is not a TTY *and* `--yes` is not
  passed (operator must be interactive or explicitly opt in).
- Production executor MUST log (stderr) every step; logs are not stored in
  `progress/` (deliberately — logs are operational, artifacts are audit).
- Audit artifacts are mode 600 owned by the operator user; the executor's
  `start.env` / `result.env` are not world-readable.
- Claim artifact remains a hard-link to the auth artifact (`nlink=2` invariant)
  — same inode, same SHA. The executor's read-only revalidation of
  `nlink ≥ 2` on the auth artifact is the canonical "claim consumed" check.

---

## 21. WORKTREE / GIT CONTRACT

Before production execution:
- `git branch --show-current == main`
- `git status --porcelain` clean (no untracked generated files)
- `git rev-parse HEAD` resolvable
- `git rev-parse HEAD == git rev-parse origin/main` (no local unpushed commit)
- pipeline runtime SHA matches the SHA recorded at L2 acceptance

`HEAD != origin/main` is a **hard BLOCK** unless an emergency exception
contract is separately signed (none exists yet).

---

## 22. L2 GATE PLACEMENT

| Profile | When |
|---------|------|
| `certify` | **release acceptance hard gate** (already done; S27T-4D-A5) |
| `quick`  | **immediate production execution hard gate** (every attempt) |

Both produce `RUNTIME_SHA256`; the production executor records the current
`quick` run's `RUNTIME_SHA256` in `start.env` and verifies it matches the
SHA accepted at release time.

---

## 23. L3 IMMEDIATE PREFLIGHT

**`MANDATORY_BEFORE_PRODUCTION = true`** for `authorized-isolated-e2e`.

Rationale: S27T-4D-A6 measured ~5–10 minutes for a full isolated run.
A real Plan + Auth + Evidence + actual-deploy-script + real-sudo + real-Compose
with exact frozen image in an isolated project is the only oracle that proves
the **same deploy script that production will execute** still works on the
exact same image.

This runs **after** the lighter preflight (steps 01–12 of §5) but **before**
the atomic claim. Total preflight cost: ~5–10 minutes; acceptable.

---

## 24. FUTURE IMPLEMENTATION SCOPE (S27T-5B onward)

**S27T-5B — Read-only Production Deployment Execution Planner** (read-only):
- New file: `scripts/plan-web-production-deployment-execution.sh`
- New test: `scripts/test-plan-web-production-deployment-execution.py`
- Behavior: validate the complete pre-claim contract (§5 steps 01–12) and emit
  a machine-bound execution plan (JSON or KEY=value) that proves the system
  is ready to claim, but **DOES NOT** claim, deploy, write production, restart
  anything, build any image, or push any tag.

**S27T-5C — Isolated Execution Engine Simulation** (isolated):
- Add isolated execution mode in new executor
- Runs through Plan→Authorize→Claim→Deploy against an isolated project with
  a stub production snapshot
- Verifies state machine transitions
- **Still does NOT touch production**

**S27T-5D — First Production Execution** (real, single attempt):
- A separate task spec, gated on S27T-5C PASS
- Will require explicit operator approval per the new contract
- Cannot be assumed or implied

**Forbidden in 5B / 5C:** claim authorization for real, create real
authorization artifact (only stub/test-mode artifacts), production write,
production compose up, restart, build, push, tag.

---

## 25. CONTRACT CONSISTENCY AUDIT

This contract does NOT require changes to:
- `scripts/authorize-web-production-release.sh` — explicit approval semantics preserved
- `scripts/claim-web-production-release-authorization.sh` — atomic one-time claim preserved
- `scripts/orchestrate-web-production-release.sh` — no production mode added
- `scripts/plan-web-production-release.sh` — read-only Plan semantics preserved
- `scripts/deploy-web-production-candidate.sh` — build-once/deploy-same-image preserved
- `scripts/verify-web-release-readiness.sh` — readiness oracle preserved
- `scripts/verify-web-release-runtime-acceptance.py` — runtime acceptance oracle preserved
- L1 contract: pipeline tests remain L1 stable regression
- L2 gate: `quick`/`certify` semantics unchanged
- L3: isolated orchestrator unchanged

**FUTURE_REQUIRED_CHANGE = none** for this contract.

If a future executor design finds it needs to modify any of the above
runtimes, that is a **new contract** requiring a separate audit phase. This
contract deliberately leaves all runtimes untouched.

---

## 26. NEXT IMPLEMENTATION PHASE

**S27T-5B — Read-only Production Deployment Execution Planner**

Goals:
1. Implement `scripts/plan-web-production-deployment-execution.sh` exactly
   per §5 steps 01–12.
2. Provide a machine-readable plan output that proves:
   - L2 quick gate PASS (record `RUNTIME_SHA256`)
   - Fresh Plan PASS with full identity re-validation
   - Authorization exists, mode 600, identity matches Plan, unclaimed
   - Image preflight (ImageID == Plan)
   - Production snapshot (Web/API/Meili) recorded
3. Emit `STATUS=READY_TO_CLAIM` only when all of §5 01–12 PASS.
4. Emit `STATUS=BLOCKED` with stable `BLOCK_REASON` enum otherwise.
5. **Do not** call Claim. **Do not** call Deploy. **Do not** modify
   production. **Do not** commit/push/tag.

Test suite (`test-plan-web-production-deployment-execution.py`):
- L2 quick stub PASS / FAIL
- Plan PASS / FAIL / fingerprint mismatch
- Auth missing / mode wrong / identity mismatch
- Auth already-claimed (must BLOCK)
- Image drift detected (must BLOCK)
- Production snapshot capture
- All success and all blocked paths

Only after S27T-5B passes its self-tests and quick profile in a real repo
checkout does S27T-5C become eligible.
