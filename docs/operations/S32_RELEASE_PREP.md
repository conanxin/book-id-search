# S32 release preparation

Task: `S32_RELEASE_PREP_CODEX_R1`. [Release PR #10](https://github.com/conanxin/book-id-search/pull/10). Baseline: `630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d`.
Scope: API packaging and deployment template only. No production execution, registry publication, merge, M1-B, or M0 SQL changes.

## Build and verify away from production

The API Dockerfile copies `pnpm-lock.yaml` before `pnpm install --frozen-lockfile`;
Corepack uses the existing `packageManager=pnpm@10.33.0`. Root tooling and API
dependencies are installed from the committed lockfile. Existing Node 22 Alpine
and runtime layout are retained. This locks dependency resolution, not every
base-image byte; record the resolved base digest for each build.

Build from a clean committed source archive, never the production checkout:

```bash
source_commit=$(git rev-parse HEAD)
image="book-id-search-api:s32-${source_commit}"
git archive "$source_commit" | docker build -f apps/api/Dockerfile \
  --build-arg "SOURCE_COMMIT=$source_commit" -t "$image" -
python3 scripts/check-s32-release-image.py "$image" "$source_commit"
python3 scripts/check-s32-release-compose.py
docker image inspect "$image" --format '{{.Id}} {{.Size}} {{json .RepoDigests}}'
```

Use a local Docker daemon or a build/test-only CI runner. The image check creates
only disposable containers with `--network none`, no mounts and no host ports;
checks locked dependency availability, the embedded lock hash, a deliberately
outdated manifest rejection, default-disabled S32 (404), authentication (401), and
missing-DB fail-safe (503); removes its test containers. It is not a live Meili or
real-PG integration test. API build runs TypeScript checking. Relevant existing
S32 non-PG and search unit tests can run inside the same image.

The Compose check accepts `--compose /path/to/docker-compose` for a standalone
binary and `--baseline /path/to/sanitized-effective-compose.json` for the observed
four-layer production configuration. It only renders configuration with dummy
credentials. Default fixtures model those four layers; validation compares the
entire Web/Meili configuration and exact API mounts/loopback port before/after,
checks persistent internal-only PG, cleared API build, and required-input errors.

## Fifth-layer template (not applied)

Append `deploy/s32-production.override.yml` after the existing ordered files:

1. `/opt/book-id-search/docker-compose.yml`
2. `/opt/book-id-search/docker-compose.override.yml`
3. `/opt/book-id-search-runtime/s31/3add9a60a20364fbd32b64a7d54197b75983d26e/api-production.override.yml`
4. `/opt/book-id-search-runtime/s32/99a3702c64e5ae389800348dc7310f23eaed4a66/web-production.override.yml`
5. The proposed S32 override (no production destination created this task).

Inputs for a later authorized application: `S32_API_IMAGE` (verified local tag or
image ID); `S32_POSTGRES_IMAGE` (already-acquired PG16 digest); `S32_POSTGRES_DB`,
`S32_POSTGRES_USER`, `S32_POSTGRES_PASSWORD`; optional `S32_PG_DATA_DIR` (default
`/data/book-id-search/postgres_data`). This bind must already exist; Compose does
not create it. PG has no published host port, has `pg_isready` health checking,
and uses the existing default network shared with API. No migration is mounted or
run automatically. Schema installation is a later authorized deployment action.

Both new service image selections use `pull_policy: never`. Supply/acquire the
approved image separately; this template cannot silently pull a different image.
API `build: !reset null` removes the old checkout build definition. The original
three API mounts and `127.0.0.1:3001` are inherited. Web/Meili have no new stanza.
API's existing Meili dependency is retained and a healthy-PG dependency added.
S32 stays off by default with blank URL/token. Later authorized enablement requires
`S32_DATABASE_URL` pointing to service `postgres` (URI-encode credentials),
`S32_PRIVATE_API_TOKEN`, and an initialized schema; no production values belong in Git.

Use a Compose implementation supporting `!reset`; the production host reports
v5.2.0, used for local render validation. See [Docker merge rules](https://docs.docker.com/reference/compose-file/merge/).
After separate deployment authorization, use the full chain with service-targeted
operations and building disabled; never global `up --build` or `down`. Existing
Web retains its static API upstream, so a conditional Nginx configuration check
and graceful reload after an API IP change belongs in that future authorization.

## Space accounting and evidence

Final measured evidence and test identifiers are recorded below.
Do not infer a registry `RepoDigest` from the image ID or a local archive checksum.
No registry publication is part of this task.

Budget the compressed transferred archive C, uncompressed saved tar T and image
size U separately. A conservative acquisition peak is C + T + U: assumes a retained
compressed archive, a full temporary expanded tar and full unshared image layers.
Streaming loading or shared layers may reduce the actual increment; neither is
credited before measurement on the target host. Docker image size is logical
layer bytes, not a measurement of the target filesystem's physical usage.

Add an estimated 128 MiB for initial PG data (including initial WAL), 1 GiB for
additional WAL/data growth, 150 MiB for API+PG rotated logs, and 128 MiB for transient
metadata. These are planning allowances, not enforced PG size/WAL caps or long-term
growth forecasts. The PG image already exists on production; no duplicate pull is
budgeted. Do not subtract the old API image or presume a cleanup credit.

Compare the peak with freshly observed free space while retaining the existing
20 GiB reserve and 21 GiB preferred headroom (project policies, not PostgreSQL
minimum requirements). A deficit is a capacity decision for later review, not
permission to clean, expand or lower the reserve. No new broad disk audit is needed.


## 2026-09-19 local verification receipt

`task_id=S32_RELEASE_PREP_CODEX_R1`; `tested_commit=ce65f1a9bf105ca08b439595ffc3800f9efedbc8`.
This is also the image source SHA: Docker received `git archive` of this commit.
All eight changed files matched the committed bytes before testing. Subsequent
report/status-only edits do not change the built source, Docker recipe, template
or verification scripts. No production build or registry publication occurred.

| Check | Actual result |
| --- | --- |
| Frozen install + API TypeScript build | Exit 0; pnpm 10.33.0, lockfile up-to-date, resolution skipped |
| Release image smoke | PASS; manifest drift rejected; dependencies and lock hash verified; 404 default-off, 401 unauthenticated, 503 missing DB |
| Test container cleanup | PASS; temporary containers removed |
| S32 non-PG + search tests | Exit 0; 11 files, 166 tests passed (42 S32, 124 search) |
| Compose v5.2.0, four-layer fixture | Exit 0; preservation/isolation/default-off/missing-input checks PASS |
| Compose v5.2.0, sanitized live four-layer baseline | Exit 0; same assertions PASS; render only |
| Commit-content comparison / git diff --check | PASS |
| M0 migration + two SQL files / apps/web / lockfile | No changes versus source baseline |

Unit command in the built image:

```bash
docker run --rm --network none --pull never "$image" pnpm exec vitest run   apps/api/src/s32 apps/api/src/search --exclude '**/*.integration.test.ts'
```

No real PG/Meili integration, full-repository test suite or production health suite
was run this round. The previously merged M0/M1-A implementation is preserved.

| Artifact | Measured value |
| --- | --- |
| Tag | `book-id-search-api:s32-ce65f1a9bf105ca08b439595ffc3800f9efedbc8` |
| Image ID | `sha256:265e810e7fb120db01076171242b19d7c069548b9e51e67b8f001432573f0319` |
| Platform | linux/amd64 |
| Logical image layer bytes U | 247,862,411 B (236.3800 MiB) |
| Saved tar bytes T | 256,659,456 B (244.7695 MiB) |
| Compressed archive bytes C | 80,387,312 B (76.6633 MiB) |
| Archive SHA-256 | `2bd55d724e22d5bc3d520e40948ca899439b1675c8a85be58ffa2e3fd39b4f58` |
| RepoDigests | `[]` (not published; no registry digest) |
| Base image resolved digest | `node@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85` |
| Embedded lockfile SHA-256 | `069d66c619c71b46ee396eb153be7e6ec242f6798ec821897228f7443f4b8c17` |

The local image and `logs/s32-release-prep/api-image.tar.gz` remain available on the
development machine. Build/smoke/unit/Compose logs, sanitized host observations and
`release-evidence.json` are in that ignored directory; they are not published images.
The archive checksum above identifies the retained archive; a future re-export can
have a different tar checksum even for the same image ID.

### Fresh capacity observation and budget

Observed by `ssh tencent` at **2026-09-19 13:22:59 UTC**:
`ubuntu@VM-0-4-ubuntu`, checkout `9a18b2aa86c7cb1b27f6e99f9f5911e80b7b61ec`;
API `3add9a60…`, Web `99a3702c…`, Meili `v1.48.3` still running with September 13,
September 13 and September 1 start timestamps respectively. Root free
**21,784,965,120 B (20.2888 GiB)**, used **79%**.
The current excess above the 20 GiB policy reserve is only
310,128,640 B; the whole disk still has 20.2888 GiB free.

Existing production PG image observation: ID and RepoDigest reported by Docker
`sha256:3c5c8892d184f738f4fe282d14ddaa613a38f00f4189d2d94725ebe6f2909ddb`,
size 116,084,812 B. Reuse reference
`postgres@sha256:3c5c8892d184f738f4fe282d14ddaa613a38f00f4189d2d94725ebe6f2909ddb`
requires no additional PG image download/storage. This reference was observed, not
newly published or pulled by this task on production.

| Increment | Bytes | Evidence class |
| --- | ---: | --- |
| C + T + U acquisition | 584,909,179 | Inputs measured locally; simultaneous target-host occupancy estimated |
| PG initialization incl. initial WAL | 134,217,728 | Estimated 128 MiB |
| Further PG WAL/data allowance | 1,073,741,824 | Estimated 1 GiB, not a cap |
| API + PG logs | 157,286,400 | Estimated 150 MiB; conservatively budgets both sets of rotated logs |
| Transient metadata | 134,217,728 | Estimated 128 MiB |
| **Peak total** | **2,084,372,859** | **Estimated 1.9412 GiB** |
| Steady increment, retaining gzip, excluding T/transient | 1,693,495,675 | Estimated 1.5772 GiB |

Estimated free at peak: **19,700,592,261 B / 18.3476 GiB**
(about 81% used, also above the existing 80% policy ceiling).
Shortfall to retaining 20 GiB: **1,774,244,219 B / 1.6524 GiB**;
to retaining the preferred 21 GiB: **2,847,986,043 B / 2.6524 GiB**.
These are conservative incremental estimates, not observed production consumption.
No credit is taken for shared layers, streamed extraction, deleting the old image,
or removing an archive. No capacity policy was changed.

`RELEASE_PREPARATION=READY_FOR_REVIEW`; `PRODUCTION_EXECUTION=HOLD_CAPACITY_AND_AUTHORIZATION`.
`IMPLEMENTED=YES`, `TESTED=PASS`, `COMMITTED=YES`, `PUSHED=YES`, `MERGED=NO`, `DEPLOYED=NO`.
The next action is review of the release-preparation PR. Production execution and
any capacity choice still require explicit authorization; no cleanup/expansion,
public image publication, M1-B or new backup/staging/rollback system was performed.
