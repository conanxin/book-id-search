# Windows 无 Docker 本地运行

## 适用场景

本方式适合 Windows 本地测试，尤其是没有 Docker Desktop 时验证 Meilisearch、API、前端和导入脚本。它不是推荐生产部署方式；生产环境优先使用 Docker Compose 和持久化数据盘。

## 准备 meilisearch.exe

可以从 Meilisearch GitHub Releases 下载 `meilisearch-windows-amd64.exe`，改名为 `meilisearch.exe`，放到一个本地工具目录，例如：

```powershell
C:\tools\meilisearch\meilisearch.exe
```

也可以放在临时目录，但临时目录不适合长期保存索引。

## 配置环境

```powershell
Copy-Item .env.example .env
```

确保 `.env` 中：

```text
MEILI_HOST=http://127.0.0.1:7700
MEILI_MASTER_KEY=book-id-search-dev-key
MEILI_INDEX=books
```

## 启动 Meilisearch

推荐使用项目里的启动脚本，默认把 Meilisearch 数据目录放到 H: 大盘：

```powershell
.\scripts\start-meili-windows.ps1
```

等价命令：

```powershell
New-Item -ItemType Directory -Force H:\book-id-search\meili_data
C:\Users\haili\AppData\Local\Temp\book-id-search-meili\meilisearch.exe --db-path H:\book-id-search\meili_data --http-addr 127.0.0.1:7700 --master-key book-id-search-dev-key --env development
```

如果你的 `meilisearch.exe` 不在默认位置，可以传入路径：

```powershell
.\scripts\start-meili-windows.ps1 -MeiliExe C:\tools\meilisearch\meilisearch.exe -DbPath H:\book-id-search\meili_data
```

旧的通用示例：

```powershell
New-Item -ItemType Directory -Force C:\data\book-id-search\meili_data
C:\tools\meilisearch\meilisearch.exe --db-path C:\data\book-id-search\meili_data --http-addr 127.0.0.1:7700 --master-key book-id-search-dev-key --env development
```

另开一个 PowerShell 验证：

```powershell
Invoke-RestMethod http://127.0.0.1:7700/health
```

## 导入样例并启动项目

```powershell
pnpm install
pnpm import:sample
pnpm dev
```

- 前端：http://localhost:5173
- API：http://localhost:3001/api/health
- Meilisearch：http://localhost:7700

## 导入前 100000 行真实 TXT

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --limit 100000 --reset-index
pnpm verify
```

## 导入前 500000 行真实 TXT

先确认 preflight 不再因为系统盘空间不足而 BLOCKED：

```powershell
pnpm preflight:import -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --meili-data-dir "H:\book-id-search\meili_data" --report reports/full-import-preflight-h-drive.json
```

再运行 500000 行压测：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --offset 0 --limit 500000 --reset-index --checkpoint reports/import-checkpoint-500k.json --report reports/import-500k-report.json
pnpm verify
```

500000 行实测结果请看 `reports/REAL_500K_IMPORT_REPORT.md`、`reports/REAL_500K_SEARCH_VERIFY.md` 和 `reports/FRONTEND_500K_QA.md`。

当前实测摘要：

- Meilisearch 数据目录：`H:\book-id-search\meili_data`
- 导入数量：500000
- `failedParsed=0`
- `weakParsed=59332`
- H: 数据目录约 2.38 GiB
- 总墙钟耗时约 4.43 小时
- 结论：500000 行本地演示和压测可用；本机继续 1000000 行或全量不推荐作为常规方案，建议腾讯云 Docker Compose 全量导入。

## 注意事项

- Windows binary 适合本地测试，不建议作为生产部署方式。
- 全量导入前先运行 `pnpm preflight:import`。
- Meilisearch 数据目录要放在空间充足的 SSD，不要放在空间很小的系统盘。
- 真实 TXT、Meilisearch 数据目录、checkpoint JSON 和 `meilisearch.exe` 不要复制进项目目录，也不要提交到 Git。
- 当前 H: 容量足够，但实际索引写入较慢；全量导入更建议放到腾讯云或其他 SSD 服务器。
