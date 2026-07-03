# WeRead Match Confirmation Workflow

This document defines the manual confirmation layer for WeRead-to-catalog matches.

## Goal

- `weread-matches.generated.json` contains machine-generated match candidates only.
- `weread-match-review.json` is a review queue for human confirmation.
- Only `weread-matches.confirmed.json` should be used by a future private overlay API.

## File paths

| File | Path | Type |
|------|------|------|
| Generated matches input | `private-data/weread/derived/latest/weread-matches.generated.json` | Private, never committed |
| Review queue | `private-data/weread/derived/latest/weread-match-review.json` | Private, never committed |
| Confirmed matches output | `private-data/weread/derived/latest/weread-matches.confirmed.json` | Private, never committed |
| Summary | `private-data/weread/derived/latest/weread-match-confirmation-summary.json` | Private, never committed |

## Review item schema

```json
{
  "reviewId": "string",
  "wereadBookId": "string",
  "wereadTitle": "string",
  "wereadAuthor": "string",
  "status": "pending|accepted|rejected|needs_manual_search",
  "decisionSource": "auto_seed|manual",
  "selectedCatalogId": "string|null",
  "selectedCandidateIndex": "number|null",
  "confidence": "high|medium|low|none",
  "reason": "string",
  "candidates": [
    {
      "catalogId": "string",
      "ssid": "string",
      "dxid": "string",
      "isbn": "string|null",
      "title": "string",
      "author": "string",
      "matchMethod": "isbn|title_author|title_similarity",
      "matchConfidence": "high|medium|low",
      "reason": "string"
    }
  ],
  "notes": ""
}
```

## Confirmed match schema

```json
{
  "wereadBookId": "string",
  "catalogId": "string",
  "ssid": "string",
  "dxid": "string",
  "isbn": "string|null",
  "matchMethod": "isbn|title_author|title_similarity|manual",
  "matchConfidence": "high|medium|low",
  "decisionSource": "manual|auto_high_confidence",
  "confirmedAt": "string",
  "confirmedBy": "local-user"
}
```

## Status rules

- `pending`: not yet reviewed by a human.
- `accepted`: a candidate has been accepted.
- `rejected`: all current candidates rejected.
- `needs_manual_search`: no candidates were generated; a manual search in book-id-search is required.
- Only `accepted` items flow into `weread-matches.confirmed.json`.

## Privacy rules

- The review queue contains real titles and `wereadBookId`, so it must stay in `private-data/`.
- Do not commit the review queue or confirmed output.
- Do not write real titles, IDs, or notes into public reports.

## Recommended manual workflow

1. Confirm high-confidence candidates first.
2. Then review medium-confidence candidates.
3. Treat low-confidence candidates as reference only.
4. Mark items with no candidates as `needs_manual_search`.

## Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| Build review queue | `pnpm weread:review:build` | Convert generated matches into a review queue |
| Apply review decisions | `pnpm weread:review:apply` | Generate confirmed matches from accepted review items |
| Summarize review | `pnpm weread:review:summary` | Print anonymous statistics |
