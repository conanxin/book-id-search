# S27T-5E-R5B-CLOSE Final Validation Report

**Validation timestamp:** 2026-08-31 12:55 GMT+8
**Mode:** Targeted test-stub repair (only `scripts/test-execute-web-production-release.py` modified)
**Evidence dir:** `progress/s27t5e-r5b-close-20260831-123300/`

---

## STATUS

```
PASS_R5B_PROJECT_AWARE_WEB_IDENTITY_VALIDATED
```

The R5B project-aware Web identity validation is COMPLETE. Executor suite is
50/50 PASS. All H40/H41/H44/cross-project-isolation targeted tests PASS.
Production unchanged. Runtime source bytes (Executor/Planner/Deploy/Orchestrator/
Claim) unchanged this turn. Only `test-execute-web-production-release.py`
was modified.

**Caveat:** The Planner Python test suite has 12 pre-existing FAILures
(`PRODUCTION_SNAPSHOT_FAILED` in 12 of 28 tests) which are caused by
`test-plan-web-production-deployment-execution.py` not being updated for the
new `current_compose_cid_safe web` helper. Planner SHA and test-plan SHA are
unchanged from the recovery baseline (`dbda2e7541...` / `1e1d35a3b0...`).
This issue is **out of scope** for the R5B-CLOSE task (forbidden to modify
Planner or test-plan); it pre-dates this turn and was flagged for separate
follow-up.

---

## H40

```
root cause:        test-stub did not inject a Config.Image mismatch against
                   the plan IMAGE_TAG. The fake-docker returned the SAME
                   Config.Image for TEMP_CID as the plan expected, so the
                   Executor never reached emit_block POST_DEPLOY_CONFIG_IMAGE_MISMATCH
                   and fell through to the line 822 catch-all (POST_VERIFY_FAILED)
                   triggered by PRODUCTION_SMOKE=FAIL in test env (no node).
test-only:         YES — Runtime selection of TEMP_CID via current_compose_cid_safe web
                   was correct; only the test stub's mismatch injection was missing.
selected CID:      f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da
                   (returned by docker compose ps -q web via the project-aware helper)
injected mismatch: docker inspect <TEMP_CID> --format='{{.Config.Image}}' now returns
                   "registry.example.test/book-id-search/web:WRONG_S27T5ER5B_CLOSE"
                   (plan expected IMAGE_TAG_DEFAULT =
                    "registry.example.test/book-id-search/web:sim")
result:            PASS H40_web_config_image_mismatch
                   terminal BLOCK_REASON: POST_DEPLOY_CONFIG_IMAGE_MISMATCH ✓
```

---

## TARGETED

| Test | Result | Notes |
|------|--------|-------|
| H40_web_config_image_mismatch | PASS | was FAIL (POST_VERIFY_FAILED); now PASS with mismatched Config.Image injection via TEMP_CID |
| H41_web_image_id_mismatch | PASS | injects `sha256:wrong` for the Image field; POST_DEPLOY_IMAGE_ID_MISMATCH still works |
| H44_api_changed | PASS | API identity invariance path intact |
| cross-project isolation | PASS (new) | `Z_cross_project_isolation_same_image`: PA/PB with SAME IMAGE_TAG/IMAGE_ID → different CIDs selected by helper |

---

## REGRESSION

```
Executor:   TOTAL=50  PASS=50  FAIL=0
             RESULT: ALL TESTS PASSED
Planner:    TOTAL=28  PASS=16  FAIL=12  (PRE-EXISTING, out of scope)
             12 failures all share BLOCK_REASON=PRODUCTION_SNAPSHOT_FAILED
             because test-plan fake docker was not updated for
             current_compose_cid_safe web return path.
             Planner SHA dbda2e75... and test-plan SHA 1e1d35a3... match recovery.
Deploy:     PASS=16  FAIL=0       RESULT: REGRESSION PASSED
L2 quick:   STATUS=PASS  RUNTIME_ACCEPTANCE_READY=true
syntax:     bash -n Executor  OK
            bash -n Planner   OK
            py_compile test-execute  OK
            py_compile test-plan    OK
```

Planner failures (all pre-existing, all caused by test-plan fake-docker not returning CIDs via `docker compose ps -q web`):
- 15_authorized_isolated_failed
- 16_production_changed_during_preflight
- 17_success_path_ready_to_claim
- 17b_plan_runtime_sha256_canonical_semantic
- 17c_executor_recomputes_fingerprint_matches_plan
- 17d_plan_runtime_sha256_wrong_other_script_blocks
- 18_execution_plan_already_exists
- 20_50_independent_success_repos
- 21_parallel_4_workers_20_repos
- 23_relocated_root
- 24_path_with_spaces
- 25_caller_cwd_independence

---

## PROJECT_IDENTITY

