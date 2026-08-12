# Web Release Runtime Acceptance Decision

**Date:** 2026-08-11
**Phase:** S27T-4D-A4 Independent Runtime Acceptance Decision and Legacy Shell Harness Disposition
**Status:** PASS_ACCEPTANCE_DECISION
**HEAD:** 73d56b7 (local commit, not pushed)
**origin/main:** d8190bed (unchanged)

---

## 1. CONTEXT

The legacy Shell test harness (`scripts/test-{authorize,claim,orchestrate}-web-production-release*.sh`)
exhibited non-deterministic flakes under S27T-4C investigation.

Rounds R1–R2G tested multiple hypotheses:
- R1: per-suite RUN_ROOT, per-test HARNESS_ROOT, cleanup ownership validation → **BLOCKED_FLAKE_REMAINS**
- R2: command-substitution capture hypothesis → **rejected** (no improvement)
- R2B: UNSAFE_SHARED_TMP elimination → **rejected** (flake persisted)
- R2C: shell-state forensics → **BLOCKED_ROOT_CAUSE_UNKNOWN**
- R2D: cross-test predecessor bisection → **inconclusive**
- R2F: pipefail + grep -q hypothesis → **falsified**
- R2G: process-per-test isolation prototype → **flakes persist** (12/20 authorize, 8/20 claim)

Ruled-out causes:
- target command substitution capture
- shared /tmp path collisions
- FAKE_PLAN_* leakage
- ordinary exported/non-exported global leakage
- shell option drift
- trap drift
- pwd drift
- background job leak
- FD divergence
- filesystem ENOSPC/EIO
- pipefail + grep -q
- shared-shell-only contamination
- process-per-test isolation

The legacy Shell harness is no longer a reliable runtime oracle.

---

## 2. INVESTIGATION SUMMARY

| Round | Hypothesis | Verdict |
|-------|-----------|---------|
| R1 | per-suite/per-test isolation hardening | Insufficient |
| R2 | command-substitution capture pattern | Rejected |
| R2B | shared /tmp path isolation | Rejected |
| R2C | shell-state forensics (env, globals, traps, jobs) | Inconclusive |
| R2D | cross-test predecessor bisection | Inconclusive |
| R2F | pipefail + grep -q handling | Falsified |
| R2G | process-per-test isolation | Rejected |

Result: shell harness flake root cause is **undetermined** by R1-R2G methods. The
harness was therefore replaced with independent Python verifiers (A1-A3) that
isolate each runtime from any shared shell state.

---

## 3. INDEPENDENT EVIDENCE

All three runtimes have been probed independently of the shell harness using
Python stdlib subprocess calls with exact-byte runtime copies in fresh temp
Git repos. No FAKE_* hooks, no shared state, no grep/sed/awk parsers.

### 3.1 Authorization Runtime (S27T-4D-A1)

| Gate | Result |
|------|--------|
| Sequential 100 | 100/100 PASS |
| Parallel 40 | 40/40 PASS |

Contract verified per iteration:
- `rc=0`
- 12 mandatory machine-output keys present exactly once
- authorization artifact exists, regular file, mode 0o600
- fingerprint matches across Plan / runtime stdout / artifact
- `PRODUCTION_DEPLOY_EXECUTED=false`

Evidence: `progress/s27t4d-a1-independent-verifier-20260811-205841/S27T-4D-A1-EVIDENCE.md`

### 3.2 Claim Runtime (S27T-4D-A2)

| Gate | Result |
|------|--------|
| Sequential 100 (first claim + replay) | 100/100 PASS |
| Concurrent atomicity 100 (2 simultaneous each) | 100/100 PASS |
| Parallel independent 40 | 40/40 PASS |

Contract verified per iteration:
- First claim `rc=0`, 13 success keys present, claim artifact regular + mode 0o600
- Hard-link atomicity: same dev:inode between auth and claim (100/100)
- Byte identity: auth SHA == claim SHA (100/100)
- Replay BLOCK with `AUTHORIZATION_ALREADY_CLAIMED` (100/100)
- Concurrent: exactly 1 winner + 1 loser (100/100)
- Authorization byte unchanged after claim and replay (100/100)
- `nlink` on authorization = 2 (hard-linked to claim) (100/100)

