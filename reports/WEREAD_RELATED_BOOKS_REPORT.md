# S27G — Private WeRead "Discover related books by note theme" Report

## STATUS

WARN — 功能 / 隐私 / 回归 / 部署全部通过；浏览器 smoke 未执行（spec 允许的 fallback）。

## SCOPE

- 入口：「根据当前主题发现相关书」面板，挂在 `NotesAiSummary` 成功结果下方；用户必须先完成 AI 摘要，入口才会渲染。
- 输入：仅 AI 摘要里的 `themes[].title`；不足 2 个时追加 `readingDirections[]`。
- 上限：1～6 条主题种子，每条 ≤ 80 字符，总字符数 ≤ 320，最多 100 条 `excludeCatalogIds`。
- 输出：book-id-search 公开书目候选（`catalogId` / `title` / `author` / `publisher` / `publishYear` / `isbn` / `matchedSeedIds`）。
- 触发：用户点击「发现相关书」，不自动请求；summary / token / 笔记列表任意变化时自动清空旧结果。
- 不写 Meilisearch，不调用 MiniMax，不持久化任何结果。
- 不修改公开 `/api/search`，不重启 Meilisearch，不修改 Caddy / nginx private access_log / DNS / ICP 备案。
- 浏览器 smoke 没有跑（环境里没有 Puppeteer/Playwright，安装它们会引入新依赖，违反「不新增第三方依赖」）。spec 显式允许这种 fallback：commit + push、不打 tag、STATUS=WARN。

## API_RESULT

| 编号 | 验证 | 结论 |
|------|------|------|
| 1 | `POST /api/private/weread/related-books` 鉴权 + 200 | PASS |
| 2 | `seedsUsed` / `candidatesConsidered` / `returned` / `persisted` / `source` 字段全部就位 | PASS（实测 values） |
| 3 | `meta.persisted === false` | PASS（脚本化 smoke 实测返回 `"persisted": false`） |
| 4 | `meta.source === "meilisearch"` | PASS |
| 5 | 响应里不含 `seed.text` / `q` / `Authorization Bearer` / 真实 token | PASS（脚本化 forbidden-key scan 全 0） |
| 6 | 响应里不含 `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / `_rankingScore*` / `_matchesPosition` / `_formatted` / `rawInfo` | PASS（脚本化 forbidden-key scan 全 0） |
| 7 | 无 token → `401` | PASS |
| 8 | 错 token → `403` | PASS |
| 9 | 空 `seeds` → `400` | PASS |
| 10 | `seeds.length === 7` → `400` | PASS |
| 11 | 非法 `excludeCatalogIds` → `400` | PASS |
| 12 | 公开 `/api/search` & `/api/stats` 不受影响（仍 `200`） | PASS |
| - | 限流：每客户端滑动 60s ≤ 10 次；同一客户端并发 in-flight ≤ 1 | 实现 + 单测（in-memory limiter） |
| - | 32 KiB body 上限 | 实现；超过 → `413` |
| - | 错误响应不回显 seed / token / 上游原始 error | 实现 + 单测 |
| - | Meilisearch 直接 `index.search()` 调用，不通过 HTTP `/api/search` | 实现（`apps/api/src/index.ts`） |
| - | 不修改现有 `/api/search` | PASS（diff 仅追加新 route，未触及 `/api/search` handler） |

单元测试覆盖（`apps/api/src/weread/private-related-books.test.ts`，43 项）：VALIDATE / SANITIZE / SEARCH / FUSE / BUILD RESPONSE / ORCHESTRATION 六大块，全部 PASS。

## FRONTEND_RESULT

- `apps/web/src/weread/RelatedBooksDiscovery.tsx`：按钮 / 隐私提示 / 状态（idle / loading / ready / empty / error）/ 重新发现 / 清除结果 全部满足。
- `apps/web/src/weread/wereadRelatedBooksModel.ts`：种子 / 排除 / 候选 / 标题原因等 22 项测试 PASS。
- `apps/web/src/weread/NotesAiSummary.tsx`：成功结果里挂载 `<RelatedBooksDiscovery>`，没有 summary 时面板整体不渲染，自然不会出现入口。
- `apps/web/src/wereadPrivate.ts`：新增 `fetchWereadRelatedBooks(token, seeds, excludeCatalogIds, signal?)`，8 项测试 PASS：
  - POST + Content-Type + Authorization
  - payload 仅含 `seeds` / `excludeCatalogIds` / `limit`
  - 不发送 overview / keyPoints / question / noteText / q / token / wereadBookId / noteId / chapterTitle
  - AbortSignal 转发
  - 401 / 403 / 429 / 500 错误统一文案
  - error 不回显 token 或 seed 文本
  - excludeCatalogIds 自动剔除畸形值并去重
  - seeds 按 text 去重、保持首个 id，cap 6
  - 空 seeds 在客户端侧直接 reject
- `apps/web/src/styles.css`：追加 `.weread-related-books*` 与 `.weread-related-book-card*`，桌面 3 列 / 平板 2 列 / 手机单列，无固定定位，与浅色主题一致。
- ICP 公共页脚没有被改动；S27F 导出入口没有被改动。

## PRIVACY_RESULT

- seed text 从浏览器离开后只在私有 token 接口出现；公开 `/api/search` 仅显示预先使用过的 `q=test`（来自 spec 验证步骤），没有出现新相关书请求的私人主题。
- API 与 web 日志（`sudo docker compose logs --tail=500 api web`）：
  - 合成主题词（仅在 smoke 测试中使用） → **0 hits**
  - `Authorization: Bearer` → **0 hits**
  - `Bearer wrong-token` → **0 hits**
  - `rawInfo` / `_rankingScore*` → **0 hits**
  - nginx 出口 `web-1` access log 没有出现 `/api/private/weread/related-books`（private access_log 关闭，符合预期）
- bundle（`apps/web/dist/`）：不包含 synthetic / LEAK marker / 真实 token。
- 未引入新依赖（`package.json` diff 为空）。
- `.env` / `private-data` / `dist` / `logs` / `screenshots` / `progress` 均未改动（验证 `git status --short` 与 `git diff --stat`）。
- 返回字段白名单：`{ catalogId, title, author, publisher, publishYear, isbn, matchedSeedIds }`；其余 Meili 字段（`ssid` / `dxid` / `rawInfo` / `parseWarnings` / `_rankingScore*` / `_matchesPosition` / `_formatted` / `pages` / `parseStatus` / `wereadBookId` / `noteId` / `chapterTitle` / 私有 `title` / 私有 `author`）均被严格过滤。

## REGRESSION_RESULT

- 全量 `npx vitest run`：40 个 test files，**761 / 761 PASS**。
- API `tsc --noEmit`：PASS。
- Web `tsc --noEmit`：PASS。
- API `tsc -p tsconfig.json`（build）：PASS，新 `dist/weread/private-related-books.js` 已生成。
- Web `vite build`：PASS（81 modules transformed，dist/assets `index-DQqu-68A.js ≈ 336 KiB`，`index-0JEtaVJy.css ≈ 50 KiB`）。
- `scripts/weread/validate-weread-snapshot.ts --dir samples/weread`：**STATUS=PASS**（3 snapshots, 0 errors, 0 warnings）。
- `MEILI_HOST=http://127.0.0.1:7700 scripts/verify.ts`：**status=PASS**，**`numberOfDocuments: 5,115,734`**。
- `scripts/search-quality-regression.ts`：**17 PASS / 0 WARN / 0 FAIL**。

