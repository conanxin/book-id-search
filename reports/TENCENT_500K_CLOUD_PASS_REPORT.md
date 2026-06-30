# book-id-search Tencent CVM 500k after upload

## STATUS

PASS

## DATA_RESULT

- file: /data/book-id-search/private-data/books.txt
- size: 655876880 bytes
- md5: 7fe76a1bcbae248b104b86fd29b8b7a8
- lines: 5115734
- container-side path: /data/private/books.txt (bind-mounted)

## PREFLIGHT_RESULT

- preflight was executed before import
- preflight exited with code 0 but printed `BLOCKED: estimatedFullIndex=41.75 GiB free=37.19 GiB`
- this is the **full-import (5.1M lines) estimate**, not the 500k-limit estimate
- 500k subset → ~1.6 GiB meili_data observed, well within 37 GiB free budget
- decision: informational-only; import proceeded because limit=500000

## IMPORT_500K_RESULT

- session: book-import-500k
- import_status: PASSED
- report path inside repo: reports/import-500k-cloud-report.json
- tmux window closed cleanly after import finished

```json
{
  "dryRun": false,
  "file": "/data/private/books.txt",
  "index": "books",
  "batchSize": 20000,
  "waitTimeoutMs": 900000,
  "searchRawInfo": false,
  "offset": 0,
  "limit": 500000,
  "totalLines": 500000,
  "imported": 500000,
  "skipped": 0,
  "weakParsed": 59332,
  "failedParsed": 0,
  "duplicateLikeCount": 0,
  "lastProcessedLine": 500000,
  "startedAt": "2026-06-30T11:33:08.651Z",
  "finishedAt": "2026-06-30T11:35:51.275Z",
  "elapsedSeconds": 162.62,
  "rowsPerSecond": 3074.65,
  "meiliTaskCount": 28,
  "averageTaskWaitSeconds": 5.62,
  "totalTaskWaitSeconds": 157.35,
  "warnings": ["missing_isbn", "pages_non_numeric:1册", "year_non_numeric:1056"]
}
```

## VERIFY_RESULT

- pnpm verify: PASS
- stats:

```json
{"index":"books","indexName":"books","numberOfDocuments":500000,"isIndexing":false,"stats":{"numberOfDocuments":500000,"rawDocumentDbSize":213282816,"avgDocumentSize":418,"isIndexing":false,"numberOfEmbeddings":0,"numberOfEmbeddedDocuments":0,"fieldDistribution":{"author":500000,"dxid":500000,"id":500000,"isbn":500000,"pages":500000,"parseStatus":500000,"parseWarnings":500000,"publisher":500000,"rawInfo":500000,"ssid":500000,"title":500000,"year":500000}}}
```

`pnpm verify` 6/6 sample queries all returned 5 hits:

| label | q | hits |
|---|---|---|
| SSID | 13000000 | 5 |
| DXID | 000008232537 | 5 |
| ISBN | 9787538455250 | 5 |
| 书名 | 时尚秋冬披肩、吊带 | 5 |
| 作者 | （日）日本靓丽社著；陈瑶 | 5 |
| 出版社 | 吉林科学技术出版社 | 5 |

## DISK_RESULT

```
Filesystem      Size  Used Avail Use% Mounted on
tmpfs           762M  1.8M  761M   1% /run
/dev/vda2       100G   60G   36G  63% /
tmpfs           3.8G   24K  3.8G   1% /dev/shm
tmpfs           5.0M     0  5.0M   0% /run/lock
tmpfs           762M   16K  762M   1% /run/user/1000
```

- before import: 38 GiB free
- after import:  36 GiB free (Δ ~2 GiB used)
- root free never crossed 15 GiB threshold during run
- import monitor would have killed itself if free < 15 GiB; never triggered

## MEILI_DATA_SIZE

```
1.6G	/data/book-id-search/meili_data
```

(before import: 136K)

## PUBLIC_ACCESS_RESULT

- frontend: http://118.195.129.137:5173
- api health: http://118.195.129.137:3001/api/health

```
--- 3001 health ---
{"ok":true,"meili":{"status":"available"},"index":"books"}

--- 5173 root ---
HTTP/1.1 200 OK
Server: nginx/1.27.5
Content-Type: text/html
Content-Length: 413
```

Both 3001 and 5173 are publicly reachable on the host's primary IP.
7700 (meilisearch) is bound to 127.0.0.1 only — not publicly exposed.

## FULL_IMPORT_DECISION

- full import on current disk: NOT_RECOMMENDED
- reason: preflight estimates 41.75 GiB needed vs 37 GiB free pre-import
- 500k used 2 GiB; full 5.1M lines would scale ~10x → ~20 GiB needed, plus headroom
- recommended: attach independent /data disk >=100GiB, ideally 160GiB+ before running full import

## ORCHESTRATION_NOTES

- user's draft script contained 5+ bash bugs that would have failed before import:
  1. `doneecho "=== FINAL VERIFY ==="` — missing newline (bash syntax error)
  2. trailing ` true` arguments on `wc/git/curl/ss/du` — `set -e` exits
  3. `pnpm verify && VAR=PASS VAR=FAILED` — second assignment treated as command
  4. `curl -s --max-time 5 ifconfig.me echo <ip>` — fallback intended but `echo` is curl arg
  5. `$(stat -c%s "$F" echo unknown)` — same pattern
- `pnpm preflight:import -- --file ...` also rejects `--` as unknown arg → dropped `--`
- fixed script uploaded to `/tmp/s15g-500k.sh` on CVM and run inside tmux session `s15g-orch`
- orchestrator was killed after import passed and verify confirmed; report written here instead of waiting for orchestrator's 5-min monitor tick

## NEXT_STEP

- 500k PASS — /api/stats shows 500000 documents, all field distributions full, no `isIndexing`
- public API at http://118.195.129.137:3001 and frontend at http://118.195.129.137:5173 both 200
- Do not run full import until /data disk is expanded
- Optional: configure Caddy reverse proxy for HTTPS / domain binding