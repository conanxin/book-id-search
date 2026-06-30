# book-id-search

一个图书 SSID / DXID / ISBN 元数据检索工具。项目把本地私有 TXT 书目索引流式导入 Meilisearch，提供中文 Web 检索界面和 Express API。

本项目只检索书目元数据，例如书名、作者、出版社、出版年、页数、ISBN、SSID、DXID 和原始记录。它不包含图书全文，不接入外部图书 API，也不会伪造图书简介。

## 功能

- 搜索书名、作者、出版社、ISBN、SSID、DXID
- Meilisearch 中文模糊搜索
- 详情页展示原始记录 `rawInfo`
- 相关图书检索
- 大 TXT 流式导入
- 支持 offset / checkpoint / resume
- 支持 Windows 无 Docker 本地测试
- 支持 Docker Compose 部署到腾讯云

## 当前验证状态

- 本地真实 TXT 100000 行验证通过
- 本地真实 TXT 500000 行演示索引验证通过
- 当前本地 `books` index: `500000` documents
- 解析失败：`failedParsed=0`
- 弱解析主要来自缺失 ISBN，`rawInfo` 已保留
- S14 benchmark 显示 `--search-raw-info false` 对 SSID / DXID / ISBN / 书名 / 作者 / 出版社核心搜索无影响，并显著提升导入速度
- 全量导入策略结论：`READY_FOR_TENCENT_DEPLOY`

推荐生产导入参数：

```bash
--batch-size 20000 --search-raw-info false --wait-timeout-ms 900000
```

## 技术栈

- Frontend: Vite + React + TypeScript
- Backend: Node.js + Express + TypeScript
- Search: Meilisearch
- Import scripts: TypeScript + streaming readline
- Deployment: Docker Compose + Nginx
- Workspace: pnpm

## 为什么真实 TXT 不进 GitHub

真实 TXT 体积大，且属于本地或服务器私有数据源。仓库只保存代码、文档和小样例数据。真实 TXT、`.env`、`.deploy.env`、`meili_data`、checkpoint JSON、日志、`meilisearch.exe` 都不应提交到 Git。

仓库内只包含 `data/sample-books.txt` 作为公开样例。

## 本地启动

有 Docker：

```bash
pnpm install
cp .env.example .env
docker compose up -d meilisearch
pnpm import:sample
pnpm dev
```

无 Docker 的 Windows 本地测试见 [docs/RUN_WITHOUT_DOCKER_WINDOWS.md](docs/RUN_WITHOUT_DOCKER_WINDOWS.md)：

```powershell
Copy-Item .env.example .env
.\scripts\start-meili-windows.ps1
pnpm install
pnpm import:sample
pnpm dev
```

默认地址：

- Web: http://localhost:5173
- API: http://localhost:3001/api/health
- Meilisearch: http://localhost:7700

## 样例导入

```bash
pnpm import:sample
pnpm verify
```

## 真实 TXT 导入

100000 行恢复验证：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --limit 100000 --reset-index --checkpoint reports/import-checkpoint-100k.json --report reports/import-100k-report.json
pnpm verify
```

500000 行验证：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --offset 0 --limit 500000 --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-500k.json --report reports/import-500k-report.json
pnpm verify
```

断点续跑：

