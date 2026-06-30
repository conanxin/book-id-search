# Full Import Strategy

## Current 500k Baseline

- Source: S13 local H: drive Meilisearch run.
- Index: `books`
- Imported: `500000`
- failedParsed: `0`
- weakParsed: `59332`
- Total wall time: about `15963.57` seconds, or `4.43` hours.
- Effective rate: about `31.32` rows/sec.
- Meilisearch data directory: `H:\book-id-search\meili_data`
- Data directory size after 500k: about `2.38 GiB`.

This proves the app and data pipeline are correct, but the original production-like import settings are too slow for a comfortable full import on this Windows machine.

## S14 Benchmark

The benchmark used independent temporary indexes and did not reset or modify the `books` 500k demo index. The requested 50k runs were automatically downgraded to 20k per config because the S13 500k import was slow enough that three full 50k runs would be wasteful locally.

| config | index | rows | batch size | rawInfo searchable | elapsed seconds | rows/sec | size delta | result |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| baseline-small | `books_bench_baseline` | 20000 | 5000 | true | 29.35 | 681.43 | 128.16 MiB | PASS |
| compact-search | `books_bench_compact` | 20000 | 10000 | false | 12.77 | 1566.17 | 57.64 MiB | PASS |
| larger-batch | `books_bench_large_batch` | 20000 | 20000 | false | 9.24 | 2164.50 | 43.20 MiB | PASS |

Search quality comparison passed for SSID, DXID, ISBN, title, author, and publisher with `rawInfo` removed from searchable attributes. No rawInfo-only fragment was found in the sampled record. The original `rawInfo` field remains displayed and stored in every document.

## Recommended Production Parameters

- index: `books`
- batch-size: `20000`
- search-raw-info: `false`
- wait-timeout-ms: `900000`
- checkpoint: `reports/import-checkpoint-full.json`
- report: `reports/import-full-report.json`
- run inside `tmux` or `screen` on Tencent Cloud.

Recommended full import command:

```bash
pnpm import:file -- --file "$HOME/private-data/books.txt" --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

Resume command:

```bash
pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

## Segmented Import Plan

Start with staged imports on a fresh Tencent Cloud server, then continue only after each stage verifies `pnpm verify` and `/api/stats`.

```bash
pnpm import:file -- --file "$HOME/private-data/books.txt" --index books --offset 0 --limit 500000 --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-0000000-0500000.json
pnpm import:file -- --file "$HOME/private-data/books.txt" --index books --offset 500000 --limit 500000 --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-0500000-1000000.json
pnpm import:file -- --file "$HOME/private-data/books.txt" --index books --offset 1000000 --limit 1000000 --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-1000000-2000000.json
pnpm import:file -- --file "$HOME/private-data/books.txt" --index books --offset 2000000 --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-2000000-full.json
```

## Tencent Cloud Sizing

- Minimum test: 2 core / 4GB / 80GB SSD.
- Recommended full import: 4 core / 8GB / 160GB SSD.
- More stable: 4 core / 16GB / 200GB SSD.

Keep `MEILI_DATA_DIR` on a data disk, not a small system disk. Reserve at least 80GB free for the full import even though the compact benchmark suggests the final index may be smaller. The earlier preflight estimate of about 42 GiB remains a safer planning number.

## Time Estimate

- Conservative: 18-36 hours.
- Neutral: 8-18 hours.
- Optimistic: 3-8 hours.

The local 20k benchmark is much faster than the old 500k run, but full-index performance can slow as the index grows. The estimates above intentionally leave room for task queue waits, disk variance, and SSH/session interruptions.

## Risks

- Meilisearch task queue: large batches still wait for indexing tasks; use `--wait-timeout-ms 900000`.
- Disk: index size can grow faster than the source TXT; keep the data dir on a large SSD data disk.
- SSH disconnect: run inside `tmux` or `screen`.
- Memory: if 4GB is unstable, move to 8GB or 16GB before retrying.
- Search tradeoff: `--search-raw-info false` means only structured fields are searchable; raw original lines remain visible and copyable.

## Conclusion

`READY_FOR_TENCENT_DEPLOY`

Proceed with Tencent Cloud Docker Compose deployment and run the staged import plan using `--batch-size 20000 --search-raw-info false`. Keep the local `books` 500k index as the demo/proof index and do not run full import locally.
