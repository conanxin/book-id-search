# S27T-4C — Recommendations

**Date:** 2026-08-10 22:30 CST

## A. Ship Decision

**Recommend: ship S27T-4C as v0.25.0-web-release-atomic-claim** after explicit user confirmation.

### Why ship now:
1. **Core tests are stable:** plan (29/29) + authorize (30/30) deterministic, claim has 1/5 flake rate
2. **Orchestrator with my Test 62 fix:** 4/5 runs = 63/63 PASS, 1/5 runs = 62/63 (different flake each time)
3. **System tests pass:** Full vitest 88/3244, TSC clean, verify.ts PASS, search quality 7/7
4. **No production risk:** All changes are offline script changes; production untouched
5. **Clean scope:** 6 files total (2 modified + 4 new), all in `scripts/`

### Why not block on flakiness:
1. Flakiness is **environmental** (residual /tmp state), not code bugs
2. With clean /tmp, the same scripts achieve 165+/165+ consistently
3. The flakiness affects different tests in different runs (no single root cause)
4. Fixing flakiness is a separate concern from shipping the feature

## B. Test Flakiness Resolution Plan

### Short term (commit today):
1. Wrap test runner with `/tmp/s27t*` cleanup
2. Document flakiness in test README

### Medium term (next phase):
1. Investigate `make_harness` paths — likely need to namespace test directories per file
2. Add timing instrumentation to identify slow tests
3. Consider parallel-safe test fixtures

### Long term:
1. Move test fixtures to non-/tmp filesystem (e.g., XDG_RUNTIME_DIR or pytest tmp_path equivalent)
2. Use unique harness prefixes per test file (not just per test)

## C. Architecture Observations

### What's solid in S27T-4C:
1. **Hard-link atomic claim:** `ln --` without `-f` gives true atomic no-overwrite semantics. Robust against concurrent claim attempts.
2. **Verification chain:** fingerprint recompute → identity match → consumed check → claim check → identity binding — all gated.
3. **Backward compatibility:** legacy `isolated-e2e` mode unchanged; only adds `authorized-isolated-e2e` mode.
4. **Fail-closed everywhere:** No silent successes; every block reason is explicit.

### What could be hardened:
1. **Hash-based claim uniqueness:** If two operators race, the second's `ln --` fails. Consider adding per-claim nonce for clearer audit trail.
2. **Claim audit log:** Currently the claim artifact itself is the audit. Adding a `progress/s27t4c-claim-audit.log` would help forensics.
3. **Authorize re-issuance:** Once authorized, no way to revoke. Consider adding a revoke path (out of scope for S27T-4C).

## D. Operational Recommendations

### For future S27T-4D (production deploy):
1. **Manual docker access required:** Local sandbox shells may not have docker socket. The orchestrator's actual deploy path needs `sudo` access to docker.
2. **Operator handoff:** Once authorized + claimed, the deployment needs human trigger. Consider adding a "deploy-due" alert.
3. **Tag management:** v0.25.0 should be created AT commit time, not after (per S27P-4B build-once rule).

### For monitoring:
1. Track `progress/s27t4c-claim-*` artifacts: presence + age = audit signal
2. Track unauthorized deploy attempts: any BLOCK_REASON starting with `AUTHORIZATION_*` should page ops

## E. Decision Required

Please confirm one of:

| Option | Action | Time |
|--------|--------|------|
| **A. Ship now** | Commit 6 files, create v0.25.0 tag, update README | ~5 min |
| **B. Stabilize first** | Investigate flakiness, re-run 10x, commit only if 0 flakes | ~30 min |
| **C. Split commits** | Separate "Test 62 fix" from "feature" commits | ~10 min |
| **D. Defer** | Save current work, address later | 0 min |

**Default suggestion: A**, with `/tmp` cleanup wrapper committed alongside.