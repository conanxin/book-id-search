# S20A — Production Health Check Baseline

**Frozen at:** 2026-07-01 (commit `905ac1a` + S20A changes)
**Tag:** `v0.4.2-search-quality` (S19)
**Overall status:** **PASS** (18/18 checks)

## Current stable state

| Item | Value |
|---|---|
| Live URL | `https://books.conanxin.com` |
| Server IP | `118.195.129.137` |
| Caddy | reverse-proxies `127.0.0.1:5173` (web) for `books.conanxin.com` |
| Stable tag | `v0.4.2-search-quality` (commit `905ac1a`) |
| Docs count | **5,115,734** |
| isIndexing | `false` |
| meili_data size | `11G` (`/data/book-id-search/meili_data`) |
| Disk / | `75% used` (25G free) |
| TLS cert | `CN=books.conanxin.com` expires `Sep 28 12:07:33 2026 GMT` |

## Search sample (verified live, 2026-07-01)

| Query | detectedType | match label |
|---|---|---|
| `9787538455250` | `isbn` | `ISBN 精确匹配` |
| `978-7-5384-5525-0` | `isbn` (normalized to `9787538455250`) | `ISBN 精确匹配` |
| `13000000` | `ssid` | `SSID 精确匹配` |
| `000008232537` | `dxid` | `DXID 精确匹配` |
| `时尚秋冬披肩` | `text` | `书名命中` |

## Port safety (verified 2026-07-01)

All internal ports bound to `127.0.0.1` and **not reachable** from the public IP
(`118.195.129.137`):

| Port | Service | External reachability |
|---|---|---|
| `3001` | api | ❌ not reachable (private) |
| `5173` | web | ❌ not reachable (private) |
| `7700` | meilisearch | ❌ not reachable (private) |

Only `:80` and `:443` are exposed publicly via Caddy.

## How to re-run

```bash
cd /opt/book-id-search
pnpm health:check
```

Outputs:
- Terminal summary + `STATUS: PASS/WARN/FAIL`
- `reports/health-check-latest.json` (machine-readable)
- `reports/HEALTH_CHECK_LATEST.md` (latest markdown snapshot)

Exit codes: `0=PASS`, `1=WARN`, `2=FAIL`.

## Drift detection rules

A re-run should yield PASS. Any drift triggers:

| Drift | Action |
|---|---|
| `docs count` ≠ 5,115,734 | Investigate meili_data size; **do not** re-run import. |
| `isIndexing=true` | Wait; if stuck, check container logs. |
| Any search label changed | Regression in normalize / rerank — check `apps/api/src/search/`. |
| Any port :3001/:5173/:7700 reachable externally | **Critical**: check security group + Caddy immediately. |
| `disk /` ≥ 80% (WARN) / ≥ 90% (FAIL) | Check meili_data growth; consider `docker system prune`. |
| Cert `notAfter` < 30 days out | Check Caddy renewal; verify `:80` reachable from Let's Encrypt validators. |

## Files

- `scripts/health-check.ts` — the check itself (idempotent, no writes).
- `docs/HEALTH_CHECK.md` — full operations doc (when/how/what-to-do).
- `reports/health-check-latest.json` — most recent JSON.
- `reports/HEALTH_CHECK_LATEST.md` — most recent Markdown snapshot.

## Safety notes

This baseline deliberately **does not** include:
- Internal paths (`/data/private`, `checkpointPath`).
- `rawInfo` field counts in `fieldDistribution` (stripped from public stats
  response).
- Sample documents from `lastImportReport`.

The `pnpm health:check` script asserts the public `/api/stats` response does
NOT contain any of the above substrings. This is enforced by
`apps/api/src/index.ts`'s `buildCompactStats` helper.