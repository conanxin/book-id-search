# Open Source Overview

`book-id-search` is an open-source, self-hostable search stack for large book-metadata catalogs. It is designed to make heterogeneous bibliographic records searchable through a reproducible import pipeline, a TypeScript/Express API, a React web interface, and Meilisearch.

## What is open source

The repository contains the reusable software and maintenance workflow:

- streaming metadata import and parsing;
- checkpoint/resume support for large imports;
- search and ranking logic;
- web UI and API;
- sample data and local development workflow;
- deployment and operations documentation;
- verification and regression tooling;
- search-quality and AI-quality checks.

The real/private source dataset is **not** part of the open-source distribution. This separation is intentional: the software can be reused with compatible metadata sources without redistributing the maintainer's private source files.

## Proven operating scale

The maintained deployment has been validated against a full index of **5,115,734 metadata records**. The repository documents full-import verification, parsing quality, search regression checks, and recovery/operations procedures.

This operating scale is evidence about the software path, not a claim that the private dataset itself is open source.

## Maintenance model

The project is actively maintained around four recurring workflows:

1. **Import reliability** — parsing, large-batch ingestion, resume/checkpoint behavior, and storage constraints.
2. **Search quality** — exact identifiers, Chinese fuzzy search, query cleaning, intent/ranking behavior, and regression cases.
3. **Operational reliability** — deployment scripts, health checks, release/deploy gates, and recovery documentation.
4. **Data boundaries** — keeping private source material and operational secrets outside the public repository and public API surface.

## Reuse and contribution

The public sample data is sufficient to exercise the development workflow. Contributors can run the application locally, test changes, and improve the reusable search stack without access to the maintainer's private catalog.

See:

- `README.md` for setup and architecture links;
- `CONTRIBUTING.md` for contribution and verification rules;
- `SECURITY.md` for vulnerability reporting and security boundaries;
- `docs/ARCHITECTURE.md` for system structure;
- `docs/OPERATIONS.md` for operations;
- `docs/SEARCH_QUALITY_REGRESSION.md` and `docs/AI_QUALITY_REGRESSION.md` for quality gates.

## License

The software is released under the MIT License.