```bash
pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

## Import Benchmark

```powershell
pnpm benchmark:import -- --file "E:\读秀512w（下架书及ss与isbn码）.txt"
```

S14 benchmark 摘要：

| config | rows | batch size | rawInfo searchable | rows/sec | result |
| --- | ---: | ---: | --- | ---: | --- |
| baseline-small | 20000 | 5000 | true | 681.43 | PASS |
| compact-search | 20000 | 10000 | false | 1566.17 | PASS |
| larger-batch | 20000 | 20000 | false | 2164.50 | PASS |

`--search-raw-info false` 只是不把原始整行放进全文搜索字段；`rawInfo` 仍然保存在文档里，并在前端详情页可查看/复制。

## API

```text
GET /api/health
GET /api/search?q=&page=&limit=
GET /api/books/:id
GET /api/books/:id/related
GET /api/stats
```

搜索响应：

```json
{
  "total": 1,
  "page": 1,
  "limit": 20,
  "items": []
}
```

## 腾讯云部署

推荐配置：

- 最低测试：2 核 4GB / 80GB SSD
- 推荐全量：4 核 8GB / 160GB SSD
- 更稳：4 核 16GB / 200GB SSD

生产环境建议把 `MEILI_DATA_DIR` 放在数据盘，例如 `/data/book-id-search/meili_data`。默认 Compose 只把 Meilisearch 7700 绑定到 `127.0.0.1:7700`，不要把 7700 暴露到公网。

最短部署流程：

```bash
export MEILI_MASTER_KEY="replace-with-a-long-random-secret"
./scripts/deploy/prepare-server.sh
./scripts/deploy/deploy-app.sh
```

上传真实 TXT：

```powershell
.\scripts\deploy\upload-data.ps1 -Host "1.2.3.4" -User root -KeyPath "C:\path\to\key.pem"
```

云端 500000 行验证：

```bash
./scripts/deploy/import-500k.sh
./scripts/deploy/verify-remote.sh
```

全量导入建议在 `tmux` 或 `screen` 中运行，S15 不直接跑全量。完整策略见 [reports/FULL_IMPORT_STRATEGY.md](reports/FULL_IMPORT_STRATEGY.md)。

## 云端全量导入命令

S16 使用，不在 S15 执行：

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

## 文档

- [PRD](docs/PRD.md)
- [架构说明](docs/ARCHITECTURE.md)
- [数据格式](docs/DATA_FORMAT.md)
- [数据探测报告](docs/DATA_INSPECTION.md)
- [腾讯云部署](docs/DEPLOY_TENCENT_CLOUD.md)
- [运维手册](docs/OPERATIONS.md)
- [Windows 无 Docker 本地运行](docs/RUN_WITHOUT_DOCKER_WINDOWS.md)

## 常见问题

**为什么搜不到图书简介？**

项目只导入 TXT 中已有的书目元数据，不包含图书全文或简介，也不接入外部图书 API。

**为什么 weakParsed 不是错误？**

弱解析表示某些字段缺失或格式不标准，例如 ISBN 为空。记录仍会导入，`rawInfo` 会保留原始行，便于回溯。

**为什么全量导入需要较大磁盘？**

Meilisearch 会为中文搜索建立索引。全量导入需要给 TXT、Meilisearch 数据目录和备份预留足够空间，建议至少 160GB SSD。

## Cloud 500k Validation（Tencent CVM · 2026-06-30）

云端真实 TXT 500k 验证已经跑通，**不是**模拟数据。

- 主机：Tencent CVM `ubuntu@118.195.129.137`（2c8g · `/dev/vda2` 100G 系统盘，无独立 /data 盘）
- 真实 TXT：`/data/book-id-search/private-data/books.txt`（626 MiB · 5,115,734 行 · MD5 `7fe76a1bcbae248b104b86fd29b8b7a8`）
- 命令：

  ```bash
  ./scripts/deploy/import-500k.sh
  ```

- 推荐参数：`--batch-size 20000 --search-raw-info false --wait-timeout-ms 900000`
- 实测：

  | 指标 | 值 |
  |---|---|
  | elapsed | 162.62s |
  | rate | 3074.65 rows/s |
  | imported | **500000 / 500000** |
  | failedParsed | 0 |
  | weakParsed | 59332（missing_isbn 为主） |
  | meili_data | 136K → **1.6 GiB** |
  | root free | 38 GiB → 36 GiB |
  | `pnpm verify` | **PASS**（6/6 样例查询各 5 hits） |
  | 7700 公网 | **未开放** ✓ |

- 完整报告：`reports/TENCENT_500K_CLOUD_PASS_REPORT.md`
- 公网端口现状：`reports/PUBLIC_ACCESS_CHECK.md`

### 全量导入仍不建议在当前盘上跑

`reports/FULL_IMPORT_PREFLIGHT.md` 当前显示 `BLOCKED: estimatedFullIndex=41.75 GiB free=37.19 GiB`。
S16 前必须挂独立 `/data` 盘（**≥100GiB**，推荐 **160GiB+**），用 `scripts/deploy/import-full.sh`
跑全量。**不要**改 `MEILI_PORT_BIND`，**不要**碰 Caddy / 80 / 443。
