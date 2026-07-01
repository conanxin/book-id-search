# Production Health Check — 2026-07-01T15:13:40.688Z

- Public URL: `https://books.conanxin.com`
- Expected docs: `5115734`
- Server IP: `118.195.129.137`
- Overall: **PASS**

## Results

| Check | Status | Detail |
|---|---|---|
| public frontend | PASS | GET / -> 200 |
| api health | PASS | ok=true meili=available |
| stats count | PASS | docs=5115734 |
| stats indexing | PASS | isIndexing=false |
| stats compact safety | PASS | no leaks (rawInfo/samples/private/checkpoint/books.txt) |
| search ISBN | PASS | q=9787538455250 detectedType=isbn label=ISBN 精确匹配 |
| search hyphen-ISBN | PASS | q=978-7-5384-5525-0 detectedType=isbn label=ISBN 精确匹配 |
| search SSID | PASS | q=13000000 detectedType=ssid label=SSID 精确匹配 |
| search DXID | PASS | q=000008232537 detectedType=dxid label=DXID 精确匹配 |
| search title | PASS | q=时尚秋冬披肩 detectedType=text label=书名命中 |
| port :3001 api external | PASS | not reachable from 118.195.129.137 (private) |
| port :5173 web external | PASS | not reachable from 118.195.129.137 (private) |
| port :7700 meilisearch external | PASS | not reachable from 118.195.129.137 (private) |
| docker compose ps | PASS | api=running meilisearch=running web=running |
| disk / | PASS | used=75% |
| meili_data size | PASS | 11G	/data/book-id-search/meili_data |
| caddy certificate | PASS | live cert subject=CN = books.conanxin.com expires=Sep 28 12:07:33 2026 GMT |
