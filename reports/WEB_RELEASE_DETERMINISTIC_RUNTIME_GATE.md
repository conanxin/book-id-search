# Web Release Deterministic Runtime Gate

**Date:** 2026-08-12
**Phase:** S27T-4D-A5 Promote Independent Runtime Verifiers into Versioned Deterministic Release Gate
**Status:** PASS_VERSIONED_RUNTIME_GATE
**HEAD:** `73d56b752a70f7b3e27a6ffbc6f2a07e993377cd` (local commit, not pushed)
**origin/main:** `d8190bed68c456369077c9fcfc8845cf128b5abb` (unchanged)

---

## 1. PURPOSE

Promote the A1/A2/A3 independent Python verifiers (formerly one-off scripts in
`progress/s27t4d-a{1,2,3}-independent-*/`) into a version-controlled,
deterministic L2 release gate that:

- runs from a fresh checkout with zero `progress/` dependency
- uses Python stdlib only (no `grep`/`sed`/`awk` parsers, no `shell=True`, no `bash -c`)
- has no legacy Shell harness dependency
- exposes `quick` (routine) and `certify` (release-blocking) profiles
- emits machine-readable `STATUS=PASS` / `STATUS=BLOCKED` contracts

---

## 2. EVIDENCE MODEL

| Layer | Tool | Role |
|-------|------|------|
| **L1 Contract** | Runtime script CLI contracts (KEY=VALUE) | What the runtime promises |
| **L2 Deterministic Runtime Gate** | `scripts/verify-web-release-runtime-acceptance.py` (+ 3 child verifiers) | **Authoritative oracle** for runtime acceptance |
| **L3 Actual Isolated E2E** | Real Docker / production compose | Reserved for final release sign-off |
| **L4 Application Regression** | Vitest / TSC / search-quality / verify.ts | Reserved for A6 final regression |

Legacy Shell harness (`test-authorize…`, `test-claim…`, `test-orchestrate…`):
**`KNOWN_FLAKY_DIAGNOSTIC`**, **`NON_BLOCKING`**, **`DELETE=false`** per A4 decision.

---

## 3. VERSIONED VERIFIERS

| Verifier | Script | Runtime under test |
|----------|--------|--------------------|
| Authorization | `scripts/verify/verify_authorization_runtime.py` | `scripts/authorize-web-production-release.sh` |
| Claim | `scripts/verify/verify_claim_runtime.py` | `scripts/claim-web-production-release-authorization.sh` |
| Orchestrator | `scripts/verify/verify_orchestrator_runtime.py` | `scripts/orchestrate-web-production-release.sh` |
| Unified Gate | `scripts/verify-web-release-runtime-acceptance.py` | All three above (subprocess) |

Shared helpers (no business logic): `scripts/verify/web_release_runtime_common.py`.

Self-tests: `scripts/test-verify-web-release-runtime-acceptance.py`.

Each verifier:
- resolves repo root from its own file path (`Path(__file__).resolve()`)
- copies the actual runtime bytes (`shutil.copy2`) into a fresh temp git repo
- invokes the runtime directly via `subprocess.run([...], shell=False, ...)`
- parses stdout with `str.partition("=")` (no `grep`/`sed`/`awk`)
- asserts the observable contract on the side-effects (artifact inode/SHA/mode, etc.)

---

## 4. PROFILES

### 4.1 Quick Profile (`--profile quick`)

| Verifier | Test Class | Count |
|----------|-----------|-------|
| Authorization | sequential | 10 |
| Authorization | parallel (4 workers) | 4 |
| Claim | sequential (first claim + replay) | 10 |
| Claim | concurrency (exactly-one-winner) | 10 |
| Claim | parallel (4 workers) | 4 |
| Orchestrator | authorized | 10 |
| Orchestrator | isolated | 5 |
| Orchestrator | missing-auth | 5 |
| Orchestrator | already-claimed | 5 |
| Orchestrator | TOCTOU | 5 |
| Orchestrator | plan-mismatch | 5 |
| Orchestrator | unsupported modes (production/deploy/bogus) | 3 |
| Orchestrator | parallel authorized | 4 |
| Orchestrator | parallel negative (TOCTOU) | 4 |

