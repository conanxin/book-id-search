# AI Quality Regression Report

Status: **PASS**

## Environment

- Public URL: https://books.conanxin.com
- AI enabled: true
- Docs count: 5115734
- Timestamp: 2026-07-02T03:56:04.928Z
- Git commit: unknown

## Totals

- Cases: 0
- Pass: 8
- Warn: 0
- Fail: 0
- Skipped: 1
- AI calls: 8

## Search Intent Cases

| Case | Query | Status | Latency | Notes |
|------|-------|--------|---------|-------|
| japanese-shawl-camisole | 时尚秋冬披肩、吊带 | PASS | 8ms | top=时尚秋冬披肩、吊带 |
| isbn-description | 满天繁星数成了你 | PASS | 4ms | top=满天繁星数成了你; warnings=2 |
| scarf-fashion | 围巾钩针技法 | PASS | 5ms | top=围巾钩针技法 |
| liao-architecture | 辽代金银器研究 | PASS | 6ms | top=辽代金银器研究 |
| luxun-publisher | 鲁迅全集  第5卷  伪自由书  准风月谈  花边文学 | PASS | 4ms | top=鲁迅全集  第5卷  伪自由书  准风月谈  花边文学 |
| low-confidence-weird-query | 月球 | PASS | 4ms | top=月球 |

## Book Insight Cases

| Case | BookId | Status | HTTP | Latency | Trust | Notes |
|------|--------|--------|------|---------|-------|-------|
| insight-complete-book | complete-book | PASS | 200 | 10ms | high | trust=high; cache.hit=true |
| insight-weak-missing-isbn | weak-missing-isbn | PASS | 200 | 4ms | low | quality.missingFields=isbn; trust=low; cache.hit=true |
| insight-not-found | not-found | SKIPPED | ? | 0ms | - | Skipped: live=false aiCallsUsed=8/10 |

## Findings

- Quality regression risks: none
- Prompt tuning candidates: see WARN cases above
- Failed cases: none

## Safety

- no import: true
- no reset: true
- no key leak: true
- no provider raw response exposed: true
