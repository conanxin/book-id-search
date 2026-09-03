# S27T-5E-R5B-CLOSE — H40 Test-Stub Repair + Project-Aware Web Identity Validation

**Close timestamp:** 2026-08-31 12:49 GMT+8
**Mode:** Targeted test-stub repair (only `scripts/test-execute-web-production-release.py` modified)
**Recovery baseline:** S27T-5E-R5B READ-ONLY STATE RECOVERY (12:32 GMT+8)
**Evidence dir:** `progress/s27t5e-r5b-close-20260831-123300/`

---

## 0. Status

```
状态：PASS
RESULT: ALL TESTS PASSED (50/50)
```

---

## 1. Permissions (constraints observed)

- ✅ ONLY modified `scripts/test-execute-web-production-release.py`
- ✅ NO modifications to Executor / Planner / Deploy / Orchestrator / Claim / Authorize / Release Plan / Readiness / L2 / production compose
- ✅ NO real Docker write, NO production Claim, NO production Deploy, NO commit, NO push, NO tag
- ✅ NO subagent used (direct execution per task constraint)

---

## 2. Preflight (must match recovery state)

| Field | Recovery value | Close value | Match |
|-------|---------------|-------------|-------|
| HEAD | `243347e4b2f7876f62a1c61b1cd71fb0a271a691` | `243347e4b2f7876f62a1c61b1cd71fb0a271a691` | ✓ |
| origin/main | `243347e4b2f7876f62a1c61b1cd71fb0a271a691` | `243347e4b2f7876f62a1c61b1cd71fb0a271a691` | ✓ |
| Executor SHA | `4f12da6130ee7c5f9e61268d352ea51fbcc329b78e1d1b7a6dc4589fdfaa7928` | (unchanged) | ✓ |
| Planner SHA  | `dbda2e75415f4dc0e9097d42019a9f7c161462572087dcc3a52aad87a225398e` | (unchanged) | ✓ |
| Deploy SHA   | `9fa0a28cb747fdd53aaa17ff562affb1443d179a96911b09af70eae79a14af2a` | (unchanged) | ✓ |
| UNKNOWN_HUNKS | 0 | 0 (Executor 5 / Planner 3 / test-execute 12 — all classified expected) | ✓ |

---

## 3. H40 Failure Recovery

**TEST_NAME:** `H40_web_config_image_mismatch`
**expected:** `BLOCK_REASON == "POST_DEPLOY_CONFIG_IMAGE_MISMATCH"`
**actual (before fix):** `POST_VERIFY_FAILED`
**fake docker argv (before fix):** `inspect <TEMP_CID> --format='{{.Config.Image}}'` → `{IMAGE_TAG_DEFAULT}` (MATCH)
**fake docker output (before fix):** `Config.Image` matches plan; static check fails (no `static-manifest.tsv` SHA in fake exec); smoke check fails (no node); catch-all emits `POST_VERIFY_FAILED`

### Proved H40 is test-only (not Runtime CID issue)

The H40 fake docker was structurally correct:
- `compose ps -q web` returned TEMP_CID `f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da` ✓
- The Executor correctly resolved via `current_compose_cid_safe web` → TEMP_CID ✓
- BUT the inspect of TEMP_CID returned MATCHING Config.Image — no mismatch was injected
- Therefore Executor never reached the `emit_block POST_DEPLOY_CONFIG_IMAGE_MISMATCH` early-exit

**Verdict:** `STATUS != BLOCKED_H40_ROOT_CAUSE_NOT_TEST_ONLY`. The H40 fix is purely a test-stub mismatch injection.

---

## 4. Minimal H40 Stub Repair

### Diff summary (H40 fake-docker only)

| Item | Before fix | After fix |
|------|-----------|-----------|
| `inspect TEMP_CID --format={{.Config.Image}}` | returns `{IMAGE_TAG_DEFAULT}` (MATCH) | returns `$MISMATCH_CONFIG_IMAGE` = `registry.example.test/book-id-search/web:WRONG_S27T5ER5B_CLOSE` (MISMATCH) |
| `inspect book-id-search-web-1 --format={{.Config.Image}}` | returns `{IMAGE_TAG_DEFAULT}` (MATCH) | returns `{IMAGE_TAG_DEFAULT}` (kept MATCH — proves test relies on new path) |
| Outer unknown argv (`*) exit 0`) | `exit 0` (fail-open) | `echo ERROR >&2 ; exit 1` (fail-closed) |
| Inner unknown compose subcommand (`*) exit 0`) | `exit 0` (fail-open) | `echo ERROR >&2 ; exit 1` (fail-closed) |

