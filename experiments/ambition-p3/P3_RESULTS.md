# P3｜Ambition Architect × BOOK-ID-SEARCH：八案例同模型对照试验

**Date:** 2026-10-14. **Status:** `FINISHED_WITH_INVALID_OUTPUT`（四个会话已完成；16 个拟评估 case×arm 输出中 15 个通过完整 ID 集合校验，1 个未通过）。**Conclusion:** 在本次小样本、同模型、同输入候选集的探索性研究里，六维提示词 B **没有表现出有意义的排序或诊断优势**。研究结果不可推出全局因果关系。

## 1. Protocol and provenance

- **Pre-registered before real A/B inference:** Git commit `d7503d7737127163c01fbf069e0b83bca3c16c7d` on separate `research/ambition-p3-ab-20261014` branch. The protocol, input selection, exact prompt hashes, diagnostic-proxy rubric, model parameters and fixed run order are in `PROTOCOL.md` and `preregistration.json`.
- **Frozen source:** BOOK-ID-SEARCH S31 v1.1 (`cases.json` + `qrels.tsv` + `baseline-current.json`), all unchanged; main source `8c9d3383b02e08e98b595dc58b76f3f93f7e1913`.
- **Eight handpicked tasks:** four `edition-choice` + four `exact-natural`. Purposefully sampled contrasting failure types (pool gap, misranking, healthy), not randomized, representative or independent.
- **Control A / method B:** both have the same ten ranked, publicly indexed book candidates and the same JSON output contract. A gets an ordinary search-quality prompt. B receives goal-oriented, deeper, cross-disciplinary, independent-evidence and effort-bounded instructions. No qrel grades or hidden proxy diagnoses are in either model prompt.
- **Same model:** Hermes Agent v0.21.3 local CLI, `minimax-cn/MiniMax-M3`, reasoning low; two fresh one-shot sessions per arm (4 cases per session). Starts occurred as registered A→B then B→A, but sessions within each batch overlapped, so execution timing is not strictly controlled.
- CLI `-t none` produced `Warning: Unknown toolsets: none`; **do not claim tool availability itself was formally disabled**. Independently exported each of the four new session summaries: all `tool_call_count=0`, `message_count=2`, `model=MiniMax-M3`; no actual tool calls observed. Only published public bibliographic input and the answer JSON, not full session export/system prompt.

## 2. Exact per-arm outcome

| Indicator | A ordinary | B ambition |
|---|---:|---:|
| Calls that returned | 2/2 | 2/2 |
| Cases with all original 10 IDs exactly once | **8/8** | **7/8** |
| Invalid candidate-ID set | 0 | **1** |
| Proxy diagnosis accuracy on the 7 shared valid cases | **6/7** | **6/7** |
| Mean nDCG@10 on the 7 shared valid cases | **0.493811** | **0.494319** |
| nDCG improvement versus frozen baseline on those 7 | **+0.196594** | **+0.197102** |
| Input tokens across two sessions | 5,574 | 5,832 |
| Output tokens across two sessions | 13,366 | 15,268 |
| Sum of session elapsed seconds | 131.086 | 146.340 |
| Tool calls across both sessions | 0 | 0 |

**Fair comparison:** B minus A = **+0.000508 nDCG@10** on the 7 valid paired cases. **Six of seven cases have equal final nDCG to the shown precision**; only `edition-choice-01` yields a tiny B advantage (0.879590 vs A 0.876037). The unequal-denominator overall means (A 8/8, B 7/8) must not be compared to claim one wins.

**Efficiency:** B used ~14.2% more output tokens and ~11.6% more summed session wall-clock time. Because runs were overlapped and provider load varies, these figures are observations, not a controlled speed comparison. Both arms require more model output tokens than the final displayed JSON because provider accounting includes billed completion tokens.

## 3. All paired case-level decisions (frozen QREL proxy)

| Case | Proxy gold | A diagnosis | B diagnosis | A nDCG | B nDCG |
|---|---|---|---|---:|---:|
| edition-choice-01 | rank_order | rank_order | rank_order | 0.876037 | 0.879590 |
| edition-choice-02 | rank_order | candidate_gap | candidate_gap | 0.498573 | 0.498573 |
| edition-choice-06 | rank_order | rank_order | rank_order | 1.000000 | 1.000000 |
| exact-natural-02 | candidate_gap | candidate_gap | candidate_gap | 0.000000 | 0.000000 |
| exact-natural-03 | candidate_gap | candidate_gap | candidate_gap | 0.000000 | 0.000000 |
| exact-natural-06 | rank_order | rank_order | rank_order | 0.734751 | 0.734751 |
| exact-natural-10 | rank_order | rank_order | rank_order | 0.347319 | 0.347319 |
| edition-choice-05 | healthy | rank_order | rank_order (INVALID IDs) | 0.963645 | not scored |

