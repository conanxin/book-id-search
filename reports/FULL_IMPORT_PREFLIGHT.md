# 全量导入前置检查

## 结论

- 状态：READY
- 文件：`/data/book-id-search/private-data/books.txt`
- 文件大小：625.49 MiB
- 估算总行数：4,685,280
- Meilisearch 数据目录：`/data/book-id-search/meili_data`
- 使用 Profile：minimal
- 基于报告估算：reports/books_bench_full_minimal_no_raw-import-report.json

## 空间估算

### Profile 实测估算
| 项目 | 数值 |
|------|------|
| 保守估算（standard） | 21.60 GiB |
| 实测 Profile 估算 | 0.00 MiB |
| 当前磁盘剩余 | 35.19 GiB |
| 导入后估算剩余 | 35.19 GiB |
| 要求导入后剩余 | 15.00 GiB |
| **全量决策** | **SAFE** |

### 基线信息
- 基线导入行数：500000
- 基线索引体积：1.54 GiB
- 估算倍率：1.5
- 建议可用空间：125.10 MiB
- TXT 所在盘剩余：35.19 GiB
- Meilisearch 数据盘剩余：35.19 GiB

## 原因

- 使用报告 reports/books_bench_full_minimal_no_raw-import-report.json 进行估算: 100000 行基线

## 建议

- 使用 profile: minimal
- 目标：导入后剩余 >= 15 GiB
- 最低测试配置：2 核 4GB / 80GB SSD。
- 推荐全量配置：4 核 8GB / 160GB SSD。
- 更稳配置：4 核 16GB / 200GB SSD。
- 先导入 500000 行，再导入 1000000 行，确认空间和耗时后再跑全量。
- 将 Meilisearch 数据目录放在容量充足的 SSD 数据盘，不建议放在空间很小的系统盘。