### Contract preserved

- ✅ Mismatch injected via TEMP_CID path (project-aware lookup) — NOT via `book-id-search-web-1` (old global-name)
- ✅ `book-id-search-web-1` Config.Image stays MATCH — so accidental fallback to old path would NOT trigger the expected BLOCK_REASON
- ✅ `exec` only allowed for TEMP_CID (fail-closed otherwise)
- ✅ Unknown argv → fail-closed (no `*) exit 0`)
- ✅ No fallback to real Docker
- ✅ `bash -n` syntax check on H40 fake-docker: rc=0

---

## 5. Run H40 Only

**Command:** `python3 scripts/test-execute-web-production-release.py H40`

**Result:** `PASS H40_web_config_image_mismatch` (rc=0, FAIL=0)

**Captured (via test framework `d.get()`):**
- exact docker argv used: `docker compose ps -q web` → TEMP_CID; `docker inspect TEMP_CID --format='{{.Config.Image}}'` → MISMATCH_CONFIG_IMAGE
- selected CID: `f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da`
- Config.Image observed: `registry.example.test/book-id-search/web:WRONG_S27T5ER5B_CLOSE`
- expected Image: `IMAGE_TAG_DEFAULT = registry.example.test/book-id-search/web:sim` (different from observed ✓)
- terminal BLOCK_REASON: `POST_DEPLOY_CONFIG_IMAGE_MISMATCH` ✓

**Log:** `progress/s27t5e-r5b-close-20260831-123300/h40-only.log`

---

## 6. Re-run H41 / H44 Targeted

**Command:** `python3 scripts/test-execute-web-production-release.py` (full suite, since regex selector over-matches substring; H41 and H44 are included in the 50 tests)

**Results:**
- `PASS H41_web_image_id_mismatch` (image ID mismatch path still works; uses TEMP_CID with `sha256:wrong` for Image field)
- `PASS H44_api_changed` (API identity invariance still works)

**Log:** `progress/s27t5e-r5b-close-20260831-123300/h41_h44.log`

**No regression on:**
- Zero CID fail-closed (`current_compose_cid_safe` returns 1 when CID empty)
- Multiple CID fail-closed (`count -ne 1` guard)
- Project-aware contract (TEMP_CID path used, not `book-id-search-web-1` global name)

---

## 7. Cross-Project Isolation Regression

### Test added: `Z_cross_project_isolation_same_image`

**Strategy:**
1. Build two tmp workspaces (PA, PB) with their own fake-bin/docker.
2. Both fake-bin/dockers answer `docker compose ps -q web` with their project's CID (CID_A = `aaaa...`, CID_B = `bbbb...`).
3. Both projects use the SAME `IMAGE_TAG_DEFAULT` / `IMAGE_ID_DEFAULT`.
4. The fake docker does NOT handle `docker inspect book-id-search-web-1` — fails closed on that path.
5. Run the production helper (extracted inline from Executor lines 187-203) in each project's PATH context and verify the right CID is selected.

**Critical invariant verified:**
- `out_a == CID_A` ✓
- `out_b == CID_B` ✓
- `out_a != out_b` despite same IMAGE_TAG/IMAGE_ID in both projects ✓

```
SAME_IMAGE_CROSS_PROJECT_COLLISION=false
```

**Log:** `progress/s27t5e-r5b-close-20260831-123300/z_cross.log`

---

## 8. Full Test Suite Re-run

**Command:** `python3 scripts/test-execute-web-production-release.py`

**Result:**
```
TOTAL: PASS=50  FAIL=0
RESULT: ALL TESTS PASSED
```

**Compared to recovery state (48 PASS / 1 FAIL):**
- +1: H40 fixed (was FAIL, now PASS)
- +1: Z_cross_project_isolation_same_image (new test added)
- 0 regressions on any other test

**Log:** `progress/s27t5e-r5b-close-20260831-123300/full-suite.log`

---

## 9. Changed Files Summary