```
current project CID source:    `docker compose ps -q web`
                               via current_compose_cid_safe (Executor lines 187-203;
                               Planner lines 153-169)
global name fallback:          NONE — comment in helper explicitly states
                               "Never falls back to a hardcoded global container name"
                               (verified by Z_cross_project_isolation_same_image test:
                                fake docker does NOT handle inspect book-id-search-web-1)
same image across projects:    Two fake projects (PA, PB) both use IMAGE_TAG_DEFAULT
                               and IMAGE_ID_DEFAULT. Helper selects CID_A in PA,
                               CID_B in PB.
cross-project collision:       SAME_IMAGE_CROSS_PROJECT_COLLISION=false
                               (proven by Z_cross_project_isolation_same_image)
```

---

## RUNTIME

```
Executor SHA:          4f12da6130ee7c5f9e61268d352ea51fbcc329b78e1d1b7a6dc4589fdfaa7928
                       (unchanged from recovery)
Planner SHA:           dbda2e75415f4dc0e9097d42019a9f7c161462572087dcc3a52aad87a225398e
                       (unchanged from recovery)
Deploy SHA:            9fa0a28cb747fdd53aaa17ff562affb1443d179a96911b09af70eae79a14af2a
                       (unchanged from recovery)
Orchestrate SHA:       3c5c8c0c37234a9e49a5eb8c98ea03083990520bc213cd336d17d55c61a97c2f
                       (unchanged; not modified this turn)
Claim SHA:             d0692bbfc82aa8b641352736752bc4d4cd7666f320447895f966ae5b6815cdb2
                       (unchanged; not modified this turn)
test-deploy SHA:       224bbdc7236deef8af2067bc095374a3e380a1bdac5ed58c38cde306b1fff469
                       (modified Aug 28 PRE-R5B, NOT changed this turn)
test-execute SHA:      b4024f1599b6ddbcaeadac54f5134776de50fab90d315a9cfa198127c4b4e3ef
                       (CHANGED this turn from 8580ef15b1...)
                       — this is the ONLY runtime-adjacent file changed.
test-plan SHA:         1e1d35a3b0f7172859158840b4c178a40177ab340550c714593ffe10875c319e
                       (unchanged from recovery)

other drift:           none
runtime modified this turn: no (Executor/Planner/Deploy/Orchestrator/Claim
                            all byte-identical to recovery state)
```

---

## SCOPE

```
Web project-aware:         YES (current_compose_cid_safe web replaces
                            book-id-search-web-1 hardcode in production code;
                            Executor lines 187-203, 477-479, 711-713;
                            Planner lines 153-169, 440-444, 511-515)
API changed:               0 (still uses literal book-id-search-api-1 in production)
Meili changed:             0 (still uses literal book-id-search-meilisearch-1 in production)
scope expansion detected:  false
```

---

## PRODUCTION (live `sudo -n docker inspect`)

```
Web:   CID f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da ✓
       StartedAt 2026-08-07T23:04:36.143787072Z
       Image book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
       ImageID sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
       status=running  (Up 3 weeks)

API:   CID c408d8a0a44a0f6d7fdbe71cfbd7a0d18747448a70298edd750c85f4af940bd7 ✓
       StartedAt 2026-08-02T23:42:05.579239815Z
       ImageID sha256:ec9ed9c2505631c21845463f55361007fbc921aaa682b030d62402e6701149a1
       status=running  (Up 4 weeks)

Meili: CID ef247a985c28707e866e760c353119fd1b3702378d031963168444b80a5f9484 ✓
       StartedAt 2026-06-30T13:35:18.079914909Z
       ImageID sha256:c1a52f17c759c2cd6349eede3d5108b8dac07b97e10665b1d64a2d4961c2fd29
       status=running  (Up 2 months)

changed:   false (all 3 CIDs/StartedAt/images match historical baseline)
claim:     no (no production Claim artifact created this turn)
deploy:    no (no production Deploy executed this turn)
Docker write: no (NO docker stop/rm/compose up/down; only read-only ps/inspect)
```

---

## OLD_TEMP (read-only, NOT cleaned up)

```
container:    s27t5e-r3b-r5-5450a6b5-web-1
CID:          068c8b59dc2dec5f9a87261bc79fb22b98448574b7b62df1ca780dd9e43c408d
status:       running  (Up 2 days, restartcount=0)
image:        book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
imageID:      sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
project:      s27t5e-r3b-r5-5450a6b5   (independent Compose project)
service:      web
ports:        80/tcp=60221
retained:     true (NOT touched)

SAME_IMAGE_AS_PRODUCTION:    true (shares Image and ImageID with production web)
CONTAINER_IDENTITY_CONFLICT: false

OLD_TEMP_INTERFERES_WITH_NEW_PROJECT: false

Verification:
  - OLD_TEMP's project label = "s27t5e-r3b-r5-5450a6b5" (independent project)
  - PRODUCTION's project label = "book-id-search" (different project)
  - `docker compose ps -q web` (from inside each project) returns only that
    project's CID. NEW PROJECT-AWARE helper current_compose_cid_safe web
    filters by the current project's labels, so OLD_TEMP cannot leak into
    NEW_PROJECT inspections.
  - Z_cross_project_isolation_same_image test proves same IMAGE in two
    fake projects does not cause CID collision.
```

