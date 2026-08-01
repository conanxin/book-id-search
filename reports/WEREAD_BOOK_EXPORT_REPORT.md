# S27F Per-book WeRead Markdown Export — 最终报告

**标签:** `v0.11.0-weread-book-export`  
**范围:** `apps/web`、`apps/api` 仅改动与导出相关的边界；不触碰 API 核心鉴权、Meilisearch、Caddy/DNS/nginx、`.env`、`private-data`、`dist/`、`logs/`、截图或进度目录。  
**状态:** PASS  

---

## 1. 实现摘要

新增功能允许用户在 `/weread` 页面中，从任意一条**已匹配书目**的微信读书笔记卡片上点击“导出本书全部笔记”，生成仅由浏览器本地构造并下载的 Markdown 文件。

核心边界：
- Markdown 中的书名、作者只来自**公共书目库** `/books/:catalogId`，不来自微信读书原始字段。
- 全部导出逻辑在浏览器完成，不 POST 到服务器，不进入 MiniMax，不进入 Meilisearch/公开搜索。
- 不暴露微信读书内部 ID（`wereadBookId`、`noteId`、`highlightId`、`chapterTitle`）。
- 服务端不持久化 Markdown、不建立导出任务、不生成公开链接。
- `catalogId` 仅作为公开书目 ID 使用。

### 新增文件

| 文件 | 作用 |
|------|------|
| `apps/web/src/weread/wereadBookExportModel.ts` | 文件名安全化、Markdown 组装、四类分组、日期排序、heading-injection 防护、截断提示。 |
| `apps/web/src/weread/wereadBookExportModel.test.ts` | 23 条模型测试。 |
| `apps/web/src/weread/BookNotesExportButton.tsx` | 按钮组件：获取公共书目详情、分页拉取本书全部笔记、生成 Blob 下载、错误/loading 状态。 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `apps/api/src/weread/private-notes.ts` | `catalogId` 参数注入、格式校验、白名单过滤。 |
| `apps/api/src/weread/private-notes.test.ts` | 7 条 F3 过滤测试。 |
| `apps/api/src/index.ts` | route 接收 `catalogId` 参数。 |
| `apps/web/src/wereadPrivate.ts` | `WereadNotesQuery` 增加 `catalogId`；`fetchWereadNotes` 透传；新增 `fetchAllWereadBookNotes`（pageSize≤100、maxItems≤2000、max 20 页、AbortSignal）。 |
| `apps/web/src/wereadPrivate.test.ts` | 10 条分页/参数/错误测试。 |
| `apps/web/src/weread/NotesLibrary.tsx` | 在已匹配卡片内挂载 `BookNotesExportButton`。 |
| `apps/web/src/styles.css` | `.weread-book-export*` 样式 + 移动端适配。 |

### 未修改

- ICP/公安备案配置（`siteCompliance.ts`）
- AI summary 行为
- nginx private access_log 规则
- Caddy、DNS
- `.env` / `private-data` / `dist` / `logs` / `reports/screenshots` / `progress/`
- `package.json`（无新增依赖）

---

## 2. API 结果

### 2.1 `catalogId` 过滤

- 最大长度 128 字符。
- 格式校验：`/^[0-9]+_[0-9]{12}$/`。
- 非法格式返回 400，错误消息不回显完整输入。
- 鉴权顺序保持：无 token 401 → 错 token 403 → overlay 404 → 成功响应。
- 响应 schema 不变，仍不返回 `wereadBookId`、`noteId`、`highlightId`、`chapterTitle`、微信读书原始 title/author。

### 2.2 分页验证

- `pageSize` 默认 100、最大 100。
- `maxItems` 默认 2000、最大 2000。
- 空页但 `hasMore=true` 会终止循环。
- `offset` 必须单调增长。
- 最多 20 页。
- 支持 `AbortSignal`。
- 不删除合法重复笔记。

### 2.3 Live 安全验证

使用真实 token 与真实已匹配书目进行验证：

- 有匹配 catalogId 可用。
- `GET /api/private/weread/notes?catalogId=<id>&limit=100&offset=0` 返回：
  - `ok=true`
  - 若干条笔记
  - 所有 `matched=true`
  - 所有 `catalogId` 与请求一致
  - 无 forbidden keys
- 非法 `catalogId=garbage` 返回 400。
- 无 token 返回 401。
- 错误响应不泄露 token 或正文。

---

## 3. 前端结果

### 3.1 导出按钮

- 仅在 `note.matched === true && note.catalogId` 非空时显示。
- 未匹配记录不显示，避免界面噪音。
- 按钮 `type="button"`，loading 时 `disabled`。
- 错误消息通用，不回显 response body、token 或正文。
- 成功提示不含浏览器 `alert`。
- 同时只允许一个按书导出请求。
- token 改变或组件卸载时 abort 请求并清理状态。
- 不自动请求，不 console 输出正文或 Markdown。

