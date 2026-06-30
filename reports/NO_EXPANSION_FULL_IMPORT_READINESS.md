# No-Expansion Full Import Readiness Report

Date: 2026-06-30

## Current State

| Item | Value |
|------|-------|
| Total books in source | 5,115,734 |
| Current index size | 500,000 books |
| Current meili_data size | 1.6 GB |
| Current disk free space | 36 GB |

## Benchmark Baseline (100k books)

| Profile | Raw DB Size | Bytes/Doc | Rows/Sec |
|---------|-------------|-----------|----------|
| minimal + rawInfo | 40.84 MB | 428 bytes | 4,830 |
| minimal - rawInfo | 23.83 MB | 250 bytes | 5,512 |

Scale factor to full import: 51.16x

## Full Import Estimates

### Profile: MINIMAL + rawInfo stored

| Scenario | Estimated Size | Estimated Time | Free After Import | 15GB Safety Margin |
|----------|----------------|----------------|-------------------|---------------------|
| Conservative | 2.04 GB | 17.7 min | 32.7 GB | ✅ YES |
| Neutral | 1.73 GB | 17.7 min | 32.7 GB | ✅ YES |
| Optimistic | 1.43 GB | 17.7 min | 32.7 GB | ✅ YES |

### Profile: MINIMAL - rawInfo (RECOMMENDED)

| Scenario | Estimated Size | Estimated Time | Free After Import | 15GB Safety Margin |
|----------|----------------|----------------|-------------------|---------------------|
| Conservative | 1.19 GB | 15.5 min | 33.4 GB | ✅ YES |
| Neutral | 1.01 GB | 15.5 min | 33.4 GB | ✅ YES |
| Optimistic | 0.83 GB | 15.5 min | 33.4 GB | ✅ YES |

## Conclusion

| Recommendation | Status |
|----------------|--------|
| READY_NO_EXPANSION_STANDARD_RAW | ❌ NO |
| READY_NO_EXPANSION_MINIMAL_RAW | ✅ YES |
| READY_NO_EXPANSION_MINIMAL_NO_RAW | ✅ YES |

## Final Recommendation

**Use MINIMAL profile with storeRawInfo=false**

- Storage savings: ~42% vs rawInfo stored
- Time savings: ~12% faster
- Safety margin: 33.4 GB free after import (well above 15GB requirement)
- Full search capability preserved
