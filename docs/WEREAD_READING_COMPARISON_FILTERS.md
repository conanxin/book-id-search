# S27N — Long-term Reading Comparison Filters

S27N 在「长期档案」工作区新增**比较筛选**面板。筛选完全作用于当前浏览器已加载的长期档案（`WereadReadingArchive`），不重新请求年度数据、不调用 AI、不持久化、不修改 URL、不修改 archive reducer / cache / retry 语义。

---

## 1. 功能入口

在「长期档案」工作区中，**阅读阶段**面板之后、年度档案目录之前，新增：

> **长期比较筛选**

顶部说明：「筛选只作用于当前浏览器已加载的长期档案，不会重新请求年度数据。结果用于比较统计，不代表阅读兴趣、内在状态或阅读质量。」

---

## 2. 筛选条件

默认条件：

| 字段 | 默认值 | 取值 |
|------|--------|------|
| 起始年份 | null（不限） | 当前 availableYears 内的年份 |
| 结束年份 | null（不限） | 当前 availableYears 内的年份 |
| 最低阅读记录 | 0 | 0 / 10 / 25 / 50 / 100 |
| 最低活跃月份 | 0 | 0 / 3 / 6 / 9 / 12 |
| Recurring 最低上榜年份 | 2 | 2 / 3 / 4 |
| 榜单重合范围 | all | all / low / medium / high |

---

## 3. 筛选规则

### 3.1 年份范围

- 起始 / 结束年份只能从当前 `availableYears` 选择。
- 若 `startYear > endYear`，normalize 时交换两者。
- 若年份不在 availableYears，向最近的合法年份收敛。
- `null` 表示不限制。

### 3.2 排除原因

| 字段 | 含义 |
|------|------|
| `before_start` | year < startYear |
| `after_end` | year > endYear |
| `records_below_min` | totalRecords < minRecords |
| `active_months_below_min` | activeMonths < minActiveMonths |

同一年可以有多个排除原因。

### 3.3 Overlap 分类

| 类别 | 比例 |
|------|------|
| low | 0 ≤ ratio < 0.25 |
| medium | 0.25 ≤ ratio < 0.5 |
| high | 0.5 ≤ ratio ≤ 1 |
| all | 不筛选 |

边界归一：
- NaN → 0
- -Infinity → 0
- Infinity → 1
- ratio < 0 → 0
- ratio > 1 → 1

### 3.4 Recurring Books

- 只统计进入 includedYears 中当前 Top N 的公共书目。
- `appearances` 只保留 includedYears。
- 过滤后出现年份数 ≥ `recurringMinYears` 才保留。
- 重算指标：`appearanceCount` / `bestRank` / `latestYear` / `latestRank` / `totalRecordsInTopLists`。
- 排序：`appearanceCount` 降序 → `bestRank` 升序 → `latestYear` 降序 → `title` 稳定排序。
- 最多 12 本。

### 3.5 Year Links

- 只有 sourceYear 和 targetYear 都属于 includedYears 才进入结果。
- 按当前 overlap 类别过滤。
- 输出按 sourceYear → targetYear 升序。

---

## 4. 输出结构

### 4.1 当前比较范围

- 纳入年份数
- 排除年份数
- 年份范围（YYYY—YYYY / —）
- 阅读记录合计
- 活跃月份合计
- 年均记录

### 4.2 被排除年份

每个被排除年份一行 + 排除原因（中文）：
- 早于起始年份
- 晚于结束年份
- 低于最低阅读记录
- 低于最低活跃月份

### 4.3 年度指标比较

表格列：年份 / 阅读记录 / 活跃月份 / 月均记录 / 已匹配记录 / 年度书目 / 最长连续月份 / 高峰月份。

### 4.4 Recurring Books

每本书：title / author / 进入年份 / 进入年份数 / 最佳排名 / 最新年份 / 公开书目 URL `/books/:catalogId`。

### 4.5 相邻年度榜单重合

每条：sourceYear → targetYear / 共同上榜书目数 / 重合比例。

---

## 5. 隐私与边界

- 包含：档案元数据 + 公共书目 catalogId/title/author/publisher/publishYear + 重合比例 + 阶段统计。
- 排除：note.text / note.comment / wereadBookId / noteId / highlightId / chapterTitle / AI 摘要 / themes / token / Authorization / API key / 原始 archive JSON。
- 网络：0 额外请求。
- 持久化：0 localStorage / 0 sessionStorage / 0 IndexedDB。
- URL：条件不写入 URL。
- 心理/兴趣/人格/质量：完全禁止。

---

## 6. 测试

- 模型单元测试：`apps/web/src/weread/wereadReadingComparisonFilters.test.ts`（64 项）。
- 面板测试：`apps/web/src/weread/ReadingComparisonFiltersPanel.test.tsx`（16 项）。
- 浏览器 smoke：`scripts/s27n-browser-smoke.cjs`（30 项）。
- 全量回归：vitest + tsc + Vite build + docs + search-quality + S27L/S27L-2/S27M/S27M-2/S27N 五套 smoke。

---

## 7. 已知限制

- 最多 20 年（由 `READING_ARCHIVE_MAX_YEARS` 决定）。
- 受当前 Top N 口径影响。
- 不计算跨年唯一书目总数。
- 条件刷新页面后恢复默认（不持久化）。
- 暂不支持保存筛选方案。
- 暂不支持自定义数值输入（仅下拉选项）。

---

## 8. 发布

- 版本：`v0.19.0-weread-comparison-filters`
- 提交：`Add long-term reading comparison filters`
- apps/api 未修改，package.json 未修改，Meilisearch / Caddy / DNS / nginx / 合规配置未修改。