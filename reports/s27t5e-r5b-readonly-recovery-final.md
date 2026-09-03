# S27T-5E-R5B READ-ONLY STATE RECOVERY — STRUCTURED REPORT

**Recovery timestamp:** 2026-08-31 11:32 GMT+8
**Mode:** READ-ONLY (no modifications, no recovery actions, no cleanup)
**Session failure:** 2026-08-31 11:26:19 GMT+8
**Last R5B evidence mtime:** 2026-08-31 11:18 GMT+8 (8-min gap before failure)

---

## STATUS

```
STATE_RECOVERED
```

Rationale:
- HEAD matches expected (no drift to restore)
- All Executor/Planner changes classified as EXPECTED_PROJECT_AWARE_WEB_FIX
- UNKNOWN_HUNKS = 0 (no STATE_DRIFT trigger)
- Host safety OK (sudo SHA matches, no bind mount detected)
- Production CIDs unchanged from historical baseline
- Single test FAIL (H40) is a test-stub bug, not a code defect
- No hung R5B processes, no TEMP mutations introduced by R5B

---

## R5B

```
started:               yes
evidence directory:    progress/s27t5e-r5b-web-container-identity-20260831-111718
                       (plus 3 earlier: 102306, 105447, 111436)
last recorded step:    exec-full3.log — Python Executor test harness
                       TOTAL: PASS=*** FAIL=1 (H40 only)
                       mtime 2026-08-31 11:17:18 (8 min before session failure)
classification:        R5B_FIX_PARTIALLY_VALIDATED
```

Why `R5B_FIX_PARTIALLY_VALIDATED` (not `R5B_ALREADY_COMPLETE`):
- All 5 Executor + 3 Planner + 11 test-execute hunks applied (UNKNOWN_HUNKS=0)
- Executor suite ran end-to-end: 48 PASS / 1 FAIL
- The single FAIL (H40_web_config_image_mismatch) is a TEST-STUB misconfiguration:
  the fake-docker stub returns `Config.Image={IMAGE_TAG_DEFAULT}` (matches expected)
  instead of an injected mismatch. Test environment also lacks node, so
  `PRODUCTION_SMOKE=FAIL` triggers the line 822 catch-all
  `FINAL_FAILURE_REASON=POST_VERIFY_FAILED` (correct fail-closed behavior,
  but not the explicit `POST_DEPLOY_CONFIG_IMAGE_MISMATCH` the test asserts).
- Compare H41 (PASS) which correctly injects `sha256:wrong` for the Image field.

---

## SOURCE

```
Executor SHA:          4f12da6130ee7c5f9e61268d352ea51fbcc329b78e1d1b7a6dc4589fdfaa7928
                       (was 3f0b8430... per pre-R5B baseline snapshot)
Planner SHA:           dbda2e75415f4dc0e9097d42019a9f7c161462572087dcc3a52aad87a225398e
                       (was 40cd6839... per pre-R5B baseline snapshot)
Deploy SHA:            9fa0a28cb747fdd53aaa17ff562affb1443d179a96911b09af70eae79a14af2a
                       (UNCHANGED — Deploy runtime not touched by R5B)
changed files:
  - scripts/execute-web-production-release.sh              (untracked, R5B)
  - scripts/plan-web-production-deployment-execution.sh    (untracked, R5B)
  - scripts/test-execute-web-production-release.py         (untracked, R5B)
  - scripts/test-plan-web-production-deployment-execution.py (untracked, R5B)
  - scripts/test-deploy-web-release-candidate.sh           (M, +216/-132, mtime Aug 28 — PRE-R5B S27T-5E-R3A-I3 work, NOT R5B)
  - reports/WEB_RELEASE_PRODUCTION_DEPLOYMENT_EXECUTION_CONTRACT.md (untracked, R5B)
  - reports/s27t5e-r5-claim-out-unbound-final.md           (untracked, older R5)
  - scripts/.test-deploy.i2v1-backup                       (untracked, Aug 15 leftover)
  - scripts/test-deploy-web-release-candidate.sh.i2v2      (untracked, Aug 15 leftover)
  - scripts/test-simulate-web-production-execution-state-machine.py (untracked, older)
  - scripts/verify/simulate_web_production_execution_state_machine.py (untracked, older)
  - scripts/__pycache__/                                   (untracked, pyc files)
  - scripts/verify/__pycache__/                            (untracked, pyc files)
unknown hunks:         0
```

