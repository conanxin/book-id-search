# book-id-search final public access verification

## META

- time: 2026-06-30 21:51 (Asia/Shanghai)
- host: VM-0-4-ubuntu (118.195.129.137, Tencent Cloud)
- operator: conanxin via OpenClaw · SSH to `mmx-prod`
- scope: read-only final verification after S15K security-group cleanup
- note: public-domain curl tests were run from the server itself (this WSL2 host has transparent-proxy SSRF rewriting public DNS to 198.18.x.x fake IPs — see MEMORY.md)

## STATUS

**PASS**

## DOCKER STACK (`docker compose ps` on server)

```
NAME                           IMAGE                          COMMAND                  SERVICE       CREATED          STATUS          PORTS
book-id-search-api-1           book-id-search-api             "docker-entrypoint.s…"   api           13 minutes ago   Up 13 minutes   127.0.0.1:3001->3001/tcp
book-id-search-meilisearch-1   getmeili/meilisearch:v1.48.3   "tini -- /bin/sh -c …"   meilisearch   3 hours ago      Up 14 minutes   127.0.0.1:7700->7700/tcp
book-id-search-web-1           book-id-search-web             "/docker-entrypoint.…"   web           21 minutes ago   Up 14 minutes   127.0.0.1:5173->80/tcp
```

All three services up; **every host port bound to 127.0.0.1 only**.

## LOCALHOST SERVICES (from server 127.0.0.1)

- `GET http://127.0.0.1:3001/api/health` → `{"ok":true,"meili":{"status":"available"},"index":"books"}`
- `GET http://127.0.0.1:3001/api/stats` → compact JSON:
  - `numberOfDocuments: 500000`
  - `rawDocumentDbSize: 213282816`
  - `isIndexing: false`
  - `lastImportReport.imported: 500000`, `failedParsed: 0`, `elapsedSeconds: 162.62`
- `HEAD http://127.0.0.1:5173` → `HTTP/1.1 200 OK`, `Server: nginx/1.27.5`, `Content-Length: 413`

## LISTENING PORTS (`ss -tulpn`)

```
udp   UNCONN 0      0                                  *:443              *:*
tcp   LISTEN 0      4096                       127.0.0.1:5173       0.0.0.0:*
tcp   LISTEN 0      4096                       127.0.0.1:3001       0.0.0.0:*
tcp   LISTEN 0      4096                       127.0.0.1:7700       0.0.0.0:*
tcp   LISTEN 0      4096                               *:80               *:*
tcp   LISTEN 0      4096                               *:443              *:*
```

- ✅ 3001 / 5173 / 7700 bound to **127.0.0.1 only** (not reachable from outside)
- ✅ 80 / 443 public-bound for nginx + Caddy reverse proxy

## PUBLIC DOMAIN — books.conanxin.com (tested from server)

- `HEAD https://books.conanxin.com/` → **HTTP/2 200**, `server: nginx/1.27.5`, `via: 1.1 Caddy`, alt-svc h3
- `GET /api/health` → `{"ok":true,"meili":{"status":"available"},"index":"books"}`
- `GET /api/stats` → 500,000 docs, compact JSON, `isIndexing:false`
- `GET /api/search?q=9787538455250` →
  ```json
  {"total":1,"page":1,"limit":20,"items":[{"id":"13000000_000008232537","ssid":"13000000","dxid":"000008232537","title":"时尚秋冬披肩、吊带","author":"（日）日本靓丽社著；陈瑶译","publisher":"长春：吉林科学技术出版社","year":2011,"pages":83,"isbn":"9787538455250","rawInfo":"13000000,000008232537,时尚秋冬披肩、吊带,（日）日本靓丽社著；陈瑶译,长春：吉林科学技术出版社,2011,83,9787538455250","parseStatus":"ok","parseWarnings":[]}]}
  ```

## MUSIC BASELINE — music.conanxin.com

`HEAD https://music.conanxin.com/` → **HTTP/2 200**, `server: cloudflare`, `cf-cache-status: DYNAMIC`, `cf-ray: a13da4ac1cc9434e-AMS` (Amsterdam). Music service untouched.

## BARE IP PORTS (118.195.129.137)

- `:3001/api/health` → empty / connection refused (port not publicly bound)
- `:5173 HEAD` → `curl: (28) Connection timeout after 5000 ms` — security-group block confirmed
- `:7700 HEAD` → `curl: (28) Connection timeout after 5000 ms` — security-group block confirmed

✅ All three bare-IP ports are NOT publicly useful. User-side Tencent-Cloud security-group cleanup of TCP 3001 + TCP 5173 (S15K) plus pre-existing 7700 lockdown are all effective.

## EXPECTED

- [x] https://books.conanxin.com works (HTTP/2 200)
- [x] `/api/health` works
- [x] `/api/stats` compact works
- [x] search works (`9787538455250` → 《时尚秋冬披肩、吊带》)
- [x] music.conanxin.com still works (HTTP/2 200, Cloudflare)
- [x] bare 3001 / 5173 / 7700 not publicly useful

## NEXT_STEP

- Cloud demo is complete.
- Do not run full import until independent `/data` disk is attached.
