# S32-M1C：把搜索到的书加入研究项目｜设计规格

日期：2026-09-20  
任务标识：`S32_M1C_PROJECT_BINDING_R1`  
代码基线：`main@7295af6e991e2a5b1575b8c2a0b5d3662c093b9f`（PR #11 已合并）  
状态：DESIGN_READY_FOR_USER_REVIEW  
实现：NOT_STARTED  
生产部署：NOT_AUTHORIZED

## 1. 目标

M1-C 把已经独立成立的三块能力连成第一个真正的研究资料闭环：

```text
Search
  ↓
Catalog Book
  ↓
M1-A explicit promotion
  ↓
canonical Work / Edition / Source
  ↓
ProjectBinding(target=EDITION)
  ↓
M1-B Project detail
```

用户在现有搜索结果中点击“加入研究”，选择一个已有研究项目；系统把该 catalog book 显式提升为 canonical object，并把具体 Edition 加入项目。之后打开项目详情可以看到这本书；重复加入不重复；移出项目只删除 ProjectBinding，不删除 canonical book。

本轮不是批量收藏、不是笔记系统，也不改变 5,115,734 条 Meilisearch catalog 的角色。

## 2. 已确认的代码与 schema 边界

基线中：

- M1-A 已提供显式 promotion：输入 `bookId`，从 Meilisearch 重新读取 authoritative catalog snapshot，创建或复用 Work / Edition / Source / ExternalIdentity。
- M1-B 已提供 Project create/list/get 和本地页面。
- `core.project_bindings` 已存在：
  - `project_id uuid NOT NULL`
  - `target_type text NOT NULL`
  - `target_id uuid NOT NULL`
  - `binding_role text NULL`
  - `metadata jsonb NOT NULL DEFAULT '{}'`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - 唯一约束 `(project_id, target_type, target_id)`
  - `target_type` 已允许 `EDITION`。
- `project_bindings.target_id` 是多态目标，没有直接 Edition FK；应用层必须显式确认目标 Edition 存在。
- 本轮不修改 M0 migration、不新增表、不修改 Meili schema。

## 3. 用户流程

### 3.1 搜索页

已有 BookCard 增加“加入研究”操作，与“加入对比”并列但语义分开。

点击后：

1. 若 `VITE_S32_ENABLED !== true`：不显示入口。
2. 若当前浏览器没有独立 S32 session token：
   - 不复制一套 token 输入表单；
   - 显示“先进入我的研究项目设置访问凭据”，提供到 `/research/projects` 的链接。
3. 若已有 token：
   - 读取当前项目列表；
   - 打开项目选择器；
   - 没有项目时显示“暂无研究项目”与“先创建项目”链接。
4. 选择项目后发送一次组合命令。
5. 成功：
   - 关闭选择器；
   - 显示“已加入「项目名」”；
   - 当前页面内可把该卡片临时标记为“已加入研究”。
6. 本轮不在每次搜索时批量预取“这本书已经在哪些项目里”；刷新搜索页后是否已加入的全局状态留给 M1-E。

### 3.2 项目详情页

项目详情增加“研究资料”区域：

- 按加入时间倒序列出 M1-C 创建的 Edition bindings；
- 显示：
  - title
  - publisher
  - publication year/date
  - ISBN
  - 加入时间
- 提供“查看书目”，回到 `/books/:catalogBookId`；
- 提供“移出项目”；
- 显示真实资料数量，不显示尚未实现的笔记数量。

移出前使用轻量确认，成功后立即从当前列表移除。

## 4. 为什么绑定 Edition

M1-C 固定使用：

```text
target_type = EDITION
```

原因：

- 用户研究经常针对具体版本，而不是抽象 Work；
- publisher / publication_date / isbn 都属于 Edition；
- Project 是 lens，不拥有 canonical object；
- 后续仍可通过 Edition 上溯 Work。

本轮不提供 Work/Edition 选择器，也不根据标题、ISBN 或作者自动猜绑定层级。

## 5. API 契约

所有新接口继续位于既有 S32 私有前缀，沿用 M1-A/M1-B 的独立 S32 token、默认关闭、`Cache-Control: no-store` 和 fail-closed 行为。

### 5.1 把 catalog book 加入 project

```http
POST /api/private/s32/projects/:projectId/catalog-books
Authorization: Bearer <S32_PRIVATE_API_TOKEN>
Content-Type: application/json

{
  "bookId": "<catalog Book.id>"
}
```

成功响应：

```json
{
  "promotionStatus": "created | existing",
  "bindingStatus": "created | existing",
  "item": {
    "bindingId": "uuid",
    "projectId": "uuid",
    "workId": "uuid",
    "editionId": "uuid",
    "sourceId": "uuid",
    "catalogBookId": "string",
    "title": "string",
    "publisher": "string | null",
    "publicationDate": "YYYY-MM-DD | null",
    "publicationDatePrecision": "YEAR | MONTH | DAY",
    "isbn": "string | null",
    "addedAt": "ISO timestamp"
  }
}
```