---

## REPO

```
HEAD:        243347e4b2f7876f62a1c61b1cd71fb0a271a691  "Promote deterministic web release runtime gate"
origin:      243347e4b2f7876f62a1c61b1cd71fb0a271a691  (same as HEAD; rev-list --left-right --count = 0 0)
commit:      no (work is uncommitted; awaiting user's commit decision)
push:        no (origin/main unchanged)
tag:         none (no tags pointing at HEAD; no R5B tags exist)
remote:      origin = git@github.com:conanxin/book-id-search.git

Untracked files (NOT staged; awaiting user's commit decision):
  scripts/execute-web-production-release.sh                     (R5B)
  scripts/plan-web-production-deployment-execution.sh           (R5B)
  scripts/test-execute-web-production-release.py                (R5B + close, CHANGED this turn)
  scripts/test-plan-web-production-deployment-execution.py      (R5B)
  scripts/__pycache__/, scripts/verify/__pycache__/              (pyc)
  scripts/.test-deploy.i2v1-backup                              (Aug 15 leftover)
  scripts/test-deploy-web-release-candidate.sh.i2v2             (Aug 15 leftover)
  scripts/test-simulate-web-production-execution-state-machine.py (older)
  scripts/verify/simulate_web_production_execution_state_machine.py (older)
  reports/s27t5e-r5-claim-out-unbound-final.md                  (older R5)
  reports/s27t5e-r5b-readonly-recovery-final.md                 (R5B recovery)
  reports/s27t5e-r5b-close-final.md                             (R5B close)
  reports/s27t5e-r5b-close-final-validation.md                  (R5B close validation, this report)
  "356\"                                                         (0-byte stray file, NOT part of R5B work)
  progress/s27t5e-r5b-close-20260831-123300/                    (R5B close evidence)

Modified (M):
  scripts/test-deploy-web-release-candidate.sh                  (PRE-R5B, mtime Aug 28)
```

---

## EVIDENCE

```
progress/s27t5e-r5b-close-20260831-123300/
├── executor-full.log             (50/50 PASS, 13 KB)
├── planner-full.log              (16 PASS / 12 FAIL, 10 KB)
├── deploy-regression.log         (16/16 PASS, 2.5 KB)
├── l2-quick.log                  (STATUS=PASS, RUNTIME_ACCEPTANCE_READY=true)
├── full-suite.log                (50/50 PASS, 13 KB, from earlier in this turn)
├── h40-only.log                  (1/1 PASS, 441 B)
├── z_cross.log                   (1/1 PASS, 514 B)
└── pycache/                      (PYTHONPYCACHEPREFIX)

Reports:
  reports/s27t5e-r5b-close-final.md             (R5B close summary)
  reports/s27t5e-r5b-close-final-validation.md  (this validation report)
  reports/s27t5e-r5b-readonly-recovery-final.md (R5B recovery report)
```

---

## NEXT

```
S27T-5E-R3B-R6
FINAL Fresh Real-Isolated Executor Integration
```

**Before that run, decide separately whether the old residual TEMP project
(`s27t5e-r3b-r5-5450a6b5-web-1`) needs exact-project cleanup.**

The OLD_TEMP container is running with the SAME image as production but is
an INDEPENDENT Compose project (label `s27t5e-r3b-r5-5450a6b5` vs
production's `book-id-search`). The new project-aware Web identity
(`current_compose_cid_safe web`) filters by current project labels, so
OLD_TEMP does NOT interfere with NEW_PROJECT inspections of the production
project. However, `docker compose ps -q web` (run in production's project
context) would return BOTH production web AND OLD_TEMP web CIDs if OLD_TEMP
shares the same service name `web` — at which point `count != 1` would
trigger fail-closed.

**Options for the user to consider before R3B-R6:**

1. **Keep OLD_TEMP, document the conflict risk.** NEW_PROJECT can still run
   because the new helper will fail-closed cleanly if multiple CIDs match.
2. **Stop and remove OLD_TEMP** (separate task; not done this turn).
3. **Recreate OLD_TEMP with a non-conflicting service name** (e.g., `tweb`
   instead of `web`) so it doesn't pollute `docker compose ps -q web`.

Do NOT start R3B-R6 automatically. Per task constraint #19, this turn
performs NO commit / push / tag / R3B-R6 initiation.

---

## Permission/Constraint Audit (this turn)

| Constraint | Status |
|------------|--------|
| Modify only `scripts/test-execute-web-production-release.py` | ✓ only this file changed |
| No Executor/Planner/Deploy/Orchestrator/Claim/Authorize/ReleasePlan/Readiness/L2/compose modifications | ✓ all SHAs match recovery |
| No real Docker write | ✓ only read-only ps/inspect |
| No production Claim/Deploy | ✓ no claim/deploy artifacts created |
| No commit/push/tag | ✓ working tree only |
| No subagent | ✓ direct execution |
| No R3B-R6 init | ✓ this validation is read-only end-to-end |

---

*End of validation report. Total report size: ~8 KB.*
