# Import Performance Benchmark

- Started: 2026-06-30T08:07:15.057Z
- Finished: 2026-06-30T08:08:10.392Z
- Meilisearch data dir: `H:\book-id-search\meili_data`
- Benchmark indexes kept: no
- Limit downgrade: S13 500k import was slow enough that three 50k benchmark runs could take too long on this machine.

| config | index | requested | effective | batch | rawInfo searchable | status | elapsed | rows/sec | task wait | size delta | docs |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| baseline-small | books_bench_baseline | 50000 | 20000 | 5000 | true | PASS | 29.35 | 681.43 | 27.05 | 128.16 MiB | 20000 |
| compact-search | books_bench_compact | 50000 | 20000 | 10000 | false | PASS | 12.77 | 1566.17 | 11.71 | 57.64 MiB | 20000 |
| larger-batch | books_bench_large_batch | 50000 | 20000 | 20000 | false | PASS | 9.24 | 2164.5 | 8.43 | 43.20 MiB | 20000 |

## Cleanup
- books_bench_baseline: deleted
- books_bench_compact: deleted
- books_bench_large_batch: deleted

## Recommendation
- Fastest successful config: `larger-batch` (2164.5 rows/sec, batch size 20000, searchRawInfo=false).
- Production should prefer `--search-raw-info false` if search quality comparison also passes.
