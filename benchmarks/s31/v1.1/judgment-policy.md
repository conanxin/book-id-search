# S31 Benchmark Judgment Policy — v1.1

STATUS: FROZEN_V1_1

Parent benchmark: `../v1/`

All relevance semantics and grading rules are inherited from `../v1/judgment-policy.md`.
v1.1 changes no grading rule; it only adds judgments for eight previously UNJUDGED records surfaced by S31-B2.

## Frozen-version immutability

- do not mutate frozen v1.1 in place
- manually judge any newly surfaced record
- create a new benchmark revision/version
- re-evaluate historical baseline and candidate against the same revised qrels

## v1.1 judgment additions

| Case | Book ID | Grade | Rule | Rationale |
|---|---|---:|---|---|
| exact-natural-02 | `14088528_000015863489` | G2 | expanded-work | 鲁迅原著，明确包含目标作品《呐喊》；标题是扩展的短篇小说集记录，与冻结 qrels 中“呐喊 鲁迅小说精选/作品集”G2 标准一致。 |
| exact-natural-10 | `13232118_161000122651` | G2 | dictionary-volume | 《汉语大词典》单独卷，第1卷。 |
| exact-natural-10 | `13232119_000007916197` | G2 | dictionary-volume | 《汉语大词典》单独卷，第4卷。 |
| exact-natural-10 | `13232122_000007916387` | G2 | dictionary-volume | 《汉语大词典》单独卷，第12卷。 |
| exact-natural-10 | `13232124_000007916260` | G2 | dictionary-volume | 《汉语大词典》单独卷，第3卷。 |
| exact-natural-10 | `13175532_000008280748` | G3 | dictionary-work | 整体《汉语大词典》普及版本；不是编号单卷，也不是研究、索引或二手著作。 |
| exact-natural-10 | `13425340_000007987923` | G2 | dictionary-volume | 缩印本上册，属于整套词典中的单卷。 |
| exact-natural-10 | `13815521_000030104321` | G2 | dictionary-volume | 缩印本下册，属于整套词典中的单卷。 |