Use case: development, pre-commit, routine release checks.

### 4.2 Certify Profile (`--profile certify`)

| Verifier | Test Class | Count | A1/A2/A3 baseline |
|----------|-----------|-------|-------------------|
| Authorization | sequential | 100 | 100 ✓ |
| Authorization | parallel | 40 | 40 ✓ |
| Claim | sequential | 100 | 100 ✓ |
| Claim | replay | 100 | 100 ✓ |
| Claim | concurrency | 100 | 100 ✓ |
| Claim | parallel | 40 | 40 ✓ |
| Orchestrator | authorized | 100 | 100 ✓ |
| Orchestrator | isolated | 50 | 50 ✓ |
| Orchestrator | missing-auth | 50 | 50 ✓ |
| Orchestrator | already-claimed | 50 | 50 ✓ |
| Orchestrator | TOCTOU | 50 | 50 ✓ |
| Orchestrator | plan-mismatch | 50 | 50 ✓ |
| Orchestrator | unsupported modes | 15 (5+5+5) | 15 ✓ |
| Orchestrator | parallel authorized | 40 | 40 ✓ |
| Orchestrator | parallel negative | 20 | 20 ✓ |

Total certify iterations: **605** (matches or exceeds A1+A2+A3 = 425).
Use case: pre-release gate, promotion acceptance evidence.

---

## 5. INDEPENDENCE PROOFS

| Property | Audit | Result |
|----------|-------|--------|
| No hardcoded `/opt/book-id-search` | `grep -rn "/opt/"` on all A5 files | 0 matches |
| No hardcoded `73d56b7` | `grep -rn "73d56b7"` on all A5 files | 0 matches |
| No hardcoded `d8190bed` | `grep -rn "d8190bed"` on all A5 files | 0 matches |
| No legacy harness import/source | `grep -rn "test-authorize\|test-claim\|test-orchestrate\|make_harness"` | 0 matches |
| No legacy env-var reliance | `grep -rn "FAKE_PLAN\|FAKE_ORCH"` | 0 matches |
| No progress/ input dependency | `grep -rn "progress/s27t4d-a[123]"` | 0 matches |
| No `grep`/`sed`/`awk` parser | code review | confirmed |
| No `shell=True` | `grep -rn "shell=True"` | 0 matches |
| No `bash -c` | code review | confirmed |

Repo-root resolution: `Path(__file__).resolve().parent.parent.parent`
(from `scripts/verify/<file>.py` → repo root).

---

## 6. CLAIM ATOMICITY CONTRACT

Verified per-iteration in Claim verifier:
- first claim: `STATUS=PASS`, `AUTHORIZATION_CLAIMED=true`
- replay (same claim): `STATUS=BLOCKED`, `BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED`
- concurrent (2 simultaneous claims): exactly 1 winner + 1 loser
- claim artifact: same `st_dev:st_ino` and same SHA256 as authorization artifact
- authorization artifact SHA256 unchanged across all invocations (immutable)
- mode 0o600 preserved

Certify counts: `SEQUENTIAL_PASS=100`, `REPLAY_PASS=100`, `ATOMICITY_PASS=100`,
`DOUBLE_WINNER=0`, `DOUBLE_LOSER=0`, `PARALLEL_PASS=40`.

---

## 7. ORCHESTRATOR FAIL-CLOSED CONTRACT

Verified per-iteration in Orchestrator verifier:

| Negative mode | Expected BLOCK_REASON | Quick | Certify |
|---------------|----------------------|-------|---------|
| Missing authorization | `AUTHORIZATION_MISSING` | 5/5 | 50/50 |
| Already claimed | `AUTHORIZATION_ALREADY_CLAIMED` | 5/5 | 50/50 |
| TOCTOU (pre-deploy image identity changed) | `PRE_DEPLOY_IMAGE_IDENTITY_CHANGED` | 5/5 | 50/50 |
| Authorization/Plan manifest mismatch | `AUTHORIZATION_PLAN_MISMATCH` | 5/5 | 50/50 |
| Unsupported mode (`production`/`deploy`/`bogus`) | `UNSUPPORTED_ORCHESTRATION_MODE` | 3/3 | 15/15 |

