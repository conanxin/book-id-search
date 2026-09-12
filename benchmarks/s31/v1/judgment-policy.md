# BOOK-ID-SEARCH S31 Benchmark Judgment Policy v1

STATUS: FROZEN_V1

## Purpose

This benchmark measures whether BOOK-ID-SEARCH returns bibliographically
relevant records for natural-language book-finding and edition-selection
queries.

The benchmark uses pooled relevance judgments. It does NOT claim that every
relevant record in the full 5M+ catalog has already been judged.

## Grade scale

- G3 — highly relevant / preferred target
- G2 — relevant / acceptable
- G1 — partially relevant
- G0 — judged not relevant

Grades are ordinal relevance judgments used by Hit@K, MRR and nDCG@10.

## Pooled judgments and UNJUDGED semantics

`qrels.tsv` contains judgments only for records collected into the S31-v1
candidate pools.

A result ID absent from qrels is **UNJUDGED**.

UNJUDGED MUST NEVER be silently converted to G0.

If any evaluated Top-K result is UNJUDGED:

- benchmark verdict = `NEEDS_JUDGMENT`
- regression PASS is forbidden
- authoritative aggregate metrics MUST NOT be emitted as PASS evidence
- diagnostic details may still be reported
- the new record must be manually judged and qrels deliberately extended

This is fail-closed by design so a genuinely improved retrieval system is not
penalized merely because it retrieves a previously unseen relevant record.

## Frozen-version immutability

Once S31-v1 is committed as a frozen benchmark, its manifest, policy and
qrels are immutable benchmark evidence.

If a future retrieval run contains an UNJUDGED result:

- do not mutate frozen v1 in place
- manually judge the new record
- create a new benchmark revision/version containing the expanded judgments
- re-evaluate both the historical baseline and the candidate run against the
  same revised qrels before comparing metrics

This preserves apples-to-apples comparisons while still allowing the pooled
judgment set to grow deliberately in future benchmark revisions.

## exact-natural-01 through exact-natural-09

These are work-identification queries with an explicit or strongly implied
title and author.

General policy:

- G3 — exact target work title + target author, non-derived record
- G2 — expanded edition/record still clearly containing the target work
- G1 — collection/context record containing the target work, or a derived
  record that is still recognizably the requested work
- G0 — wrong work, wrong author, research about the work, biography,
  unrelated record, or clearly non-target derivative

The benchmark evaluates retrieval of the work, not preference among ordinary
publishers unless the case explicitly asks for an edition.

## exact-natural-10 — 《汉语大词典》

- G3 — record representing the dictionary work as a whole
- G2 — an individual dictionary volume
- G0 — research, errata, source-study, index, notes or other secondary work

## edition-choice-01 — 《围城》普通阅读

- G3 — 钱钟书原著、独立中文《围城》、非改编
- G2 — 原作合集/扩展记录
- G1 — 翻译或双语版本
- G0 — 编剧、改写、缩写、研究著作、非目标作品

## edition-choice-02 — 《围城》1997 漓江 vs 2000 人民文学

- G3 — exactly one of the two explicitly requested target editions:
  - 漓江出版社 1997
  - 人民文学出版社 2000
- G1 — another direct original Chinese edition of 钱钟书《围城》
- G0 — adaptation, screenplay, abridgment, translation, secondary work,
  or unrelated record

This case measures retrieval of the explicitly named comparison targets, not
general quality preference.

## edition-choice-03 — 《围城》较早版本

For direct, non-derived 钱钟书《围城》 records:

- G3 — publication year <= 1991
- G2 — publication year 1992–2000
- G1 — publication year > 2000
- G1 — year unknown: partially relevant, but cannot strongly satisfy
  “较早版本” without a date
- G0 — adaptation, translation or non-target record

## edition-choice-04 — 《呐喊》适合阅读

- G3 — 鲁迅原著、独立《呐喊》
- G2 — collection/expanded original record containing 《呐喊》
- G0 — research, biography, quotations, commemorative/secondary work,
  adaptation or unrelated record

## edition-choice-05 — 《乡土中国》经典版本

- G3 — 费孝通原著、独立中文《乡土中国》
- G2 — bilingual/translated original or expanded/collection edition that
  still contains the original work
- G0 — teaching aid, adaptation, rewritten edition, secondary interpretation
  or unrelated record

“经典” is operationalized as an original-author reading edition; the policy
does not claim a particular publisher is historically or critically superior.

## edition-choice-06 — 梁思成《中国建筑史》完整版本

- G3 — exact work 《中国建筑史》 by 梁思成
- G2 — expanded record clearly representing the same work
- G0 — 《图像中国建筑史》 or other different works, even when authored by
  梁思成; unrelated records

《图像中国建筑史》 and 《中国建筑史》 are treated as distinct works.

## edition-choice-07 — 《史记》点校本，不要学生版

- G3 — 中华书局 record explicitly identified as 点校本 / 点校本二十四史
- G2 — another direct 《史记》 edition explicitly identified as 点校/校订
- G1 — 中华书局 original-text edition whose collation status is not explicit
- G0 — adaptation, rewrite, 编译, student/children/youth edition,
  secondary work or unrelated record

## edition-choice-08 — 人民文学出版社《红楼梦》

- G3 — 《红楼梦》正文/校注 reading edition containing 曹雪芹 and published
  by 人民文学出版社
- G2 — 人民文学出版社 bilingual parallel-text edition
- G1 — correct original 《红楼梦》 work from another publisher
- G0 — research/reference material, adaptation, screenplay or unrelated work

Institution names such as “中国艺术研究院红楼梦研究所” do not by themselves
make a reading edition a secondary research work.

## edition-choice-09 — 《古文观止》注释比较完整

This case uses a metadata proxy only. Catalog metadata cannot establish the
actual scholarly completeness or quality of annotations.

- G3 — explicit 注释 / 注译 / 译注 / 注评 / 新注 / 评点 marker and not merely
  one numbered part-volume
- G2 — explicit annotation marker but only an individual part-volume
- G1 — original 吴楚材/吴调侯 work with no explicit annotation evidence
- G0 — 《续古文观止》, unrelated work or weak non-target match

## edition-choice-10 — behavior case

Query:

`同一本书有很多条记录 怎么找原版而不是编剧改写版`

This is a system-behavior question, not a single book-ranking qrel case.

It is excluded from Hit@K, MRR and nDCG metrics.

It should later be evaluated with explicit behavior assertions around
work clustering, original-vs-adaptation distinction and edition comparison.

## Metrics

For metric-eligible cases:

- relevance for Hit@K and MRR means grade > 0
- nDCG gain = `2^grade - 1`
- authoritative metrics require every evaluated Top-K result to be judged
- any UNJUDGED result changes the verdict to `NEEDS_JUDGMENT`
