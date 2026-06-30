# Public Access Check · post-S15J

Date: 2026-06-30 21:38 Asia/Shanghai · Operator: OpenClaw S15J

## What changed since 2026-06-30 19:43 (S15I-B)

- `docker-compose.yml`: api and web host ports bound to `127.0.0.1` only.
  Public exposure through Caddy → `127.0.0.1:5173` → web nginx → api only.
- `apps/api/src/index.ts`: `GET /api/stats` now returns a compact summary by
  default. Internal file paths, checkpoint paths, and raw `samples` are
  stripped. `?verbose=1` is honored only when the request peer is the host
  loopback or the docker bridge gateway IP.

## Current public attack surface

| port | service | bind | public via |
|---|---|---|---|
| 80 | Caddy | `*:80` | HTTP→HTTPS redirect |
| 443 | Caddy | `*:443` | TLS, books + music |
| 22 | SSH | (system default) | direct |
| 3001 | api | `127.0.0.1:3001` | **never** |
| 5173 | web host port | `127.0.0.1:5173` | **never** |
| 7700 | meilisearch | `127.0.0.1:7700` | **never** |

External probes after S15J:

```
$ curl --connect-timeout 3 http://118.195.129.137:3001/api/health    → empty / timeout
$ curl --connect-timeout 3 http://118.195.129.137:5173/             → empty / timeout
$ curl --connect-timeout 3 http://118.195.129.137:7700/health        → empty / refused
$ curl -I https://books.conanxin.com/                                → HTTP/2 200
$ curl https://books.conanxin.com/api/health                         → {"ok":true,...}
$ curl https://books.conanxin.com/api/search?q=9787538455250         → 1 hit
$ curl https://books.conanxin.com/api/stats?verbose=1                → compact (verbose stripped)
```

## Stats content comparison

### Compact (default, public)

```json
{
  "index": "books",
  "indexName": "books",
  "numberOfDocuments": 500000,
  "isIndexing": false,
  "stats": { ...fieldDistribution + rawDocumentDbSize... },
  "lastImportReport": {
    "totalLines": 500000, "imported": 500000, "skipped": 0,
    "weakParsed": 59332, "failedParsed": 0, "duplicateLikeCount": 0,
    "batchSize": 20000, "searchRawInfo": false,
    "elapsedSeconds": 162.62, "rowsPerSecond": 3074.65,
    "startedAt": "2026-06-30T11:33:08.651Z",
    "finishedAt": "2026-06-30T11:35:51.275Z"
  },
  "parseQualityReport": null
}
```

### Verbose (`?verbose=1`, localhost only)

Same as before: includes `lastImportReport.file`, `lastImportReport.checkpointPath`,
`lastImportReport.samples.ok / .weak / .failed` with rawInfo, and the full
`parseQualityReport` JSON.

## Recommended Tencent Cloud security-group state

- Keep open: 22 (SSH, ideally source-restricted), 80, 443
- Close: 3001, 5173
- Never open: 7700

Even with docker ports bound to loopback, the security group is a second
defence — keep 3001 and 5173 closed there too.

## What's safe to do after this change

- Reload Caddy (still on `127.0.0.1:2019` admin)
- Restart `docker compose up -d` (api/web/meili)
- Rebuild api/web images when index.ts / frontend changes

## What's NOT safe to do

- Revert `127.0.0.1:` prefix in docker-compose.yml
- Set `MEILI_PORT_BIND=0.0.0.0:7700`
- Open 3001/5173/7700 in security group
- Bind Caddy to a public IP other than the books.conanxin.com hostname