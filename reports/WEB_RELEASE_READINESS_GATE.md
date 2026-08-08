# Web Release Readiness Gate

STATUS: PASS

## PURPOSE

Unified machine-checked gate that answers: **is this candidate ready to be deployed to production?**

The gate is **read-and-test only**. It never builds, never deploys to production, never restarts production, never creates tags, never mutates the repository. Only `READY_FOR_PRODUCTION_DEPLOY=true` indicates that a candidate may enter the next stage (real production deploy via `scripts/deploy-web-release-candidate.sh`).

## INPUT

```
scripts/verify-web-release-readiness.sh <SOURCE_SHA>
```

`SOURCE_SHA` is a 40-character hex Git commit that uniquely identifies the candidate build. The gate validates every layer against this single SHA — there is no way to bypass or skip a mandatory identity check.

## VERIFIED IDENTITIES

| Check | Source of truth | Hard-fail |
|-------|-----------------|-----------|
| Candidate source SHA | `git cat-file -e ${SOURCE_SHA}^{commit}` + `progress/web-release-candidate-${SOURCE_SHA}/candidate.json:gitSha` | `INVALID_SOURCE_SHA` / `CANDIDATE_EVIDENCE_MISSING` / `CANDIDATE_SOURCE_MISMATCH` |
| Image ID | `docker image inspect ${TAG}` `.Id` vs `candidate.json:imageId` | `CANDIDATE_IMAGE_MISSING` / `CANDIDATE_IMAGE_IDENTITY` |
| Static manifest | re-extract `/usr/share/nginx/html` from image, hash with the **same algorithm as `scripts/build-web-release-candidate.sh`**, then `sha256sum` | `CANDIDATE_MANIFEST_IDENTITY` |
| Lockfile identity | `git show ${SOURCE_SHA}:pnpm-lock.yaml` SHA-256 vs `candidate.json:lockfileSha256` | `CANDIDATE_LOCKFILE_IDENTITY` |

## DEPLOY SAFETY

| Check | What it proves | Hard-fail |
|-------|----------------|-----------|
| Deploy-script regression | `scripts/test-deploy-web-release-candidate.sh` (self-contained fake harness) covers sudo/no-sudo propagation, exact identity, no-build, no-pull, missing-candidate fail-closed, no-dev-fallback, plus 6 path-resolution tests (production-layout root, exact-byte relocation, caller-cwd independence, path-with-spaces, missing-compose fail-closed). 15/15 PASS required. | `DEPLOY_REGRESSION_FAILED` |
| Actual-script isolated E2E | Real sudo + real docker compose against an isolated project at `/tmp/s27t…`. Container `Image`, `Config.Image`, `compose.project` labels must equal the frozen candidate triple. **Production `book-id-search_default` network is never joined.** | `ISOLATION_GUARD` / `ISOLATED_E2E_FAILED` |
| Production identity snapshot | Production Web/API/Meili container ID + StartedAt read before and after; byte-equal required. | `PRODUCTION_TOUCHED` |
| Worktree snapshot | `git status --porcelain` SHA before vs after; byte-equal required. | `WORKTREE_CHANGED` |

## READY CONTRACT (hard invariant)

```
READY_FOR_PRODUCTION_DEPLOY = true
  iff
    STATUS = PASS
    AND ISOLATED_E2E = PASS
    AND DEPLOY_REGRESSION = PASS
    AND PRODUCTION_UNCHANGED = PASS
    AND WORKTREE_UNCHANGED = PASS
```

Fail-closed rules:

- `RUN_REAL_ISOLATED_E2E=0`         → `BLOCKED ISOLATED_E2E_REQUIRED` (READY=false)
- `FAKE_BIN_DIR=...` set            → `BLOCKED ISOLATED_E2E_REQUIRED` (READY=false)
- Any mandatory gate skipped/failed → `BLOCKED <enum>` (READY=false, non-zero exit)

A defensive `[ "$ISOLATED_E2E_RESULT" = "PASS" ] || block ISOLATED_E2E_REQUIRED` guard at the very end enforces this invariant regardless of any earlier control flow.

