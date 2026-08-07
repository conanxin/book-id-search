# S27R-3 — WeRead Long-term Reading Data Repair Recommendations Markdown Export

> 微信读书「长期档案 → 数据修复建议」面板内置浏览器本地 Markdown 导出。该导出使用当前「数据修复建议」结果在浏览器中生成静态 Markdown 文件，**不重新请求 annual-review**，**不调用 MiniMax**，**不上传服务器**，**不写 storage**，**不修改 URL**。

---

## 1. 功能范围

- 仅在 `/weread` 中心页「长期档案 → 数据修复建议」面板出现，导出按钮位于面板底部。
- 点击导出按钮后立即在浏览器内：
  1. 使用当前 `recommendations` 结果作为唯一数据源；
  2. 序列化为 Markdown 字符串；
  3. 创建 `Blob`（MIME `text/markdown;charset=utf-8`）；
  4. 通过 `URL.createObjectURL` 获得临时 URL；
  5. 创建临时 `<a download>` 并触发 `click()`；
  6. 立即 `URL.revokeObjectURL` 撤销临时 URL。
- **不重新发起任何网络请求**（包括 `annual-review` / `summary` / `trends` / `related-books` / MiniMax）。
- **不写 localStorage / sessionStorage / IndexedDB / cookie**。
- **不修改 URL / history / pushState / replaceState**。
- **不调用 fetch / XMLHttpRequest**。
- **不使用 innerHTML / dangerouslySetInnerHTML**。
- 下载目录 `/tmp/s27r3-downloads` 在脚本结束（`finally` 块）中被强制 `rm -rf` 清理。

---

## 2. 文件结构

生成的 Markdown 文件按以下顺序排列：

1. **元数据**：导出时间戳（浏览器本地 `Date.now()`）、当前长期档案范围、Top N 档位、审计面板状态（仅枚举，不含真实内容）。
2. **安全说明**：声明本文件**不是**自动修复工具，**不修改源数据**，**不评价用户**；不含 title / author / catalogId / note 原文 / token / 私有 ID / 原始 archive / 原始修复计划。
3. **建议总览**：建议总数 + `actionable` / `manual-review` / `unsupported` 三档分组的计数；不出现「问题严重」「紧急」「自动修复」等措辞。
4. **建议明细**：每条建议一行，含：
   - 优先级（`P0` / `P1` / `P2` / `P3` 枚举）；
   - 动作（`RepairAction` 枚举的中文标签）；
   - 能力（`RepairCapability` 枚举的中文标签）；
   - 安全位置（`year=YYYY / rank=N` 之类），**不包含**真实书目元数据；
   - 一句话中性摘要。
5. **可由现有界面处理**（`actionable`）：仅列出动作与能力，不展开真实执行步骤。
6. **需要人工核对**（`manual-review`）：仅列出动作与能力，提示人工可以在书评/笔记流程中核对。
7. **当前字段不足**（`unsupported`）：仅列出动作与能力，说明当前档案数据本身缺乏必要字段；**不会**虚构数据。
8. **方法说明**：声明建议模型的输入是审计结果（不读取原始数据），列建议模型的 9 个 action / 5 个 capability / 4 个 priority / 9 个 guidance key；说明当前 `unsupported_with_current_fields` 分支因 Archive 不暴露 recurring per-year rank 映射而当前不可达；声明隐私边界。

---

## 3. 文件名与 MIME

- 文件名：`weread-reading-data-repair-plan-YYYYMMDD.md`
  - `YYYYMMDD` 取自浏览器本地日期
  - 仅 ASCII 字符，最大 80 字符
- MIME：`text/markdown;charset=utf-8`
- 文件编码：UTF-8（无 BOM）

---

## 4. 隐私边界（FORBIDDEN 列表）

导出过程中**强制不包含**以下字段，由 `validateReadingDataRepairMarkdown()` + `FORBIDDEN_PATTERNS` 正则在序列化前/序列化后双重防御：

- `Recommendation ID`（如 `recXXXXXXX`）
- `Issue ID`（如 `issueXXXXXXX`）
- `actual` / `expected` 原始字段（仅保留 `safeValue()` 处理后的中性安全数值）
- `title` / `author` / `catalogId`（任何书目真实元数据）
- 笔记正文 / 笔记评论 / 章节标题 / 划线正文
- `noteId` / `wereadBookId` / `highlightId` 等私有 ID
- raw audit JSON
- raw repair plan JSON
- token / API key / 任何认证凭据
- 评价性语言（「更爱阅读」/「兴趣增强」/「能力提升」/「阅读质量」/「心理状态」/「人格」/「成长」/「退步」/「低谷」/「巅峰」/「优秀」/「较差」/「自动修复成功」/「一键修复」/「用户评分」等）

---

## 5. 行为

- 0 网络
- 0 storage
- 0 URL 写入
- 0 自动修复
- 浏览器本地 Blob download（`URL.createObjectURL` + `<a download>` + `URL.revokeObjectURL`）
- 决定性：相同审计结果 + 相同档案范围 → 相同 Markdown 内容

---

## 6. 已知限制

- 仅基于当前浏览器已加载档案 + 当前审计结果，不重新请求数据。
- 不与源服务器重新对账（不会调用任何后端 endpoint）。
- 不自动修复任何 Issue。
- 文件不会自动更新，需要用户主动点击导出按钮。
- 不支持 PDF 导出、不支持公开分享（不上传到任何第三方服务）。
- 当前 `unsupported_with_current_fields` 分支因 Archive 不暴露 recurring per-year rank 映射而当前不可达；这是当前实现限制，不是缺陷。

---

## 7. 测试覆盖

- 50 个单元测试覆盖 `wereadReadingDataRepairMarkdown.ts` 的所有纯函数（隐私正则、文件结构、filename、MIME、redact 边界、FORBIDDEN_PATTERNS 防御）。
- 15 个组件测试覆盖 `ReadingDataRepairExportAction.tsx` 的渲染、状态机、reset key、按钮可用性、URL.revokeObjectURL。
- 45 项浏览器端到端断言（`scripts/s27r3-browser-smoke.cjs`）覆盖真实下载、文件名、内容结构、隐私不泄露、React #300=0、桌面 / 移动端无横向溢出。
- 上述测试在 S27R-3B、S27R-3C-0、S27R-3C-1A、S27R-3C-1B、S27R-3C-1C 期间均通过。