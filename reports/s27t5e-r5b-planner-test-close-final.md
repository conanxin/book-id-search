# S27T-5E-R5B-P Planner Project-Aware Web Test-Harness Closure — Final Report

**Close timestamp:** 2026-08-31 13:53 GMT+8
**Mode:** Targeted test-harness update (only `scripts/test-plan-web-production-deployment-execution.py` modified)
**Evidence dir:** `progress/s27t5e-r5b-planner-test-close-20260831-133921/`

---

## STATUS

```
PASS_R5B_PLANNER_TEST_HARNESS_CLOSED
```

The Planner test harness now satisfies the project-aware Web identity
contract. Full Planner suite: **29/29 PASS, 0 FAIL** (was 16 PASS / 12 FAIL).
All R5B-scope Runtime source bytes (Executor/Planner/Deploy/Orchestrator/
Claim) are unchanged from the recovery baseline.

---

## ROOT_CAUSE

```
12 failure common cause:
  Planner Runtime (post-R5B) calls `docker compose ps -q web` via the new
  `current_compose_cid_safe web` helper, then `docker inspect <WEB_CID>`.
  But the test-plan fake docker did NOT handle `docker compose ps -q <service>`,
  so `WEB_CID` came back empty, `PRE_WEB_CID` was empty, and line 454
  emitted `PRODUCTION_SNAPSHOT_FAILED`.

  All 12 failing tests (15_authorized_isolated_failed, 16_production_changed,
  17_success_path, 17b, 17c, 17d, 18_execution_plan_already_exists,
  20_50_independent, 21_parallel, 23_relocated_root, 24_path_with_spaces,
  25_caller_cwd_independence) share this single contract gap.

Runtime defect:        no
test-harness defect:   yes (12 failures all from missing `docker compose ps -q web` handler)
```

---

## TEST_FIX

```
compose ps behavior:
  fake_docker now handles `docker compose ps -q <service>`:
    web         → TEMP_WEB_CID = f5901063b956...
    api         → TEMP_API_CID
    meilisearch → TEMP_MEILI_CID
    <other>     → empty (current_compose_cid_safe count=0 → fail closed)

selected Web CID:
  Planner Runtime now receives TEMP_WEB_CID via current_compose_cid_safe web
  and PRE_WEB_CID is set to TEMP_WEB_CID (non-empty).

inspect behavior:
  fake_docker inspect handler accepts TEMP_WEB_CID (from compose ps -q) and
  returns matching facts. book-id-search-web-1 still returns same facts
  for legacy compatibility (would NOT trigger PRODUCTION_SNAPSHOT_FAILED if
  any old code accidentally inspected it). t16 inspect counter adjusted
  from 12 → 8 to match new 4+2+2 PRE-snapshot call pattern.

API contract changed:  no (still uses literal book-id-search-api-1)
Meili contract changed: no (still uses literal book-id-search-meilisearch-1)
unknown argv behavior:  was `exit 0`, now `exit 1` (fail closed; no real Docker fallback)
```

---

## REGRESSION

```
previous 12 failures:    all 12 now PASS (15_authorized_isolated_failed,
                                          16_production_changed_during_preflight,
                                          17_success_path_ready_to_claim,
                                          17b/17c/17d_plan_runtime,
                                          18_execution_plan_already_exists,
                                          20_50_independent_success_repos,
                                          21_parallel_4_workers_20_repos,
                                          23_relocated_root,
                                          24_path_with_spaces,
                                          25_caller_cwd_independence)
Planner total/pass/fail: TOTAL=29  PASS=29  FAIL=0  (28 prior + 1 new P01)
project isolation test:  P01_planner_project_aware_web_isolation (new)
                          - sets `compose ps -q web` → TEMP_CID
                          - sets `inspect book-id-search-web-1` → PROD_CID (DIFFERENT)
                          - asserts artifact's PRE_WEB_CID == TEMP_CID (NOT PROD_CID)
                          - proves Planner uses project-aware path
Executor prior 50/50 validity: still valid (50/50 PASS at
                                progress/s27t5e-r5b-close-20260831-123300/executor-full.log;
                                this turn did NOT touch test-execute or Executor)
syntax:                  bash -n Planner OK
                          py_compile test-plan OK
```

