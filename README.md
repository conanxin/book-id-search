# book-id-search

一个开源的图书 SSID / DXID / ISBN 检索工具。项目把本地私有 TXT 书目元数据流式导入 Meilisearch，提供中文 Web 检索界面和 Express API。

本项目只检索书目元数据：书名、作者、出版社、出版年、页数、ISBN、SSID、DXID 和原始记录。它不自带图书全文，也不承诺提供图书内容简介。

## 当前状态

- 100000 行真实 TXT 导入和搜索验证已通过。
- 500000 行真实 TXT 导入和搜索验证已通过。
- 解析审计：`failedParsed=0`，`weakParsed=9813`，弱解析主要原因是 `missing_isbn`。
- 500000 行压测：`imported=500000`，`failedParsed=0`，`weakParsed=59332`，H: 数据目录约 2.38 GiB，总墙钟耗时约 4.43 小时。
- 全量索引空间按当前样本估算约 42 GiB，实际部署请预留更多空间。
- 推荐腾讯云全量配置：4 核 8GB / 160GB SSD 起步，更稳建议 4 核 16GB / 200GB SSD。
- 当前本机没有 Docker，本地测试使用 Windows Meilisearch binary；生产仍推荐 Docker Compose。
- Windows 无 Docker 推荐把 Meilisearch 数据目录放到 H: 大盘：`H:\book-id-search\meili_data`。
- H: 容量足够继续测试，但索引写入较慢，不建议在本机直接跑全量。

## 功能截图

> TODO：本地启动后可在这里放首页、结果页和详情页截图。

## 技术栈

- 前端：Vite + React + TypeScript
- 后端：Node.js + Express + TypeScript
- 搜索：Meilisearch，支持中文模糊搜索
- 导入：Node.js 流式读取大 TXT，支持分段、checkpoint、resume
- 部署：Docker Compose + Nginx
- 工作区：pnpm workspace

## 为什么真实 TXT 不进 Git

真实 TXT 文件体积大，并且属于本地或服务器私有数据源。仓库只保存代码、文档和可公开样例数据；真实 TXT 通过命令行参数导入，不复制进项目目录，也不提交到 Git。

## 本地启动

有 Docker 时：

```bash
pnpm install
cp .env.example .env
docker compose up -d meilisearch
pnpm import:sample
pnpm dev
```

- 前端：http://localhost:5173
- API：http://localhost:3001/api/health
- Meilisearch：http://localhost:7700

Windows 无 Docker 时，请看 [docs/RUN_WITHOUT_DOCKER_WINDOWS.md](docs/RUN_WITHOUT_DOCKER_WINDOWS.md)。最短流程：

```powershell
Copy-Item .env.example .env
.\scripts\start-meili-windows.ps1
pnpm install
pnpm import:sample
pnpm dev
```

## 样例导入

```bash
pnpm import:sample
pnpm verify
```

## 真实 TXT 导入

解析审计和全量前置检查：

```powershell
pnpm audit:parse -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --limit 100000
pnpm preflight:import -- --file "E:\读秀512w（下架书及ss与isbn码）.txt"
pnpm check:storage
```

恢复 100000 行真实演示索引：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --limit 100000 --reset-index --checkpoint reports/import-checkpoint-100k.json --report reports/import-100k-report.json
pnpm verify
```

500000 行压测命令。只有确认 Meilisearch 数据目录已经迁移到剩余空间充足的大盘后再运行：

```powershell
pnpm preflight:import -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --meili-data-dir "H:\book-id-search\meili_data" --report reports/full-import-preflight-h-drive.json
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --offset 0 --limit 500000 --reset-index --checkpoint reports/import-checkpoint-500k.json --report reports/import-500k-report.json
```

500000 行实测报告：

- `reports/REAL_500K_IMPORT_REPORT.md`
- `reports/REAL_500K_SEARCH_VERIFY.md`
- `reports/FRONTEND_500K_QA.md`
- `reports/NEXT_IMPORT_SCALE_RECOMMENDATION.md`

500000 行结果摘要：

- `imported=500000`
- `failedParsed=0`
- `weakParsed=59332`
- Meilisearch 数据目录：`H:\book-id-search\meili_data`
- H: 数据目录大小约 2.38 GiB
- 总墙钟耗时约 4.43 小时
- 结论：本机 500k 可用；本机 100w/全量不推荐作为常规方案，腾讯云全量推荐。

全量导入命令：

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --reset-index --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

断点续跑：

```powershell
pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume
```

## 搜索 API

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

最短步骤：

```bash
git clone <your-repo-url> book-id-search
cd book-id-search
cp .env.example .env
mkdir -p /data/book-id-search/meili_data
sed -i 's#MEILI_DATA_DIR=.*#MEILI_DATA_DIR=/data/book-id-search/meili_data#' .env
docker compose up -d --build
pnpm install
pnpm preflight:import -- --file "$HOME/private-data/books.txt" --meili-data-dir /data/book-id-search/meili_data
pnpm import:file -- --file "$HOME/private-data/books.txt" --offset 0 --limit 500000 --reset-index --checkpoint reports/import-checkpoint.json
pnpm import:file -- --checkpoint reports/import-checkpoint.json --resume
```

全量更推荐在腾讯云执行，而不是在当前 Windows 本机 H: 盘上执行。当前本机 500k 已证明功能可用，但导入吞吐偏慢。

详细步骤见 [docs/DEPLOY_TENCENT_CLOUD.md](docs/DEPLOY_TENCENT_CLOUD.md)，日常维护见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 常见问题

**为什么搜不到图书简介？**
项目只导入 TXT 中已有的书目元数据，不接入外部图书 API，也不生成内容简介。

**为什么 weakParsed 不是错误？**
弱解析表示某些字段缺失或不标准，例如 ISBN 为空。记录仍会导入，`rawInfo` 会保留原始行，便于回溯。

**为什么不要把 TXT 放进 Git？**
真实 TXT 体积大且属于私有数据。Git 仓库只应保存代码、文档和样例数据，真实数据放在本机或服务器私有目录。

同理，Meilisearch 数据目录、checkpoint JSON、`meilisearch.exe`、日志和构建产物也不应提交到 Git。

**为什么全量导入需要较大磁盘？**
Meilisearch 会为中文全文检索建立索引，索引体积通常大于原始 TXT 的线性切片。当前全量预估约 42 GiB，生产环境建议至少 160GB SSD。

**Docker 不存在怎么办？**
本地 Windows 测试可以使用 `meilisearch.exe`，生产部署建议使用 Docker Compose。

## 文档

- [PRD](docs/PRD.md)
- [架构说明](docs/ARCHITECTURE.md)
- [数据格式](docs/DATA_FORMAT.md)
- [数据探测报告](docs/DATA_INSPECTION.md)
- [腾讯云部署](docs/DEPLOY_TENCENT_CLOUD.md)
- [运维手册](docs/OPERATIONS.md)
- [Windows 无 Docker 本地运行](docs/RUN_WITHOUT_DOCKER_WINDOWS.md)
