# Web Release Artifact Provenance (S27P-4A)

This document defines the release-artifact identity rules for the `@book-id-search/web` Docker image after the S27P-4A deterministic build repair.

## Why this matters

Before S27P-4A, the web Dockerfile did **not** copy `pnpm-lock.yaml` into the build context and used `pnpm install --frozen-lockfile=false`. As a result, every Docker build resolved dependencies from `package.json` semver ranges independently. This produced different static bundles on different builds, making it impossible to answer the question: *“Did the image we deployed actually come from the code we audited?”*

## Golden rule: build once, deploy the same image

1. The release candidate image is built **exactly once** per git commit.
2. The deploy script must not build a new image. It must reference an existing image tag.
3. The running container image ID must equal the candidate image ID.

## Required Dockerfile contract

- `pnpm-lock.yaml` is copied into the build stage before `pnpm install`.
- `corepack prepare pnpm@<exact-version> --activate` is used; `latest` or floating versions are not allowed.
- `pnpm install --frozen-lockfile` is used. If the lockfile is stale, the build fails and the release is blocked.
- Source code is copied only after dependency installation so layer caching remains sensible.

## Role of the lockfile

`pnpm-lock.yaml` is the source of truth for dependency versions. Committing it to the build context guarantees that every build installs the same transitive dependency tree, which is the prerequisite for a reproducible bundle.

## Role of the host Vite build

Running `vite build` on the host is a regression test for the product source code. Its output manifest is **not** the release gate because host and Docker builds may legitimately differ in chunk hash names due to absolute paths, dependency hoisting, or tool differences. The **Docker candidate manifest** is the authoritative identity for the production artifact.

## Candidate image identity

- Tag pattern: `book-id-search-web:<full-40-char-git-sha>`
- Provenance record: `progress/web-release-candidate-<sha>/candidate.json`
- Required fields:
  - `tag`
  - `imageId`
  - `gitSha`
  - `nodeVersion`
  - `pnpmVersion`
  - `lockfileSha256`
  - `staticManifestSha256`

## Static manifest verification

The candidate image is mounted read-only and its `/usr/share/nginx/html` directory is hashed file-by-file into a TSV manifest (`path`, `size`, `sha256`). Two builds from the same source must produce an identical manifest.

## Deploy-time verification

`scripts/deploy-web-release-candidate.sh`:

- Refuses to run if the image tag is not provided.
- Refuses to run if the image does not exist locally.
- Deploys with `docker compose up -d --no-deps --no-build web` using `BOOK_ID_SEARCH_WEB_IMAGE`.
- Verifies the running container image ID matches the candidate image ID.

## What the deploy script must not do

- Run `docker build` internally.
- Accept `latest` or untagged images as a default.
- Restart `api` or `meilisearch`.
- Modify `pnpm-lock.yaml`, `package.json`, or application source.

## Rollback policy

If a deployed image must be rolled back, re-deploy an existing candidate tag. Rebuilding from an old commit is only an emergency path and should not be treated as a normal release because it re-creates the provenance chain.

## Summary checklist for a release

- [ ] Working tree is clean and matches the intended git SHA.
- [ ] `pnpm-lock.yaml` hash is recorded before and after the build and is unchanged.
- [ ] Docker build uses `--frozen-lockfile` and succeeds.
- [ ] Two consecutive clean builds produce the same static manifest.
- [ ] Candidate image tag contains the full SHA.
- [ ] Deploy script uses the exact image tag and verifies image ID equality.
- [ ] API and Meilisearch services are not restarted by the web deploy.
