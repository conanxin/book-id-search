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
- [AI 质量回归](docs/AI_QUALITY_REGRESSION.md)
- [搜索质量回归](docs/SEARCH_QUALITY_REGRESSION.md)

## AI 质量周检（S23）

每周日 04:20 由 `scripts/run-ai-quality-weekly.sh` 跑一次完整的 AI 质量回归，
目的是在「代码没动」的情况下也能发现模型 / 提示词 / 清洗逻辑的漂移。

- 与每日 03:30 的健康检查互不重叠（健康检查不调用 AI）
- 日志保留 56 天：`/opt/book-id-search/logs/ai-quality/`
- 手动跑：`/opt/book-id-search/scripts/run-ai-quality-weekly.sh`
- 详细说明：`docs/AI_QUALITY_REGRESSION.md#weekly-ai-quality-check`

## 搜索质量周检（S25B）

每周日 04:40 由 `scripts/run-search-quality-weekly.sh` 跑一次 17 个
case 的搜索质量回归——纯 HTTP，不调用 MiniMax，目的是在「代码没动」
的情况下也能发现清理 / 意图 / 路由的回归。

- 紧接每周日 04:20 的 AI 质量周检（先后 20 分钟）
- 日志保留 56 天：`/opt/book-id-search/logs/search-quality/`
- 手动跑：`/opt/book-id-search/scripts/run-search-quality-weekly.sh`
  或 `pnpm search:quality`
- 详细说明：`docs/SEARCH_QUALITY_REGRESSION.md`

## 搜索质量框架（S24）

普通搜索和 AI 找书现在共享一套「查询清洗 + 意图识别 + 统一重排」框架。

- `q=查一下北京旅游的书` → 自动清理为 `北京旅游`，识别为 `旅行指南` 类，错误命中「查斯特菲尔德伯爵家训」已修复
- 精确 ISBN/SSID/DXID 不被清理，仍走精确匹配
- 每个结果附带 `ranking` 字段（分数 / 命中字段 / 意图加权 / 证据）
- 前端显示：已自动忽略 X · 实际搜索：Y · 识别为：旅行指南类检索

手动验证：

```bash
NO_PROXY="*" no_proxy="*" ./node_modules/.bin/tsx scripts/search-quality-regression.ts
```

17 个回归 case（S25A 起），基线 17 PASS / 0 WARN / 0 FAIL。详细报告：
`reports/SEARCH_QUALITY_WARN_CLEANUP_REPORT.md`，框架总览：
`reports/SEARCH_QUALITY_FRAMEWORK_REPORT.md`

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

当前稳定 tag：`v0.20.1-weread-dual-period-comparison-markdown`。

## WeRead Center

独立的微信读书私有数据入口：<https://books.conanxin.com/weread>

- 输入 private token 后显示 counts-only 统计。
- 不显示笔记/划线正文，不暴露微信读书内部 ID。
- 不影响主搜索，不写入 Meilisearch。

### S27E · 私有 AI 整理

- AI 整理当前已加载笔记。
- 详见 [docs/WEREAD_AI_SUMMARY.md](docs/WEREAD_AI_SUMMARY.md) 和 [reports/WEREAD_AI_SUMMARY_REPORT.md](reports/WEREAD_AI_SUMMARY_REPORT.md)。

### S27F · 按书导出 Markdown

- 将当前已加载的笔记导出为 Markdown（不上传、不包含私密 ID）。
- 详见 [reports/WEREAD_BOOK_EXPORT_REPORT.md](reports/WEREAD_BOOK_EXPORT_REPORT.md)。

### S27G · 根据当前主题发现相关书

- 仅取 AI 摘要里的主题词作为种子，私有 token 接口直接复用 Meilisearch 公开索引。
- 不调用 MiniMax，不经过 `/api/search`，不写日志、不持久化结果。
- 详见 [docs/WEREAD_RELATED_BOOKS.md](docs/WEREAD_RELATED_BOOKS.md) 和 [reports/WEREAD_RELATED_BOOKS_REPORT.md](reports/WEREAD_RELATED_BOOKS_REPORT.md)。

### S27H · 个人阅读地图

- `GET /api/private/weread/reading-map?months={6|12|24|36}&topBooks={6|12|18}` 返回月度笔记时间轴、高互动书目、同期阅读关系网络。
- 仅使用笔记日期、类型和已确认的公共书目匹配关系；不读取 / 不返回笔记正文，不返回微信读书原始 title/author。
- 页面顶部的「笔记与 AI / 个人阅读地图」标签切换：默认仍为「笔记与 AI」，切换到地图后才请求数据。
- 详见 [docs/WEREAD_READING_MAP.md](docs/WEREAD_READING_MAP.md) 和 [reports/WEREAD_READING_MAP_REPORT.md](reports/WEREAD_READING_MAP_REPORT.md)。

### S27H-2 · 当前会话主题层

- 在「个人阅读地图」顶部叠加从 AI 摘要主题 + 当前已加载 matched catalogId 派生的焦点层。
- 完整复用 S27E 已经生成的 AI 摘要；不会再次调用 MiniMax / related-books endpoint。
- 不传入笔记正文 / 评论 / summary overview / keyPoints / questions / token / 私有 ID。
- 不写 `localStorage` / `sessionStorage`；token 清除后主题层立即清空。
- 详见 [docs/WEREAD_SESSION_THEME_OVERLAY.md](docs/WEREAD_SESSION_THEME_OVERLAY.md) 和 [reports/WEREAD_SESSION_THEME_OVERLAY_REPORT.md](reports/WEREAD_SESSION_THEME_OVERLAY_REPORT.md)。