**Baseline nDCG** on shared valid cases averages approximately 0.297217. Positive improvements for candidate-gap cases remain exactly zero; reranking absent relevant candidates cannot create them. For `edition-choice-05`, baseline top-1 human grade is already 3, so both A/B calling it `rank_order` contradict the predefined operational proxy. B additionally fails the ID integrity gate.

## 4. New discovery: the judge can disagree with a genuinely useful diagnosis

The user question `edition-choice-02` is **“钱钟书围城 漓江1997和人民文学2000有什么版本差别”** — it explicitly requires **both** specified editions.

The actual baseline Top-10 contains `13295263_000007939550`, `围城`, 漓江出版社, 1997, human grade G3, at rank 6. **It contains no 人民文学出版社 2000 edition.** The mechanical rubric says `rank_order` because *at least one* candidate is labeled relevant. But both model arms diagnosed `candidate_gap`, correctly recognizing that a reliable two-edition comparison cannot be completed until the second target is found.

Therefore the rubric's apparent “error” is not necessarily a model error. **nDCG, single-candidate relevance and one diagnostic proxy are insufficient for multi-object research intents.** This is a judge-design finding, not evidence that the Ambition prompt succeeded: both arms reached the same diagnosis.

Proposed **P4 metric**, not retroactively applied to P3: `facet_coverage@K` = required target facets that have at least one verified candidate within top-K / total required target facets. On a two-version query, success requires independently identified records for both versions, then verified distinguishing facts. The current case would cover at most 1/2 facets among the top ten (recognition of 1997; 2000 absent). This requires separate human-adjudicated facet labels, not automatic inference from a single G3 row.

## 5. New discovery: model prose instructions do not guarantee exact machine IDs

The B response for `edition-choice-05` includes `11616539_000006031779` while the source candidate is `11616539_000006031079`. The last six digits contain a transposition/substitution. The program correctly **rejects** the entire invalid case; it does not repair the ID by edit distance, invent a new book, or score the model as successful.

**Design implication:** future tooling should ask the model to choose stable *1–10 candidate indices* or short ephemeral labels rather than copying 26-character IDs; a deterministic resolver can map them back to original `book_id` values. This is a proposed next-version test, not something retroactively applied.

## 6. Post-run technical amendment (does not change scoring)

The originally pre-registered `pilot.py` aborted an entire four-case batch on the first invalid case. After the first B output revealed the issue, the evaluator was changed to **mark that one case INVALID and continue evaluating the remaining cases**, preserving the original metric and diagnosis formula. Then a descriptive **paired valid-subset summary** was added so unequal-denominator aggregates cannot be mistakenly compared. Elapsed time was corrected to sum each real call once, including calls that contained invalid case outputs. The original frozen prompts, case selection, run order, grade mapping, ID integrity rule and metric definition **did not change**. This is a transparent parser/reporting amendment made after first data inspection; confirmatory analysis must start from a new frozen protocol.

## 7. Conclusions and boundaries

1. **No observed meaningful quantitative advantage:** The B method produced nearly identical rankings and diagnoses on valid shared cases, with higher token use and one extra ID-integrity failure.
2. **Valid new measurement problems:** The experiment exposed two separate verification needs: output-ID determinism and facet-complete evaluation for compound research questions.
3. **Scope:** This tests closed-pool metadata-only reranking and diagnosis, not research with archives, outside verification, software tools or prolonged Agent autonomy. It neither validates nor refutes Felix Rieseberg's general higher-level-ambition thesis.
4. **Needed next experiment:** P4-A deterministic index → book_id decoding + adversarial outputs; P4-B annotate multi-facet queries and use facet coverage alongside nDCG; P4-C multi-seed/held-out design with matched tool and time budgets to evaluate genuine goal-level problem solving. No search algorithm should be modified solely from this pilot.

**Safety:** All work stayed in new research worktree and Draft PR. No production services, indexes, PostgreSQL, released web UI, existing P2 PR #75, or `main` were changed. No merges or deployments.

## 8. Evidence bundle

- `PROTOCOL.md` and `preregistration.json` (pre-run Git commit).
- `outputs/batch1_A.prompt.txt`, `batch1_B.prompt.txt`, `batch2_A.prompt.txt`, `batch2_B.prompt.txt` (hash-locked input text).
- `outputs/batch*.raw.json` (four unchanged model outputs and stdout/stderr/latency).
- `outputs/pilot_results.json` and `.md` (machine evaluation; one invalid case).
- `outputs/session_audit.json` (only session model/usage/tool counts; session export full contents **not published**).
- `pilot.py`, `audit_sessions.py` (reproducible scripts).
- [Methodology master in Notion](https://app.notion.com/p/3f934a28189a81f2a7b6cbba2e35e1e0).
