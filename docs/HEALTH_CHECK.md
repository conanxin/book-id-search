# Production Health Check — Operations Guardrail

The `pnpm health:check` script verifies the live book-id-search deployment is
healthy, that the public attack surface has not expanded, and that the search
quality guarantees from S19 still hold.

## When to run

- **Before** any production deploy / container rebuild.
- **After** any Caddy / security-group / firewall change.
- **Periodically** (cron or manual) to detect silent regressions — docs count
  drift, isIndexing stuck true, cert expiry, port exposure.
- **As a baseline snapshot** for `v0.4.2-search-quality` and future tags.
- **Daily automated** via cron at 03:30 (server local time) — see the
  "Daily cron" section below.

## How to run

From the repo root:

```bash
pnpm health:check
# or directly:
tsx scripts/health-check.ts
```

CLI flags (all optional, defaults match the current live deployment):

| Flag | Default | Purpose |
|---|---|---|
| `--public-url` | `https://books.conanxin.com` | Public origin to probe |
| `--expected-docs` | `5115734` | Required `numberOfDocuments` |
| `--server-ip` | `118.195.129.137` | Public IP used to probe port exposure |
| `--json` | `reports/health-check-latest.json` | Machine-readable report |
| `--markdown` | `reports/HEALTH_CHECK_LATEST.md` | Markdown report |
| `--skip-local` | _(off)_ | Skip docker / df / caddy local checks (for CI from non-CVM) |

Exit codes:
- `0` — PASS (all checks PASS)
- `1` — WARN (no FAIL, at least one WARN)
- `2` — FAIL (at least one FAIL)

## What it checks

