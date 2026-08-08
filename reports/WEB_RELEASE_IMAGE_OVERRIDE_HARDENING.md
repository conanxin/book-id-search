# Web Release Image Override Hardening

STATUS: PASS

## INCIDENT

`RELEASE_PIPELINE_ENV_PROPAGATION_INCIDENT` (originally observed in S27S-R2)

`BOOK_ID_SEARCH_WEB_IMAGE` was set in the parent shell of the deploy script, but the deploy script invoked `docker compose` via `sudo`. Sudo's default `env_reset` strips the inherited `BOOK_ID_SEARCH_WEB_IMAGE`. The `docker-compose.yml` then resolved `${BOOK_ID_SEARCH_WEB_IMAGE:-book-id-search/web:dev}` to the **dev fallback**, briefly starting the production `web` service from a stale local development image (`sha256:591f7951ae58`) instead of the S27S frozen release candidate (`sha256:712ad4abc…`).

`PRODUCT_DEFECT: false` — this was a release-pipeline defect only; the production product itself was correct.

## ROOT_CAUSE

Original (pre-patch) form:

```bash
BOOK_ID_SEARCH_WEB_IMAGE="$IMAGE_TAG" $DOCKER_SUDO docker compose up -d --no-deps --no-build web
```

When `DOCKER_SUDO="sudo"`, `BOOK_ID_SEARCH_WEB_IMAGE` is established in the parent shell, but `sudo` defaults to `env_reset` and strips it. The subsequent `docker compose` invocation sees only the compose-level default `book-id-search/web:dev` and uses that image.

## PATCH

The deploy script now reconstructs the image override **after** the privilege boundary using a small helper `run_compose_with_release_image()`:

```bash
run_compose_with_release_image() {
  local image="$1"
  if [ -n "$DOCKER_SUDO" ]; then
    "$DOCKER_SUDO" env "BOOK_ID_SEARCH_WEB_IMAGE=$image" docker compose up -d --no-deps --no-build web
  else
    env "BOOK_ID_SEARCH_WEB_IMAGE=$image" docker compose up -d --no-deps --no-build web
  fi
}
run_compose_with_release_image "$IMAGE_TAG"
```

- `sudo path`: `sudo env "BOOK_ID_SEARCH_WEB_IMAGE=$image" docker compose up -d --no-deps --no-build web` — the inline `env BOOK_ID_SEARCH_WEB_IMAGE=…` is executed *by sudo*, not *before* it, so sudo's env_reset has no effect on this assignment.
- `no-sudo path`: `env "BOOK_ID_SEARCH_WEB_IMAGE=$image" docker compose …` — `env` is a no-op wrapper that still establishes the variable for the immediate `docker compose` invocation. This keeps the no-sudo path's behavior consistent.
- Parameter safety: image is passed via ordinary parameter quoting (`local image="$1"`); no `eval`, no `bash -c` string interpolation.

`CALLER_WORKAROUND_REQUIRED: false` — operators no longer need to wrap invocations in `sudo env BOOK_ID_SEARCH_WEB_IMAGE=…`. The script itself reconstructs the required env after the privilege boundary.

> Correct description: **script reconstructs required env after privilege boundary**.
> Do NOT describe this as: *sudo preserves env* — that is not what happens.

## EVIDENCE_MODEL

Two independent evidence layers jointly close the S27T-0 debt.

### Evidence A — actual deploy-script control flow (S27T-0A)

- Actual patched `scripts/deploy-web-release-candidate.sh`
- Fake `sudo` (env_reset simulated)
- Fake `docker` (records argv + env)
- 8 test cases covering sudo/no-sudo paths, exact-image identity, no-build, no-pull, fail-closed on missing candidate, no-dev-fallback

`ACTUAL_DEPLOY_SCRIPT_ISOLATED_E2E: NOT_EXECUTED` (see Limitations). Evidence A proves the **script's control flow**.

### Evidence B — real privileged compose invocation (S27T-0B-R1)

- Real `sudo` (version 1.9.9, default `env_reset`)
- Real `docker compose` (real daemon, real project)
- Isolated compose project at `/tmp/s27t0b-real-sudo-…` with unique name `s27t0b-20260808-082731`
- Frozen S27S image: `book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af` (`sha256:712ad4abc…`)
- Driver invokes the **exact** privileged form used by the deploy script's helper

Evidence B proves the **privilege-boundary behavior** of the patched form. Combined with Evidence A, the two layers jointly close `SUDO_IMAGE_OVERRIDE_PROPAGATION`.

## REAL_SUDO_RESULT

- `sudo -V`: `Sudo version 1.9.9` (default `env_reset`)
- Probe 1 — inherited `TEST_VAR` after `sudo env`: `<unset>` (env_reset strips)
- Probe 2 — explicit `env TEST_VAR=…` after `sudo env`: `s27t0b-explicit` (env-establishes correctly)
- Real isolated deployment: exit 0
- Isolated container `.Config.Image`: `book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af` ✅
- Isolated container `.Image`: `sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce` ✅
- Dev fallback `book-id-search/web:dev` observed: **false**
- Caller `sudo env` workaround used: **false**
- HTTP smoke on `127.0.0.1:15177`:
  - `/` → 200
  - `/weread` → 200
  - `/assets/index-6SXb39Bm.js` → 200, SHA `68d787c4d20d93231d1d0e6bcf464c037bb537792b12e2c3f643b04ab148ffdc` ✅ (matches R1 frozen manifest)
  - `/assets/index-DYqm4R_E.css` → 200, SHA `7eee398f57a3e406e1746df9f97e1c3d141a52184e7e3f14cff18fb6a8f3f69d` ✅ (matches R1 frozen manifest)
