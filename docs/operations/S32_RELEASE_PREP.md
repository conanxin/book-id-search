# S32 release preparation

Task: `S32_RELEASE_PREP_CODEX_R1`. Baseline: `630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d`.
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

Measurements and final test/image identifiers are recorded below after building.
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