Plus:
- `PRODUCTION_DEPLOY_EXECUTED=false` on every BLOCK iteration
- `AUTHORIZATION_CONSUMED=false` on every BLOCK iteration
- `FAIL_CLOSED_CONTRACT=true` on PASS
- Parallel negative (TOCTOU under contention): 4/4 quick, 20/20 certify

---

## 8. UNIFIED GATE MACHINE CONTRACT

### PASS contract
```
STATUS=PASS
PROFILE=<quick|certify>
AUTHORIZATION_VERIFIER=PASS
CLAIM_VERIFIER=PASS
CLAIM_ATOMICITY=PASS
CLAIM_REPLAY_PROTECTION=PASS
ORCHESTRATOR_VERIFIER=PASS
FAIL_CLOSED_CONTRACT=PASS
LEGACY_SHELL_HARNESS_BLOCKING=false
RUNTIME_ACCEPTANCE_READY=true
PRODUCTION_DEPLOY_MODE=NOT_IMPLEMENTED
PRODUCTION_DEPLOY_EXECUTED=false
```

### BLOCK contract (fail-closed)
- `STATUS=BLOCKED` if any child exits non-zero OR reports `STATUS≠PASS`
- `BLOCK_REASON=<AUTHORIZATION|CLAIM|ORCHESTRATOR>_VERIFIER_FAILED`
- `RUNTIME_ACCEPTANCE_READY=false`
- Stable block enums: `INVALID_ARGUMENTS`, `AUTHORIZATION_VERIFIER_FAILED`,
  `CLAIM_VERIFIER_FAILED`, `ORCHESTRATOR_VERIFIER_FAILED`,
  `VERIFIER_OUTPUT_INCOMPLETE`, `VERIFIER_OUTPUT_AMBIGUOUS`

The unified gate deliberately **does NOT** emit
`READY_FOR_PRODUCTION_DEPLOY=true`. Runtime acceptance ≠ production
deployment authorization. Production deploy is governed by a separate
Production Deployment Execution Contract (future A7+).

---

## 9. FRESH-CHECKOUT PORTABILITY

Validated via detached worktree at `73d56b7` with overlay of:
- `scripts/verify/*.py`
- `scripts/verify-web-release-runtime-acceptance.py`
- `scripts/test-verify-web-release-runtime-acceptance.py`

**Not copied:** `progress/` (the source dir for A1/A2/A3 evidence).

Results:
- `progress/`: **absent** in fresh checkout ✓
- `python3 -m py_compile`: **PASS** ✓
- self-test: **10 PASS / 0 FAIL** ✓
- unified quick gate: **STATUS=PASS, RUNTIME_ACCEPTANCE_READY=true** ✓

Worktree registration cleanly removed post-test; `git worktree list` shows
only the original `/opt/book-id-search`.

---

## 10. PRODUCTION BOUNDARY

Across all profiles and iterations:
- `real production deploy`: NO
- `production Compose`: NO
- `production restart`: NO
- `tag`: NO
- `PRODUCTION_DEPLOY_EXECUTED=false` on every iteration
- `PRODUCTION_DEPLOY_MODE=NOT_IMPLEMENTED` on unified gate
- runtime uses narrow fake boundaries only (`ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID`,
  `ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH`, `ORCHESTRATOR_SUDO=/bin/true`,
  `ORCHESTRATOR_DOCKER=/bin/true`, `ORCHESTRATOR_SKIP_PRODUCTION_CHECK=1`,
  `ORCHESTRATOR_SKIP_CLEANUP=1`)

---

## 11. RUNTIME SHA BINDING

Runtime bytes at `73d56b7` and verifier outputs:

