# S32-M1E：Rediscover｜Project Overview + Search Membership｜设计规格

日期：2026-09-20  
任务标识：`S32_M1E_REDISCOVER_R1`  
代码基线：`main@414ee84f260d2bfae703956cbb879fbe76ab9c27`（PR #13 / M1-D 已合并）  
状态：DESIGN_READY_FOR_USER_REVIEW  
实现：NOT_STARTED  
生产部署：NOT_AUTHORIZED

## 1. 目标

M1-E 完成 M1 的最后一段：让已经进入 canonical research layer 的书和研究笔记能够被再次找到，并且能直接回到它所属的研究语境。

M1-A～D 已经提供：

```text
Search
→ Promote
→ Project
→ Edition ProjectBinding
→ Note
→ immutable NoteRevision history
```

M1-E 新增的是两个只读 Rediscover read model：

```text
A. Search Membership Read Model
catalog Book.id
  → canonical identity
  → Edition
  → Project memberships

B. Project Overview Read Model
Project
  → Edition bindings
  → current Note summary
  → recent-research ordering
```

最终用户闭环：

```text
重新搜索一本已经研究过的书
→ 搜索卡直接显示所属 Project 名
→ 点击 Project chip
→ 深链定位到具体 ProjectBinding
→ 默认看到当前 Note 的短摘要和最近研究时间
→ 按需打开完整 Note / Revision history
```

M1-E 不新增 canonical truth，不修改 M0 schema，不把 research membership 写回 Meilisearch。

## 2. 已确认的产品决策

本规格固定以下已批准决策：

1. 搜索结果直接显示所属 Project 名，而不是只显示“已加入研究”。
2. Project 详情默认按“最近研究优先”排序。
3. Project 资料卡默认显示当前 Note 的 240 Unicode code point 短摘要。
4. Membership 区分 ACTIVE 与 ARCHIVED Project。
5. ARCHIVED Project 可以完整只读回看 Project / Edition / Note / Revision，但所有写操作禁止。
6. Membership 是搜索的私有增强层；失败不能拖垮 catalog search，也不能伪装为“未研究”。
7. Search → Project 深链使用具体 Edition ProjectBinding 的 `bindingId`。
8. 搜索结果稳定后，有 S32 token 时自动对当前页执行一次 batch membership lookup。
9. 不做 N+1 membership 请求，也不对 Project items 做 N+1 Note 请求。

## 3. 架构总览

### Canonical truth

继续由 PostgreSQL `core.*` 保存：

- Project
- Edition ProjectBinding
- NOTE ProjectBinding
- Note
- NoteRevision
- ExternalIdentity / Source / Edition / Work

### Discovery truth

Meilisearch 继续只负责约 511 万 catalog 文档的搜索发现。

### Rediscover read models

M1-E 只从 canonical truth 计算两个 projection：

```text
Search Membership
Project Overview
```

projection 不落新表、不写缓存表、不写回 Meili，不成为第二份 truth。

## 4. Search Membership Read Model

### 4.1 API

```http
POST /api/private/s32/research-memberships/catalog-books
Authorization: Bearer <S32_PRIVATE_API_TOKEN>
Content-Type: application/json

{
  "bookIds": [
    "14624320_000030433335",
    "..."
  ]
}
```

### 4.2 输入

`bookIds`：

- 必须是 array；
- 最多 100 项；
- 每项必须是 non-empty string；
- 服务端去重后查询；
- 空数组合法并返回空 memberships object；
- 不 fuzzy match；
- 不 promotion；
- 不创建 ProjectBinding；
- 不修改任何 canonical row。

### 4.3 Canonical identity chain

Membership truth 必须从：

```text
catalog Book.id
↓
core.external_identities
  provider='BOOK_ID_SEARCH'
  namespace='CATALOG_DOCUMENT'
  binding_state<>'RETIRED'
↓
Source
↓
Edition
↓
ProjectBinding(target_type='EDITION')
↓
Project
```

查出。

禁止把 M1-C `ProjectBinding.metadata.catalogBookId` 当 membership identity truth。该 metadata 仍只是 provenance/convenience。

Note 状态可继续 LEFT JOIN：

```text
Edition ProjectBinding
↓ NOTE ProjectBinding.metadata.subjectBindingId
Note
```

得到 `hasNote` / `noteUpdatedAt`。

### 4.4 响应

每个请求中的 bookId 必须显式出现，即使没有 membership：

