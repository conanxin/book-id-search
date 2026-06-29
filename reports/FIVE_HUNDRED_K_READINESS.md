# 500000 行压测准备报告

## 结论

- 状态：BLOCKED
- 是否运行 500000 行导入：否
- 阻塞原因：当前运行中的 Meilisearch 仍使用 C: 临时数据目录，不满足“只有实际使用大盘目录时才允许跑 500000”的条件。

## 存储探测

- 推荐盘符：`H:\`
- 推荐 Meilisearch 数据目录：`H:\book-id-search\meili_data`
- 推荐盘剩余空间：167.90 GiB
- 500000 行压测建议最低剩余空间：80 GiB

各盘剩余空间见 `reports/STORAGE_TARGETS.md` 和 `reports/storage-targets.json`。

## 当前 Meilisearch

当前进程命令：

```text
"C:\Users\haili\AppData\Local\Temp\book-id-search-meili\meilisearch.exe" --db-path C:\Users\haili\AppData\Local\Temp\book-id-search-meili\data --http-addr 127.0.0.1:7700 --master-key book-id-search-dev-key --env development
```

当前目录适合 100000 行演示索引，不建议继续 500000 行或全量导入。

## 最短迁移命令

停止当前 Meilisearch：

```powershell
Stop-Process -Name meilisearch
```

使用大盘目录启动：

```powershell
New-Item -ItemType Directory -Force H:\book-id-search\meili_data
C:\Users\haili\AppData\Local\Temp\book-id-search-meili\meilisearch.exe --db-path H:\book-id-search\meili_data --http-addr 127.0.0.1:7700 --master-key book-id-search-dev-key --env development
```

重新恢复 100000 行演示索引：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --limit 100000 --reset-index --checkpoint reports/import-checkpoint-100k.json --report reports/import-100k-report.json
pnpm verify
```

确认运行目录已经是 `H:\book-id-search\meili_data` 后，再跑 500000 行：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --offset 0 --limit 500000 --reset-index --checkpoint reports/import-checkpoint-500k.json --report reports/import-500k-report.json
```

## 建议

- 本机可以继续保留当前 100000 行演示索引。
- 500000 行压测前先迁移 Meilisearch 数据目录到 H: 或腾讯云 SSD 数据盘。
- 全量导入前继续执行 `pnpm preflight:import`，并确认 `MEILI_DATA_DIR` 不在小容量系统盘。