| Category | Probe |
|---|---|
| **public frontend** | `HEAD /` → 200/304 |
| **api health** | `/api/health` returns `{ok:true, meili.status:"available"}` |
| **stats count** | `/api/stats` `numberOfDocuments === 5115734` |
| **stats indexing** | `isIndexing === false` |
| **stats compact safety** | Response body does not contain `rawInfo` / `samples` / `/data/private` / `checkpointPath` / `books.txt` substrings |
| **search ISBN** | `9787538455250` → `ISBN 精确匹配` |
| **search hyphen-ISBN** | `978-7-5384-5525-0` → normalized, `ISBN 精确匹配` |
| **search SSID** | `13000000` → `SSID 精确匹配` |
| **search DXID** | `000008232537` → `DXID 精确匹配` |
| **search title** | `时尚秋冬披肩` → `书名命中` |
| **port :3001 external** | API must NOT be reachable from public IP |
| **port :5173 external** | Web must NOT be reachable from public IP |
| **port :7700 external** | Meilisearch must NOT be reachable from public IP |
| **docker compose ps** | All services `running` |
| **disk /** | `used < 90%` (WARN ≥ 80%, FAIL ≥ 90%) |
| **meili_data size** | `du -sh /data/book-id-search/meili_data` (informational) |
| **caddy certificate** | Live cert probe via `openssl s_client` — subject + `notAfter` |

## PASS / WARN / FAIL criteria

- **PASS** — every probe met its expectation.
- **WARN** — at least one probe is non-critical (e.g. local check skipped,
  unexpected cert artifact layout). The deployment is still healthy but
  warrants a follow-up.
- **FAIL** — at least one probe failed. The deployment is not healthy.

## What to do when something fails

### `stats count` fails (docs mismatch)

1. **Don't** re-run import or reset the index.
2. Check `pnpm verify` to confirm Meilisearch reachable.
3. Inspect the running container's meili_data dir (`/data/book-id-search/meili_data`)
   for size changes — a sudden drop suggests data loss.
4. If docs count is just stale (e.g. a queued indexing task), wait and re-run.
5. If docs count is permanently lower, escalate — this is a data-loss scenario.

### `isIndexing=true`

1. Inspect the running `meilisearch` container logs.
2. If a long-running batch task is mid-flight, wait for it to finish.
3. If the flag is stuck after several minutes, the previous import may have
   crashed mid-write; do **not** re-import. Check `meili_data` size and disk.

### Search failures

1. **Identify the field**: which label failed (`ISBN` / `hyphen-ISBN` / `SSID` /
   `DXID` / `title`)?
2. **Re-run locally** with curl to see the raw response — the script's expected
   match label is printed in the FAIL detail.
3. **Did normalization regress?** Check `apps/api/src/search/normalize.ts`.
4. **Did rerank regress?** Check `apps/api/src/search/rerank.ts`.
5. **Did the index drift?** Confirm `stats count` is still 5,115,734.

### Port exposure (FAIL)

This is **critical** — it means one of api / web / meilisearch is publicly
reachable on its internal port.

1. Immediately check the cloud security group: only `:80` and `:443` should be
   open inbound.
2. Confirm Caddy is still the only ingress (no temporary SSH-tunnel / ngrok).
3. Re-run the script after fixing the exposure.

### Disk low (WARN ≥ 80%, FAIL ≥ 90%)

1. Check `/data/book-id-search/meili_data` size — should be roughly stable.
2. If `meili_data` is growing unexpectedly, an indexing task may be unbounded.
3. Free up old docker images / stopped containers (`docker system prune`).

### Cert expires soon

The script prints the cert's `notAfter` date. If it's within 30 days:

1. Caddy auto-renews via ACME, so this usually only fails if the renewal hook
   broke or rate limits were hit.
2. Check `systemctl status caddy` and Caddy's logs.
3. Verify port 80 is reachable from Let's Encrypt validation servers.

## Files

- `scripts/health-check.ts` — the check itself.
- `scripts/run-health-check-cron.sh` — cron wrapper that invokes pnpm via
  the locally-installed binary (bypasses corepack self-bootstrap) and writes
  per-run logs.
- `reports/health-check-latest.json` — latest JSON snapshot (overwritten each run).
- `reports/HEALTH_CHECK_LATEST.md` — latest Markdown snapshot.
- `reports/HEALTH_CHECK_BASELINE.md` — frozen baseline snapshot for
  `v0.4.2-search-quality`.
- `logs/health-check/health-check-YYYYMMDD-HHMMSS.log` — per-run logs
  (14-day retention, auto-pruned by the cron wrapper).

## Daily cron

The repo installs a single cron entry:

```
30 3 * * * /opt/book-id-search/scripts/run-health-check-cron.sh
```

Install / inspect:

```bash
# Install (idempotent — removes any previous copy of this line first)
( crontab -l 2>/dev/null | grep -v 'run-health-check-cron.sh' ; \
  echo '30 3 * * * /opt/book-id-search/scripts/run-health-check-cron.sh' ) | crontab -

# Verify
crontab -l | grep run-health-check-cron
```

What the wrapper does:

1. `cd /opt/book-id-search`
2. `mkdir -p logs/health-check`
3. Sets `NO_PROXY="*"` so the in-VM curl/openssl probes don't get tangled in
   the sing-box SOCKS proxy.
4. Invokes the installed pnpm binary directly
   (`/home/ubuntu/.local/share/pnpm/store/v11/links/@/pnpm/10.33.0/.../pnpm.cjs`)
   instead of going through corepack — this avoids pnpm's self-bootstrap that
   would otherwise re-fetch pnpm from `registry.npmmirror.com` (blocked).
5. Runs `pnpm health:check` with the live defaults (URL, expected docs, IP,
   output paths).
6. Writes the full per-run log to
   `logs/health-check/health-check-YYYYMMDD-HHMMSS.log`.
7. Prunes logs older than 14 days.
8. Exits with `0` (PASS) / `1` (WARN) / `2` (FAIL) / `4` (pnpm binary missing).

A failed daily run will leave a log on disk; the simplest manual re-run is:

```bash
/opt/book-id-search/scripts/run-health-check-cron.sh
echo "exit=$?"
tail -25 logs/health-check/$(ls -t logs/health-check/ | head -1)
```