新建 binding 返回 201；重复 binding 返回 200。

### 5.2 项目资料列表

```http
GET /api/private/s32/projects/:projectId/items
```

响应：

```json
{
  "items": [ProjectResearchItem]
}
```

只返回 `target_type='EDITION'` 的项目资料，按 `project_bindings.created_at DESC, id DESC` 稳定排序。

本轮不把未来 NOTE / CLAIM / SOURCE_ASSET bindings 混进这个列表。

### 5.3 移出项目

```http
DELETE /api/private/s32/projects/:projectId/items/:bindingId
```

成功使用 204。

删除范围必须同时匹配：

- binding id
- project id
- `target_type='EDITION'`

不存在或不属于该项目返回 404。

该操作只删除 ProjectBinding；不得删除 Work / Edition / Source / ExternalIdentity。

## 6. 组合命令与事务边界

采用后端组合命令，而不是让浏览器串联两次领域 API。

概念接口：

```text
addCatalogBookToProject(projectId, bookId)
```

执行顺序：

1. 验证 projectId / bookId。
2. 查询 Project：
   - 不存在 → 404；
   - 非 ACTIVE → 409。
3. 调用已有 M1-A promotion command。
4. 获得 `workId / editionId / sourceId / catalogBookId`。
5. 在 PostgreSQL 中确认该 Edition 存在且 ACTIVE。
6. 创建或复用：
   `ProjectBinding(projectId, 'EDITION', editionId)`。
7. 读取并返回 ProjectResearchItem。

### 6.1 不把 promotion + binding 强行包进同一个大事务

M1-A promotion 已有自己的 transaction boundary，本轮不拆掉重写。

允许：

```text
promotion COMMIT
binding 暂时失败
```

此时 canonical object 已合法存在，只是尚未加入项目，不属于 partial corruption。

重试时：

```text
promotion → existing
binding   → created
```

因此组合命令必须是 retry-safe。

### 6.2 Binding 自身幂等

插入依赖现有唯一约束：

```text
(project_id, target_type, target_id)
```

并发或重复调用只能得到一个 binding。

若 binding 已存在：

- 返回同一 binding；
- 不覆盖原 binding metadata；
- `bindingStatus=existing`。

## 7. ProjectBinding metadata

M1-C 创建的 binding：

```text
target_type = EDITION
target_id = editionId
binding_role = NULL
```

metadata：

```json
{
  "addedVia": "BOOK_ID_SEARCH_CATALOG",
  "catalogBookId": "<Book.id>",
  "sourceId": "<promotion sourceId>"
}
```

这些字段记录“这次加入动作从哪里来”，不是新的 canonical bibliographic truth。

- title / publisher / isbn 不复制到 binding metadata；
- catalog author 不在本轮自动拆成 Actor/Contribution；
- 若已有同一 binding，其 metadata 不因再次加入而静默覆盖。

## 8. 项目资料读取

列表查询以 `project_bindings` 为起点，限定 `target_type='EDITION'`，连接：

```text
project_bindings
  → editions
  → works
```

页面展示值来自 canonical Work/Edition：

- title ← Work.title
- publisher ← Edition.publisher
- publicationDate ← Edition.publication_date
- publicationDatePrecision ← Edition.publication_date_precision
- isbn ← Edition.isbn

`catalogBookId` 和 `sourceId` 从 M1-C binding metadata 读取。

对于 metadata 缺失或非预期类型的旧记录：

- 不抛出数据库细节；
- `catalogBookId` 可为 null；
- 没有 catalogBookId 时不显示“查看书目”链接；
- 仍可展示 canonical Edition。

## 9. 错误语义

沿用既有 S32 鉴权顺序：鉴权失败时不得访问 store、Project 或 Meili。

建议状态：

- S32 disabled → 404
- private token not configured → 503
- missing token → 401
- wrong token → 403
- DB not configured → 503
- invalid projectId / bindingId / blank bookId → 400
- project not found → 404
- project archived/non-active → 409
- catalog book not found → 404
- catalog unavailable → 503
- identity conflict → 409
- canonical / binding store unavailable → 503
- unexpected → generic 500，不泄漏 SQL、连接串或 token
- delete target not found / not owned by project → 404

## 10. 前端状态与凭据

复用 M1-B 的：

- `VITE_S32_ENABLED`
- 独立 S32 sessionStorage token
- same-origin `/api/private/s32`

本轮仍不把 token 放入 VITE 环境变量，不复用 WeRead token。

