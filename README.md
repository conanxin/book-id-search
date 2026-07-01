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

### 前端 UX (S17 + S18A)

- 搜索框：placeholder 含书名 / 作者 / 出版社 / ISBN / SSID / DXID；Enter 立即搜索；× 一键清空；300 ms debounce；输入空时显示 `输入关键词开始搜索`
- 结果高亮：title / author / publisher / isbn / ssid / dxid 内命中的查询词用 `<mark>` 包裹（大小写不敏感，中文原样匹配）
- 复制按钮：每张卡片可复制 SSID / DXID / ISBN / 整条；详情页可复制 SSID / DXID / ISBN / rawInfo；1.2 s 闪烁提示
- 结果导出（toolbar）：`复制链接` / `导出当前页 CSV` / `复制本页摘要`；CSV 带 UTF-8 BOM，文件名 `book-search-YYYYMMDD-HHmmss.csv`；摘要格式 `书名｜作者｜出版社｜ISBN｜SSID｜DXID`
- 键盘快捷键：`/` 聚焦搜索框 · `Esc` 清空 · `Enter` 搜索 · `← / →` 翻页；输入框内不抢键
- 状态栏：搜索页底部显示 `索引 books · 5,115,734 条 · 索引空闲 · 上次导入 ...`
- 移动端：760 px → 2 列，480 px → 1 列；等宽字段自动换行；横向无溢出
- Toast 提示：成功 / 失败 / 信息三种颜色，1.2 s 自动消失，不阻塞复制
- localStorage 最近 5 个搜索词：点击芯片即可重搜

## 当前验证状态

- **Live: Full Index 已上线 5,115,734 documents（不扩容全量导入成功）**
- 云端全量导入（生产级，`minimal` profile + `storeRawInfo=true`）通过
- `pnpm verify`：PASS
- `failedParsed=287 (~0.0056%)`（数据来源原始记录残缺，非 importer 缺陷）
- `weakParsed=1,598,107` 主要来自缺失 ISBN，`rawInfo` 已保留
- 搜索验证：SSID / DXID / ISBN / 书名 / 作者 / 出版社全部通过
- `/api/stats` 仅返回 compact 字段（`numberOfDocuments` / `isIndexing` / `rawDocumentDbSize`），不泄漏 rawInfo 内容、samples、checkpoint 或路径
- `3001 / 5173 / 7700` 全部 loopback bind；只有 80 / 443 经 Caddy 公网代理
- S14 benchmark 显示 `--search-raw-info false` 对 SSID / DXID / ISBN / 书名 / 作者 / 出版社核心搜索无影响
- 已知问题：`scripts/import-books.ts` 的 `waitForTask` 早期版本使用 SDK 内置 `client.tasks.waitForTask` 会在 AbortSignal 上累积 listener（5,000+ 任务后触发 `MaxListenersExceededWarning` 警告 3,611+ 个）。S16C 已用自写轮询循环替换：见 `scripts/import-books.wait-task.test.ts`（5/5 通过，0 AbortSignal listener 累积）。

推荐生产导入参数：

```bash
--batch-size 20000 --search-raw-info false --store-raw-info true \
  --index-profile minimal --filter-profile minimal --sortable-profile minimal \
  --wait-timeout-ms 900000 --resume --checkpoint reports/full-import-checkpoint.json
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
## Caddy Reverse Proxy（2026-06-30）

公网访问入口已经收敛到 Caddy，不再依赖 3001/5173 公网暴露。

- 反代域名：https://books.conanxin.com
- TLS：Let's Encrypt（auto renewal，签发于 2026-06-30）
- Caddy 反代目标：127.0.0.1:5173（web 容器）
- web 容器 nginx 内部把 `/api` 反代到 `api:3001`，前端 `VITE_API_BASE_URL=/api` 已是 baked-in
- `music.conanxin.com`（已有站点）未受影响
- Meilisearch 7700 仍只绑 `127.0.0.1`，未公网
- 完整收口计划与剩余动作：`reports/CADDY_PROXY_APPLIED.md`

> 注意：`systemctl reload caddy` 在 WSL 容器内会触发 systemd namespace 失败（`status=226/NAMESPACE`），但 `caddy validate` 和 `sudo caddy reload --config ... --force` 直接调用均成功。后续 reload 用 `sudo caddy reload --config /etc/caddy/Caddyfile --force` 而不是 systemctl。## Security Hardening（2026-06-30 · S15J）

Caddy 是公网唯一入口。3001/5173/7700 全部绑定 `127.0.0.1`。

| port | service | bind | public via |
|---|---|---|---|
| 80/443 | Caddy | `*:80` / `*:443` | direct |
| 3001 | api | `127.0.0.1:3001` | **never** |
| 5173 | web host port | `127.0.0.1:5173` | Caddy → 127.0.0.1:5173 only |
| 7700 | meilisearch | `127.0.0.1:7700` | **never** |

`docker-compose.yml` 已经把 api/web 的 host ports 改写为 `127.0.0.1:${API_PORT:-3001}:3001` 与 `127.0.0.1:${WEB_PORT:-5173}:80`。改回去会让 3001/5173 重新公网暴露。

### /api/stats 公开输出已精简

默认返回 compact 视图，只包含数字 + 时间戳 + 字段分布；**不**返回：

- `file`（内部 TXT 路径）
- `checkpointPath`（内部 checkpoint 路径）
- `samples.ok / samples.weak / samples.failed`（含 `rawInfo`）
- `parseQualityReport` 全文

本地调试可用 `http://127.0.0.1:3001/api/stats?verbose=1`，verbose 仅当请求 IP 是 host loopback（127.0.0.1 / ::1 / ::ffff:127.0.0.1 / 172.18.0.1 docker bridge gateway）才生效。通过 Caddy / 腾讯云公网 IP / 任何容器 → 容器调用永远拿不到 verbose。

### 腾讯云安全组仍建议保留

- 22 / 80 / 443 — 保留
- 3001 / 5173 / 7700 — 即使 docker 已经绑 loopback，安全组也别开，公网多一道防线

详细：`reports/SECURITY_HARDENING.md`
## Cloud Demo Live（2026-06-30 · S15L）

云端公网 demo 已经稳定运行，作为当前可访问入口。

- **公网访问地址**：<https://books.conanxin.com/>
- 数据规模：**500k records**（真实 TXT，5,115,734 行原始库的前 500,000 行）
- HTTPS：Caddy → 127.0.0.1:5173（web 容器 nginx）→ 127.0.0.1:3001（api 容器）
- 公网端口现状：
  - `3001` / `5173` / `7700` **全部不公网**（loopback bind + 腾讯云安全组关入站）
  - 公网只有 `80` / `443`（Caddy）
- 全量导入前置：**必须挂独立 `/data` 盘 ≥100GiB（推荐 160GiB+）**，否则会 OOM / 索引盘满。详细见 [reports/FULL_IMPORT_PREFLIGHT.md](reports/FULL_IMPORT_PREFLIGHT.md)

最终公网复核报告：[reports/FINAL_PUBLIC_ACCESS_VERIFICATION.md](reports/FINAL_PUBLIC_ACCESS_VERIFICATION.md)。

当前稳定 tag：`v0.2.2-security-hardening`。