Evidence: `progress/s27t4d-a2-independent-claim-20260811-215402/S27T-4D-A2-EVIDENCE.md`

### 3.3 Orchestrator Runtime (S27T-4D-A3)

| Gate | Result |
|------|--------|
| Authorized sequential 100 | 100/100 PASS |
| Isolated-e2e legacy 50 | 50/50 PASS |
| Missing auth negative 50 | 50/50 BLOCK(AUTHORIZATION_MISSING) |
| Already-claimed negative 50 | 50/50 BLOCK(AUTHORIZATION_ALREADY_CLAIMED) |
| TOCTOU image negative 50 | 50/50 BLOCK(PRE_DEPLOY_IMAGE_IDENTITY_CHANGED) |
| Auth-plan mismatch negative 50 | 50/50 BLOCK(AUTHORIZATION_PLAN_MISMATCH) |
| Production-mode 5 | 5/5 BLOCK(UNSUPPORTED_ORCHESTRATION_MODE) |
| Deploy-mode 5 | 5/5 BLOCK(UNSUPPORTED_ORCHESTRATION_MODE) |
| Unsupported-mode 5 | 5/5 BLOCK(UNSUPPORTED_ORCHESTRATION_MODE) |
| Parallel authorized 40 | 40/40 PASS |
| Parallel TOCTOU negative 20 | 20/20 PASS |

**Total: 425 PASS / 0 FAIL**

All BLOCK paths verified: `deploy_count=0`, `PRODUCTION_DEPLOY_EXECUTED=false`, `AUTHORIZATION_CONSUMED=false`.

Evidence: `progress/s27t4d-a3-independent-orchestrator-20260811-220704/S27T-4D-A3-EVIDENCE.md`

---

## 4. VERIFIER INDEPENDENCE AUDIT

Code inspection of all three Python verifiers confirms:

| Criterion | A1 | A2 | A3 |
|-----------|----|----|----|
| References legacy test scripts | 0 | 0 | 0 |
| Sources `test-*.sh` | 0 | 0 | 0 |
| Reuses `make_harness`/`make_fake_plan`/`assert_*`/`clear_test_env` | 0 | 0 | 0 |
| Uses `grep`/`sed`/`awk` pipeline | 0 | 0 | 0 |
| Uses `bash -c`/`shell=True` | 0 | 0 | 0 |
| Uses Python `subprocess` with exact-byte runtime copy | YES | YES | YES |
| Python `str.partition("="")` parser | YES | YES | YES |

`FAKE_*` references in code are documentation comments and environment
sanitization (stripping fake hooks from inherited env), not fake
infrastructure setup.

Verifiers are **truly independent** of the legacy shell harness.

---

## 5. RUNTIME BYTE BINDING

| Runtime | Evidence SHA | Current Working-Tree SHA | Match |
|---------|--------------|--------------------------|-------|
| `authorize-web-production-release.sh` | `26483c85eb5b2da2e3c92e19ad13b9fa67781370cf67edc1da83d2698c1745e9` | `26483c85eb5b2da2e3c92e19ad13b9fa67781370cf67edc1da83d2698c1745e9` | ✅ |
| `claim-web-production-release-authorization.sh` | `d0692bbfc82aa8b641352736752bc4d4cd7666f320447895f966ae5b6815cdb2` | `d0692bbfc82aa8b641352736752bc4d4cd7666f320447895f966ae5b6815cdb2` | ✅ |
| `orchestrate-web-production-release.sh` | `3c5c8c0c37234a9e49a5eb8c98ea03083990520bc213cd336d17d55c61a97c2f` | `3c5c8c0c37234a9e49a5eb8c98ea03083990520bc213cd336d17d55c61a97c2f` | ✅ |
| `plan-web-production-release.sh` | `f5ded1df6ef8cfa11054b8cf2bca4fbe74b54e408c8703ec690ce2575439cc95` | `f5ded1df6ef8cfa11054b8cf2bca4fbe74b54e408c8703ec690ce2575439cc95` | ✅ |

