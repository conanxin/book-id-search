# Public Access Check — 2026-06-30 (Tencent CVM 500k validation)

Captured right after `pnpm verify` confirmed `numberOfDocuments=500000` on `books` index.

## Listen sockets (host)

```
udp   UNCONN 0      0                                  *:443              *:*
tcp   LISTEN 0      4096                         0.0.0.0:5173       0.0.0.0:*
tcp   LISTEN 0      4096                         0.0.0.0:3001       0.0.0.0:*
tcp   LISTEN 0      4096                       127.0.0.1:7700       0.0.0.0:*
tcp   LISTEN 0      4096                               *:80               *:*
tcp   LISTEN 0      4096                               *:443              *:*
tcp   LISTEN 0      4096                            [::]:5173          [::]:*
tcp   LISTEN 0      4096                            [::]:3001          [::]:*
```

## Per-port result

| port | service | bind | from public IP 118.195.129.137 | verdict |
|---|---|---|---|---|
| 80 | Caddy | `*:80` | listening (handled by Caddy reverse-proxy) | OK |
| 443 | Caddy | `*:443` | listening (handled by Caddy reverse-proxy) | OK |
| 3001 | API (Node/Express) | `0.0.0.0:3001` | `200 {"ok":true,"meili":{"status":"available"},"index":"books"}` | public |
| 5173 | Web (Nginx static) | `0.0.0.0:5173` | `HTTP/1.1 200 OK`, `Server: nginx/1.27.5`, 413 bytes | public |
| 7700 | Meilisearch | `127.0.0.1:7700` | `Connection refused` from public IP | **not public** ✓ |

## Decision matrix

- **3001** is currently public because the container binds `0.0.0.0:3001` and the host
  security group permits inbound 3001. This is fine for the 500k validation window but
  is **not** the long-term shape — the canonical entry should be Caddy on 80/443 with
  `/api` reverse-proxied to `127.0.0.1:3001` and a domain + TLS terminator.
- **5173** is public the same way (Nginx inside the web container, host port 5173).
  Long-term: serve the SPA from Caddy on 80/443 and keep 5173 closed on the host.
- **7700** stays on `127.0.0.1:7700` only. Do not change `MEILI_PORT_BIND` to
  `0.0.0.0:7700` in production; it would expose the master-keyed API to anyone who
  can reach the host.
- **80/443** are owned by Caddy. This validation did not modify Caddy config.
  Direct hits to `http://118.195.129.137:80` / `:443` return whatever Caddy has
  configured for the host; nothing was added or removed.

## Recommended long-term shape

1. Close 3001 and 5173 in the Tencent Cloud security group.
2. Open 80 and 443 only.
3. Configure Caddy to:
   - serve the SPA build (or reverse-proxy 127.0.0.1:5173) on 80/443,
   - reverse-proxy `/api` to `127.0.0.1:3001`,
   - terminate TLS for the chosen domain.
4. Keep `MEILI_PORT_BIND=127.0.0.1:7700` in `.env`.

This keeps Meilisearch behind a firewall, API behind Caddy auth, and the SPA on TLS.
