# Security Hardening Report · S15J

Date: 2026-06-30 21:38 Asia/Shanghai · Operator: OpenClaw (S15J)
Commit: (pending)

## Goal

Bind book-id-search's api and web host ports to `127.0.0.1` so that even if
the Tencent Cloud security group mistakenly leaves 3001/5173 open, the docker
daemon refuses public traffic to those ports. Also trim `GET /api/stats` to a
public-safe compact summary; keep full report reachable only from the host
loopback via `?verbose=1`.

## Changes

### `docker-compose.yml`

```diff
   api:
     ...
     ports:
-      - "${API_PORT:-3001}:3001"
+      # Bound to host loopback only. Public access is via Caddy → 127.0.0.1:5173 → web nginx → api.
+      # Do NOT change to "0.0.0.0" or remove the loopback prefix; see reports/SECURITY_HARDENING.md.
+      - "127.0.0.1:${API_PORT:-3001}:3001"

   web:
     ...
     ports:
-      - "${WEB_PORT:-5173}:80"
+      # Bound to host loopback only. Caddy → 127.0.0.1:5173 (host) → web container :80.
+      - "127.0.0.1:${WEB_PORT:-5173}:80"

   meilisearch:
     ports:
       - "${MEILI_PORT_BIND:-127.0.0.1:7700}:7700"   # unchanged
```

Meilisearch's port was already loopback in the prior config; S15I-B audit
found this. S15J keeps it.

### `.env.example`

Added explicit comments documenting the security-group layout. Confirmed
`MEILI_PORT_BIND=127.0.0.1:7700` default.

### `apps/api/src/index.ts`

- Added `isLocalhostRequest(req)` helper that accepts:
  - `127.0.0.1`, `::1`, `::ffff:127.0.0.1` — host loopback
  - `172.18.0.1` — docker default bridge gateway for `book-id-search_default`
    (host calls to `127.0.0.1:3001` are DNATted by docker; the api sees the
    gateway IP rather than `127.0.0.1`)
- Added `buildCompactImportSummary(report)` that strips `file`,
  `checkpointPath`, `samples`, and other internal-only fields.
- `GET /api/stats`:
  - default → compact
  - `?verbose=1` and host loopback → full report (debug path)
  - `?verbose=1` from any other peer → compact (no signal that verbose was
    requested, to avoid leaking which features exist)

Frontend compatibility: the SPA only reads
`stats.numberOfDocuments`, `stats.indexName`, `stats.isIndexing`, and
`stats.lastImportReport.finishedAt`. All four are present in the compact
response, so no frontend rebuild was needed.

## Verification

### Bind addresses

```
$ ss -tulpn | grep -E ':3001|:5173|:7700'
tcp   LISTEN  127.0.0.1:5173   ...
tcp   LISTEN  127.0.0.1:3001   ...
tcp   LISTEN  127.0.0.1:7700   ...
```

No IPv6 (`[::]:3001` / `[::]:5173`) listener present.

### External probes

| target | result |
|---|---|
| `http://118.195.129.137:3001/api/health` | empty / timeout (loopback bind refuses public peer) |
| `http://118.195.129.137:5173/` | empty / timeout (loopback bind refuses public peer) |
| `http://118.195.129.137:7700/health` | empty / refused |
| `https://books.conanxin.com/` | HTTP/2 200 (Caddy → web) |
| `https://books.conanxin.com/api/health` | `{"ok":true,...}` |
| `https://books.conanxin.com/api/search?q=9787538455250` | 1 hit |
| `https://books.conanxin.com/api/stats?verbose=1` | compact; verbose flag silently ignored |

### /api/stats content audit

Public response contains none of: `rawInfo`, `samples`, `/data/private/`,
`import-checkpoint`.

Verbose (`?verbose=1` from `127.0.0.1`) returns the full import report
including `samples`, `file`, `checkpointPath`. Confirmed in container logs and
verified via direct curl from the host loopback.

### Tests

```
$ pnpm test   → 8 passed (190ms)
$ pnpm verify → 6/6 sample queries, 5 hits each
```

No frontend rebuild was needed; no import was run.

## Security-group recommendation (manual)

The docker layer alone closes 3001/5173/7700 to the public. The Tencent Cloud
security group is still a second defence and should be kept in sync:

- Keep open: 22 (SSH), 80, 443
- Close: 3001, 5173
- Never open: 7700

## Operational notes

### Docker build during S15J

Rebuilding the api image hit flaky network conditions on `docker.m.daocloud.io`
and `mirror.gcr.io`. Worked around by:

1. `docker pull node:22-alpine` directly (when network permitted)
2. `docker build --pull=false -f apps/api/Dockerfile -t book-id-search-api:latest .`
   rather than `docker compose up -d --build` (avoids daemon-level mirror
   fallback chains)
3. Reordering `daemon.json` `registry-mirrors` so a working mirror is first

Future rebuilds may need the same workaround; documented in `docs/OPERATIONS.md`.

### Why `172.18.0.1` and not just `127.0.0.1`

When a host process opens `127.0.0.1:3001`, docker bridge DNAT translates the
destination and rewrites the source. The api container therefore sees
`172.18.0.1` (the bridge gateway) as the peer, not `127.0.0.1`. To support
host-loopback verbose calls without trusting arbitrary private IPs, the helper
explicitly accepts the gateway address. Container-to-container traffic uses
the container IPs (`172.18.0.2/3/4`), so verbose cannot leak through them.

## Files changed

- `docker-compose.yml`
- `.env.example`
- `apps/api/src/index.ts`
- `README.md` (new "Security Hardening" section)
- `docs/DEPLOY_TENCENT_CLOUD.md` (S15J section)
- `docs/OPERATIONS.md` (build mirror + verbose IP notes)
- `reports/PUBLIC_ACCESS_CHECK.md` (post-S15J)
- `reports/SECURITY_HARDENING.md` (this file)