## BLOCK OUTPUT CONTRACT

```
STATUS=BLOCKED
BLOCK_REASON=<enum>
READY_FOR_PRODUCTION_DEPLOY=false
```

Non-zero exit. Enums (in priority order):

- `INVALID_SOURCE_SHA`
- `CANDIDATE_EVIDENCE_MISSING`
- `CANDIDATE_EVIDENCE_INCOMPLETE`
- `CANDIDATE_SOURCE_MISMATCH`
- `CANDIDATE_IMAGE_MISSING`
- `CANDIDATE_IMAGE_IDENTITY`
- `CANDIDATE_MANIFEST_IDENTITY`
- `CANDIDATE_LOCKFILE_IDENTITY`
- `DEPLOY_REGRESSION_FAILED`
- `ISOLATED_E2E_REQUIRED`
- `ISOLATED_E2E_FAILED`
- `PRODUCTION_TOUCHED`
- `WORKTREE_CHANGED`

## PORTABILITY (S27T-2B)

- **`scripts/test-deploy-web-release-candidate.sh`** no longer reads from `progress/s27t0a-before-fix-*/fake-bin`. It self-creates `fake-bin/sudo` and `fake-bin/docker` at runtime inside `$RUN_TMP`, runs the deploy script under controlled `PATH`, and removes the tmp dir via `trap … EXIT INT TERM`. **Fresh checkout, no historical evidence needed.**
- **`scripts/verify-web-release-readiness.sh`** removed `s27t0a-before-fix-*` auto-discovery. The deploy regression is now self-contained.
- **`scripts/test-verify-web-release-readiness.sh`** self-creates its own fake-bin per run; no historical fixture required.

`HISTORICAL_PROGRESS_FIXTURE_REQUIRED: false`

## VALIDATION (this run)

| Check | Result |
|-------|--------|
| Deploy-script regression | 15/15 PASS |
| Readiness Level-1 tests | 12/12 PASS |
| Real frozen candidate (1ab120c4…) | `STATUS=PASS`, `READY=true` |
| Vitest | 88 files / 3244 tests PASS / 31.81s |
| TSC | exit 0 |
| verify | status PASS, docs=5,115,734 |
| search-quality | 17 PASS / 0 WARN / 0 FAIL |

Production identity before vs after:

| Component | Before | After |
|-----------|--------|-------|
| Web CID | `f5901063b956…` | `f5901063b956…` ✅ |
| Web Image | `sha256:712ad4abc…` | `sha256:712ad4abc…` ✅ |
| Web Config.Image | `book-id-search-web:1ab120c4…` | `book-id-search-web:1ab120c4…` ✅ |
| Web StartedAt | `2026-08-07T23:04:36Z` | `2026-08-07T23:04:36Z` ✅ |
| API | `c408d8a0a44a…` (startedAt 2026-08-02T23:42:05Z) | identical ✅ |
| Meilisearch | `ef247a985c28…` (startedAt 2026-06-30T13:35:18Z) | identical ✅ |

No build, no deploy, no tag, no production restart.

## USAGE

Future standard release flow:

1. `scripts/build-web-release-candidate.sh` (frozen candidate + evidence)
2. **`scripts/verify-web-release-readiness.sh <SOURCE_SHA>`** — must show `READY=true`
3. Operator reviews the `READY_FOR_PRODUCTION_DEPLOY=true` line
4. `scripts/deploy-web-release-candidate.sh <image-tag>` (no `--build`, no env workaround)
5. Post-deploy artifact identity verification (separate concern, S27S-R2 / S27T-1B territory)

The gate does not automatically deploy. It validates readiness. A `READY=true` line is a precondition for the operator to proceed with the deploy step.

## EVIDENCE

- `progress/s27t2b-final-20260808-110046/` — production-before/after snapshots, vitest/tsc/verify/search-quality logs, gate output.
- The gate is deterministic: same `SOURCE_SHA` + same environment → same `STATUS` / `READY`.

NEXT_STEP: S27T-2 UNIFIED WEB RELEASE READINESS GATE COMPLETE