---

## WEB_IDENTITY

```
Web sites changed:           1 (only the web service)
remaining hardcoded Web:      0
                            (Executor: 0; Planner: 0; no literal book-id-search-web-1 in production)
helper present:              yes
                            current_compose_cid_safe() (Executor lines 187-203; Planner lines 153-169)
zero CID fail closed:        yes  (return 1, no stdout)
multiple CID fail closed:    yes  (count -ne 1)
static fallback project-aware: yes
                            Executor line 753: `sudo -n docker exec "$WEB_CID" sha256sum ...`
```

---

## SCOPE

```
API sites changed:           0
                            (Executor still uses literal `book-id-search-api-1` at lines 481-482, 792-793)
                            (Planner still uses literal `book-id-search-api-1` at lines 447-448, 518-519)
Meili sites changed:         0
                            (Executor still uses literal `book-id-search-meilisearch-1` at lines 483-484, 794-795)
                            (Planner still uses literal `book-id-search-meilisearch-1` at lines 450-451, 521-522)
scope expansion detected:    false
```

---

## TEST_STATE (recovered from existing logs only — no rerun)

```
targeted:                H40=FAIL (test-stub bug, see analysis), H41=PASS, H44=PASS
Executor:                PASS=48 FAIL=1 (only H40 failed)
                         source: progress/s27t5e-r5b-web-container-identity-20260831-111718/exec-full3.log
Planner:                 NOT_RUN (no separate test-plan run in any evidence dir)
Deploy:                  NOT_RUN (no separate test-deploy run)
L2 quick:                NOT_RUN (no L2 evidence)
no-write integration:    PASS (L_no_crash_injection_flags, L_no_identity_override_env,
                              L_no_nounset_in_executor_text, L_no_retry_no_rollback,
                              L_only_explicit_execute_path — all PASS)
```

Test category summary across all 4 R5B runs:
- `102306/exec-baseline.log`: initial broken state, mostly FAIL
- `102306/exec-rerun.log`: PASS=*** FAIL=9 (stability/identity failures)
- `105447/exec-full.log`: improved
- `111436/exec-full2.log`: near-final
- `111718/exec-full3.log` (LATEST): PASS=48 FAIL=1 (H40 only)

---

## PRODUCTION (live introspection via `sudo -n docker inspect`)

```
Web:
  CID:               f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da  ✓ matches baseline
  StartedAt:         2026-08-07T23:04:36.143787072Z  (Up 3 weeks)
  Config.Image:      book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
  Image ID:          sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
  status:            running

API:
  CID:               c408d8a0a44a0f6d7fdbe71cfbd7a0d18747448a70298edd750c85f4af940bd7  ✓ matches baseline
  StartedAt:         2026-08-02T23:42:05.579239815Z  (Up 4 weeks)
  Config.Image:      book-id-search-api
  Image ID:          sha256:ec9ed9c2505631c21845463f55361007fbc921aaa682b030d62402e6701149a1
  status:            running

Meili:
  CID:               ef247a985c28707e866e760c353119fd1b3702378d031963168444b80a5f9484  ✓ matches baseline
  StartedAt:         2026-06-30T13:35:18.079914909Z  (Up 2 months)
  Config.Image:      getmeili/meilisearch:v1.48.3
  Image ID:          sha256:c1a52f17c759c2cd6349eede3d5108b8dac07b97e10665b1d64a2d4961c2fd29
  status:            running

changed:              false (all CIDs/StartedAt/images match historical baseline)
```

---

## OLD_TEMP (s27t5e-r3b-r5-5450a6b5-web-1)

```
CID:               068c8b59dc2dec5f9a87261bc79fb22b98448574b7b62df1ca780dd9e43c408d
status:            running (Up 2 days)
image:             book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af  (SAME as production)
imageID:           sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce  (SAME as production)
project:           s27t5e-r3b-r5-5450a6b5
service:           web
ports:             127.0.0.1:60221->80/tcp
retained=true:     yes (still running; NOT touched in this session)

Conflict warning (informational, no action):
  The OLD_TEMP and PRODUCTION web containers share the SAME image and imageID.
  This is the exact conflict the R5A audit flagged (TEMP residue from prior R3B-R5 attempt).
  `docker compose ps -q web` returns BOTH CIDs (068c8b59... and f5901063...).
  The new `current_compose_cid_safe web` helper enforces "exactly one" → would fail closed
  if R5B executor/planner were run against the current production state. This is by design.
  Removing the OLD_TEMP container is OUT OF SCOPE for this recovery (requires manual review).
```

