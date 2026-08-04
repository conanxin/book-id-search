# S27M-2 — Browser-local Reading Era Markdown Export

S27M-2 在 S27M 的“阅读阶段”面板增加**浏览器本地 Markdown 导出**，
把当前已计算出的阶段结果保存为本地文件。整个过程不重新请求年度数据、
不调用 AI、不上传服务器、不写 storage。

---

## 1. 功能入口

在「长期档案」→「阅读阶段」面板中，模式选择下方新增：

> **导出阅读阶段 Markdown**

按钮状态：
- 档案 bootstrap 加载中：禁用。
- 计算完成（含空档案、部分失败）：可用。
- 点击后立即在当前浏览器生成 `.md` 文件并触发下载。

---

## 2. 导出内容

文件由 `wereadReadingEraMarkdown.ts` 在浏览器本地构建，输入为：

- `result`：当前已计算出的 `WereadReadingEraResult`。
- `rangeLabel`：当前档案范围（最近 5 年 / 最近 10 年 / 全部）。
- `topBooksLimit`：当前 Top N 口径（6 / 12 / 18）。
- `mode`：当前阶段划分模式（automatic / gaps_only）。
- `failedYears`：当前失败年份列表。
- `exportedAt`：导出时间。
- `siteBaseUrl`：公开书目页面根 URL（默认 `https://books.conanxin.com`）。

---

## 3. 文件结构

```markdown
# 阅读阶段档案

- 档案年份：YYYY—YYYY / 暂无年份
- 当前长期档案范围：最近 5 年 / 最近 10 年 / 全部（最多 20 年）
- 高互动书目口径：各年度 Top N
- 阶段划分模式：自动阶段 / 仅按年份中断
- 成功加载年份：N
- 暂时失败年份：N
- 阶段数量：N
- 导出时间：YYYY-MM-DD HH:mm
- 生成方式：book-id-search 浏览器本地生成
- 保存状态：未上传服务器

> 隐私说明：...
> 解释边界：...
> 完整性提示 / 数据完整性：...

--------------------------------------------------
## 阶段总览
--------------------------------------------------

| 阶段 | 年份 | 年份数 | 阅读记录 | 活跃月份 | 年均记录 | 高峰年份 |

--------------------------------------------------
## 阶段详情
--------------------------------------------------

### 阶段 1：YYYY—YYYY 年

- 包含年份：...
- 年份数量：...
- 阅读记录合计：...
- 活跃月份合计：...
- 年均记录：...
- 高峰年份：...

#### 与上一阶段的分界
- 分界位置：YYYY → YYYY
- 分界得分：N
- 分界依据：
  - 年份存在中断
  - 阅读记录数量变化较大
  - 活跃月份数量变化较大
  - 相邻年度 Top N 榜单重合较低

--------------------------------------------------
### 阶段内重复进入 Top N 的书目
--------------------------------------------------

> 本节只统计...

#### 1. 《公共书名》
- 作者：公共作者
- 出版信息：出版社，出版年份
- 进入榜单年份：YYYY、YYYY
- 进入榜单次数：N 年
- 最佳排名：第 N
- 最新上榜年份：YYYY
- 书目页面：https://books.conanxin.com/books/<catalogId>

--------------------------------------------------
## 阶段边界一览
--------------------------------------------------

| 分界 | 得分 | 分界依据 |

--------------------------------------------------
## 方法说明
--------------------------------------------------

- 只比较相邻年份。
- 年份中断必定形成边界。
- 阅读记录变化需要同时满足比例和绝对差阈值。
- 活跃月份变化只依据月份数量差。
- Top N 变化只依据公共书目榜单重合率。
- 自动阶段模式中，非年份中断原因的总分达到阈值才分段。
- 仅按年份中断模式忽略其他统计变化。
- 单一年份阶段可能依据确定性规则与相邻阶段合并。
- 阶段结果受当前年份范围和 Top N 口径影响。
- 本文件不分析主题、类别、个人内在状态、兴趣或阅读质量。
- 本文件未读取笔记正文。
- 本文件未调用外部 AI。
- 本文件未上传或保存到服务器。
```

---

## 4. 空档案与单一年份

- **空档案**：元数据保留，阶段总览显示“当前暂无成功加载的年度数据，
  无法生成阅读阶段”，不输出虚假阶段或边界。
- **单一年份**：输出一个阶段，recurring books 为空，附加说明
  “当前只有一个成功加载年份，无法比较相邻年份。”
- **部分失败**：在文件头部附加完整性提示，并列出失败年份数量。
  阶段划分只基于成功加载年份。

---

## 5. 文件名

- automatic：`weread-reading-eras-automatic-<first>-to-<latest>-YYYYMMDD.md`
- gaps_only：`weread-reading-eras-gaps-only-<first>-to-<latest>-YYYYMMDD.md`
- 空档案：`weread-reading-eras-<mode>-empty-YYYYMMDD.md`

约束：ASCII、≤80 字符、不含书名/作者/catalogId/私有信息。

MIME：`text/markdown;charset=utf-8`。

---

## 6. 安全与隐私

**包含**：
- 档案元数据、阶段统计、边界分数与白名单原因。
- 各阶段公共书目 `catalogId`、`title`、`author`、`publisher`、`publishYear`。
- 公开书目链接 `/books/:catalogId`。

**不包含**：
- 笔记正文、评论、划线、原始微信读书 ID、章节标题。
- AI 摘要、主题、私钥、token、cookie、session。
- 原始 archive JSON 或 era JSON 输出。
- 心理、人格、兴趣或阅读质量推断。

**转义**：所有标题、作者、出版社等字符串都经过 Markdown 元字符与
控制字符清洗，防止标题注入、表格破坏或隐藏内容。

---

## 7. 下载实现

```
Blob(content, { type: "text/markdown;charset=utf-8" })
  → URL.createObjectURL(blob)
  → 临时 <a download>
  → click()
  → remove()
  → URL.revokeObjectURL()
```

- 无 `console.log` 输出完整 Markdown。
- 无 `localStorage` / `sessionStorage` / `IndexedDB` 写入。
- 无网络上传或后端 POST。

---

## 8. 测试

- 模型单元测试：`apps/web/src/weread/wereadReadingEraMarkdown.test.ts`（59 项）。
- 面板测试：`apps/web/src/weread/ReadingEraPanel.test.tsx`（22 项，含导出行为）。
- 浏览器下载 smoke：`scripts/s27m2-browser-smoke.cjs`（45 项）。
- 全量回归：vitest + tsc + Vite build + docs + search-quality + S27L/S27L-2/S27M/S27M-2 四套 smoke。

---

## 9. 已知限制

- 最多 20 年（由 `READING_ARCHIVE_MAX_YEARS` 决定）。
- 阶段结果受当前年份范围和 Top N 口径影响。
- 阈值是启发式规则，不支持用户手工编辑。
- 阶段内 recurring 书目只统计该阶段至少两个年份进入 Top N 的公共书目。
- 不包含 PDF、图表或图片。
- 导出的 Markdown 不会自动更新，需要手动重新导出。

---

## 10. 发布

- 版本：`v0.18.1-weread-reading-eras-markdown`
- 提交：`Add browser-local reading era Markdown export`
- apps/api 未修改，package.json 未修改，Meilisearch / Caddy / DNS / nginx / 合规配置未修改。
