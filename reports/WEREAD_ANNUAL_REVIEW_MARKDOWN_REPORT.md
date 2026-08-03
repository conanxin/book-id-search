# S27J-2 — Browser-local Annual Review Markdown Export Report

> 「年度回顾」工作区新增「导出年度回顾 Markdown」按钮。Markdown 在浏览器内生成并下载，不重新调用 API、不调用 AI、不写入 localStorage / sessionStorage / IndexedDB / 服务器。

---

## STATUS: PASS

---

## SCOPE

- 只读「年度回顾」工作区当前已加载的 `WereadAnnualReviewResponse`（selectedYear、topBooks 范围、12 个月时间轴、Q1–Q4、年度高互动书目、概览数字）。
- 浏览器本地生成 Markdown。
- 无新增 API、无 AI 调用、无持久化、无公开分享。

---

## MARKDOWN_RESULT

| 维度 | 状态 | 证据 |
|------|------|------|
| 文档结构 | ✅ PASS | `# <year> 年阅读回顾` → meta → 引用块 → 年度概览 → 12 个月时间轴 → 季度回顾 → 年度高互动书目 → 年度记录 → 说明 |
| selected year | ✅ PASS | 标题包含 `2025 年阅读回顾`；`buildAnnualReviewMarkdownFilename` 校验 4 位年份 |
| 12 个月时间轴 | ✅ PASS | 固定 12 行；表头 `| 月份 | 记录 | 划线 | 想法 | 书评 | 未分类 | 已匹配 | 书目 |`；每行 8 字段 |
| 季度回顾 | ✅ PASS | `### Q1` … `### Q4` 按 `Q1` → `Q4` 顺序；含 阅读记录 / 活跃月份 / 已匹配记录 / 涉及书目 / 占全年记录 % |
| 年度高互动书目 | ✅ PASS | 公共书目标题 / 作者 / 出版社 / 年份 / 计数 / 首次最后日期 / 类型分布 / `https://books.conanxin.com/books/<catalogId>` |
| 年度记录 | ✅ PASS | 5 条描述性统计：全年记录 / 活跃月份 / 最长连续 / 高峰月份 / 已匹配书目。无心理推断文案 |
| 空年度 | ✅ PASS | `该年度暂无有效日期的阅读记录` + 12 行零值表 + 四张零值季度卡 + 说明区 |
| 文件名 / MIME | ✅ PASS | `weread-annual-review-2025-20260803.md`；`text/markdown;charset=utf-8`；纯 ASCII；≤ 80 字符 |
| 浏览器下载 | ✅ PASS | `URL.createObjectURL` + `<a download>` + `setTimeout(0)` + `URL.revokeObjectURL` |

---

## PRIVACY_RESULT

