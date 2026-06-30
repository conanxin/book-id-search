# Caddy Reverse Proxy Applied · books.conanxin.com

Date: 2026-06-30 · Operator: OpenClaw S15I-B

## What was applied

A new Caddy site block was added to `/etc/caddy/Caddyfile`:

```
books.conanxin.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:5173 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
    header {
        X-Frame-Options SAMEORIGIN
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

`music.conanxin.com` block is untouched. Backup of pre-change Caddyfile at
`/etc/caddy/Caddyfile.bak.pre-s15i-b`.

## Verification

| probe | result |
|---|---|
| `caddy validate --config /etc/caddy/Caddyfile` | Valid configuration (one expected warning about redundant X-Forwarded-* removed) |
| `caddy reload` (direct, sudo) | exit=0 · ACME issued cert for books.conanxin.com in ~10s |
| `curl -I https://books.conanxin.com/` | HTTP/2 200 · `via: 1.1 Caddy` · `x-frame-options: SAMEORIGIN` |
| `curl https://books.conanxin.com/api/health` | `{"ok":true,"meili":{"status":"available"},"index":"books"}` |
| `curl https://books.conanxin.com/api/stats` | `numberOfDocuments=500000, isIndexing=false` |
| `curl 'https://books.conanxin.com/api/search?q=9787538455250'` | 1 hit: id `13000000_000008232537` |
| `curl -I http://books.conanxin.com/` | HTTP/1.1 308 → `https://books.conanxin.com/` |
| `curl -I https://music.conanxin.com/` | HTTP/2 200 · unchanged |
| `curl -I http://118.195.129.137:7700/` | Connection refused (Meili still private) |

TLS cert (Let's Encrypt):

```
subject=CN = books.conanxin.com
issuer  = C = US, O = Let's Encrypt, CN = YE2
notBefore = Jun 30 12:07:34 2026 GMT
notAfter  = Sep 28 12:07:33 2026 GMT
```

## Operational gotcha

`sudo systemctl reload caddy` fails inside this WSL container with
`status=226/NAMESPACE`. Reason: systemd tries to set up
`/run/systemd/unit-root/tmp` mount namespace before spawning the reload child,
and that path does not exist.

**Workaround used**:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile --force
```

This bypasses systemd and talks directly to the running Caddy admin API on
`127.0.0.1:2019`. Cert is acquired and config is loaded successfully; the running
Caddy process (PID 1981477) is the one serving both music and books now.

## Recommended security-group cleanup (manual, not done here)

Per S15I-B constraint "do not modify Tencent security group", the following
ports are still publicly open but should be closed now that Caddy is the single
public entry:

- **TCP 3001** (api direct): close inbound from `0.0.0.0/0`. Caddy reaches the
  api via the docker network (`api:3001`) through the web container, not via the
  host port.
- **TCP 5173** (web host port): close inbound from `0.0.0.0/0`. Caddy reaches
  web via `127.0.0.1:5173` (localhost on the host).

Keep open:

- TCP 22 (SSH, ideally source-restricted)
- TCP 80 (Caddy HTTP → 308)
- TCP 443 (Caddy HTTPS)

Never open:

- TCP 7700 (Meili with master-keyed API)

## Architecture

```
[client]
   │ HTTPS :443
   ▼
[Caddy on host :80/443]
   │ reverse_proxy 127.0.0.1:5173
   ▼
[web container :80  (docker-published as host :5173)]
   │ nginx location /api → proxy_pass http://api:3001/api/
   ▼
[api container :3001]
   │
   ▼
[meilisearch container :7700]  ← NOT public, only on book-id-search_default network
```

Frontend (`/assets/index-*.js`) calls `/api/...` same-origin, so no rebuild needed.
The Caddy layer adds TLS termination, HSTS-ready headers, and a single domain
that hits both the SPA and its API.