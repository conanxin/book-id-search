# S27T-5E-R5 Executor CLAIM_OUT Unbound-variable Root-cause & Minimal Runtime Repair

## Current Formal Status
- current_phase: S27T-5E
- current_status: BLOCKED_EXECUTOR_RUNTIME_CLAIM_OUT_UNBOUND → REPAIRED (pending validation in fresh temp repo)
- confirmed_failure: yes
- exact production Executor runtime error: `CLAIM_OUT: unbound variable`
- failure occurred: AFTER real Planner generated Execution Plan + TEMP Authorization existed; BEFORE Claim / Start / Deploy / Result
- Production: UNCHANGED
- Host: SAFE

## Old TEMP_REPO Disposition
- Path: `/tmp/s27t5e-r3b-r4-root-Pi4JvG/s27t5e-r3b-r4-one1fgc5nhc9`
- Classification: ABANDONED_FAILURE_EVIDENCE / READ_ONLY / DO_NOT_RESUME
- Execution Plan: STALE_VALIDATION_EVIDENCE
- Authorization: STALE_TEST_AUTHORIZATION / UNCLAIMED
- Not modified, not resumed, not deleted.

## Preflight
- HEAD = origin/main = `243347e4b2f7876f62a1c61b1cd71fb0a271a691` ✅
- Planner SHA = `40cd68391f4bbf568529210e1e8dae082f4f07bf0edba95042435b9e03e02d15` ✅
- Executor pre-fix SHA = `e78d36133be5749d9de4b35334a99829e271345befc7b1709a617a6f1c99e377` ✅
- No git reset / checkout / stash / clean performed.

## Evidence Root
- Evidence dir: `progress/s27t5e-r5-claim-out-unbound-20260828-212259`
- `source-before/` copies Executor, Executor test, Planner, Claim, Deploy, Simulator, test scripts with SHA256 recorded.
- `failure-contract.txt` reconstructs exact failure from R3B-R4 evidence.
- `claim-out-control-flow.tsv` maps every CLAIM_OUT assignment/read/trap reference.

## Exact Failure Evidence Recovered
- Executor stdout: `STATUS=BLOCKED`, `BLOCK_REASON=PLANNER_FAILED`
- Executor stderr: `...execute-web-production-release.sh: line 1: CLAIM_OUT: unbound variable`
- Executor exit code: 1
- Last machine-output line: `AUTO_ROLLBACK=false`
- Execution Plan artifact: present (CLAIM_EXECUTED=false)
- Authorization artifact: present (PRODUCTION_DEPLOY_AUTHORIZED=true, PRODUCTION_DEPLOY_EXECUTED=false)
- Claim artifact: ABSENT
- Start/Result artifacts: ABSENT

## CLAIM_OUT Control Flow
| line | operation |
|------|-----------|
| 63 | `set -uo pipefail` (nounset enabled) |
| 262 | `trap '... $CLAIM_OUT ...' EXIT INT TERM` — FIRST syntactic read, defined BEFORE assignment |
| 504 | `CLAIM_OUT="$(mktemp)"` — actual assignment |
| 507 | `>"$CLAIM_OUT"` — first use as Claim stdout redirect |
| 511 | `CLAIM_TEXT="$(cat "$CLAIM_OUT")"` — read Claim output |

## First Invalid Read Classification
- **A — variable CLAIM_OUT was never initialized before the trap attempted to read it.**
- The trap at line 262 references `$CLAIM_OUT` while `set -u` is active, but `CLAIM_OUT` is not assigned until line 504.
- When an early failure triggers `emit_block` + `exit 1` before line 504, the EXIT trap fires and expands the unset variable, producing the observed `unbound variable` shell error.

## Why Claim Was Not Invoked
1. Claim invocation is at line 507, gated by Planner returning `STATUS=READY_TO_CLAIM` (line 500-504).
2. The real Planner in the failed temp repo returned `STATUS=BLOCKED`, `BLOCK_REASON=EXECUTION_PLAN_ALREADY_EXISTS` (R3B-R4 `planner-stdout.txt`).
3. Executor therefore exited via `emit_block PLANNER_FAILED` at line ~240, **before** reaching line 507.
4. The EXIT trap then crashed on unset `CLAIM_OUT`, masking the real Planner failure.
5. No Claim command process was ever started; hence no Claim artifact exists.
- This is case 1 (trap reads CLAIM_OUT before Claim is called) **and** case 3 (Claim command never exec'd); the primary root cause is A.

## Minimal Runtime Repair
- Changed Executor EXIT trap line 262 from direct expansion to default expansion:
  ```bash
  trap 'rm -f "${PLANNER_OUT:-}" "${PLANNER_ERR:-}" "${CLAIM_OUT:-}" "${CLAIM_ERR:-}" "${DEPLOY_OUT:-}" "${DEPLOY_ERR:-}" 2>/dev/null' EXIT INT TERM
  ```
- This prevents `set -u` from aborting cleanup when temp file variables are still unset, allowing early failures to emit clean `STATUS=BLOCKED` output.
- Files modified (allowed):
  - `scripts/execute-web-production-release.sh`
  - `scripts/test-execute-web-production-release.py` (added regression test B07b)
- Files NOT modified: Planner, Claim, Deploy, Orchestrator, Authorize, Release Plan, Readiness/L2, product source.

## Post-Fix Verification
- Bash syntax check: `bash -n scripts/execute-web-production-release.sh` → OK
- Executor post-fix SHA: `e92ac05b3ccde8922941b0d63c8137721910faf3d629f12ccd70fde40ba6eba0`
- Test harness: `python3 scripts/test-execute-web-production-release.py` → **TOTAL: PASS=38 FAIL=0**
- New regression test `B07b_planner_failure_no_unbound_variable_in_stderr` passes.

## Post-Fix Git State
- HEAD = origin/main = `243347e4...` ✅
- `scripts/test-deploy-web-release-candidate.sh` remains modified (I3 diff preserved, not touched)
- No commits, pushes, tags, resets, checkouts, stashes, or cleans performed.

## Safe Resume Point
- Do NOT resume the abandoned `/tmp/s27t5e-r3b-r4-root-Pi4JvG` temp repo.
- The runtime defect is repaired; the next R5/R6 validation should create a **NEW TEMP_REPO** and run the Executor end-to-end against simulated production.