- Cleanup via `sudo docker compose -p s27t0b-20260808-082731 -f … down --remove-orphans`:
  - isolated containers: 0
  - isolated networks: 0
  - port 15177: released
  - tmp dir removed
  - frozen image **kept** (no image delete)

## REGRESSION

### S27T-0A shell regression (re-run under R16)

```
PASS: TEST1_sudo_envreset_image_override_visible_to_compose
PASS: TEST2_nosudo_image_override_visible_to_compose
PASS: TEST3_exact_identity_registry_pathtag_preserved
PASS: TEST4_no_build_flag_in_compose
PASS: TEST4_no_docker_build_direct
PASS: TEST5_no_pull_in_compose
PASS: TEST6_missing_candidate_fails_closed (exit=4)
PASS: NEG_no_dev_fallback_observed

TOTAL: PASS=8  FAIL=0
RESULT: REGRESSION PASSED
```

- `bash -n scripts/deploy-web-release-candidate.sh`: OK
- `bash -n scripts/test-deploy-web-release-candidate.sh`: OK
- `shellcheck`: not installed (per task instruction to skip if absent)

### Full app regression (R17)

- `vitest run`: 88 files / 3244 tests passed / 32.07s
- `tsc -p apps/web/tsconfig.json --noEmit`: exit 0

### verify + search quality (R18)

- `MEILI_HOST=http://127.0.0.1:7700 tsx scripts/verify.ts`: status PASS, `numberOfDocuments: 5,115,734`
- `search-quality-regression.ts`: 17 PASS / 0 WARN / 0 FAIL

## PRODUCTION_BOUNDARY

Production identity before vs. after isolated test:

| Component | Before | After | Match |
|-----------|--------|-------|-------|
| Web CID | `f5901063b956…` | `f5901063b956…` | ✅ |
| Web Image | `sha256:712ad4abc…` | `sha256:712ad4abc…` | ✅ |
| Web StartedAt | `2026-08-07T23:04:36Z` | `2026-08-07T23:04:36Z` | ✅ |
| API CID | `c408d8a0a44a…` | `c408d8a0a44a…` | ✅ |
| API StartedAt | `2026-08-02T23:42:05Z` | `2026-08-02T23:42:05Z` | ✅ |
| Meilisearch CID | `ef247a985c28…` | `ef247a985c28…` | ✅ |
| Meilisearch StartedAt | `2026-06-30T13:35:18Z` | `2026-06-30T13:35:18Z` | ✅ |

Production was **not touched** by the isolated test:
- no production deploy
- no production build
- no production restart
- production Image ID unchanged
- API/Meilisearch untouched

## DEBT_STATUS

- `SUDO_IMAGE_OVERRIDE_PROPAGATION: CLOSED_WITH_SPLIT_EVIDENCE` (not `FULL_DEPLOY_SCRIPT_ISOLATED_E2E_COMPLETE`)

FOLLOW_UP:
- S27T-1A closed `APP_DIR_HARDCODE_TESTABILITY_DEBT` (deploy script now derives APP_DIR from `BASH_SOURCE[0]`)
- S27T-1B closed `ACTUAL_DEPLOY_SCRIPT_ISOLATED_E2E_GAP` (actual deploy script run end-to-end under real sudo + real docker compose + isolated project; exact frozen image ID + JS/CSS SHA matched)

FINAL_STATUS: CLOSED
- The deploy script's hardcoded `APP_DIR="/opt/book-id-search"; cd "$APP_DIR"` is a **separate** low-priority **testability** debt (it prevents an isolated end-to-end run of the actual deploy script). This is documented here for transparency but is NOT mixed with the env-propagation debt.

## KNOWN_LIMITATIONS

- `ACTUAL_DEPLOY_SCRIPT_ISOLATED_E2E: NOT_EXECUTED` — the actual `scripts/deploy-web-release-candidate.sh` was not run end-to-end against an isolated compose project, because the script hardcodes `APP_DIR=/opt/book-id-search` and `cd "$APP_DIR"`, which would resolve to the production compose file. Evidence A (fake-harness regression of the actual script) + Evidence B (real sudo + real compose on the exact patched form) jointly cover the gap.
- The deploy script's `APP_DIR` hardcode remains. Suggested follow-up: introduce an `APP_DIR_OVERRIDE` (or `COMPOSE_FILE` override) so the script can be tested in isolation in a future release. **Out of scope for S27T-0**; recorded as testability debt.

## EVIDENCE_INDEX

- `progress/s27t0a-before-fix-20260808-075113/` — fake harness pre-fix
- `progress/s27t0a-after-fix-20260808-081238/` — fake harness post-fix
- `progress/s27t0b-real-sudo-20260808-082701/` — real sudo + real compose isolated run

NEXT_STEP: S27T-0 RELEASE PIPELINE IMAGE OVERRIDE HARDENING COMPLETE