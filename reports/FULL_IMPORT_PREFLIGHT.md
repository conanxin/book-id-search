# 全量导入前置检查

## 结论

- 状态：BLOCKED
- 文件：`/data/private/books.txt`
- 文件大小：625.49 MiB
- 估算总行数：4,685,280
- Meilisearch 数据目录：`/data/book-id-search/meili_data`

## 空间估算

- 基线导入行数：100000
- 基线索引体积：608.25 MiB
- 估算倍率：1.5
- 估算全量索引体积：41.75 GiB
- 建议可用空间：41.87 GiB
- TXT 所在盘剩余：37.19 GiB
- Meilisearch 数据盘剩余：37.19 GiB

## 原因

- Meilisearch 数据目录所在盘可用空间 37.19 GiB 小于建议空间 41.87 GiB

## 建议

- 最低测试配置：2 核 4GB / 80GB SSD。
- 推荐全量配置：4 核 8GB / 160GB SSD。
- 更稳配置：4 核 16GB / 200GB SSD。
- 先导入 500000 行，再导入 1000000 行，确认空间和耗时后再跑全量。
- 将 Meilisearch 数据目录放在容量充足的 SSD 数据盘，不建议放在空间很小的系统盘。