```json
{
  "memberships": {
    "book-a": [],
    "book-b": [
      {
        "projectId": "uuid",
        "projectName": "北京古道研究",
        "projectLifecycleState": "ACTIVE",
        "bindingId": "edition-project-binding-uuid",
        "hasNote": true,
        "noteUpdatedAt": "2026-09-20T06:00:00.000Z"
      },
      {
        "projectId": "uuid",
        "projectName": "2025 西山资料整理",
        "projectLifecycleState": "ARCHIVED",
        "bindingId": "edition-project-binding-uuid",
        "hasNote": true,
        "noteUpdatedAt": "2025-12-18T10:00:00.000Z"
      }
    ]
  }
}
```

显式空数组表示“已确认没有 membership”；缺 key 视为异常 payload，前端不能默认为未研究。

### 4.5 Membership 排序

API 返回全部 membership，按以下顺序稳定排序：

1. `projectLifecycleState`：ACTIVE 先于 ARCHIVED；
2. 各 lifecycle 内：
   - `noteUpdatedAt DESC NULLS LAST`
   - `projectName ASC`
   - `projectId ASC`

前端展示：

ACTIVE：

```text
已在研究
[北京古道研究] [京彰道研究] +N
```

ARCHIVED：

```text
曾用于研究
[2025 西山资料整理] +N
```

第一版默认直接显示：
- ACTIVE 最多 2 个；
- ARCHIVED 最多 1 个；
- `+N` 在当前卡片内展开全部，不跳新页面。

### 4.6 “加入其他项目”

Membership read 与可加入目标是两个不同概念：

```text
membership read:
ACTIVE + ARCHIVED

available add targets:
ACTIVE only
```

AddToProject 选择器：

- 只列 ACTIVE Project；
- 已经存在该 Edition membership 的 ACTIVE Project 不再列为候选；
- 如果所有 ACTIVE Project 都已包含该书，显示“已加入全部现有研究项目”；
- ARCHIVED Project 永远不是新增 binding 目标。

加入成功后：

```text
POST add success
→ invalidate current-page membership
→ rerun batch membership
→ 以 PostgreSQL canonical state 更新 chips
```

前端不得自己 append 一个 Project chip 作为 truth。

如果 add 已成功但 membership refresh 失败：

> 已加入项目；研究状态暂未能重新确认。

加入成功不能因 refresh 失败被回滚成失败。

## 5. Search Membership 自动加载与降级

### 5.1 自动 batch

用户有有效 S32 token，且当前 search result page 稳定后：

```text
Meili result arrives
→ collect current page Book.id
→ one batch membership request
→ render project chips
```

每一页最多一次当前结果集 lookup；不得每张卡单独请求。

query/page/result 集变化：
- abort stale membership request；
- 清除上一批对应状态；
- 新结果稳定后重新 batch。

### 5.2 无 token

没有 S32 token：

- 不发 membership 请求；
- catalog search 正常；
- 保留现有“加入研究”入口；
- 点击后仍引导先设置 S32 访问凭据。

### 5.3 401 / 403

搜索结果继续正常显示。

研究增强区显示：

> 研究项目访问凭据已失效，请重新设置。

不得清空 catalog search results。

### 5.4 503

例如 PostgreSQL unavailable：

> 研究状态暂不可用

Catalog search 正常。

不得把未知状态显示为：
- “未加入研究”；
- 空 membership；
- 自动重新 promotion。

### 5.5 500 / corrupt payload

同样显示：

> 研究状态暂不可用

不把异常降级为“没有研究历史”。

### 5.6 Canonical corruption

如果发现：

- CATALOG_DOCUMENT identity 存在但 Source/Edition chain 损坏；
- Edition ProjectBinding 指向异常实体；
- NOTE relation 与 subject Edition 不一致；
- 同一 subject 出现不符合 M1-D invariant 的多个 NOTE relation；

整个 membership request fail closed 为 generic 500。

M1-E 第一版不做逐 book partial-corruption payload。历史研究系统中“未知/损坏”不能伪装成“从未研究”。

## 6. Project Overview Read Model

### 6.1 API

```http
GET /api/private/s32/projects/:projectId/overview
```

纯只读。

### 6.2 响应