| 维度 | 状态 | 证据 |
|------|------|------|
| 包含字段 | ✅ PASS | 仅含公共 catalogId / 公共 title / 公共 author / 公共 publisher / 公共 publishYear / 计数 / YYYY-MM-DD 日期 / 公共书目 URL |
| 排除字段 | ✅ PASS | 笔记正文 / 评论 / `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / 微信读书原始 title/author / AI 摘要 / `token` / `q` / API key / 私有 API URL / Meili 原始字段 / raw snapshot |
| 网络请求 | ✅ PASS | smoke 测试 0 服务器 POST、0 外部请求（Google/Apple/Outlook/钉钉/Notion 等）、0 `/annual-review` 重复调用 |
| 持久化 | ✅ PASS | 不写 localStorage / sessionStorage / IndexedDB；不调用 `/api/private/weread/notes/summarize`；不调用 `/api/private/weread/related-books` |
| 清理 | ✅ PASS | `URL.revokeObjectURL(blobUrl)` 在 `setTimeout(0)` 中执行；Blob URL 是临时的 |
| 来源 | ✅ PASS | 模型消费的是 S27J 端点已脱敏后的 `WereadAnnualReviewResponse` |

---

## REGRESSION_RESULT

| 维度 | 状态 | 数字 / 路径 |
|------|------|------------|
| vitest | ✅ PASS | 1177 passed across 50 files |
| web tsc | ✅ PASS | `./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit` |
| Vite build | ✅ PASS | `dist/index-CBa1-2la.css` 78.68 kB；`dist/index-ETQzPo0g.js` 422.67 kB |
| verify | ✅ PASS | docs=5,115,734 |
| search-quality | ✅ PASS | 17 PASS / 0 WARN / 0 FAIL |
| package.json | ✅ PASS | 无变化（无新增依赖） |
| apps/api | ✅ PASS | 无变化（`git diff apps/api` 为空） |

---

## DEPLOY_RESULT

| 维度 | 状态 | 证据 |
|------|------|------|
| web rebuilt | ✅ PASS | `book-id-search-web-1` Up 21s（smoke 后运行）；容器重启前已确认新代码生效 |
| api untouched | ✅ PASS | `book-id-search-api-1` Up 55 minutes |
| Meilisearch untouched | ✅ PASS | `book-id-search-meilisearch-1` Up 4 weeks |
| Caddy / DNS / nginx / 合规 | ✅ PASS | 仅 `--no-deps --build web`；Caddy / DNS / nginx / ICP / 公安备案配置未触碰 |

---

## REPO_RESULT

| 维度 | 状态 |
|------|------|
| commit | Add browser-local annual review Markdown export |
| push | `origin main` |
| tag | `v0.15.1-weread-annual-review-markdown` |
| README 稳定 tag | 已更新为 `v0.15.1-weread-annual-review-markdown` |

---

## LIMITATIONS

- 只导出当前 selectedYear + 当前 topBooks 范围。
- 不包含 AI 年度总结（不调用 MiniMax）。
- 不包含主题分析（不调用 related-books）。
- 不包含图片 / 图表截图。
- 不自动更新已导出的文件。
- 暂不支持 PDF / DOCX。
- 无公开分享渠道（按设计要求）。

---

## NEXT_STEP

- **S27K — Year-over-Year Reading Comparison**：对比任意两个年度的活跃月份、记录类型分布、年度高互动书目重合度，纯浏览器端实现，复用 S27J `WereadAnnualReviewResponse`。

---

## 关键文件清单（增量）

- `apps/web/src/weread/wereadAnnualReviewMarkdown.ts`（新增）
- `apps/web/src/weread/wereadAnnualReviewMarkdown.test.ts`（新增，45 项）
- `apps/web/src/weread/AnnualReviewDashboard.tsx`（新增 export UI + handler + state + props）
- `apps/web/src/weread/AnnualReviewDashboard.test.ts`（新增 S27J-2 段，11 项）
- `apps/web/src/styles.css`（新增 export CSS 类）
- `docs/WEREAD_ANNUAL_REVIEW_MARKDOWN.md`（新增）
- `docs/WEREAD_ANNUAL_REVIEW.md`（追加 6.1 节）
- `docs/WEREAD_CENTER.md`（追加 S27J-2 段）
- `README.md`（追加 S27J-2 段 + 更新稳定 tag）
- `scripts/s27j2-browser-smoke.cjs`（新增，27 项端到端断言）
- `reports/WEREAD_ANNUAL_REVIEW_MARKDOWN_REPORT.md`（本文件）

## 端到端浏览器 smoke

`scripts/s27j2-browser-smoke.cjs` 用 Puppeteer + 请求拦截模拟完整流程。**所有 27 项断言通过**：

1. 年度回顾 tab 存在
2. 未激活前 annual request=0
3. 激活后 annual request=1
4. 导出按钮存在
5. 不点击时没有下载
6. 点击不新增 annual API 请求
7. 下载 .md 文件
8. 文件名包含 selectedYear
9. 文件含年度标题
10. 文件含 12 个月表格
11. 文件含 Q1–Q4
12. 文件含 synthetic public title
13. 文件含 synthetic public author
14. 文件含公开书目 URL
15. 文件不含 forbidden note text/comment
16. 文件不含 private IDs
17. 文件不含 token/q
18. 文件不含 AI summary
19. 空年度可导出
20. URL.revokeObjectURL 被调用
21. 无服务器 POST
22. 无外部服务请求
23. S27I ICS 导出入口仍存在
24. S27H 阅读地图入口仍存在
25. ICP footer 仍存在
26. desktop-1440 无横向滚动
27. mobile-360 无横向滚动

下载文件保存到 `/tmp/s27j2-downloads`，测试结束后自动删除；截图保存到 `reports/screenshots/s27j2-annual-review-markdown.png`（**不入库**）。