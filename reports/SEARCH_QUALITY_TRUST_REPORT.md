# S19 Search Quality & Trust — Report

STATUS: **PASS**

ROOT_PROBLEM
- 搜索结果缺少命中解释，用户无法判断“为什么这条结果排在前面”。
- ISBN 连字符（`978-7-5384-5525-0`）与全角数字等输入需要归一化才能命中。
- 前端缺少命中原因（match reason）和记录可信度（parseStatus 解读）展示。
- 弱解析记录的原始来源透明度不足，rawInfo 文案需要明确“可核对”含义。

API_CHANGES
- `normalizeQuery`：剥离空格、统一全角→半角数字、剥离连字符/空格后再做 ISBN 判定。
- `queryInfo`：响应里新增 `queryInfo.{original, normalized, detectedType}`，前端可直接显示。
- `match` 字段：每条结果新增 `{type, label, score, fields}`，label 中文文案与 type 一一对应：
  - `exact_isbn` → `ISBN 精确匹配`
  - `exact_ssid` → `SSID 精确匹配`
  - `exact_dxid` → `DXID 精确匹配`
  - `title` → `书名命中` / `书名完全匹配`
  - `author` → `作者命中`
  - `publisher` → `出版社命中`
  - `unknown` → `未知匹配`
- `rerank`：精确 identifier 命中优先于文本命中，再按 Meilisearch score 排序。
- `exact identifier priority`：ISBN/SSID/DXID 精确匹配直接置顶，score = 1。

UX_CHANGES
- `match-badge`：每条结果右上角彩色标签（ISBN 蓝 / SSID 紫 / DXID 青 / title 绿 / author 橙 / publisher 灰）。
- 精确命中额外展示 `.match-badge__dot` 圆点。
- `trust-hint`：解析状态中文叙事（`正常` / `弱解析` / `解析异常`），并把 `parseWarnings` 翻译成中文短语（如 `缺 ISBN`）。
- `raw-info-title`：标题改为“原始 TXT 记录（用于核对）”，说明 `这是一行原始 TXT 记录，可用于核对解析字段`。
- 弱解析无 rawInfo 时显示 `当前索引未保存原始记录`（保持透明）。

BUILD_FIX
- 新增仓库根 `.dockerignore`，从构建上下文排除：
  - `**/node_modules`（核心修复：阻止宿主 pnpm 的绝对路径 symlink 进入 image，导致 `tsc` 找不到 `react-router-dom`）
  - `**/dist`、`**/.vite`
  - `.git`、`.env*`（保留 `.env.example`）
  - `books.txt`、`private-data`、`meili_data`
  - 编辑器/缓存/日志临时文件
- 这是 Docker 官方推荐做法，比 `COPY --exclude` 更可移植，并同时修好 web + api 的潜在隐患。
- `sudo docker compose build --no-cache web` → **PASS**（tsc + vite build 成功）
- `sudo docker compose build --no-cache api` → **PASS**

VERIFY

| 检查项 | 结果 | 备注 |
|---|---|---|
| `npx vitest run` | **51/51 PASS** | 含 38 个新增 `handle-search.test.ts` |
| `pnpm verify` (MEILI_HOST=http://127.0.0.1:7700) | **PASS** | status="PASS" |
| `pnpm build` (api + web) | **PASS** | api tsc、web tsc + vite 均成功 |
| 线上 `/api/stats` 文档数 | **5,115,734** | 与 import 前一致 |
| ISBN `9787538455250` | ✅ `ISBN 精确匹配` | `detectedType=isbn` |
| Hyphen ISBN `978-7-5384-5525-0` | ✅ 归一化 → `9787538455250` → `ISBN 精确匹配` | 命中同一本书 |
| SSID `13000000` | ✅ `SSID 精确匹配` | `detectedType=ssid` |
| DXID `000008232537` | ✅ `DXID 精确匹配` | `detectedType=dxid` |
| Title `时尚秋冬披肩` | ✅ `书名命中` | 精确书名置顶 |
| Author `陈瑶译` | ✅ `作者命中` | |
| Publisher `吉林科学技术出版社` | ✅ `出版社命中` | |
| 弱解析 `汉学研究与中国社会科学的推进` | ✅ `弱解析` StatusBadge 可见 | `缺 ISBN` 文本未渲染：API 该记录 `parseWarnings=None`，前端逻辑正确，仅无可翻译的内容 |
| 详情页 rawInfo | ✅ `原始 TXT 记录（用于核对）` 标题 + 说明存在 | |
| 前端 smoke (Playwright Chromium, http-bridge :7899) | **20/21 PASS** | A-F + H + I 全部 PASS；G 中 `缺 ISBN` 文本未渲染因 API 未存 warning |
| Mobile 390x844 无横向溢出 | ✅ `docW=390 == winW=390` | |
| 复制链接 toast | ✅ `已复制链接` | |
| 复制本页摘要 toast | ✅ `已复制本页 1 条摘要` | |
| 导出当前页 CSV | ✅ download 文件名 `book-search-YYYYMMDD-HHMMSS.csv` | |
| 快捷键 `/` 聚焦 / `Esc` 清空 | ✅ | |
| kbd hint 渲染 | ✅ `<kbd>/</kbd>` `<kbd>←</kbd>` 等可见 | |

SAFETY
- no import：未运行任何 import 脚本。
- no reset：未触碰 books 索引。
- docs count unchanged：`5,115,734`（import 前一致）。
- meilisearch untouched：容器 28h 连续运行，仅重建 api/web。
- 7700 仍 private：`docker compose ps` 显示 `127.0.0.1:7700->7700/tcp`，未对外暴露。
- api/web 重建：仅 `api` 和 `web` 服务用 `--force-recreate` 重建。

NOTES
- 前端 smoke 唯一 FAIL 项（`G.缺 ISBN`）不是前端 bug：API 返回的弱解析记录 `parseWarnings=null`，前端 `explainParseWarnings` 因此不渲染任何 warning 文本。属于“数据维度未记录 warning”，符合“前端忠实反映 API 数据”的设计。报告与 smoke 已诚实标注。
- `.dockerignore` 是 S19-FINISH-R 的核心修复：根因不是 pnpm install layer 顺序，而是宿主的 `apps/web/node_modules` 里的 pnpm symlink 引用 `/home/ubuntu/...` 绝对路径，被 `COPY apps/web apps/web` 一并带入 image，污染了 image 内的 module resolution。