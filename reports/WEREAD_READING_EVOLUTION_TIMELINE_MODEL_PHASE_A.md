# WEREAD Reading Evolution Timeline Model — Phase A Report

**STATUS: PASS**

---

## STATUS

PASS — S27P-1 Reading Evolution Timeline Model is in place.

## MODEL_SCOPE

- **Inputs**: `WereadReadingArchive` from the archive model (already
  pure-functional, already privacy-safe, already deterministic).
- **Outputs**: `WereadReadingEvolutionTimeline` containing
  per-year normalised nodes, adjacent-year transitions with metric
  deltas + Top N book diff + overlap, milestones (first/latest/
  year_gap/statistical_shift), and summary counters.
- **No requests, no AI, no persistence**: `meta.persisted=false`
  hard-coded; `meta.source="current_loaded_archive"` hard-coded.
- **No DOM, no React, no fetch, no storage writes, no `Date.now()`
  inside the algorithm**.

## YEAR_NODE_RESULT

`buildReadingEvolutionYearNodes(archive)`:

| Concern | Behaviour |
|---------|-----------|
| Empty archive | Returns `[]` |
| Single year | Returns `[yearNode]` |
| Multiple years | Returns sorted ascending by year |
| Duplicate year numbers | Last entry wins (deterministic) |
| NaN numeric fields | → 0 |
| Infinity numeric fields | → 0 |
| Negative numeric fields | → 0 |
| topBooks ordering | by archive position (rank asc) |
| topBooks deduplication | catalogId unique within a year |
| topBooks fields | only catalogId, title, author, publisher, publishYear, rank |
| averageRecordsPerActiveMonth | `totalRecords / activeMonths`, 0 when activeMonths=0 |
| All numeric outputs | finite (no NaN / Infinity in output JSON) |

## TRANSITION_RESULT

### Per-transition structure
`ReadingEvolutionTransition` carries:

- `fromYear`, `toYear` (chronologically adjacent loaded years)
- `metrics`: `totalRecords`, `matchedRecords`, `matchedBooks`,
  `activeMonths` — each a `ReadingEvolutionMetricDelta` with
  `{ absolute, percentage, direction }`
- `topListOverlap`: `{ commonBooks, unionBooks, ratio }`
- `books`: `{ continued, entered, left }` arrays of
  `ReadingEvolutionBookDiff` capped at 12 each
- `reasons`: array of `ReadingEvolutionTransitionReason`
- `significanceScore`: integer sum of per-reason scores
- `significant`: boolean (year_gap always true, otherwise score ≥ 50)

### Delta reuse
`calculateReadingEvolutionDelta` delegates to
`calculateMetricDelta` from `wereadDualPeriodComparison`. The two
models share identical delta semantics (increase / decrease / same /
from_zero / to_zero, percentage rounding to 1 decimal, percentage=null
for from_zero, percentage=-100 for to_zero). NO third delta rule set
was introduced.

### Book diff
- `continued`: in both lists — sorted currentRank asc, previousRank asc, title stable
- `entered`: only in current — sorted currentRank asc, title stable
- `left`: only in previous — sorted previousRank asc, title stable
- `rankDelta = previousRank - currentRank` (positive = current rank numerically smaller)
- Each bucket capped at 12

### Overlap
- `ratio = common / union`, normalised to [0, 1], rounded to 4 decimal places
- Both lists empty → `{ commonBooks: 0, unionBooks: 0, ratio: 0 }`
- Never NaN; never Infinity

### Reasons
| Reason | Trigger |
|--------|---------|
| `year_gap` | `toYear - fromYear > 1` |
| `records_shift` | `max/ min >= 2` AND `|cur - prev| >= 20` |
| `active_months_shift` | `|cur - prev| >= 5` |
| `matched_books_shift` | `|cur - prev| >= 5` AND `max/min >= 1.5` |
| `low_top_list_overlap` | both lists non-empty AND `ratio < 0.2` |

These tags describe statistical difference only. No "preference",
"interest drift", "stable reader", "quality change", or any
inference-language label is emitted.

### Significance score
| Reason | Score |
|--------|-------|
| `year_gap` | 100 |
| `records_shift` | 35 |
| `active_months_shift` | 25 |
| `matched_books_shift` | 20 |
| `low_top_list_overlap` | 25 |

`significant` iff `year_gap` is present OR score ≥ 50.

## MILESTONE_RESULT

`buildReadingEvolutionMilestones(yearNodes, transitions)`:

- **Empty archive**: `[]`
- **Single year**: exactly one milestone, `kind="first_year"`,
  no synthetic transition
