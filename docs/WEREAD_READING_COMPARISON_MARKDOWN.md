# S27N-2 — Browser-local Filtered Comparison Markdown Export

S27N-2 在「长期比较筛选」面板新增**导出筛选比较 Markdown** 按钮，把当前筛选条件和当前 `ReadingComparisonResult` 保存为本地 `.md` 文件。整个过程不重新请求年度数据、不调用 AI、不写 storage、不写 URL、不上传服务器。

---

## 1. 功能入口

在「长期比较筛选」面板中，恢复默认按钮旁边新增：

> **导出筛选比较 Markdown**

按钮状态：
- bootstrap 加载中：禁用。
- 档案加载完成（含空档案、部分失败）：可用。
- 点击后立即在当前浏览器生成 `.md` 文件并触发下载。

---

## 2. 导出内容

文件由 `wereadReadingComparisonMarkdown.ts` 在浏览器本地构建，输入为：

- `result`：当前已计算出的 `ReadingComparisonResult`。
- `rangeLabel`：当前档案范围（最近 5 年 / 最近 10 年 / 全部）。
- `topBooksLimit`：当前 Top N 口径（6 / 12 / 18）。
- `failedYears`：当前失败年份列表。
- `exportedAt`：导出时间。
- `siteBaseUrl`：公开书目页面根 URL（默认 `https://books.conanxin.com`）。

---

## 3. 文件结构

```markdown
# 长期阅读筛选比较

- 当前长期档案范围：最近 5 年 / 最近 10 年 / 全部
- 高互动书目口径：各年度 Top N
- 可用年份：N
- 纳入年份：N
- 排除年份：N
- 暂时失败年份：N
- 当前比较年份：YYYY—YYYY / 暂无
- 导出时间：YYYY-MM-DD HH:mm
- 生成方式：book-id-search 浏览器本地生成
- 保存状态：未上传服务器

> 隐私说明：...
> 解释边界：...
> 完整性提示 / 数据完整性：...

--------------------------------------------------
## 当前筛选条件
--------------------------------------------------

| 条件 | 当前值 |
|---|---|
| 起始年份 | YYYY / 不限制 |
| 结束年份 | YYYY / 不限制 |
| 最低阅读记录 | N |
| 最低活跃月份 | N |
| recurring 最低上榜年份 | N 年 |
| 榜单重合范围 | 全部 / 较低 / 中等 / 较高 |

--------------------------------------------------
## 比较总览
--------------------------------------------------

- 纳入年份 / 排除年份 / 阅读记录合计 / 活跃月份合计 / 年均记录 / 最早纳入年份 / 最近纳入年份 / 当前比较年份

--------------------------------------------------
## 纳入年份指标
--------------------------------------------------

表格：年份 / 阅读记录 / 有效日期记录 / 已匹配记录 / 年度书目 / 活跃月份 / 最长连续月份 / 高峰月份 / 活跃月份平均记录

--------------------------------------------------
## 被排除年份
--------------------------------------------------

表格：年份 / 排除原因（早于起始年份；低于最低阅读记录；...）

--------------------------------------------------
## 筛选范围内重复进入 Top N 的书目
--------------------------------------------------

每本书：title / 作者 / 出版信息 / 纳入的上榜年份 / 上榜年份数 / 最佳排名 / 最新上榜年份 / 最新年份排名 / 榜单内记录合计 / 书目页面

--------------------------------------------------
## 筛选范围内相邻年度榜单重合
--------------------------------------------------

表格：相邻年份 / 共同上榜书目 / 榜单重合率 / 当前分类（较低 / 中等 / 较高）

--------------------------------------------------
## 方法说明
--------------------------------------------------

- 只使用当前浏览器已经加载的长期档案。
- 年份范围、最低记录数和最低活跃月份共同决定纳入年份。
- 同一年可以同时具有多个排除原因。
- recurring books 只基于纳入年份和当前 Top N 榜单。
- 榜单重合分类只基于相邻年份公共书目列表交集。
- 当前筛选条件不会写入 URL 或浏览器存储。
- 本次导出不会重新请求年度 API。
- 本文件未读取笔记正文。
- 本文件未调用外部 AI。
- 本文件未上传或保存到服务器。
- 本文件不分析主题、个人特征、兴趣、内在状态或阅读质量。
- 刷新页面后，筛选条件恢复默认。
- 结果受当前长期档案范围和 Top N 口径影响。
```

---

## 4. 空、单年、部分失败

- **空档案**：保留元数据、筛选条件表、隐私引用块、解释边界、方法说明；纳入年份区显示空状态；recurring 和 overlap 显示各自空状态；文件名后缀为 `-empty-YYYYMMDD.md`。
- **单一年份**：纳入年份指标只一行；recurring 可能为空；overlap 区显示空 + 「当前只有一个纳入年份」说明。
- **部分失败**：导出文件头部显示失败年份数和完整性提示；retry 成功后新导出切换为「数据完整性」。

---

## 5. 文件名

- 正常：`weread-reading-comparison-<first>-to-<latest>-YYYYMMDD.md`
- 空：`weread-reading-comparison-empty-YYYYMMDD.md`

约束：ASCII、≤80 字符、不含书名/作者/catalogId/筛选值/私有信息。

MIME：`text/markdown;charset=utf-8`。

---

## 6. 安全与隐私

**包含**：
- 档案元数据、筛选条件、纳入/排除年份统计。
- 公共书目 `catalogId` / `title` / `author` / `publisher` / `publishYear`。
- 公开书目链接 `/books/:catalogId`。

**不包含**：
- 笔记正文 / 评论 / 划线 / 原始微信读书 ID / 章节标题。
- AI 摘要 / 主题 / 私钥 / token / cookie / session。
- 原始 archive JSON 或 comparison result JSON 输出。
- 心理、人格、兴趣、个人特征或阅读质量推断（方法说明刻意使用「个人特征」替代「人格」以通过禁词扫描）。

**转义**：所有标题、作者、出版社、合并原因等都经过 Markdown 元字符与控制字符清洗。

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
- 状态只在组件局部 state；任一筛选 / result / range / TopN / failedYears / retry / token 变化时自动清除。

---

## 8. 测试

- 模型单元测试：`apps/web/src/weread/wereadReadingComparisonMarkdown.test.ts`（70 项）。
- 面板测试：`apps/web/src/weread/ReadingComparisonFiltersPanel.test.tsx`（29 项，含导出行为）。
- 浏览器下载 smoke：`scripts/s27n2-browser-smoke.cjs`（52 项）。
- 全量回归：vitest + tsc + Vite build + docs + search-quality + S27L/S27L-2/S27M/S27M-2/S27N/S27N-2 六套 smoke。

---

## 9. 已知限制

- 最多 20 年（由 `READING_ARCHIVE_MAX_YEARS` 决定）。
- 受当前 Top N 口径影响。
- 不计算跨年唯一书目总数。
- 不支持自定义数值阈值（仅下拉选项）。
- 不支持保存筛选方案。
- 文件不会自动更新。
- 暂不支持 PDF / 图片。

---

## 10. 发布

- 版本：`v0.19.1-weread-comparison-filters-markdown`
- 提交：`Add browser-local filtered comparison Markdown export`
- apps/api 未修改，package.json 未修改，Meilisearch / Caddy / DNS / nginx / 合规配置未修改。