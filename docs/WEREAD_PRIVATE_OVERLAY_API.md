# WeRead Private Overlay API

Private, read-only API endpoints that expose a minimal, redacted view of your WeRead library based on confirmed catalog matches. This is **disabled by default** and must be explicitly enabled with a token.

## Endpoints

- `GET /api/private/weread/summary` — aggregate counts only.
- `GET /api/private/weread/status?catalogId=<catalogId>` — per-book reading status.

## Authentication

Both endpoints require a private token. Accepted header styles:

- `Authorization: Bearer <token>`
- `X-Private-Token: <token>`

If the feature is disabled or the token is missing/invalid, the API returns `404`/`401`/`403` without exposing private details.

## Environment variables

- `WEREAD_OVERLAY_ENABLED` — must be `true` to enable the endpoints.
- `WEREAD_PRIVATE_API_TOKEN` — token used for bearer / header auth.
- `WEREAD_PRIVATE_DATA_DIR` — absolute path inside the api container; defaults to `/app/private-data/weread`.

Never commit the token. The token is read from `.env` via docker compose env-file; it is not baked into the Docker image.

## Docker mount

The api container bind-mounts the private data directory read-only:

```yaml
volumes:
  - ./private-data/weread:/app/private-data/weread:ro
```

No private data is copied into the image.

## Privacy rules

The API response never includes:

- `wereadBookId`
- Book title or author
- Note text or highlight comment
- Cookie, session, or raw WeRead tokens
- API keys

Response only includes aggregated counts and matched status metadata (`readingStatus`, `progress`, `noteCount`, `highlightCount`, `matchMethod`, `matchConfidence`, `decisionSource`).

## Relationship to public search

This overlay has no effect on `/api/search`, `/api/stats`, `/api/health`, or AI search. It is a separate, authenticated route.

## How to disable

Set `WEREAD_OVERLAY_ENABLED=false` in `.env` and restart the api container. The endpoints will return `404 Not Found`.