Project selector 可复用 M1-B `listProjects` client，但 M1-C 的 add/list/remove client 应放在 `apps/web/src/research/` 模块内，不把私有 S32 写逻辑塞进公共 `apps/web/src/api.ts`。

搜索页只承载触发器与选择器，不负责 canonical ID 编排。

## 11. 本地开发与试用数据

继续复用 M1-B 已建立的本地开发 PG 持久卷。

本轮本地试用允许写：

- core.works
- core.editions
- core.sources
- core.external_identities
- core.project_bindings

只针对用户明确点击“加入研究”的少量 catalog records。

不批量导入 5,115,734 条 catalog，不复制生产 PG，不通过 SSH 写生产数据。

自动测试继续使用独立一次性 PG，不能清空开发试用卷。

## 12. 测试与验收 Gate

### 12.1 单元/API

至少验证：

- invalid projectId/bookId/bindingId
- 所有接口鉴权失败不访问 store/Meili
- project missing / inactive
- catalog missing
- identity conflict
- DB/catalog unavailable
- unexpected error 不泄密
- duplicate binding returns existing
- delete only removes matching project binding

### 12.2 真实 PostgreSQL 集成

使用一次性 PG16 + unchanged M0 migration。

用注入的 deterministic catalog snapshot / reader 走真实 M1-A promotion + M1-C binding：

1. 第一次加入：
   - 1 Work
   - 1 Edition
   - 1 Source
   - catalog identities
   - 1 ProjectBinding
2. 第二次相同请求：
   - canonical row count 不增加；
   - ProjectBinding 不增加；
   - 返回 existing。
3. 并发重复加入仍只有一个 binding。
4. 项目列表读取 stable。
5. DELETE 后：
   - ProjectBinding 消失；
   - Work/Edition/Source/ExternalIdentity 保留。
6. binding 不写 Note/Claim 等其他领域表。
7. failed binding after successful promotion 可重试恢复。

不要求本轮重跑所有历史 M0/M1-A 测试；若对应代码未改，记录 NOT_RUN，不能冒充 PASS。

### 12.3 浏览器验收

在本地真实页面完成：

```text
打开搜索
→ 搜索一本真实 catalog book
→ 点击加入研究
→ 选择“北京古道研究”
→ 成功提示
→ 打开项目详情
→ 看到该书
→ 刷新
→ 仍存在
→ 再次从搜索加入
→ 项目中仍只有一条
→ 重启 API/PG（保留开发卷）
→ 仍存在
→ 移出项目
→ 项目中消失
→ 通过 SQL/API 确认 canonical Work/Edition/Source 仍在
```

同时检查 390px 移动宽度，不要求独立移动端信息架构。

## 13. 明确不做

M1-C 不做：

- Note / NoteRevision
- M1-D / M1-E
- project 编辑、删除、归档
- author → Actor/Contribution resolution
- title/author/ISBN fuzzy merge
- 搜索结果批量加入
- 一次加入多个项目
- 全搜索结果预取“已在哪些项目”
- 项目内搜索/标签/排序设置
- 跨源 `VITE_API_BASE_URL` S32 私有请求
- AI 自动选择项目
- Notion/Drive 产品数据双向同步
- 生产部署、扩盘、清盘或容量策略调整

## 14. 建议代码边界

保持 modular monolith：

```text
apps/api/src/s32/
  application/
    add-catalog-book-to-project.ts
    project-items.ts
  postgres/
    project-binding-store.ts
  routes/
    project-item-routes.ts

apps/web/src/research/
  api.ts                  # 扩展私有研究 API
  AddToProject.tsx        # 项目选择器/加入动作
  ProjectItems.tsx        # 项目资料列表
```

允许 Codex 根据现有结构做小幅命名调整，但不得把所有逻辑继续堆进 `App.tsx` 或 `index.ts`。

## 15. 完成定义

M1-C 完成不是“ProjectBinding API 存在”，而是用户能在本地真实完成：

```text
Search → Add to Project → Redisplay in Project → Retry-safe → Remove
```

并且：

- 数据来自 canonical PostgreSQL；
- 重启后仍存在；
- 重复加入不重复；
- 移出不删除 canonical object；
- 无生产写入；
- GitHub PR 与 Notion 阶段页使用相同 task_id / tested_commit / PR URL。

## 16. 下一 Gate

本设计批准后：

1. 使用 writing-plans 生成 M1-C 实施计划；
2. 用户审阅实施计划并选择执行方式；
3. 才允许本地 Codex 开始 M1-C 产品代码。

当前：

```text
M1_B_IMPLEMENTATION=MERGED
M1_C_DESIGN=READY_FOR_USER_REVIEW
M1_C_IMPLEMENTATION=NOT_STARTED
PRODUCTION_CHANGED=NO
PRODUCTION_EXECUTION=HOLD_CAPACITY_AND_AUTHORIZATION
```