```json
{
  "project": {
    "id": "uuid",
    "name": "北京古道研究",
    "description": "...",
    "lifecycleState": "ACTIVE",
    "readOnly": false,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "summary": {
    "itemCount": 12,
    "noteCount": 7,
    "lastActivityAt": "2026-09-20T06:10:00.000Z"
  },
  "items": [
    {
      "bindingId": "uuid",
      "workId": "uuid",
      "editionId": "uuid",
      "sourceId": "uuid-or-null",
      "catalogBookId": "string-or-null",
      "title": "京西商旅古道",
      "publisher": "...",
      "publicationDate": "2001-01-01",
      "publicationDatePrecision": "YEAR",
      "isbn": "...",
      "addedAt": "...",
      "activityAt": "...",
      "noteSummary": {
        "noteId": "uuid",
        "currentRevisionId": "uuid",
        "currentRevisionNo": 3,
        "excerpt": "第三章提到从门头沟进入西山的商路……",
        "updatedAt": "..."
      }
    }
  ]
}
```

无 Note：

```json
{
  "noteSummary": null,
  "activityAt": "<Edition ProjectBinding.created_at>"
}
```

空项目：

```json
{
  "summary": {
    "itemCount": 0,
    "noteCount": 0,
    "lastActivityAt": null
  },
  "items": []
}
```

### 6.3 Summary 定义

```text
itemCount
= Project 当前 EDITION ProjectBinding 数

noteCount
= 有一个合法 NOTE/ANNOTATION relation 的 item 数

lastActivityAt
= max(items.activityAt)
= null when itemCount=0
```

### 6.4 activityAt 与排序

```text
activityAt =
  Note.updated_at                 if Note exists
  EditionProjectBinding.created_at otherwise
```

稳定排序：

```sql
ORDER BY activity_at DESC, edition_binding_id DESC
```

因此“刚加入但尚未写 Note”本身也算近期研究动作。

### 6.5 Query complexity

Project Overview 禁止：

```text
GET /items
→ N × GET /note
```

实现必须使用一条主 SQL 或固定数量 batch SQL，使数据库 query count 不随 itemCount 线性增长。

Overview 只读取：
- current Note revision；
- current Note metadata；
- 不加载全部 revision history。

完整 Note/历史仍由 M1-D Note API 按需读取。

### 6.6 Read consistency

Overview 使用：

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
```

确保同一 response 中：
- Project summary；
- item activityAt；
- current Note summary；

来自同一 snapshot。

不需要行锁。

## 7. Note excerpt 规则

来源：

```text
current NoteRevision.content
```

只用于运行时 preview。

处理顺序：

1. 防御性 `CRLF → LF`；
2. 剩余 `CR → LF`；
3. 所有 Unicode whitespace run 折叠为一个 ASCII space；
4. preview 两端 trim；
5. 按 Unicode code point 截取最多 240 个；
6. 如果规范化后的 preview 超过 240 code points，返回前 240 个 + `…`。

实现不得使用简单 UTF-16 `slice(0, 240)` 作为契约；应以 code point aware 方式处理，例如 `Array.from(text)`。

第一版不要求 grapheme-cluster 完整切分。

Excerpt：
- 不写回数据库；
- 不影响 Note content/hash；
- 不解析 Markdown AST；
- 不渲染 HTML；
- 不调用 AI。

Markdown 原文只作为安全纯文本 preview。

## 8. Project 页面 UX

### 8.1 Project Header

Overview 顶部显示：

```text
北京古道研究

12 项资料 · 7 项已有笔记
最近研究：今天 14:10
```

ARCHIVED：

```text
2025 西山资料整理
已归档 · 只读

12 项资料 · 7 项已有笔记
最近研究：2025/12/18
```

空项目：

```text
0 项资料 · 0 项已有笔记
尚无研究活动
```

M1-E 第一版不把 summary 扩展到“我的项目”列表卡，也不做全局 dashboard。

### 8.2 Item Card

有 Note：

```text
《京西商旅古道》

出版社……
出版日期……
ISBN……

研究笔记 · v3
更新于 2026/9/20 14:10

第三章提到从门头沟进入西山的商路，需要继续核对……

[打开笔记]
```

无 Note：

```text
尚未写研究笔记
[写笔记]
```

完整 Note panel 仍复用 M1-D。

Overview 摘要不替代 Note API。

## 9. ACTIVE / ARCHIVED Project 语义

### 9.1 ACTIVE

允许：
- Project read；
- Overview read；
- Note current/history read；
- 加入 Edition；
- 创建 Note；
- append Revision；
- 移出无 Note Edition。

### 9.2 ARCHIVED

允许只读：
- Project read；
- Overview read；
- Edition/card read；
- current Note read；
- Revision history read；
- 从 Search membership chip 深链回来。

禁止写：
- 新增 catalog-book binding；
- 创建第一条 Note；
- append Revision；
- 移出 Edition；
- 其他 future M1 write。

服务端必须 enforce，不只依赖前端隐藏按钮。

### 9.3 M1-D read/write 语义调整

当前 M1-D Note read helper 会把 archived Project 当 inactive。

M1-E 范围内需要拆分：

```text
read path:
Project lifecycle ACTIVE or ARCHIVED allowed

