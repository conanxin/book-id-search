# No-Expansion Full Import Benchmark Report

Date: 2026-06-30

## Overview

Benchmark of 100,000 books with different storage profiles to estimate full import feasibility without disk expansion.

## Benchmark Results

| Metric | A: full-compact-raw-stored | B: full-minimal-no-raw |
|--------|----------------------------|------------------------|
| Profile | minimal (search/filter/sort) | minimal (search/filter/sort) |
| storeRawInfo | true | false |
| Imported | 100,000 | 100,000 |
| Elapsed Time | 20.70s | 18.14s |
| Rows/Second | 4830.9 | 5512.7 |
| Raw Document DB Size | 40.84 MB | 23.83 MB |
| Bytes/Document | 428.2 | 249.9 |

## Savings (B vs A)

- **Size**: 41.7% smaller (23.83 vs 40.84 MB)
- **Time**: 12.6% faster (18.1 vs 20.7 seconds)

## Search Verification

Both indices passed all search tests:
- ✅ SSID search
- ✅ ISBN search  
- ✅ Title search
- ✅ Author search

## Conclusion

Disabling `storeRawInfo` provides significant storage savings (~42%) while maintaining full search capability.
This is the recommended profile for full import without disk expansion.