- **Multi-year**: always emits `first_year` and `latest_year`
- **Significant transition**:
  - `year_gap` reason → milestone `kind="year_gap"`, year=toYear
  - other significant → milestone `kind="statistical_shift"`, year=toYear
- **Sort**: year ascending; ties broken by kind order
  first_year < year_gap < statistical_shift < latest_year
- **Dedup**: by (year, kind)

## PRIVACY_RESULT

### Allowed fields (output)

`ReadingEvolutionYearNode`: `year`, `totalRecords`, `matchedRecords`,
`matchedBooks`, `activeMonths`, `averageRecordsPerActiveMonth`,
`topBooks[]`.

`ReadingEvolutionBook`: `catalogId`, `title`, `author`, `publisher`,
`publishYear`, `rank`.

`ReadingEvolutionTransition.metrics.*`: `absolute`, `percentage`,
`direction` (only).

`ReadingEvolutionTransition.topListOverlap`: `commonBooks`,
`unionBooks`, `ratio` (counts only).

`ReadingEvolutionTransition.books.*`: only the public catalog fields
listed above.

`ReadingEvolutionMilestone`: `year`, `kind`, `transitionIndex`,
`reasons`, `significanceScore`.

`summary`: numeric counters and `firstYear` / `latestYear` only.

`meta`: `source` and `persisted` only.

### Excluded fields (output)

- `note.text` / `note.comment` / `markedText`
- `wereadBookId` / `noteId` / `highlightId` / `chapterTitle`
- `Authorization` / `token=`
- AI summary body / themes
- Raw archive JSON
- Request / cache metadata
- Note comments / highlight text / chapter titles

### Debug snapshot

`buildReadingEvolutionDebugSnapshot(timeline)` returns:

```ts
{
  yearCount: number;
  yearNumbers: number[];
  transitionCount: number;
  milestoneCount: number;
  milestoneKinds: ReadingEvolutionMilestoneKind[];
  reasons: ReadingEvolutionTransitionReason[];
  significanceScores: number[];
  persisted: boolean;
}
```

No title, author, catalogId, records detail, token, raw archive,
or request/cache info. Verified by test #56 and #57.

### Inference-language scan

`READING_EVOLUTION_FORBIDDEN_PSYCHOLOGICAL_WORDS` includes: 心理, 兴趣,
人格, 质量, 成长, 退步, 改善, 提升, 稳定, 变化, 巅峰, 低谷, 成熟期,
探索期, 转折点, 阅读质量, 阅读低谷, 阅读巅峰, 能力变化, 偏好改变.

Production model file contains zero occurrences of these strings
outside the constant array declaration. Verified by
`/tmp/model-stripped.ts` scan.

## TEST_RESULT

### Targeted
`wereadReadingEvolutionTimeline.test.ts`:
- **72 tests PASS** (exceeds the 60-test requirement).
- Tests 1–4: archive shape (empty / single / multi / dup)
- Tests 5–7: numeric normalisation (NaN / Infinity / negative)
- Tests 8–10: topBooks (order / dedup / public fields)
- Tests 11–16: delta math
- Tests 17–23: book diff (continued / entered / left / rankDelta / sort / cap)
- Tests 24–26: overlap math
- Tests 27–39: transition reasons (each trigger + combinations)
- Tests 40–42: significance score (year_gap / 50 / below 50)
- Tests 43–49: milestones (first / latest / single / year_gap / statistical_shift / sort / dedup)
- Tests 50–55: summary + persisted + deterministic
- Tests 56–65: privacy scan (catalogId / title / note / private IDs / token / AI / storage / inference / NaN / HTML)
- Tests 66–68: privacy notice / forbidden tokens list / threshold exported
- Tests 69–70: archive with / without recurringBooks
- Tests 71–72: end-to-end multi-year pipeline

### Full vitest
- 2088 tests PASS across 69 files.

### tsc
- `apps/web/tsconfig.json --noEmit` clean.

## KNOWN_LIMITATIONS

- Max 20 years inherited from the archive model.
- Top N book diff is bounded by current `archive.meta.topBooksLimit`
  (6 / 12 / 18). Switching Top N produces a different diff.
- Significance thresholds (2x / 1.5x / 5 / 20 / 0.2) are deterministic
  heuristics — not calibrated against any reader cohort.
- The model does NOT explain why metrics differ; it only describes
  the difference with a numeric delta and an enum reason.
- No topic / category / era / sentiment analysis.
- No manually editable milestones.
- No custom reason thresholds.

## NEXT_STEP

`S27P-2 Reading Evolution Timeline Dashboard` — produce a dashboard
view that consumes this timeline model and renders the per-year
nodes, transition diffs, and milestone markers as JSX. UNBLOCKED
upon completion of this phase.
