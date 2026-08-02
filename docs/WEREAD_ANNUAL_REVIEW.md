# S27J — WeRead Annual Reading Review

> 微信读书中心新增「年度回顾」工作区。该功能把私有微信读书笔记按 **选定年份** 聚合成概览、12 个月时间轴、季度节奏、年度高互动书目和描述性年度记录卡。数据只来自 `note.createdAt` / `updatedAt`（首选 createdAt，回退 updatedAt）、note type、以及 `weread-matches.confirmed.json` 中的 `wereadBookId → public catalogId` 匹配。

---

## 1. 功能范围

- 新增第四个工作区：「年度回顾」，与「笔记与 AI」「个人阅读地图」「复习日历」并列，默认仍是「笔记与 AI」。
- 用户可在 `availableYears` 中选择有数据的年份；切换年份触发新请求。
- 顶部高互动书目数 6 / 12 / 18 三档可调；切换触发新请求。
- 数据来源是现有 `GET /api/private/weread/annual-review` 端点（前端通过 `Authorization: Bearer …` 头调用，不发送 body、不调用 `/api/search`）。
- 输出包含：年度概览、12 个月时间轴、类型分布、Q1–Q4 季度卡、年度高互动书目、年度记录卡。
- 选中年份没有数据时返回完整 12 个零值月份、`topBooks=[]`、overview 全零值、HTTP 200。

## 2. API 与数据来源

### 端点

```
GET /api/private/weread/annual-review?year=<YYYY>&topBooks=<6|12|18>
```

| 参数 | 范围 | 默认 | 说明 |
|------|------|------|------|
| `year` | `[2000, currentYear+1]` 的整数 | 私有笔记中最新的有效年份 | 缺省时使用最新有数据年份；完全无日期时使用当前 UTC 年 |
| `topBooks` | `6 / 12 / 18` | `12` | 顶部高互动书目数 |

### 响应字段

```ts
type AnnualReviewOverview = {
  year: number
  totalRecords: number
  datedRecords: number
  matchedRecords: number
  matchedBooks: number
  activeMonths: number
  longestStreakMonths: number
  firstNoteAt: string | null
  lastNoteAt: string | null
  peakMonth: string | null
  peakMonthRecords: number
  averageRecordsPerActiveMonth: number
}

type AnnualReviewMonth = {
  month: string         // "YYYY-MM"
  total: number
  highlights: number
  thoughts: number
  reviews: number
  unknown: number
  matched: number
  bookCount: number     // 当月 distinct matched catalogId 数
}

type AnnualReviewQuarter = {
  quarter: "Q1" | "Q2" | "Q3" | "Q4"
  total: number
  activeMonths: number
  matchedRecords: number
  bookCount: number
}

type AnnualReviewBook = {
  catalogId: string                  // 公共 catalogId
  title: string                      // 来自公共书目库；缺失时回退 `书目 ${catalogId}`
  author?: string | null
  publisher?: string | null
  publishYear?: string | number | null
  noteCount: number
  highlights: number
  thoughts: number
  reviews: number
  unknown: number
  activeMonths: number
  firstNoteAt: string | null
  lastNoteAt: string | null
}

type PrivateAnnualReviewResponse = {
  ok: true
  selectedYear: number
  availableYears: number[]          // 全部有效笔记日期的年份，去重降序
  overview: AnnualReviewOverview
  months: AnnualReviewMonth[]        // 长度 = 12
  quarters: AnnualReviewQuarter[]    // 长度 = 4
  topBooks: AnnualReviewBook[]
  meta: {
    topBooksRequested: number
    topBooksReturned: number
    persisted: false
    source: "private_snapshot+public_catalog"
  }
}
```

### 数据来源

| 字段 | 来自 |
|------|------|
| `overview.totalRecords` / `datedRecords` / `months[].total` / `quarters[].total` | `private-data/weread/snapshots/latest/weread-notes.snapshot.json` |
| `months[].bookCount` / `quarters[].bookCount` / `topBooks[].noteCount` | 同上 + `derived/latest/weread-matches.confirmed.json` 提供的 `wereadBookId → catalogId` 映射 |
| `topBooks[].title` / `author` / `publisher` / `publishYear` | 公共书目库（Meilisearch `books` 索引，`index.getDocument` 直读） |
| `meta.source` | 固定为 `"private_snapshot+public_catalog"` |
| `meta.persisted` | 固定为 `false` |

**绝对不返回：**

- 笔记正文 / 评论 / 标注文本 / `markedText` / `content`
- 微信读书内部 ID：`wereadBookId` / `noteId` / `highlightId` / `chapterTitle`
- 微信读书原始 `title` / `author`
- 原始 snapshot 记录、Meili 排名细节、文件路径、`mtime`、内部映射表
- AI 摘要或主题数据

## 3. 聚合规则

### 日期

- 优先 `createdAt`，回退 `updatedAt`，使用 UTC 年月。
- 无有效日期的记录不进入任何年度、不计入 `availableYears`。
- 不根据文件时间或导入时间补日期。

### 年份

- `availableYears` 从全部有效笔记日期提取年份，去重降序。
- `selectedYear`：
  1. 调用方传入且在范围时使用。
  2. 否则取 `availableYears` 的第一项（最新）。
  3. 完全无数据时使用当前 UTC 年。
- 选中年份没有数据 → 返回完整 12 个零值月份、`topBooks=[]`、overview 零值、HTTP 200。

### 月份

