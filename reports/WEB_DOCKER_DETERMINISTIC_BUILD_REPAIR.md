# Web Docker Deterministic Build Repair Report

S27P-4A — Deterministic Web Build and Artifact Provenance Repair

## STATUS

PASS

The web Docker build is now deterministic: two consecutive `--no-cache` builds from the same source produced identical static-asset manifests, the lockfile was not modified, and the new build/deploy scripts enforce build-once/deploy-same-image provenance.

## ROOT_CAUSE

- **build context:** `docker-compose.yml` already uses `context: .` (repo root). No compose context change was required.
- **lockfile missing from build context:** `apps/web/Dockerfile` only copied `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, and `apps/web/package.json`. It did not copy `pnpm-lock.yaml`.
- **floating install:** `RUN pnpm install --frozen-lockfile=false` caused pnpm to re-resolve dependencies from `package.json` semver ranges on every build.
- **pnpm version not pinned in image:** `RUN corepack enable` let pnpm resolve to whatever version corepack chose at build time.
- **historical impact:** Each Docker build could produce a different static bundle, so the deployed Docker artifact and the host Vite build never had a guaranteed identity relationship.

## BUILD_CONTEXT_RESULT

- `docker-compose.yml` web service `context:` was already `.` (repo root). Verified with `sudo docker compose config`.
- `apps/web/Dockerfile` now copies `pnpm-lock.yaml` as part of the dependency layer.
- Working tree remained clean except for the intended files (`apps/web/Dockerfile`, `docker-compose.yml`, new scripts, new docs, and this report).
- `apps/api`, `package.json`, `pnpm-lock.yaml`, and `apps/web/src` were not modified.

## TOOLCHAIN_RESULT

- Host Node: `v22.22.1`
- Host pnpm: unable to determine because corepack tried to fetch `pnpm@10.33.0` through a dead proxy; the `packageManager` field is the authoritative source.
- `packageManager`: `pnpm@10.33.0` (already present in `package.json`)
- Dockerfile pnpm pin: `RUN corepack enable && corepack prepare pnpm@10.33.0 --activate`
- lockfile hash before/after: `fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134` (unchanged)
- pnpm-lock.yaml `lockfileVersion: '9.0'`

## FROZEN_INSTALL_RESULT

- Dockerfile install command: `RUN pnpm install --frozen-lockfile`
- Build A exit: `0`
- Build B exit: `0`
- Candidate script build exit: `0`
- lockfile unchanged: `yes`
- `pnpm install --frozen-lockfile` succeeded: `yes`

## REPRODUCIBILITY_RESULT

- Image A manifest: 4 files
- Image B manifest: 4 files
- Manifest diff exit: `0`
- Image A manifest SHA-256: `b51c4c26bad970efed676ec7d6da6f12d10fb70e82f709ac7352fc7d12f50bb0`
- Image B manifest SHA-256: `b51c4c26bad970efed676ec7d6da6f12d10fb70e82f709ac7352fc7d12f50bb0`
- Candidate script manifest SHA-256: `b51c4c26bad970efed676ec7d6da6f12d10fb70e82f709ac7352fc7d12f50bb0`
- Static files in manifest:
  - `50x.html`
  - `assets/index-CoQPhCit.css`
  - `assets/index-DUh-n4Eh.js`
  - `index.html`
- Host Vite build role: recorded as source-code regression evidence only; its manifest uses different chunk hashes and is **not** the release gate.
- Note: the first `--no-cache` attempt failed because Docker metadata resolution for `nginx:1.27-alpine` returned `401 Unauthorized` from the configured mirror. After `sudo docker pull nginx:1.27-alpine` succeeded and the image was available locally, the deterministic build passed. This is a transient registry/mirror issue, not a build determinism issue.

## ARTIFACT_PROVENANCE

- Candidate image tag pattern: `book-id-search-web:<full-40-char-git-sha>`
- Candidate image tag produced: `book-id-search-web:7990cce367e6ce137a5d38711085c30e4470e34d`
- Candidate image ID: `sha256:e36d67458feb0d8536fc1975974922898322f52ce75ac2b8987401969dc2960c`
- Static manifest SHA-256: `b51c4c26bad970efed676ec7d6da6f12d10fb70e82f709ac7352fc7d12f50bb0`
- Lockfile SHA-256: `fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134`
- Provenance output: `progress/web-release-candidate-7990cce367e6ce137a5d38711085c30e4470e34d/candidate.json`
- Deploy-same-image rule: `docker-compose.yml` web service now uses `image: ${BOOK_ID_SEARCH_WEB_IMAGE:-book-id-search/web:dev}` while keeping the `build:` block for local development.
- Revised R6 (release gate): candidate image ID must equal the running container image ID; static manifest must be verified against the candidate record; deploy command must not rebuild.
- New scripts:
  - `scripts/build-web-release-candidate.sh` — builds once, records provenance, does not deploy.
  - `scripts/deploy-web-release-candidate.sh` — deploys an existing image, verifies image ID equality, does not touch `api`/`meilisearch`, and never runs a build.

## REGRESSION_RESULT

- `vitest run`: `2236 passed` / `2236 total` (72 test files)
- `tsc -p apps/web/tsconfig.json --noEmit`: PASS (no errors)
- `scripts/verify.ts`: status `PASS`, `numberOfDocuments: 5115734`, 6 checks
- `scripts/search-quality-regression.ts`: `17 PASS / 0 WARN / 0 FAIL`
- API/Meilisearch uptime: unchanged; no API or Meilisearch service was restarted.

## PRODUCT_BOUNDARY

The following were **not** modified:

- `apps/web/src` (product UI and algorithm code)
- `apps/api` (no rebuild or restart)
- `package.json` dependencies or devDependencies
- `pnpm-lock.yaml` content (hash unchanged)
- `README` stable version
- No `v0.21.1` tag was created
- No production deployment of the new web image was performed

The following were modified or added:

- `apps/web/Dockerfile` — added `pnpm-lock.yaml` COPY, pinned pnpm, and used `--frozen-lockfile`
- `docker-compose.yml` — added `image:` to the web service for build-once/deploy-same-image
- `scripts/build-web-release-candidate.sh` — new
- `scripts/deploy-web-release-candidate.sh` — new
- `docs/WEB_RELEASE_ARTIFACT_PROVENANCE.md` — new
- `reports/WEB_DOCKER_DETERMINISTIC_BUILD_REPAIR.md` — this report

## NEXT_STEP

S27P-4B — Reading Evolution Timeline Release Closeout.
