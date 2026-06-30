# 真实 500000 行导入压测报告

## 结论

- 状态：PASS
- 数据文件：`E:\读秀512w（下架书及ss与isbn码）.txt`
- Meilisearch 数据目录：`H:\book-id-search\meili_data`
- Meilisearch index：`books`
- 导入上限：500000 行
- 最终文档数：500000

## Meilisearch 迁移

- 已停止旧 C: 临时目录进程：是
- 旧数据目录：`C:\Users\haili\AppData\Local\Temp\book-id-search-meili\data`
- 新数据目录：`H:\book-id-search\meili_data`
- 当前启动命令：

```powershell
C:\Users\haili\AppData\Local\Temp\book-id-search-meili\meilisearch.exe --db-path H:\book-id-search\meili_data --http-addr 127.0.0.1:7700 --master-key book-id-search-dev-key --env development
```

- 当前健康状态：`/health` available
- 7700 端口：由 H: 数据目录的 `meilisearch.exe` 监听

## H: Preflight

- 命令：`pnpm preflight:import -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --meili-data-dir "H:\book-id-search\meili_data" --report reports/full-import-preflight-h-drive.json`
- 状态：READY
- 保守全量索引估算：41.75 GiB
- 建议可用空间：41.87 GiB
- preflight 时 H: 可用空间：167.90 GiB
- 报告：`reports/FULL_IMPORT_PREFLIGHT_H_DRIVE.md`

## 导入过程

第一次启动命令：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --offset 0 --limit 500000 --reset-index --checkpoint reports/import-checkpoint-500k.json --report reports/import-500k-report.json
```

第一次运行在 200000 行后遇到 Meilisearch task 等待 120 秒超时。该 task 随后在 Meilisearch 中成功完成，checkpoint 保留在 200000 行。

随后已把导入脚本 task 等待上限从 120 秒提高到 600 秒，并使用 checkpoint 续跑：

```powershell
pnpm import:file -- --checkpoint reports/import-checkpoint-500k.json --resume --batch-size 5000 --report reports/import-500k-report.json
```

## 导入结果

| 指标 | 数值 |
| --- | ---: |
| imported | 500000 |
| totalLines | 500000 |
| weakParsed | 59332 |
| failedParsed | 0 |
| skipped | 0 |
| lastProcessedLine | 500000 |
| resumedFrom | 200000 |
| 脚本续跑耗时 | 14025.63 秒 |
| 总墙钟耗时 | 15963.57 秒 |
| 总墙钟耗时 | 4.43 小时 |
| 平均速度（按总墙钟） | 31.32 rows/sec |
| 平均速度（按续跑脚本） | 35.65 rows/sec |

解析 warning 汇总：

- `missing_isbn`
- `pages_non_numeric:1册`
- `year_non_numeric:1056`

## 索引与空间

- Meilisearch `numberOfDocuments`：500000
- Meilisearch `isIndexing`：false
- Meilisearch `rawDocumentDbSize`：262213632 bytes
- H: 数据目录大小：2.38 GiB
- H: 剩余空间：165.53 GiB

## 判断

500000 行导入稳定性通过，解析失败为 0，checkpoint 续跑可用。H: 大盘容量充足，但持续索引吞吐较低，不建议在本机直接跑全量导入。