All runtime bytes are **identical** between A1-A3 evidence and current
73d56b7 working tree. Evidence is valid for this commit.

---

## 6. REAL INTEGRATION EVIDENCE

Complementary to the independent runtime determinism probes, the following
integration evidence (established prior to this acceptance phase) remains
valid and is not contradicted:

- `reports/WEB_RELEASE_PLAN_ORCHESTRATOR.md` — Plan contract
- `reports/WEB_RELEASE_DEPLOY_SCRIPT_ISOLATED_E2E.md` — real sudo + real
  Docker Compose + isolated project + frozen image E2E
- `reports/WEB_RELEASE_READINESS_GATE.md` — readiness gate contract

The integration evidence layer addresses actual Docker/deploy execution,
not runtime determinism. The two evidence classes are complementary.

---

## 7. EVIDENCE LAYER MODEL

| Layer | Scope | Authority |
|-------|-------|-----------|
| L1 | Static / Contract Validation | syntax, machine-output schema, identity rules |
| L2 | Independent Runtime Determinism | A1/A2/A3 Python verifiers |
| L3 | Actual Isolated Integration E2E | real sudo + real Docker Compose + exact deploy + frozen image |
| L4 | Application Regression | Vitest, TSC, verify, search-quality |

The legacy Shell harness is reclassified as:
**`DIAGNOSTIC_LEGACY_HARNESS`** — NOT in any of L1-L4 above. Useful for
development diagnostics, regression clues, manual forensic, and future
rewrite reference, but **not authoritative** for runtime acceptance.

---

## 8. ACCEPTANCE DECISION

Based on the evidence above:

| Component | Decision | Basis |
|-----------|----------|-------|
| **Authorization Runtime** | **ACCEPT** | A1: 100/100 sequential, 40/40 parallel |
| **Claim Runtime** | **ACCEPT** | A2: 100/100 sequential + replay |
| **Claim Atomicity** | **ACCEPT** | A2: 100/100 exactly-one-winner |
| **Orchestrator Runtime** | **ACCEPT** | A3: 100/100 authorized, 50/50 isolated |
| **Fail-Closed Contract** | **ACCEPT** | A3: 250/250 negative cases BLOCK with correct reason |

**All five components ACCEPTED** based on independent Python verifier
evidence (L2 layer).

---

## 9. LEGACY HARNESS DISPOSITION

| Property | Value |
|----------|-------|
| Classification | `KNOWN_FLAKY_DIAGNOSTIC` |
| Blocking Gate | **NO** |
| Deleted | **NO** |
| Kept for | development diagnostics, regression clues, manual forensic, future rewrite reference |

The legacy harness still contains useful test logic (it just has a
non-deterministic runner/observer). It must NOT be deleted.

---

## 10. LEGACY FAILURE ESCALATION RULE

Legacy Shell harness failure, by itself, does **NOT** block runtime
acceptance.

A legacy failure becomes a `BLOCKING_RUNTIME_DEFECT` only when **at least
one** of the following independently reproduces the failure:

A. **Independent runtime verifier** reproduces the same runtime contract
   failure on the same bytes (L2 reproducer).

B. **Actual isolated E2E** reproduces the same failure (L3 reproducer).

C. **Raw runtime artifact/output** independently violates the machine
   contract (e.g., mandatory key missing, mode != 600, fingerprint
   mismatch).

If legacy FAIL + Independent verifier PASS + Actual isolated evidence
no failure, the classification is `LEGACY_HARNESS_DIAGNOSTIC_WARNING`.

---

## 11. LEGACY PASS RULE (BIDIRECTIONAL)

Legacy Shell harness PASS, by itself, does **NOT** prove runtime
acceptance either. The "non-blocking" status is bidirectional.