```
scripts/test-execute-web-production-release.py    M (only file modified)
  SHA before: 8580ef15b12d55ba850786c12a699fbb6954cedcfc61528e4197415bc6d18b2e
  SHA after:  b4024f1599b6ddbcaeadac54f5134776de50fab90d315a9cfa198127c4b4e3ef
  +863 / -211 lines (12 hunks; all EXPECTED_DIRECT_TEST_CHANGE)

Executor / Planner / Deploy / Orchestrator / Claim / Authorize / Release Plan / Readiness / L2 / production compose
  UNCHANGED
```

---

## 10. Repository State

```
HEAD = origin/main = 243347e4b2f7876f62a1c61b1cd71fb0a271a691  (unchanged)
commit: NOT made (work is uncommitted; awaiting user's commit decision)
push: NOT done
tag: none

working tree:
  M scripts/test-deploy-web-release-candidate.sh          (PRE-R5B, +216/-132, mtime Aug 28)
  ?? scripts/{execute,plan,test-execute,test-plan}-*      (R5B R5x scripts, untracked)
  ?? scripts/__pycache__/, scripts/verify/__pycache__/    (untracked)
  ?? scripts/.test-deploy.i2v1-backup                    (Aug 15 leftover)
  ?? scripts/test-deploy-web-release-candidate.sh.i2v2   (Aug 15 leftover)
  ?? scripts/test-simulate-web-production-execution-state-machine.py (older)
  ?? scripts/verify/simulate_web_production_execution_state_machine.py (older)
  ?? reports/s27t5e-r5-claim-out-unbound-final.md        (older R5)
  ?? reports/s27t5e-r5b-readonly-recovery-final.md       (R5B recovery report)
  ?? reports/WEB_RELEASE_PRODUCTION_DEPLOYMENT_EXECUTION_CONTRACT.md (R5B)
  ?? "356\""                                             (0-byte stray file, not part of R5B work)
```

---

## 11. SAFE_RESUME_POINT for next session

**Exact checkpoint:** `/opt/book-id-search` @ `243347e4...` with `scripts/test-execute-web-production-release.py` updated to SHA `b4024f1599...`. All R5B code changes (Executor/Planner/test-execute) are in working tree. H40 fixed. Cross-project isolation test added. Full suite 50/50 PASS.

**Next safe actions (in a NEW session, after explicit user confirmation):**

1. **Review** this report + `progress/s27t5e-r5b-close-20260831-123300/` evidence.
2. **Decide** whether to remove the stray `356\"` 0-byte file (not part of R5B).
3. **Decide** whether to commit only the R5B changed scripts (Executor/Planner/test-execute + new reports).
4. **git add** (exclude leftovers, pycache, and stray):
   - `scripts/execute-web-production-release.sh` (R5B)
   - `scripts/plan-web-production-deployment-execution.sh` (R5B)
   - `scripts/test-execute-web-production-release.py` (R5B + close)
   - `scripts/test-plan-web-production-deployment-execution.py` (R5B)
   - `reports/s27t5e-r5b-readonly-recovery-final.md` (R5B)
   - `reports/s27t5e-r5b-close-final.md` (R5B-CLOSE)
   - (Optional) `progress/s27t5e-r5b-close-20260831-123300/` (evidence)
5. **git commit** with descriptive message referencing S27T-5E-R5B pre-R5B baseline SHAs (`3f0b8430...` for Executor, `40cd6839...` for Planner).
6. **git tag** (e.g. `s27t5e-5e-r5b-completed`).
7. **git push** ONLY after explicit user confirmation.
8. **Separate task**: manual review for OLD_TEMP cleanup of `s27t5e-r3b-r5-5450a6b5-web-1` (still running, NOT touched).

---

## 12. Evidence Directory

```
progress/s27t5e-r5b-close-20260831-123300/
├── full-suite.log          (50/50 PASS, 13 KB)
├── h40-only.log            (1/1 PASS, 441 B)
├── h40.log                 (1/1 PASS, 441 B, duplicate)
├── h41_h44.log             (full suite, H41/H44 included, 13 KB)
└── z_cross.log             (1/1 PASS, 514 B)
```

---

*End of close report. NO commit/push/tag performed. NO real Docker mutation. NO production Claim/Deploy.*
