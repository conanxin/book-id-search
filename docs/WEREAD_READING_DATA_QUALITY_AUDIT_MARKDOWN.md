# S27Q-3B — WeRead Long-term Reading Data Quality Audit Markdown Export

> 微信读书「长期档案 → 数据质量审计」面板内置浏览器本地 Markdown 导出。该导出使用当前 audit result 在浏览器中生成静态 Markdown 文件，**不重新请求 annual-review**，**不调用 MiniMax**，**不上传服务器**，**不写 storage**，**不修改 URL**。

---

## 1. 功能范围

- 仅在 `/weread` 中心页「长期档案 → 数据质量审计」面板出现，导出按钮位于面板底部。
- 点击导出按钮后立即在浏览器内：
  1. 使用当前 `audit` 结果作为唯一数据源；
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
- 下载目录 `/tmp/s27q3-downloads` 在脚本结束（`finally` 块）中被强制 `rm -rf` 清理。

---

## 2. 文件结构

生成的 Markdown 文件按以下顺序排列：

1. **元数据**：审计时间戳（浏览器本地 `Date.now()`）、长期档案范围、Top N 档位。
2. **隐私说明**：声明本文件不含 title / author / catalogId / note 原文 / token / 私有 ID / 原始 archive。
3. **完整性提示**：当存在暂时失败或未闭合的目标年份时，给出显式提示；retry 成功后该提示自动消失。
4. **审计总览**：状态（`pass / warn / fail`）+ 各严重级 Issue 计数。
5. **五项覆盖比例**：`年份闭合比例` / `有效日期记录占比` / `已匹配记录占比` / `Top N 公共元数据完整比例` / `相邻年度链接覆盖比例`，每项一行。
6. **年份覆盖**：所有年份集合（target / loaded / failed / unaccounted / extra），按年份升序排序。
7. **Issue 分组**：按 `错误` / `警告` / `信息` 三组分别列出，含 Issue 中文标签、item position、actual / expected 安全数值。
8. **当前模型限制**：列出 `NOT_APPLICABLE` 项（如 `重算 bestRank` / `核对 latestYear 对应 latestRank`），说明模型不虚构数据。
9. **方法说明**：声明审计对象、5 个分组口径、5 个比例含义、口径边界、隐私边界。

---

## 3. 文件名与 MIME

- 文件名：`weread-reading-data-quality-audit-YYYYMMDD.md`
  - `YYYYMMDD` 取自浏览器本地日期
  - 仅 ASCII 字符，最大 80 字符
- MIME：`text/markdown;charset=utf-8`
- 文件编码：UTF-8（无 BOM）

---

## 4. 安全字段

### 4.1 允许出现在文件中的字段

- 年份（如 `2023`）
- scope 枚举（如 `coverage` / `year-metrics` / `top-n` / `year-link` / `recurring` / `summary-debug`）
- Issue 中文标签（如「年份闭合缺失」）
- item position（如 `year=2023 / rank=1`）
- `rank`（正整数）
- `actual` / `expected` 经过 `safeValue()` 处理的**安全数值**
- 比例和计数（如 `0.75` / `123`）

### 4.2 绝对不出现的字段

| 类别 | 模式示例 |
|------|---------|
| Issue 内部 ID | `year:foo:-:-:1234:`（含冒号 + 短 hash 后缀） |
| 书目元数据 | `title=...` / `author=...` / `catalogId=...` |
| 笔记 / 评论 | `note.text` / `note.comment` / `markedText` / `chapterTitle` |
| 私有 ID | `noteId` / `wereadBookId` / `highlightId` |
| 凭据 | `Authorization: Bearer ...` / `token=...` / `api-key` / `cookie` / `session` |
| 原始 archive / audit JSON | `{"audit":...` / `{ "issues": [...] }` 原文 |
| request / cache / debug 状态 | `request_id` / `cache_key` / `debug_snapshot` |

### 4.3 评价性文案

**不**出现：
- `更爱阅读` / `兴趣增强` / `兴趣减弱` / `能力提升` / `能力下降` / `阅读质量` / `心理状态` / `人格` / `成长` / `退步` / `低谷` / `巅峰` / `用户评分` / `优秀` / `较差`

只出现中性数据可核对程度的描述。

---

## 5. 下载实现

```text
1. Markdown = buildReadingDataQualityAuditMarkdown(audit)
2. Blob = new Blob([Markdown], { type: "text/markdown;charset=utf-8" })
3. URL = URL.createObjectURL(Blob)
4. a = document.createElement("a")
   a.href = URL
   a.download = buildReadingDataQualityAuditFilename()
   document.body.appendChild(a)
   a.click()
   document.body.removeChild(a)
5. URL.revokeObjectURL(URL)
```

- 第 4 步中 `a.click()` 是**唯一**触发浏览器下载的接口。
- 第 5 步立即撤销 Blob URL，避免内存泄漏。
- 整个流程在 `try / finally` 内，finally 保证 `URL.revokeObjectURL` 一定会执行。

---

## 6. 已知限制

- 仅审计当前浏览器已加载的档案数据，不审计未加载的年份。
- 失败年份的内容不能被审计（因为没拿到）。
- 不与源服务器重新对账（不会调用任何后端 endpoint）。
- 不自动修复任何 Issue。
- 文件不会自动更新，需要用户主动点击导出按钮。
- 不支持 PDF 导出、不支持公开分享（不上传到任何第三方服务）。

---

## 7. 测试覆盖

- 65 个单元测试覆盖 `wereadReadingDataQualityAuditMarkdown.ts` 的所有纯函数（隐私正则、文件结构、filename、MIME、redact 边界）。
- 26 个组件测试覆盖 `ReadingDataQualityAuditExportAction.tsx` 的渲染、状态机、reset key、按钮可用性。
- 43 项浏览器端到端断言（`scripts/s27q3-browser-smoke.cjs`）覆盖真实下载、文件名、内容结构、隐私不泄露、React #300=0、桌面 / 移动端无横向溢出。
- 上述三类测试在 S27Q-3C-0、S27Q-3C-1A、S27Q-3C-1B、S27Q-3C-1C 期间均通过。