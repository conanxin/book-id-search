# P3 8-case pilot — PARTIAL

Historical frozen S31 v1.1 pooled ranking. Not independent new retrieval; no significance test.
Problems: ['batch1_B: INVALID_RANKED_IDS: edition-choice-05']

## Aggregates
| Metric | A | B |
|---|---:|---:|
| diagnosis_correct | 6 | 6 |
| mean_ndcg10 | 0.552541 | 0.494319 |
| baseline_mean_ndcg10 | 0.375146 | 0.297217 |
| mean_delta_ndcg10 | 0.177394 | 0.197102 |
| call_elapsed_seconds | 131.086 | 146.34 |

## Case-level
| Case | Arm | Gold | Prediction | Correct | Baseline nDCG | nDCG | Δ |
|---|---|---|---|---|---:|---:|---:|
| edition-choice-01 | A | rank_order | rank_order | True | 0.698661 | 0.876037 | 0.177376 |
| edition-choice-01 | B | rank_order | rank_order | True | 0.698661 | 0.87959 | 0.180929 |
| edition-choice-02 | A | rank_order | candidate_gap | False | 0.177595 | 0.498573 | 0.320978 |
| edition-choice-02 | B | rank_order | candidate_gap | False | 0.177595 | 0.498573 | 0.320978 |
| edition-choice-05 | A | healthy | rank_order | False | 0.92065 | 0.963645 | 0.042995 |
| edition-choice-06 | A | rank_order | rank_order | True | 0.58833 | 1.0 | 0.41167 |
| edition-choice-06 | B | rank_order | rank_order | True | 0.58833 | 1.0 | 0.41167 |
| exact-natural-02 | A | candidate_gap | candidate_gap | True | 0.0 | 0.0 | 0.0 |
| exact-natural-02 | B | candidate_gap | candidate_gap | True | 0.0 | 0.0 | 0.0 |
| exact-natural-03 | A | candidate_gap | candidate_gap | True | 0.0 | 0.0 | 0.0 |
| exact-natural-03 | B | candidate_gap | candidate_gap | True | 0.0 | 0.0 | 0.0 |
| exact-natural-06 | A | rank_order | rank_order | True | 0.50016 | 0.734751 | 0.234591 |
| exact-natural-06 | B | rank_order | rank_order | True | 0.50016 | 0.734751 | 0.234591 |
| exact-natural-10 | A | rank_order | rank_order | True | 0.115773 | 0.347319 | 0.231546 |
| exact-natural-10 | B | rank_order | rank_order | True | 0.115773 | 0.347319 | 0.231546 |
