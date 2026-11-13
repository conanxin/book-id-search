# P4｜Ambition Architect：Deterministic Candidate IDs × Facet-Aware Research Evaluation

**Date:** 2026-10-15 · **Status:** `OFFLINE_EVALUATOR_IMPLEMENTED_AND_CI_PASS / LIVE_MODEL_NOT_TESTED`  
**Source baseline:** BOOK-ID-SEARCH `main` at `8c9d3383b02e08e98b595dc58b76f3f93f7e1913`. Frozen S31 v1.1 source files are unchanged.  
**Upstream research:** [P3 Draft PR #76](https://github.com/conanxin/book-id-search/pull/76) · [P2 Draft PR #75](https://github.com/conanxin/book-id-search/pull/75) · [Notion research master](https://app.notion.com/p/3f934a28189a81f2a7b6cbba2e35e1e0).

## 1. What was actually done

P3 demonstrated two independent problems: (1) a model invented a near-miss long catalog ID; (2) nDCG and one relevant book fail to measure whether *both* explicitly requested editions have been found.

P4 implements two **experimental, read-only** utilities without changing production search ranking:

- `contract.py`: a model may submit only the **position indices** of candidates in the current request, as an exact permutation `1..N`. The trusted program maps each index to the unchanged source `book_id`. Duplicate IDs, missing candidate slots, strings, bools, out-of-range integers and unauthorized extra ID fields are rejected rather than repaired.
- `facet_eval.py` + `facets.json`: an explicitly authored list of must-have facets for five existing S31 v1.1 queries; the evaluator reports Top-K **bibliographic** coverage and distinguishes missing candidates from content needing direct primary evidence.

**The key separation:** Model outputs = selections/diagnoses, never authoritative IDs or proof of full text. Sources + original frozen QREL = catalog-level evidence, never automatically proof that the true publication is complete.

## 2. Deterministic ID protocol

A request supplies input rows `[{book_id, title, ...}]` in an immutable order. The model returns a structured record:

```json
{
  "results": [{
    "case_id": "case-from-request",
    "diagnosis": "rank_order",
    "ranked_indices": [3, 1, 2],
    "next_action": "Review the best candidate",
    "limitation": "Only catalog fields were available"
  }]
}
```

The example is illustrative for **three input candidates**. The resolver checks that `ranked_indices` has all positions exactly once and maps them using the trusted candidates. With ten candidates, it requires a permutation of exactly 1–10; the model never needs to reproduce long identifiers. Unexpected `ranked_ids` or other extra model-supplied keys make the response invalid.

**Guarantee:** If a response passes the strict decoder, all returned book IDs must come from the caller's vetted input list. **Non-guarantee:** this cannot make the model's ranking or bibliographic reasoning correct; invalid index arrays still require rejection, and a real-model error-rate comparison remains untested.

## 3. Independent multifacet audit: five frozen S31 v1.1 cases

The facets are manually documented, visible in `facets.json`, and evaluated *against the captured original Top-10 only*. Neither “missing in Top-10” nor “human bibliographic QREL” establishes facts about the entire multi-million-record corpus or actual textual completeness.

| Case / actual question | Bibliographic facets supported | Still missing / unverified | Baseline nDCG@10 |
| --- | ---: | --- | ---: |
| `edition-choice-02`：漓江 1997 vs 人民文学 2000《围城》 | **1/2** | 1997 appears at rank 6; 2000 edition absent from Top-10 | **0.177595** |
| `edition-choice-05`：《乡土中国》原著而非教辅改写 | **2/2** | Work identity and human-QREL bibliographic “standalone-original” type; **full text not reviewed** | **0.920650** |
| `edition-choice-06`：梁思成《中国建筑史》完整版本 | **1/2 confirmed at catalog level**, upper **2/2** | Exact bibliographic work present; completeness requires original page/content comparison, status `NEEDS_PRIMARY_EVIDENCE` | **0.588330** |
| `exact-natural-02`：鲁迅《呐喊》 | **0/1** | Named work not in the original Top-10; does **not** mean corpus-wide absence | **0.000000** |
| `exact-natural-10`：《汉语大词典》正文，非二手研究 | **1/1** | Frozen human qrel identifies an actual dictionary-work at rank 7; it does not prove complete original multivolume contents | **0.115773** |

The numerical `catalog_coverage_lower` is the count of `SUPPORTED_IN_POOL` facets divided by the total. The `catalog_coverage_upper` also includes facets explicitly marked `NEEDS_PRIMARY_EVIDENCE`, representing the *within-pool* hypothetical upper bound if original evidence becomes available—not a full-corpus recall estimate.

**New methodological result:** `exact-natural-10` has low nDCG (the actual dictionary is ranked 7th) yet already provides **100% catalog-level task-facet coverage**. Conversely, `edition-choice-02` has positive nDCG yet fails a **necessary second-edition constraint**. A ranking metric and task completion therefore answer different questions.

The completeness facet for `edition-choice-06` remains `NEEDS_PRIMARY_EVIDENCE`: it must not be satisfied by merely matching the title and author.

## 4. Testing and execution receipt

[GitHub Actions run #38654275759](https://github.com/conanxin/book-id-search/actions/runs/38654275759) — `success`, Python 3.12, **11/11 standard-library unit tests PASS**; read-only frozen S31 evaluator successfully processed **5 real queries / 8 manually specified facets**. Includes the Top-K boundary: the 1997 漓江 edition is absent at K=5 and present at K=6.

CI only invokes local Python and reads tracked S31 inputs; it does not call MiniMax, use login credentials, write PostgreSQL, rebuild Meili, deploy, or modify any previously frozen file.

Re-run from a checkout of this branch:

```bash
python -m unittest discover -s experiments/ambition-p4 -p 'test_*.py' -v
python experiments/ambition-p4/facet_eval.py --top-k 10 --output /tmp/ambition-p4-facets.json
```

The GitHub CI is a stronger external check than the author's own prose claims, but **a passing unit test is not a live-model performance benchmark**.

## 5. Why this is not a P3-to-P4 “win rate”

No MiniMax-M3 call used the short-index protocol in P4. The user’s remote Hermes host was listed as **Offline** at execution time, so there is no valid live-model comparison against P3’s 7/8 vs 8/8 raw-ID integrity. The P4 decoder fixes a particular *software boundary* (only source IDs can leave the resolver on valid input); it does not show that the model is more likely to return a valid permutation.

Likewise, the manually specified `facets.json` is a small casebook illustrating better evaluator semantics; it is **not** a large-scale human-independent validation of the user's actual task satisfaction.

## 6. Recommended P5 experiment

**P5-A: Actual MiniMax-M3 short-index versus raw-ID paired trial.** Freeze both prompts, case samples, identical model/provider/reasoning/time budgets before running; include `edition-choice-05` as a documented past failure and genuinely unseen additional queries. Compare exact-format validity, missing/duplicate positions, nDCG, useful evidence-correct diagnosis, token use and human review time. Record model/tool transcripts only to controlled local evidence, publish minimal results.

**P5-B: Extend facet evidence beyond bibliographic identity.** For compound historical research questions, require specific independent archive or field records for each facet; preserve `UNKNOWN / NOT_FOUND / VERIFIED` separately. Do not label historical artifacts as proven because a model repeats a plausible story.

**Exit criterion:** Prefer the simpler protocol if it improves ID determinism without adding meaningful overhead; otherwise record `NO_MEASURED_GAIN` and stop expanding the infrastructure.

**Boundary:** Draft research branch only. No merge, no production writes, no changes to P2 PR #75 or P3 PR #76.