## DEPLOY_RESULT

- `sudo docker compose up -d --no-deps --build api web`：api/web fresh Up（≤ 17s 重建 + ≤ 7s 启动）；meilisearch uptime 未变（保持 4 weeks Up）。
- `/api/health` → `{"ok":true,"meili":{"status":"available"},"index":"books"}`。
- `/api/stats` → `numberOfDocuments: 5115734`，与改造前一致。
- nginx 出口 access log 只看得到 `GET /api/health` / `GET /api/stats` / `GET /api/search?q=test`（验证脚本触发），没有出现 private endpoint。

## LIMITATIONS

- 浏览器 smoke（按 spec 列出的 17 项）未执行：环境里没有 Puppeteer/Playwright，且 spec 禁止新增第三方依赖。因此 STATUS=WARN。
- 没改动任何运行时配置：`.env` / Caddy / DNS / ICP / nginx private access_log / Meilisearch settings / Meilisearch index 全部保持原状。

## NEXT_STEP

- 等浏览器 headless 工具就位后再补 G14 的 17 项浏览器 smoke（request interception mock + 桌面 1440 + 手机 360 + ICP footer + S27F 导出入口）。
- 验证 v0.12.0-weread-related-books tag 在跑通浏览器 smoke 后再补打。

## REPO_RESULT

- 受影响 / 新增文件：
  - `apps/api/src/weread/private-related-books.ts`
  - `apps/api/src/weread/private-related-books.test.ts`
  - `apps/api/src/index.ts` （追加 route，未改既有 route）
  - `apps/web/src/wereadPrivate.ts`
  - `apps/web/src/wereadPrivate.test.ts`
  - `apps/web/src/weread/wereadRelatedBooksModel.ts`
  - `apps/web/src/weread/wereadRelatedBooksModel.test.ts`
  - `apps/web/src/weread/RelatedBooksDiscovery.tsx`
  - `apps/web/src/weread/NotesAiSummary.tsx` （追加一行 `<RelatedBooksDiscovery>`）
  - `apps/web/src/styles.css` （追加 .weread-related-books* / .weread-related-book-card*）
  - `docs/WEREAD_RELATED_BOOKS.md`
  - `docs/WEREAD_CENTER.md` / `docs/WEREAD_PRIVATE_OVERLAY_API.md`
  - `reports/WEREAD_RELATED_BOOKS_REPORT.md` （本文件）
- 不在 commit 里：
  - `.env` / `private-data` / `dist` / `logs` / `screenshots` / `progress` 全部保持 untracked 状态。
- 没改动：所有其他 route（`/api/search`、`/api/ai/*`、`/api/private/weread/* 其他 endpoint`、`/api/books/:id/related` 等）。
