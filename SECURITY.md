# Security Policy

`book-id-search` is a self-hostable metadata-search application with a web frontend, Express API, Meilisearch backend, import tooling, and deployment scripts. Security reports are welcome, especially for issues involving API exposure, import inputs, deployment defaults, dependency behavior, or the boundary between public metadata and private source data.

## Supported versions

Security fixes are applied to the current `main` branch and the latest maintained release line. Older snapshots are not maintained separately unless explicitly stated in release notes.

## Reporting a vulnerability

Please do **not** publish exploit details, credentials, private dataset contents, or sensitive server information in a public issue.

Preferred reporting path:

1. Use GitHub's **Report a vulnerability** / private vulnerability reporting flow if it is available for this repository.
2. If that option is unavailable, open a minimal public issue stating that you need a private channel for a security report. Do not include exploit details in that issue.

Include, when possible:

- affected component and version/commit;
- reproduction steps or a minimal proof of concept;
- expected vs. observed behavior;
- impact and preconditions;
- suggested mitigation, if known.

## Security boundaries

The public repository intentionally excludes real/private source datasets, `.env` files, deployment secrets, checkpoints, logs, and Meilisearch data directories. Sample data is provided only for development and verification.

The project should preserve these defaults:

- internal service ports remain loopback-bound unless an operator explicitly changes them;
- public API responses should not expose private filesystem paths, secrets, raw private-source samples, or operational checkpoints;
- deployment and import tooling should fail clearly rather than silently weaken data or network boundaries.

## Non-sensitive bugs

For ordinary functional bugs with no confidentiality or security impact, use a normal GitHub issue.