# Web Release Deploy Script Isolated E2E

STATUS: PASS

## BACKGROUND

Two independent release-pipeline debts were identified after S27S shipped v0.24.0:

1. **`SUDO_IMAGE_OVERRIDE_PROPAGATION`** — the deploy script set `BOOK_ID_SEARCH_WEB_IMAGE` in the parent shell and then invoked `docker compose` via `sudo`, which caused `sudo`'s default `env_reset` to strip the variable. `docker-compose.yml` then resolved to the dev fallback `book-id-search/web:dev`. (Original incident: S27S-R2.)
2. **`APP_DIR_HARDCODE_TESTABILITY_DEBT`** — the deploy script hardcoded `APP_DIR="/opt/book-id-search"` and `cd "$APP_DIR"`, so even an exact-byte copy of the script into `/tmp` would jump back to the production repo, making a fully isolated end-to-end run impossible.

## S27T-0 RESULT

`SUDO_IMAGE_OVERRIDE_PROPAGATION: CLOSED_WITH_SPLIT_EVIDENCE`

- Patch: deploy script now reconstructs `BOOK_ID_SEARCH_WEB_IMAGE` after the privilege boundary via a `run_compose_with_release_image()` helper using `sudo env "BOOK_ID_SEARCH_WEB_IMAGE=$image" docker compose …`.
- Evidence A (fake harness): actual deploy script control flow — 8/8 PASS.
- Evidence B (real sudo + real docker compose): exact patched privileged invocation against an isolated project — exact Image ID, HTTP/static identity all PASS.

## S27T-1A RESULT

`APP_DIR mode: HARDCODED_ABSOLUTE_PATH → SCRIPT_RELATIVE`

- `SCRIPT_DIR` is derived from `BASH_SOURCE[0]` (`cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd`).
- `APP_DIR` is derived from `cd -- "$SCRIPT_DIR/.." && pwd`.
- Fail-closed guard: if the resolved root does not contain `docker-compose.yml`, the script exits with code 6.
- No external override introduced (no `APP_DIR_OVERRIDE`, `BOOK_ID_SEARCH_APP_DIR`, `TEST_ROOT`, etc.).
- Production default behavior unchanged: when the script lives at `/opt/book-id-search/scripts/deploy-web-release-candidate.sh`, `APP_DIR` resolves to `/opt/book-id-search`.
- Exact-byte relocation, caller-cwd independence, and path-with-spaces all PASS via 6 new tests added to the existing `scripts/test-deploy-web-release-candidate.sh` (15/15 total).

## ACTUAL_E2E_RESULT

`ACTUAL_DEPLOY_SCRIPT_ISOLATED_E2E: PASS`

This phase closes the gap by running the **actual deploy script** (not a driver) end-to-end under real sudo + real docker compose against an isolated project.

| Check | Result |
|-------|--------|
| Exact-byte script SHA match | `9fa0a28cb747fdd53aaa17ff562affb1443d179a96911b09af70eae79a14af2a` (original = relocated) |
| Resolved root | `/tmp/s27t1b-20260808-093845-1280491` |
| Production root touched | NO (script never cd'd to `/opt/book-id-search`) |
| Caller cwd at invoke | `/` (proves caller cwd independence) |
| Real sudo | YES (`sudo 1.9.9`, default `env_reset`) |
| Real docker compose | YES (real daemon, real project `s27t1b-20260808-093845`) |
| Outer `sudo env` workaround | NO — caller contract was `BOOK_ID_SEARCH_WEB_IMAGE=… bash <script>` only |
| Frozen image tag | `book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af` |
| Expected Image ID | `sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce` |
| Actual Image ID | `sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce` ✅ |
| Config.Image | `book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af` ✅ (no dev fallback) |
| compose project label | `s27t1b-20260808-093845` (≠ `book-id-search`) ✅ |
| HTTP `/` | 200 |
| HTTP `/weread` | 200 |
| Live JS SHA-256 | `68d787c4d20d93231d1d0e6bcf464c037bb537792b12e2c3f643b04ab148ffdc` ✅ |
| Live CSS SHA-256 | `7eee398f57a3e406e1746df9f97e1c3d141a52184e7e3f14cff18fb6a8f3f69d` ✅ |
| Isolated network | `s27t1b-20260808-093845_default` (isolated, NOT production `book-id-search_default`) |
| Cleanup | containers=0, network=0, port 15178 released, frozen image kept, tmp dir removed |

## PRODUCTION_BOUNDARY

Production identity before vs. after the isolated actual-script E2E:

| Component | Before | After | Match |
|-----------|--------|-------|-------|
| Web CID | `f5901063b956…` | `f5901063b956…` | ✅ |
| Web Image | `sha256:712ad4abc…` | `sha256:712ad4abc…` | ✅ |
| Web Config.Image | `book-id-search-web:1ab120c4…` | `book-id-search-web:1ab120c4…` | ✅ |
| Web StartedAt | `2026-08-07T23:04:36Z` | `2026-08-07T23:04:36Z` | ✅ |
| API CID | `c408d8a0a44a…` | `c408d8a0a44a…` | ✅ |
| Meilisearch CID | `ef247a985c28…` | `ef247a985c28…` | ✅ |

No production restart, no production build, no production deploy.

## REGRESSION

| Check | Result |
|-------|--------|
| Deploy-script regression (fake harness, 15 tests) | 15/15 PASS (8 image-override + 6 path-resolution + 1 negative guard) |
| `bash -n` deploy script | OK |
| `bash -n` test script | OK |
| `vitest run` | 88 files / 3244 tests PASS / 32.30s |
| `tsc -p apps/web/tsconfig.json --noEmit` | exit 0 |
| `verify.ts` | status PASS, `numberOfDocuments: 5,115,734` |
| `search-quality-regression.ts` | 17 PASS / 0 WARN / 0 FAIL |

## CLOSED DEBTS

```
SUDO_IMAGE_OVERRIDE_PROPAGATION:        CLOSED
APP_DIR_HARDCODE_TESTABILITY_DEBT:       CLOSED
ACTUAL_DEPLOY_SCRIPT_ISOLATED_E2E_GAP:   CLOSED
```

## REMAINING LIMITATIONS

- The isolated compose project used `extra_hosts: api:127.0.0.1` so that nginx's `proxy_pass http://api:3001` could resolve `api` without spinning up a real API service. This means **nginx would fail to proxy `/api/*` traffic** if a client hit it; but this isolated environment does NOT exercise `/api/*` paths and is verified at static-asset level only. Production routing is unchanged.
- The fail-closed root validation requires `docker-compose.yml` at the resolved root. If someone moves the script into a non-repo directory tree, the script will exit 6. This is the intended behavior.

## EVIDENCE

- `progress/s27t1a-before-20260808-090630/` — pre-patch baseline
- `progress/s27t1a-after-20260808-091454/` — post-patch regression (15/15)
- `progress/s27t1b-isolated-e2e-20260808-093817/` — actual-script isolated E2E
  - `actual-deploy-script-e2e.log`, `actual-deploy-script-e2e.exit` — actual script run output
  - `isolated-container-inspect.txt`, `identity-verification.txt` — exact image / project assertions
  - `http-static-smoke.log` — isolated HTTP + JS/CSS SHA checks
  - `exact-byte-identity.txt` — relocated script SHA = original SHA
  - `production-before/`, `production-after/` — production untouched
  - `regression-run.log`, `vitest-run.log`, `tsc-run.log`, `verify-run.log`, `search-quality-run.log`

NEXT_STEP: S27T-1 RELEASE DEPLOY SCRIPT TESTABILITY HARDENING COMPLETE