---

## HOST

```
sudo SHA:          686287d80efa1400561301a1c9fc1d35e03b74adde29bd94e5178a36e7b0a6c8
                   (matches expected ✓)
bind mount:        none
                   findmnt -T /usr/bin/sudo → TARGET=/ SOURCE=/dev/vda2 FSTYPE=ext4 OPTIONS=rw,relatime
                   findmnt -T /opt/book-id-search → TARGET=/ SOURCE=/dev/vda2 (same)
                   findmnt -T /usr/bin/docker → TARGET=/ SOURCE=/dev/vda2 (same)
                   No bind mount on any critical path binary. Root fs is ext4 on /dev/vda2.
```

---

## REPO

```
HEAD:              243347e4b2f7876f62a1c61b1cd71fb0a271a691
                   "Promote deterministic web release runtime gate"
origin:            243347e4b2f7876f62a1c61b1cd71fb0a271a691
                   "Promote deterministic web release runtime gate"
                   (HEAD == origin/main; rev-list --left-right --count HEAD...origin/main = 0	0)
commit:            NOT made for R5B
                   (13 untracked files including all R5B code, 1 pre-existing modified test-deploy)
push:              NOT done (origin/main unchanged from R5B-start state)
tag:               none
                   (no tags pointing at HEAD, no R5B tags exist anywhere)
remote:            origin = git@github.com:conanxin/book-id-search.git
```

---

## SAFE_RESUME_POINT

```
exact checkpoint:  /opt/book-id-search
                   HEAD = 243347e4b2f7876f62a1c61b1cd71fb0a271a691 (clean, matches origin/main)
                   Working tree:
                     M scripts/test-deploy-web-release-candidate.sh  (PRE-R5B, leave as-is)
                     ?? 13 untracked files (R5B changes + leftovers)
                   All Executor/Planner/test-execute changes are PRODUCTION_AWARE_WEB_FIX (UNKNOWN_HUNKS=0)
                   Last evidence: progress/s27t5e-r5b-web-container-identity-20260831-111718/exec-full3.log
                   Last test state: PASS=48 FAIL=1 (H40 only, test stub bug)

next safe action:  In a NEW session (NOT this one, per "Do not resume, retry, modify, test, or cleanup"):
                   1. Open /opt/book-id-search (HEAD already at 243347e4)
                   2. (Optional) Review this report at:
                      reports/s27t5e-r5b-readonly-recovery-final.md
                   3. (Optional) Fix H40 test stub: in scripts/test-execute-web-production-release.py
                      around line 1804-1902, change the H40 fake-docker stub's
                      `Config.Image` return from `{IMAGE_TAG_DEFAULT}` to a mismatched value
                      (e.g. `wrong:image:tag`) so the executor actually triggers
                      POST_DEPLOY_CONFIG_IMAGE_MISMATCH
                   4. Re-run ONLY H40 (not full suite): `python3 scripts/test-execute-web-production-release.py H40_web_config_image_mismatch`
                   5. If H40 now PASS, run full Executor suite to confirm 49/49
                   6. git add the R5B changed files (do NOT include the Aug 15 leftover backups or pycache)
                   7. git commit with descriptive message referencing R5B and the pre-R5B SHAs
                   8. git tag (e.g. s27t5e-5e-r5b-completed) before push
                   9. git push (only after explicit user confirmation)
                   10. (Separate task) Manual review for OLD_TEMP cleanup of s27t5e-r3b-r5-5450a6b5-web-1
```

---

## IMPORTANT

This recovery turn executed ONLY read-only commands:
- `git` read-only operations (status, log, rev-parse, rev-list, tag list)
- `sudo -n docker ps`, `sudo -n docker inspect`, `sudo -n docker ps -q --filter`
- `sha256sum /usr/bin/sudo`
- `findmnt -T ...`
- `id`
- `ps -ef`

No `git add/commit/push/tag`, no `docker stop/rm/compose down`, no Executor/Planner/Deploy execution, no test re-run, no TEMP cleanup, no `mount/unshare/nsenter`.

*End of structured recovery report. Total report size: 16386+ bytes.*