更全面的说明见 [docs/WEREAD_CENTER.md](docs/WEREAD_CENTER.md) / [docs/WEREAD_PRIVATE_OVERLAY_API.md](docs/WEREAD_PRIVATE_OVERLAY_API.md)。

### S27I · 复习日历
- `GET /api/private/weread/reading-map` 派生确定性复习建议（书目任务 + 当前会话主题）。
- 14 / 28 / 42 天展望窗口，6 / 12 / 18 推荐书目数。
- 不接入任何外部日历，不保存完成状态，不调用 AI。
- 详见 [docs/WEREAD_REVIEW_CALENDAR.md](docs/WEREAD_REVIEW_CALENDAR.md)。

### S27I-2 · 浏览器本地 ICS 导出
- 「导出日历文件 (.ics)」按钮，纯浏览器生成。
- 三种导出范围：全部任务 / 仅书目任务 / 仅当前会话主题。
- 全天事件 (`VALUE=DATE`)，文件名 `weread-review-calendar-<horizon>-<range>-YYYYMMDD.ics`。
- 不新增任何 API、不调用 Google / Apple / Outlook、不写入 localStorage / sessionStorage / IndexedDB / 服务器。
- 详见 [docs/WEREAD_REVIEW_CALENDAR_ICS.md](docs/WEREAD_REVIEW_CALENDAR_ICS.md)。

### S27J · 年度回顾
- 新增第四个工作区「年度回顾」，与「笔记与 AI」「个人阅读地图」「复习日历」并列。
- `GET /api/private/weread/annual-review?year=<YYYY>&topBooks=<6|12|18}` 返回按选中年份聚合的概览、12 个月时间轴、Q1–Q4 季度卡、年度高互动书目与年度记录卡。
- 年度 top books 仅按 `selectedYear` 精确聚合，跨年记录自动排除；月份、季度同样只统计选中年。
- 公共书目元数据只来自现有 Meilisearch `books` 索引 (`index.getDocument`)，不走 `/api/search`。
- 不读取笔记正文、不调用 MiniMax、不持久化、不提供公开分享链接；`meta.persisted` 恒为 `false`。
- 月度活跃度分类（高活跃 / 稳定 / 轻量 / 无记录）只基于数量，UI 顶部固定免责声明。
- 年度记录卡只展示数量 / 月份 / 类型 / 书目 / 峰值月份等描述性统计，不做心理推断。
- 详见 [docs/WEREAD_ANNUAL_REVIEW.md](docs/WEREAD_ANNUAL_REVIEW.md)。

### S27J-2 · 浏览器本地 Markdown 导出
- 「年度回顾」工作区新增「导出年度回顾 Markdown」按钮，纯浏览器生成。
- 文件名 `weread-annual-review-<year>-YYYYMMDD.md`（ASCII，长度 ≤ 80）。
- MIME `text/markdown;charset=utf-8`；含年度标题、meta 列表、隐私引用块、年度概览、12 个月时间轴、Q1–Q4、年度高互动书目、年度记录、说明区。
- 空年度保留完整 12 行零值表与四张零值季度卡，不伪造任何字段。
- 不重新调用 annual-review API、不调用 AI、不写 `localStorage` / `sessionStorage` / IndexedDB / 服务器。
- 详见 [docs/WEREAD_ANNUAL_REVIEW_MARKDOWN.md](docs/WEREAD_ANNUAL_REVIEW_MARKDOWN.md)。

### S27K · 年度对比
- 「年度回顾」工作区新增「开启年度对比」入口，仅当 `availableYears.length >= 2` 时启用。
- 复用两份 `GET /api/private/weread/annual-review` 响应（基准年 + 目标年），不新增 endpoint，不调用 MiniMax。
- 浏览器内缓存（dashboard 生命周期内）防止重复请求。
- 输出：六张核心指标同比卡 / 12 个月双柱 / Q1–Q4 对比 / 顶部书目连续 / 进入 / 未上榜 / 描述性摘要。
- 描述性摘要只描述数量 / 排名 / 月份变化；不做心理 / 质量 / 兴趣推断。
- 不调用 MiniMax、不调用 related-books、不写 `localStorage` / `sessionStorage` / IndexedDB / 服务器。
- 切换 token / 卸载组件 / 关闭对比时立即清空所有对比状态与缓存。
- 详见 [docs/WEREAD_YEAR_COMPARISON.md](docs/WEREAD_YEAR_COMPARISON.md)。

### S27K-2 · 浏览器本地年度对比 Markdown 导出
- 「年度对比」面板新增「导出年度对比 Markdown」按钮，纯浏览器生成。
- 仅使用面板当前已加载的 `WereadYearComparison`（基准年 / 目标年 / 当前 Top N）。
- 文件名 `weread-year-comparison-<base>-vs-<target>-YYYYMMDD.md`（ASCII，长度 ≤ 80）。
- MIME `text/markdown;charset=utf-8`；含年度对比标题、meta 列表、隐私 / 解释边界 / entered / left 四个 blockquote、六项核心指标同比、12 个月对比、Q1–Q4 对比、连续进入 / 进入 / 未进入三个高互动书目榜分组、描述性摘要、说明区。
- 切换基准年 / 目标年 / Top N 范围 / 关闭对比时，已显示的成功状态立即清空。
- 两年空数据也允许导出，输出零值结构；不输出心理 / 兴趣 / 性格推断。
- 不重新调用 annual-review API、不调用 AI、不调用 related-books、不写 `localStorage` / `sessionStorage` / IndexedDB / 服务器。
- 详见 [docs/WEREAD_YEAR_COMPARISON_MARKDOWN.md](docs/WEREAD_YEAR_COMPARISON_MARKDOWN.md)。