- 固定返回 12 项 `YYYY-01` ~ `YYYY-12`。
- 没记录的月份补零。
- `total` 包含全部有效记录（含未匹配）。
- `matched` 仅含已匹配书目的记录。
- `bookCount` 是该月 distinct matched public catalogId 数量。未匹配笔记计入 `total` 和类型，但不计入 `bookCount`。

### 年度 streak

- 只在该年的 12 个月内计算最长连续活跃月份。
- **不跨年连接**（2024-12 与 2025-01 不算连续）。
- `activeMonths` 是该年内 `total > 0` 的月份数。

### peakMonth

- `total` 最大的月份。
- 并列时取更早月份。
- 全年为零时 `peakMonth=null`、`peakMonthRecords=0`。

### 年度 top books

- 只聚合该年记录。
- 用 `wereadBookId → public catalogId` confirmed 映射。
- 多个 WeRead 条目映射同一 `catalogId` 时合并。
- **不按相同正文去重**（同一条目多次划线都计入 `noteCount`）。
- 排序：`noteCount` DESC → `activeMonths` DESC → `lastNoteAt` DESC → `catalogId` ASC。
- 公共元数据失败：`title = 书目 ${catalogId}`，其他字段为空。**绝不回退到微信读书原始 title/author**。

### Quarter

| 季度 | 月份范围 |
|------|----------|
| Q1 | 1–3 月 |
| Q2 | 4–6 月 |
| Q3 | 7–9 月 |
| Q4 | 10–12 月 |

`bookCount` 是该季度 distinct matched catalogId 数量（按原 note 集合精确计算，不是月份近似）。

## 4. 月度活跃度描述性分类

仅依据数量，**不推断阅读动机或心理状态**：

| 分类 | 条件 | UI 文案 |
|------|------|---------|
| 高活跃 | `total >= avg × 1.5`（avg = `averageRecordsPerActiveMonth`） | "高活跃" |
| 稳定 | `avg × 0.5 < total < avg × 1.5` | "稳定" |
| 轻量 | `0 < total <= avg × 0.5` | "轻量" |
| 无记录 | `total == 0` | "无记录" |
| 全部空（avg=0） | 全部为 "无记录" | "无记录" |

UI 上明确显示：「以下为基于记录数量的描述性分类，不代表阅读质量或个人状态。」

## 5. 隐私边界

- **不读取笔记正文**：服务端 helper（`private-annual-review.ts`）和前端 model（`wereadAnnualReviewModel.ts`）都不读取 `note.text` / `note.comment` / `markedText` / `content`。
- **不返回微信读书原始 title/author**：`hydrateAnnualReviewBooks` 在公共元数据失败时只使用 `书目 ${catalogId}` 兜底。
- **不调用 MiniMax / MiniMax**：端点不调用任何 AI 服务；前端 `AnnualReviewDashboard` 不接收 session overlay、不调用 `fetchWereadAiSummary` 或 `fetchWereadRelatedBooks`。
- **不持久化**：`meta.persisted` 恒为 `false`；不写入数据库、不写本地存储、不写 IndexedDB、不写 Meilisearch。
- **不提供公开分享**：没有 `GET /api/weread/annual-review`、没有导出链接、没有社交分享。
- **公共元数据只通过 `index.getDocument` 获取**：不走 `/api/search` HTTP，不写入新索引。

## 6. 已知限制

- **只有有效日期的记录进入年度**：缺日期记录被丢弃；`availableYears` 不包含该年。
- **只有 confirmed 匹配的书目进入 top books**：未匹配笔记仍计入 `total` 和类型，但不出现在 `topBooks[]` 中。
- **未匹配笔记仍计入 type 分布与季度 `total`**：保留完整统计量，但 `bookCount` 只反映已匹配书目。
- **月度活跃度只是数量描述**：不做主题分析、不做心理推断。
- **暂不支持年度 Markdown / PDF 导出**：当前版本只在浏览器中展示，不生成下载文件。
- **不提供跨任意日期范围的对比**：仅按完整自然年聚合，不支持 2025-03 → 2026-02 这类任意区间。

## 7. 测试覆盖

| 文件 | 测试数 | 说明 |
|------|--------|------|
| `apps/api/src/weread/private-annual-review.test.ts` | 63 | API 单元测试（validate / months / streak / peak / quarters / top books / hydrate / full response / orchestrator） |
| `apps/web/src/weread/wereadAnnualReviewModel.test.ts` | 27 | 前端 model 单元测试（timeline / classification / distribution / quarters / record cards） |
| `apps/web/src/weread/wereadPrivate.test.ts` (fetchWereadAnnualReview) | 8 | 浏览器 fetcher 测试（默认、参数、auth、abort、错误） |
| `apps/web/src/weread/AnnualReviewDashboard.test.ts` | 30 | 结构 / 隐私 / 响应式测试（第四 tab、激活守卫、年度切换、book URL、隐私说明、无禁词） |

合计 ≥ 38 个 API 单元测试 + ≥ 14 个前端 model 测试 + ≥ 27 个组件结构测试。

## 8. 端到端浏览器 smoke

`scripts/s27j-browser-smoke.cjs` 用 Puppeteer + 请求拦截模拟整个年度回顾流程：

- 不读取真实私有数据。
- 验证四个 workspace tab、默认笔记工作区、未激活前 0 请求、首次激活 1 请求、切换保留数据、年份切换重新请求、topBooks 切换重新请求、6 张概览卡、12 个月时间轴、Q1–Q4 卡片、月度活跃度分类、top books 卡片、book URL `/books/<catalogId>`、记录卡、空年份状态、ICP footer、desktop / mobile 无横向滚动、DOM 无 note text/comment/private IDs、保留 S27I ICS 导出与 S27H 阅读地图入口。