### 3.2 导出流程

1. 用户点击。
2. 按钮获取公共书目 title/author。
3. 调用 `fetchAllWereadBookNotes` 分页拉取该书全部笔记。
4. 调用 `buildWereadBookExport` 组装 Markdown。
5. 使用 `Blob` + `URL.createObjectURL` + 临时 `<a download>` 触发浏览器下载。
6. 下载后 `URL.revokeObjectURL`。
7. 不调用 MiniMax。

### 3.3 Markdown 结构

- 书名/作者来自公共书目库。
- 书目 ID、生成时间、导出条数。
- 隐私声明：说明数据仅来自浏览器 session，不发送给 MiniMax/Meilisearch/公开搜索。
- 摘要：划线/想法/书评/未分类计数。
- 四类分组：划线、想法、书评、未分类。
- 同组内按时间 newest-first 排序。
- 无日期使用占位符 “—”。
- 正文/评论保留换行；行首 `#` 被转义防止 heading injection。
- 单条正文超过 4000 字符截断并提示。
- 达到 2000 条安全上限时，提示“导出达到 2000 条安全上限，文件可能不完整”。
- 合法重复记录不去重。

### 3.4 文件名

- 前缀：`weread-book-<catalogId>-<sanitized title>.md`。
- 清理 `/ \ : * ? " < > |`、控制字符、`=`、连续空格。
- 最大 80 字符。
- 不允许 `..`、不以点或空格结尾。
- title 为空时回退为 catalogId。

---

## 4. 隐私结果

| 检查项 | 结果 |
|--------|------|
| 笔记正文仅在认证浏览器与私有 API 之间传输 | ✅ |
| 书名/作者仅来自公共书目库 | ✅ |
| 不暴露 `wereadBookId`/`noteId`/`highlightId`/`chapterTitle` | ✅ |
| 导出请求不含 `q`、token、session、cookie | ✅ |
| Markdown 不发送给 AI provider | ✅ |
| 服务端不持久化 Markdown | ✅ |
| 不进入 Meilisearch / 公开搜索 | ✅ |
| 服务日志无 token、无正文、无 Markdown | ✅ |
| web bundle 无 hardcoded token/key | ✅ |
| 未提交 private data / `.env` / `dist` / `logs` / 截图 | ✅ |
| 临时文件已清理 | ✅ |

---

## 5. 回归结果

| 检查 | 结果 |
|------|------|
| vitest | 688 PASS / 0 FAIL |
| api tsc | PASS |
| web tsc | PASS |
| weread snapshot validate | PASS |
| verify | docs=5,115,734 |
| search-quality | 17 PASS / 0 WARN / 0 FAIL |
| vite build | 47.09 kB CSS / 327.11 kB JS |

---

## 6. 部署结果

- `api` 容器重建并 Up。
- `web` 容器重建并 Up（强制无缓存构建，确保新 bundle 生效）。
- Meilisearch 未重启，uptime 保留。
- Caddy / DNS / nginx 未触碰。
- `/api/private/*` 仍不写入 nginx access log。

---

## 7. 浏览器下载 smoke

- 使用 `http://172.18.0.4:80/weread` 直接访问容器，避免 CDN 缓存旧 bundle。
- 请求拦截仅使用 synthetic 数据，不向 MiniMax 或真实 private API 发送真实笔记。
- 验证项：
  - 3 个导出按钮渲染（3 条 matched synthetic notes）。
  - 点击后下载 1 个 Markdown 文件。
  - 文件名包含 `catalogId` 与公共书目 title。
  - Markdown 包含公共 title/author 与 synthetic 笔记正文。
  - Markdown 不含 forbidden keys。
  - 成功提示文本正确，无错误 fallback。
  - 请求日志仅含：summary、notes、book detail、paginated book notes（不含 token/正文泄露）。

---

## 8. 仓库结果

- 提交包含：API 过滤、分页、模型、组件、测试、样式。
- 不包含：`.env`、`private-data`、`dist`、`logs`、`reports/screenshots`、`progress`。
- 无新增第三方依赖。
- `package.json` 未改动。

---

## 9. 后续步骤

- **S27G** — note-theme related-book discovery。
- 公安联网备案号在官方下发后，单独更新 `apps/web/src/siteCompliance.ts` 并仅重建 web 容器。

---

STATUS: PASS  
API_RESULT: PASS  
FRONTEND_RESULT: PASS  
PRIVACY_RESULT: PASS  
REGRESSION_RESULT: PASS  
DEPLOY_RESULT: PASS  
BROWSER_DOWNLOAD_SMOKE: PASS  
REPO_RESULT: 待 commit + tag