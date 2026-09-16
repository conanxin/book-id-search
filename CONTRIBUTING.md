# Contributing to book-id-search

Thanks for helping improve `book-id-search`. The project is an open-source, self-hostable metadata-search stack for large book catalogs. Contributions should preserve three properties: reproducible imports, explainable search behavior, and a clear boundary between public code/sample data and private source datasets.

## Development setup

Requirements:

- Node.js compatible with the current workspace
- pnpm 10.x
- Meilisearch (Docker or a local binary)

Quick start:

```bash
pnpm install
cp .env.example .env
docker compose up -d meilisearch
pnpm import:sample
pnpm dev
```

On Windows without Docker, follow `docs/RUN_WITHOUT_DOCKER_WINDOWS.md`.

## Before opening a pull request

Run the checks relevant to your change:

```bash
pnpm test
pnpm build
pnpm verify
```

For search/ranking changes, also run the documented search-quality regression workflow in `docs/SEARCH_QUALITY_REGRESSION.md`. For AI-assisted search changes, follow `docs/AI_QUALITY_REGRESSION.md`.

## Change discipline

- Keep real/private book-source files, `.env` files, checkpoints, logs, and Meilisearch data out of Git.
- Add or update regression coverage when changing parsing, query cleaning, ranking, API behavior, or import/resume logic.
- Prefer small PRs with one clear purpose.
- Document operational changes that affect deployment or recovery.
- Do not silently broaden public API responses to include raw private-source material.

## Pull request checklist

A good PR should explain:

1. What problem it solves.
2. What behavior changed.
3. How it was tested.
4. Any deployment, migration, data, or compatibility impact.

If a change alters search relevance, include before/after examples or regression results.

## Issues

Bug reports should include the smallest reproducible example, expected behavior, actual behavior, environment, and relevant logs with secrets/private data removed.

Feature requests are most useful when they describe the user workflow and why the existing behavior is insufficient.

## License

By contributing, you agree that your contribution is provided under the repository's MIT License.