A legacy PASS does not override L1/L2/L3 failures. It only corroborates
when those layers also pass.

---

## 12. LEGACY REFERENCE AUDIT

Searched the repo for callers of the legacy test scripts:

```
scripts/test-authorize-web-production-release.sh
scripts/test-claim-web-production-release-authorization.sh
scripts/test-orchestrate-web-production-release.sh
```

**Caller references** (excluding the scripts themselves and progress/):

| Caller | Reference | Blocking? | Action |
|--------|-----------|-----------|--------|
| `reports/S27T-4C-COMMIT-CHANGELOG.md` | historical | NO | none |
| `reports/S27T-4C-EVIDENCE.md` | historical | NO | none |
| `reports/WEB_RELEASE_PLAN_ORCHESTRATOR.md` | historical | NO | none |

No CI scripts, no `package.json` scripts, no release gate callers, no
readiness gate callers reference the flaky shell harness.

`scripts/verify-web-release-readiness.sh` does **NOT** depend on the
flaky suites — it uses real sudo + real Docker Compose isolated E2E
(checked: 0 references).

**CURRENT_READINESS_GATE_NOT_CONTAMINATED = true**

---

## 13. LOCAL COMMIT ACCEPTANCE

73d56b7 classification:

| Category | Files | Status |
|----------|-------|--------|
| RUNTIME | authorize (NEW), claim (NEW), orchestrate (M) | ACCEPTED as runtime baseline |
| LEGACY_TEST | test-authorize (NEW), test-claim (NEW), test-orchestrate (M) | DIAGNOSTIC_LEGACY_HARNESS, kept for forensic |
| REPORT | S27T-4C-COMMIT-CHANGELOG, S27T-4C-EVIDENCE, S27T-4C-RECOMMENDATIONS | historical |
| PRODUCT | none | none |

Product source change count:
- `apps/web/src`: 0
- `apps/api`: 0
- `package.json`: 0
- `pnpm-lock.yaml`: 0
- `Dockerfile`: 0
- `docker-compose.yml`: 0

**ACCEPTED_RUNTIME_BASELINE_PENDING_VERIFIER_PROMOTION**

Push authorization: **NO** (this acceptance decision is the basis for a
future promotion phase, not for immediate push).

---

## 14. PRODUCTION BOUNDARY

| Property | Value |
|----------|-------|
| `PRODUCTION_DEPLOY_MODE` | **NOT_IMPLEMENTED** |
| `PRODUCTION_DEPLOY_EXECUTED` | **false** (unconditional, even on success paths) |
| Production capability | **rejected** (any non-`isolated-e2e`/`authorized-isolated-e2e` mode → `UNSUPPORTED_ORCHESTRATION_MODE`) |
| Production touched | **NO** during this acceptance |

The S27T-4 series establishes authorization, claim, and authorized
isolated orchestration. It does **not** implement real production write
capability.

---

## 15. STABLE TAG

`v0.24.0-weread-guided-repair-navigation` — **unchanged**.

No new tag created. **No `v0.25.0` tag** because production deployment
execution contract is not yet implemented.

---

## 16. NEXT STEP

**S27T-4D-A5 Promote Independent Runtime Verifiers into Versioned
Deterministic Release Gate.**

This is the implementation phase that:
- Migrates A1/A2/A3 verifiers from `progress/` to version-controlled
  scripts under `scripts/verify/`
- Establishes the deterministic runtime acceptance gate as the
  authoritative L2 source of truth
- Supersedes the legacy shell harness as a blocking gate
- Is the prerequisite for any future `v0.25.0` tag

---

## 17. REPO BOUNDARY

- HEAD before/after: `73d56b7` (unchanged)
- origin/main: `d8190bed` (unchanged)
- New tracked files: only this document (`reports/WEB_RELEASE_RUNTIME_ACCEPTANCE_DECISION.md`)
- No runtime modifications
- No test modifications
- No application modifications
- No commit performed during A4 audit
- No push performed during A4 audit