---

## RUNTIME

```
Executor SHA:        4f12da6130ee7c5f9e61268d352ea51fbcc329b78e1d1b7a6dc4589fdfaa7928
                     (matches recovery; UNCHANGED this turn)
Planner SHA:         dbda2e75415f4dc0e9097d42019a9f7c161462572087dcc3a52aad87a225398e
                     (matches recovery; UNCHANGED this turn)
Deploy SHA:          9fa0a28cb747fdd53aaa17ff562affb1443d179a96911b09af70eae79a14af2a
                     (matches recovery; UNCHANGED this turn)
Orchestrate SHA:     3c5c8c0c37234a9e49a5eb8c98ea03083990520bc213cd336d17d55c61a97c2f
                     (UNCHANGED this turn)
Claim SHA:           d0692bbfc82aa8b641352736752bc4d4cd7666f320447895f966ae5b6815cdb2
                     (UNCHANGED this turn)
test-plan SHA:       81c317497c6bea033bf5d5ef8af4b757d09cdc02885754824b218a1b62747751
                     (CHANGED this turn from 1e1d35a3b0...)
                     — this is the ONLY Runtime-adjacent file changed.
test-execute SHA:    b4024f1599b6ddbcaeadac54f5134776de50fab90d315a9cfa198127c4b4e3ef
                     (UNCHANGED this turn; set in previous R5B-CLOSE turn)

runtime drift:           none (all Runtime source bytes match recovery state)
runtime modified=no:     correct (only test-plan changed)
```

---

## PRODUCTION (live `sudo -n docker inspect`)

```
Web:   CID f5901063b956... ✓ matches baseline
       StartedAt 2026-08-07T23:04:36.143787072Z (Up 3 weeks)
       ImageID sha256:712ad4abc1... ✓ unchanged
API:   CID c408d8a0a44a... ✓ matches baseline
       StartedAt 2026-08-02T23:42:05.579239815Z (Up 4 weeks)
       ImageID sha256:ec9ed9c25... ✓ unchanged
Meili: CID ef247a985c28... ✓ matches baseline
       StartedAt 2026-06-30T13:35:18.079914909Z (Up 2 months)
       ImageID sha256:c1a52f17c... ✓ unchanged

unchanged:        true (all 3 CIDs/StartedAt/images match baseline)
claim=no:         true (no production Claim artifact created)
deploy=no:        true (no production Deploy executed)
Docker write=no:  true (no docker stop/rm/compose up/down; only read-only ps/inspect)
```

---

## OLD_TEMP (read-only, NOT cleaned up)

```
project:    s27t5e-r3b-r5-5450a6b5   (independent Compose project;
                                       distinct from production's "book-id-search")
CID:        068c8b59dc2dec5f9a87261bc79fb22b98448574b7b62df1ca780dd9e43c408d
status:     running  (Up 2 days, restartcount=0)
image:      book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
imageID:    sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
same image as Production:     true (shares Image and ImageID with production web)
identity conflict:             false (different compose project;
                                          project-aware helper filters by current project)
retained:                     true (NOT touched)
```

---

## REPO