write path:
Project lifecycle must be ACTIVE
```

适用：

允许 ARCHIVED：
- GET Project；
- GET Project Overview；
- GET Note；
- GET Revision。

拒绝 ARCHIVED：
- POST catalog-book binding；
- POST Note；
- POST Revision；
- DELETE Edition binding。

拒绝写操作使用明确 409 lifecycle conflict，不静默失败。

## 10. Search → Project deep link

Search membership chip URL：

```text
/research/projects/:projectId?item=:bindingId
```

使用具体 Edition ProjectBinding id，不使用 Edition id 或 catalogBookId。

原因：

```text
ProjectBinding.id
= “这个 Edition 在这个具体 Project 中的研究位置”
```

### 10.1 Project 页面定位

Overview 加载完成后：

1. 读取 `item` query param；
2. 校验 locator 形状；
3. 找到 exact `bindingId`；
4. `scrollIntoView({ block: "center" })`；
5. 对卡片给予约 5 秒视觉强调；
6. URL 保留 query param，支持刷新/复制/浏览器前后退。

不自动打开完整 Note，不自动进入编辑状态。

### 10.2 locator 已不存在

Project 正常显示。

页面提示：

> 这项研究资料已不在当前项目中。

不 fallback 到同 Edition 的另一 binding，不猜测。

## 11. Membership frontend state

SearchPage 维护当前 result page 的 membership state：

```text
idle/no-token
loading
ready
auth-error
unavailable
```

BookCard 接收某一 book 的 memberships 和 global research-state availability。

禁止让每个 BookCard 自己发 membership request。

查询/page/limit/token 改变时：
- abort old request；
- stale result 不得写入新 page state。

## 12. AddToProject 与 Membership 协作

AddToProject 在 M1-E 不再孤立维护“已加入某项目”作为最终 truth。

成功 POST 后，通过 callback / invalidation 让 SearchPage 重拉当前 page membership。

Add selector 使用已加载 membership：
- 过滤已有 ACTIVE membership；
- 只提供未加入的 ACTIVE projects；
- ARCHIVED 仅展示历史 chip，不作为候选。

Membership 未成功加载时：
- AddToProject 仍可工作；
- 不基于未知 membership 过滤；
- server-side M1-C idempotency 仍是最终保护。

## 13. API 安全与错误语义

两个新 read model 继续使用：
- S32 private auth；
- `Cache-Control: no-store`；
- same-origin；
- shared PostgreSQL Pool；
- fail closed；
- generic 500 不泄漏 SQL / DB URL / token / Note content。

Membership：
- malformed body / >100 ids → 400；
- feature disabled → 404；
- missing/wrong token → 401/403；
- DB unavailable → 503；
- canonical integrity failure → generic 500。

Overview：
- malformed project id → 400；
- Project missing → 404；
- ACTIVE/ARCHIVED 都可 200；
- DB unavailable → 503；
- canonical integrity failure → generic 500。

## 14. 测试 Gate

### 14.1 Membership domain/store

至少验证：

- input array / max100 / empty / dedupe；
- no identity → explicit `[]`；
- canonical identity → correct Project membership；
- same Edition in multiple Projects；
- ACTIVE + ARCHIVED both returned and distinct；
- membership stable sorting；
- Note absent/present `hasNote/noteUpdatedAt`；
- retired identity ignored；
- corrupt identity/Source/Edition chain fail closed；
- corrupt NOTE relation fail closed；
- query count constant with 1 vs many bookIds；
- no writes to any table。

### 14.2 Overview

至少验证：

- ACTIVE overview；
- ARCHIVED overview 200 + `readOnly=true`；
- empty Project summary；
- item/note counts；
- activityAt fallback；
- recent-research ordering + stable binding tie-break；
- current Note summary only；
- excerpt whitespace/code-point/ellipsis edge cases；
- emoji/supplementary-plane code point boundary；
- malformed/multiple NOTE relationship fail closed；
- repeatable-read snapshot consistency；
- query count not N+1。

### 14.3 Archived read/write

真实 PG 至少：

ARCHIVED Project：
- GET Project 200；
- GET Overview 200；
- GET Note 200；
- GET Revision 200；
- POST catalog-book → 409；
- POST Note → 409；
- POST Revision → 409；
- DELETE Edition binding → 409；
- rows unchanged。

### 14.4 Web

Search：
- no token → no membership request；
- stable page → exactly one batch request；
- query/page/token change aborts stale request；
- ACTIVE chips；
- ARCHIVED chips；
- +N expansion；
- membership unavailable ≠ “not researched”；
- 401/403 credential message；
- add success triggers membership refresh；
- membership refresh failure does not turn successful add into failure；
- existing ACTIVE projects filtered from selector。

Project：
- overview summary；
- recent-research order；
- Note excerpt；
- no-Note state；
- archived read-only controls；
- bindingId scroll/highlight；
- missing binding warning；
- locator does not auto-open/edit Note；
- 390px no overflow。

## 15. Real browser acceptance

使用真实本地 Search + development PG：

### Active rediscover

```text
1. Search 真实 catalog book。
2. 加入“北京古道研究”。
3. membership 自动刷新，搜索卡出现 [北京古道研究]。
4. 在 Project 写 R1，再写 R2。
5. 回 Search，重新搜索同一本书。
6. 自动 batch membership 显示 Project chip。
7. 点击 chip。
8. URL 包含 ?item=<bindingId>。
9. Project Overview 自动定位到 exact item。
10. 卡片默认显示 current v2、240字以内 excerpt、更新时间。
11. 打开完整 Note，R2 current，R1 history 可读。
12. restart API/PG preserving volume。
13. Search membership + overview + Note/history 仍恢复。
```

### Archived rediscover

```text
1. 将测试 Project 置 ARCHIVED（通过本阶段允许的测试/fixture路径，不新增产品 archive UI）。
2. Search 同一本书。
3. 显示“曾用于研究 [归档项目]”。
4. 点击进入。
5. 页面显示“已归档 · 只读”。
6. Overview / current Note / Revision history 可读。
7. 所有新增/编辑/移出写操作不可用，服务端直接调用也返回 lifecycle 409。
```

## 16. M1-E 明确不做

- 全局 Note 搜索；
- PostgreSQL full-text index；
- embedding/vector；
- 最近研究全局 dashboard；
- 标签系统；
- 收藏；
- Project 排序切换器；
- AI Note summary；
- AI 推荐 Project；
- excerpt 持久化；
- Meilisearch membership 字段；
- membership cache/materialized table；
- bulk promotion；
- Claim / Evidence UI；
- M2；
- 生产部署；
- Project archive/unarchive 产品 UI。

## 17. M1 最终完成定义

M1-A～E 只有在真实用户本地完成以下完整闭环后才算完成：

```text
Search
→ Promote / 加入 Project
→ Search card 自动显示 Project membership
→ Project deep-link 精确定位 Edition binding
→ 写 Note R1
→ 保存 Revision R2
→ R1 immutable
→ 回到 Search
→ 再次搜到这本书
→ membership 仍显示 Project
→ 点击 Project
→ Overview 显示 current Note v2 / excerpt / activity
→ 打开 full Note + history
→ restart API / PG
→ 所有状态从 PostgreSQL canonical truth 恢复
```

还必须满足 historical rediscover：

```text
Project ARCHIVED
→ Search 显示“曾用于研究”
→ 点击可只读回看 Overview / Note / Revision
→ 写操作全部拒绝
```

## 18. Production boundary

M1-E application implementation 与 Production PostgreSQL deployment 继续分离。

本设计不授权：
- 腾讯云部署；
- production PostgreSQL；
- disk cleanup/expansion；
- image publish；
- runtime env 修改；
- merge PR。

Production 继续：

```text
PRODUCTION_EXECUTION=HOLD_CAPACITY_AND_AUTHORIZATION
```

## 19. 下一 Gate

本 written spec 获用户确认后：

1. 使用 writing-plans 创建 M1-E Implementation Plan；
2. 用户审阅 Plan；
3. 用户明确选择/确认 Native 执行方式后，才创建 feature worktree/branch 并实现。

当前：

```text
M1_D_IMPLEMENTATION=MERGED
M1_E_DESIGN=READY_FOR_USER_REVIEW
M1_E_IMPLEMENTATION=NOT_STARTED
PRODUCTION_CHANGED=NO
PRODUCTION_EXECUTION=HOLD_CAPACITY_AND_AUTHORIZATION
```