| Runtime | SHA256 | A1/A2/A3 evidence |
|---------|--------|-------------------|
| `authorize-web-production-release.sh` | `26483c85eb5b2da2e3c92e19ad13b9fa67781370cf67edc1da83d2698c1745e9` | matches A1 ✓ |
| `claim-web-production-release-authorization.sh` | `d0692bbfc82aa8b641352736752bc4d4cd7666f320447895f966ae5b6815cdb2` | matches A2 ✓ |
| `orchestrate-web-production-release.sh` | `3c5c8c0c37234a9e49a5eb8c98ea03083990520bc213cd336d17d55c61a97c2f` | matches A3 ✓ |
| `plan-web-production-release.sh` | `f5ded1df6ef8cfa11054b8cf2bca4fbe74b54e408c8703ec690ce2575439cc95` | shared helper |
| `deploy-web-release-candidate.sh` | `9fa0a28cb747fdd53aaa17ff562affb1443d179a96911b09af70eae79a14af2a` | shared helper |

Each child verifier emits `RUNTIME_SHA256=<...>` in its result; the
unified gate propagates the child status without re-asserting SHA itself
(its `STATUS=PASS` transitively binds the three child SHAs).

---

## 12. SELF-TEST RESULTS

`python3 scripts/test-verify-web-release-runtime-acceptance.py`:

| # | Test | Result |
|---|------|--------|
| 1 | `test_invalid_profile` | PASS |
| 2 | `test_all_pass` | PASS |
| 3 | `test_auth_fail` | PASS |
| 4 | `test_claim_fail` | PASS |
| 5 | `test_orch_fail` | PASS |
| 6 | `test_missing_status` | PASS |
| 7 | `test_exit_zero_but_blocked` | PASS |
| 8 | `test_acceptance_ready_only_when_all_pass` | PASS |
| 9 | `test_production_deploy_always_false` | PASS |
| 10 | `test_legacy_blocking_always_false` | PASS |

**TOTAL: 10 / FAIL: 0**

Self-tests use controlled fake child executables (env-var injection) and
do **not** run certify workloads.

---

## 13. LEGACY HARNESS DISPOSITION (preserved from A4)

- `scripts/test-authorize-web-production-release.sh` → `KNOWN_FLAKY_DIAGNOSTIC`,
  `BLOCKING_GATE=false`, `DELETE=false`
- `scripts/test-claim-web-production-release-authorization.sh` → same
- `scripts/test-orchestrate-web-production-release.sh` → same

A5 does not touch these. They remain for diagnostic and historical
reference only. They do **not** influence `RUNTIME_ACCEPTANCE_READY`.

---

## 14. EXISTING READINESS GATE BOUNDARY (preserved)

- `scripts/verify-web-release-readiness.sh`: **unmodified** by A5
- Runtime Acceptance Gate (this L2) and Readiness Gate (existing) are
  **independent**. Combination policy is reserved for the future
  Production Deployment Execution Contract.

---

## 15. REPO STATE

```
HEAD:    73d56b752a70f7b3e27a6ffbc6f2a07e993377cd (unchanged)
origin:  d8190bed68c456369077c9fcfc8845cf128b5abb (unchanged)

Untracked (A5 outputs):
  ?? reports/WEB_RELEASE_RUNTIME_ACCEPTANCE_DECISION.md   (A4)
  ?? reports/WEB_RELEASE_DETERMINISTIC_RUNTIME_GATE.md   (A5, this file)
  ?? scripts/verify/                                      (A5 verifiers)
  ?? scripts/verify-web-release-runtime-acceptance.py     (A5 gate)
  ?? scripts/test-verify-web-release-runtime-acceptance.py (A5 self-tests)
  ?? scripts/__pycache__/                                 (transient)
```

73d56b7 commit content: **unchanged**. No `git add`, no `commit`, no
`push`, no `tag`. A6 will reconcile and decide on the local-commit
integration path.

---

## 16. NEXT STEP

**S27T-4D-A6 Final Regression, Documentation Reconciliation, Local Commit
Integration, and Push Decision.**

A6 will:
1. Run full application regression (Vitest, TSC, search-quality, verify.ts)
2. Run current release-pipeline regression (`verify-web-release-readiness.sh`)
3. Reconcile documentation (S27T-4C changelog + A4 + A5 reports)
4. Decide whether to fold 73d56b7 and the A5 additions into one commit,
   two commits, or amend-73d56b7-then-add
5. Decide whether to push to `origin/main` or hold