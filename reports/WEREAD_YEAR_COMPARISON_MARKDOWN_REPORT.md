# S27K-2 — WeRead Year Comparison Markdown Export Report

STATUS: PASS

## SCOPE

- **Target**: 浏览器本地年度对比 Markdown 导出。
- **仅使用**当前已经加载的 `WereadYearComparison`（基准年 / 目标年 / 当前 Top N 范围）。
- 不新增 API、不调用 `fetchWereadAnnualReview` / `fetchWereadAiSummary` / `fetchWereadRelatedBooks`、不写入 `localStorage` / `sessionStorage` / IndexedDB、不上传服务器。

## MARKDOWN_RESULT

- **结构**：标题（`# 2024—2025 年阅读对比`）、meta 列表（基准年度 / 目标年度 / Top N / 导出时间 / 数据来源 / 生成方式 / 保存状态）、四个 blockquote（隐私说明 / 解释边界 / entered 免责声明 / left 免责声明）、六项核心指标表、12 个月对比表、Q1–Q4 季度对比、三个书目变化分组（连续进入 / 进入 / 未进入）、描述性变化摘要、说明区。
- **指标**：六项核心指标（阅读记录 / 活跃月份 / 已匹配记录 / 年度书目 / 最长连续月份 / 活跃月份平均记录），百分比按 `from_zero` → `由 0 开始`、`to_zero` → `-100%`、`same` → `0%`、其他 → `±N%` 渲染。
- **时间轴**：固定 12 行（1月–12月），按 `monthNumber` 升序。
- **季度**：Q1–Q4 顺序输出，每张卡包含基准/目标年记录、活跃月份、书目。
- **书目榜分组**：
  - **continuing**：基准年和目标年均出现的书目；按目标年排名排序。
  - **entered**：仅出现在目标年的书目；标注免责声明。
  - **left**：仅出现在基准年的书目；标注免责声明。
- **排名变化**：`上升 N 位` / `下降 N 位` / `持平` / `—`。
- **零基线**：`base=0` → `由 0 开始`；`target=0` → `-100%`；不允许 `NaN` / `Infinity`。
- **空数据**：两年均无数据时仍可导出；六项指标全部 0、12 个月全部 0、Q1–Q4 全部 0、三个书目变化分组均为空。
- **文件名 / MIME**：`weread-year-comparison-<base>-vs-<target>-YYYYMMDD.md`；纯 ASCII；≤ 80 字符；`text/markdown;charset=utf-8`。
- **下载**：浏览器本地 `Blob` + 临时 `<a download>` + `setTimeout(URL.revokeObjectURL, 0)`。

## PRIVACY_RESULT

- **包含字段**：基准年 / 目标年（4 位年份）、Top N 范围（6/12/18）、六项核心指标数字、12 个月对比数字、Q1–Q4 对比数字、`title` / `author`（来自公共书目元数据）、`catalogId`（仅用于 `/books/<catalogId>` 公开链接）、模型生成的描述性摘要。
- **不包含字段**：笔记正文 / 评论 / `markedText` / `content`；微信读书私有 ID（`wereadBookId` / `noteId` / `highlightId` / `chapterTitle`）；微信读书原始 title / author；AI 摘要（`summary.overview` / `keyPoints` / `reviewQuestions` / `themes`）；`token` / `q` / `Authorization` 头；私有 API URL。
- **网络请求**：0 次额外网络请求（除按钮按下前已经发出的基准年 / 目标年请求）。
- **持久化**：无 `localStorage` / `sessionStorage` / IndexedDB 写入；不上传服务器。
- **清理**：`URL.revokeObjectURL` 在 `setTimeout(0)` 内被调用；切换基准年 / 目标年 / Top N / 关闭对比时已显示的成功 / 失败状态立即清空。

## REGRESSION_RESULT

- **vitest**: 53 个测试文件 / **1293 项断言全部 PASS**（包含 57 项 S27K-2 模型测试 + 29 项 YearComparisonPanel 测试）。
- **web tsc**: `tsc -p apps/web/tsconfig.json --noEmit` 通过，无错误。
- **Vite build**: 100 个模块转换，CSS 87.13 kB / JS 461.84 kB，构建成功。
- **verify**: `docs = 5,115,734`，状态 `PASS`。
- **search-quality**: 17 项全部 `PASS` / 0 `WARN` / 0 `FAIL`。

## DEPLOY_RESULT

- **web rebuilt**: `book-id-search-web` 容器 rebuild + restart，`Up 14 seconds` (本次任务)。
- **api untouched**: `book-id-search-api-1` 保持 `Up 3 hours`，未重启。
- **Meilisearch untouched**: `book-id-search-meilisearch-1` 保持 `Up 4 weeks`，未重启。
- **Caddy / DNS / nginx / ICP / 公安备案 untouched**: 无变更。

## SECURITY_RESULT

- **代码引用检查**: 源码不引用 `note.text` / `note.comment` / `summary.overview` / `summary.keyPoints` / `summary.reviewQuestions` / `wereadBookId` / `noteId` / `highlightId` / `fetchWereadAiSummary` / `fetchWereadRelatedBooks`。
- **响应检查**: 浏览器 smoke 验证 Markdown 不含任何 `FORBIDDEN_*` 标记、私有 ID、token、AI 摘要字段。
- **日志检查**: `docker compose logs --tail=100 web` 无 Markdown 内容、真实榜单、token 或私有 ID。
- **持久化检查**: `apps/web/src/weread/wereadYearComparisonMarkdown.ts` 中无 `localStorage` / `sessionStorage` / IndexedDB 写入。
- **依赖检查**: `package.json` 无变化；`apps/web/package.json` 无变化。

## REPO_RESULT

- **未提交的本地变更**:
  - `M  README.md`
  - `M  apps/web/src/styles.css`
  - `M  apps/web/src/weread/YearComparisonPanel.test.ts`
  - `M  apps/web/src/weread/YearComparisonPanel.tsx`
  - `M  docs/WEREAD_ANNUAL_REVIEW.md`
  - `M  docs/WEREAD_CENTER.md`
  - `M  docs/WEREAD_YEAR_COMPARISON.md`
  - `?? apps/web/src/weread/wereadYearComparisonMarkdown.test.ts`
  - `?? apps/web/src/weread/wereadYearComparisonMarkdown.ts`
  - `?? docs/WEREAD_YEAR_COMPARISON_MARKDOWN.md`
  - `?? scripts/s27k2-browser-smoke.cjs`
- **apps/api 无改动**: `git diff --stat -- apps/api/` 为空。
- **.env / private-data / dist / logs / screenshots / progress 不提交**: 仅本地调试用 `reports/screenshots/s27k2-year-comparison-markdown.png` 未在仓库中跟踪。
- **目标 tag**: `v0.16.1-weread-year-comparison-markdown`。

## LIMITATIONS

- 只比较两个自然年；不支持任意日期区间。
- 只导出当前基准年 / 目标年 + 当前 Top N 范围。
- 不包含主题 / 类别 / 阅读内容分析。
- 不包含心理 / 阅读质量 / 阅读兴趣 / 性格推断。
- 不支持 PDF / 图片 / 图表截图；只生成纯文本 Markdown。
- 不自动更新已导出的文件；用户自行管理。
- 不提供公开分享链接。
- 文件名不含书名 / 作者 / 主题 / catalogId；只含基准年 / 目标年 / 日期戳。

## NEXT_STEP

- **S27L Long-term Reading Archive Index**: 跨多年阅读档案索引。