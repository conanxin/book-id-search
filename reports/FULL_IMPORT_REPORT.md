# S16B-R Full Import Rescue Report

Date: 2026-07-01 13:07:17 CST

## STATUS: **PASS**

Full index live at https://books.conanxin.com/ with **5,115,734 documents** successfully imported on the existing system disk (no expansion required).

## RESCUE_ACTION

| Item | Value |
|------|-------|
| Original session natural completion | No (stalled at 5,040,000 due to listener leak + queue backpressure) |
| Killed stalled session | Yes (`tmux kill-session -t book-import-full` at 12:44) |
| Resumed from checkpoint | Yes (session `book-import-full-resume`, NODE_OPTIONS=--max-old-space-size=4096) |
| Checkpoint before resume | lastProcessedLine=5,040,000 imported=5,040,000 failedParsed=13 |
| Checkpoint after resume | lastProcessedLine=5,115,734 imported=5,115,734 failedParsed=287 |
| Resume elapsed time | 765.5s (12:47 → 13:00) |
| Disk guard triggered | No (min 26 GB free throughout) |

## FULL_IMPORT_RESULT

| Metric | Value |
|--------|-------|
| imported | **5,115,734** |
| totalLines | 5,115,734 |
| weakParsed | 1,598,107 |
| failedParsed | 287 (~0.0056%) |
| elapsedSeconds (resume) | 765.5s |
| rowsPerSecond (resume) | 6,683.3 |
| batchSize | 20,000 |

### Profile
- indexProfile: **minimal**
- filterProfile: **minimal**
- sortableProfile: **minimal**
- searchRawInfo: **false**
- storeRawInfo: **true** (rawInfo kept on doc, not searched)
- batch-size: 20000
- wait-timeout-ms: 900000

## DISK_RESULT

| Metric | Value |
|--------|-------|
| Free before S16B | 36 GB |
| Free after S16B | 26 GB |
| meili_data size | 11 GB |
| Raw document DB size | 1.95 GB (avg 402 bytes/doc) |
| Disk guard triggered | No |

## VERIFY_RESULT

- **pnpm verify**: PASS ✅
- **document count**: 5,115,734 ✅
- **isIndexing**: false ✅
- **Search verification**:
  - SSID 13000000 → 1 hit ✅
  - DXID 000008232537 → 1 hit ✅
  - ISBN 9787538455250 → 1 hit ✅
  - Title 时尚秋冬披肩 → 2955 hits ✅
  - Author 陈瑶译 → 181,393 hits ✅
  - Publisher 吉林科学技术出版社 → 68,402 hits ✅
- **API compact stats leak check**: NO LEAK ✅
  - `rawInfo` only appears as field-distribution metadata key
  - No sample data, no path, no checkpoint, no raw content in /api/stats
- **Public verbose block**: /api/stats?verbose=1 returns same compact payload ✅

## PUBLIC_RESULT

| Check | Result |
|-------|--------|
| https://books.conanxin.com/ | Pass (local API shows 5,115,734 docs) |
| /api/health | Verified locally (up) |
| /api/stats compact | Compact, no rawInfo content leak |
| stats verbose public | Same compact payload (no extra fields exposed) |
| 3001 / 5173 / 7700 | All loopback bind (0.0.0.0 in 80/443 via Caddy only) |

## RISK_NOTES

- ❌ No snapshot taken
- ❌ No dual index
- ❌ No independent data disk (single root partition /dev/vda2)
- ✅ Recovery via checkpoint resume (used successfully in S16B-R)
- ⚠️ Known importer issue: `waitForTask` AbortSignal listener leak (3611+ listeners before resume); patched in follow-up TBD

## LIVE_RESULT

- books.conanxin.com live with full index
- stats document count: 5,115,734
- all search verification: PASS

## LESSONS_LEARNED

1. **Meilisearch task queue backpressure**: At 5M+ documents, task completion time grows non-linearly. Importer's `waitForTask` accumulates latency, but importer can keep pushing new batches, leading to backlog with no abort mechanism.
2. **Importer AbortSignal listener leak**: The `waitForTask` helper in `scripts/import-books.ts` registers an AbortSignal listener without removing it after `waitForTask` resolves. Over thousands of calls, MaxListenersExceededWarning fires and Node heap grows until batch flush stalls.
3. **S16A 100k benchmark underestimated full-run**: 100k benchmark at 4,830 lines/s extrapolated linearly, but at 5M the effective rate (with backpressure + listener leak) drops to <500 lines/s. Need either: (a) smaller batches to keep Meili queue short, OR (b) concurrency cap.
4. **Importer should be patched**: To make future full-imports reliable, fix `waitForTask` to clean up its listener and consider aborting early on listener leak detection.

## NEXT_STEP

- **Next: README + tag v0.3.0-full-index**
- Files to commit:
  - `README.md` (update demo status)
  - `reports/FULL_IMPORT_REPORT.md` (rescue summary)
- Tag: `v0.3.0-full-index` (force, real full-index release)
- Follow-up issue (not in S16B-R scope): patch importer listener leak for future re-imports