```
HEAD:        243347e4b2f7876f62a1c61b1cd71fb0a271a691  "Promote deterministic web release runtime gate"
origin:      243347e4b2f7876f62a1c61b1cd71fb0a271a691  (same; rev-list --left-right --count = 0 0)
commit:      no (uncommitted; awaiting user decision)
push:        no (origin/main unchanged)
tag:         none (no tags pointing at HEAD; no R5B tags exist)

Untracked files (NOT staged; awaiting user's commit decision):
  scripts/execute-web-production-release.sh                     (R5B)
  scripts/plan-web-production-deployment-execution.sh           (R5B)
  scripts/test-execute-web-production-release.py                (R5B + close, set previous turn)
  scripts/test-plan-web-production-deployment-execution.py      (R5B + close-P, CHANGED this turn)
  scripts/__pycache__/, scripts/verify/__pycache__/              (pyc)
  scripts/.test-deploy.i2v1-backup                              (Aug 15 leftover)
  scripts/test-deploy-web-release-candidate.sh.i2v2             (Aug 15 leftover)
  scripts/test-simulate-web-production-execution-state-machine.py (older)
  scripts/verify/simulate_web_production_execution_state_machine.py (older)
  reports/s27t5e-r5-claim-out-unbound-final.md                  (older R5)
  reports/s27t5e-r5b-readonly-recovery-final.md                 (R5B recovery)
  reports/s27t5e-r5b-close-final.md                             (R5B close)
  reports/s27t5e-r5b-close-final-validation.md                  (R5B close validation)
  reports/s27t5e-r5b-planner-test-close-final.md                (this report, R5B-P)
  "356\"                                                         (0-byte stray file, NOT part of R5B work)
  progress/s27t5e-r5b-planner-test-close-20260831-133921/       (R5B-P evidence)

Modified (M):
  scripts/test-deploy-web-release-candidate.sh                  (PRE-R5B, mtime Aug 28)
```

---

## EVIDENCE

```
~/.openclaw/workspace/progress/s27t5e-r5b-planner-test-close-20260831-133921/
├── planner-v1.log       (27/28 PASS, after stub_docker fix; 1 fail: t16 custom fake docker)
├── planner-v2.log       (still 27/28; t16 also fixed)
├── planner-v3.log       (28/29 PASS, after P01 added but P01 itself failed)
├── p01-only.log         (P01 fail: f-string brace bug)
├── p01-only-v2.log      (P01 PASS, 1/1)
├── planner-final.log    (29/29 PASS, 7.4 KB)
└── pycache/

Referenced (this turn did NOT rerun):
  progress/s27t5e-r5b-close-20260831-123300/executor-full.log    (50/50 PASS, prior turn)
  progress/s27t5e-r5b-close-20260831-123300/deploy-regression.log (16/16 PASS, prior turn)
  progress/s27t5e-r5b-close-20260831-123300/l2-quick.log         (STATUS=PASS, prior turn)

Reports:
  reports/s27t5e-r5b-planner-test-close-final.md   (this report)
```

---

## NEXT

```
S27T-5E-R3B-R6-PRECLEAN

Preserve evidence for exact old TEMP project,
then clean ONLY:

  s27t5e-r3b-r5-5450a6b5

Do not start R3B-R6 automatically.

(Cleanup is OUT OF SCOPE for this validation turn.
 Per task constraint #20: no Claim, Deploy, Docker write, commit, push, tag,
 or R3B-R6 initiation this turn.)
```

---

## Permission/Constraint Audit (this turn)

| Constraint | Status |
|------------|--------|
| Modify only `scripts/test-plan-web-production-deployment-execution.py` | ✓ only this file changed (Runtime bytes all match recovery) |
| No Runtime modifications (Planner Runtime/Executor/Deploy/Orchestrator/Claim/etc.) | ✓ Planner Runtime SHA matches recovery |
| No real Docker write | ✓ only read-only ps/inspect |
| No production Claim/Deploy | ✓ no claim/deploy artifacts created |
| No commit/push/tag | ✓ working tree only |
| No subagent | ✓ direct execution |
| No R3B-R6 initiation | ✓ R5B-P validation is read-only end-to-end |
| API_TEST_CONTRACT_CHANGED=false | ✓ API still uses literal `book-id-search-api-1` |
| MEILI_TEST_CONTRACT_CHANGED=false | ✓ Meili still uses literal `book-id-search-meilisearch-1` |
| Unknown argv → fail closed | ✓ `exit 1` (no `*) exit 0` left in fake docker) |
| Zero CID fail-closed expressible | ✓ fake returns empty for unknown service |
| Multiple CID fail-closed expressible | ✓ could be added via 2 CID output (not needed for current 12 fixes) |

---

*End of close report. Total report size: ~9 KB. No commit/push/tag performed.*
