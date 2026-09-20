# S32-M1D：Project Item Note + Immutable Revisions｜设计规格

日期：2026-09-20  
任务标识：`S32_M1D_NOTE_REVISIONS_R1`  
代码基线：`main@51c63b1dc45890bd5989d6bf6442d8ab7aaccc74`（PR #12 / M1-C 已合并）  
状态：DESIGN_READY_FOR_USER_REVIEW  
实现：NOT_STARTED  
生产部署：NOT_AUTHORIZED

## 1. 目标

M1-D 让用户在“某个研究项目里的某一本具体 Edition”下面写第一条真正的研究笔记，并且每次保存都追加不可变的 NoteRevision，而不是覆盖旧内容。

第一版固定模型：

```text
Project
  └─ Edition ProjectBinding
       └─ 1 Note
            ├─ Revision 1
            ├─ Revision 2
            └─ Revision N ← current
```

同一 canonical Edition 可以同时存在于不同 Project，每个 Project 的 Edition binding 各自拥有自己的 Note。

M1-D 完成后，用户可完成：

```text
Project → Edition material → write Note → edit → save new Revision → inspect old Revision
```

本轮不做多笔记管理、删除、归档、恢复、branch/merge、自动保存、AI、Note 搜索或生产部署。

## 2. 已确认的 schema 能力

现有 M0 schema 已具备：

### core.notes

- `id uuid`
- `note_type text`
- `lifecycle_state ACTIVE|ARCHIVED`
- `current_revision_id uuid NULL`
- `next_revision_no bigint DEFAULT 1`
- `metadata jsonb`
- `created_at / updated_at`

### core.note_revisions

- `id uuid`
- `note_id uuid`
- `revision_no bigint`
- `title text NULL`
- `content_format MARKDOWN|PLAIN_TEXT`
- `content text`
- `content_sha256`
- `change_summary text NULL`
- `created_at`
- unique `(note_id, revision_no)`

### core.note_revision_parents

允许同 Note 内的 Revision DAG。

### 已冻结约束

- `notes.current_revision_id` 必须指向同 Note 的 revision，FK 为 DEFERRABLE INITIALLY DEFERRED；
- `note_revisions` UPDATE / DELETE 被数据库 trigger 禁止；
- ProjectBinding 已允许 `target_type='NOTE'`；
- ProjectBinding 唯一约束为 `(project_id, target_type, target_id)`。

因此 **M1-D 不修改 M0 migration，不新增表/列/index/trigger**。

## 3. 确认的产品模型：每个 Project Edition Binding 一条 Note

第一版不允许“一本项目资料下创建任意多条 Note”。

唯一语义：

```text
(project_id, edition_project_binding_id)
→ at most one Note
```

例如：

```text
北京古道研究 + Edition X → Note A
京彰道研究     + Edition X → Note B
```

Note A/B 互不共享 current revision。

未来如真实使用证明需要多篇专题 Note，再单独设计 1:N；M1-D 不预建标题、排序、笔记列表和删除体系。

## 4. Note 如何关联到项目中的 Edition

不新增 `notes.edition_id`。

继续使用 ProjectBinding：

### 现有 Edition binding

```text
project_id = P
target_type = EDITION
target_id = E
```

### M1-D 新建 Note binding

```text
project_id = P
target_type = NOTE
target_id = N
binding_role = ANNOTATION
```

metadata 固定写：

```json
{
  "subjectBindingId": "<Edition ProjectBinding id>",
  "subjectType": "EDITION",
  "subjectId": "<Edition id>"
}
```

其中 **subjectBindingId 是项目语境的主关联键**。只存 Edition id 不足以区分“同一 Edition 在两个 Project 中的两条 Note”。

Note binding metadata 是关系 provenance，不是 bibliographic truth；不复制书名、出版社、ISBN 等字段。

## 5. 一条 Note 的固定属性

第一版创建：

```text
note_type = PROJECT_ITEM_NOTE
lifecycle_state = ACTIVE
metadata = {}
```

Revision：

```text
title = NULL
content_format = MARKDOWN
change_summary = NULL
```

用户只编辑正文，不要求额外 Note 标题。

界面不引入第三方 Markdown 编辑器或 Markdown HTML renderer；编辑使用 textarea，阅读使用安全的纯文本/pre-wrap 表现。

## 6. 内容规范

服务端接收 content 后：

1. `\r\n → \n`
2. 剩余 `\r → \n`
3. 其余字符原样保留

校验：

- `normalizedContent.trim()` 不得为空；
- UTF-8 byte length ≤ 65536 bytes；
- hash 对实际保存的 normalized content 计算：
  `SHA-256 UTF-8 → lowercase 64 hex`。

不自动 trim 正文、不改 Markdown 空格、不自动加标题。

这样 Windows/Linux 换行差异不会制造无意义不同 hash。

## 7. 创建第一条 Note 的 transaction

入口由 `projectId + editionBindingId` 指定研究对象。

事务步骤：

```text
BEGIN

1. SELECT Edition ProjectBinding ... FOR UPDATE
2. 验证：
   - binding 属于 project
   - target_type = EDITION
   - project ACTIVE
   - Edition ACTIVE
3. 在同一 project 中查找：
   NOTE ProjectBinding
   metadata.subjectBindingId = editionBindingId
4. 已存在任何绑定 → NOTE_ALREADY_EXISTS
5. INSERT core.notes
   current_revision_id = NULL
   next_revision_no = 1
6. INSERT core.note_revisions revision 1
7. UPDATE core.notes
   current_revision_id = revision1.id
   next_revision_no = 2
   updated_at = now()
8. INSERT ProjectBinding target_type=NOTE
   binding_role=ANNOTATION
   metadata.subjectBindingId/subjectType/subjectId

COMMIT
```

任何一步失败必须 rollback，不能留下：
- orphan Note；
- orphan Revision；
- Note 无 current revision；
- Note binding 无 Note。

### 并发创建

两个 create 请求都必须锁同一 Edition ProjectBinding row `FOR UPDATE`。

第二个请求获得锁后重新查询 Note binding，因此：

```text
1 project material → at most 1 Note
```

在个人规模下允许用 `metadata->>'subjectBindingId'` 查询，不为此增加 JSON index。

## 8. 创建 Revision 的 transaction

客户端编辑当前 Note 时必须提交：

```json
{
  "baseRevisionId": "<client loaded current revision>",
  "content": "<new normalized content>"
}
```

事务：

```text
BEGIN

1. 通过 project + editionBinding 找到 Note
2. SELECT Note ... FOR UPDATE
3. 验证 lifecycle_state = ACTIVE
4. 验证 baseRevisionId == current_revision_id
   否则 STALE_NOTE_REVISION
5. revision_no = next_revision_no
6. INSERT NoteRevision N
7. INSERT note_revision_parents:
   child = Revision N
   parent = previous current revision
   parent_order = 1
8. UPDATE Note:
   current_revision_id = Revision N
   next_revision_no = N + 1
   updated_at = now()

COMMIT
```

永远不 UPDATE/DELETE 旧 NoteRevision。

### 乐观并发

两个页面都从 R1 开始编辑：

```text
请求 A(base=R1) → R2 created
请求 B(base=R1) → 409 STALE_NOTE_REVISION
```

因此不会出现 last-write-wins 覆盖。

网络层重复提交同一个 `baseRevisionId` 时，第一次成功后第二次也会 409，不会再造一条重复 revision。

## 9. Revision parent 规则

M1-D 只创建线性历史：

```text
R1 ← R2 ← R3 ← R4
```

- R1 没有 parent；
- R2+ 恰好一个 parent，即保存时的 previous current revision；
- 不实现 multi-parent merge；
- 不实现 branch UI；
- schema 的 DAG 能力保留给未来，不在本阶段使用。

## 10. 读取模型

### 当前 Note

读取通过项目 + Edition binding 定位。

响应：

```json
{
  "note": {
    "noteId": "uuid",
    "projectId": "uuid",
    "subjectBindingId": "uuid",
    "subjectId": "edition uuid",
    "createdAt": "ISO",
    "updatedAt": "ISO",
    "currentRevision": {
      "revisionId": "uuid",
      "revisionNo": 3,
      "contentFormat": "MARKDOWN",
      "content": "...",
      "contentSha256": "64hex",
      "createdAt": "ISO"
    },
    "revisions": [
      {
        "revisionId": "uuid",
        "revisionNo": 3,
        "createdAt": "ISO"
      },
      {
        "revisionId": "uuid",
        "revisionNo": 2,
        "createdAt": "ISO"
      }
    ]
  }
}
```

没有 Note 是正常状态：

```json
{ "note": null }
```

历史列表只返回 summary，不重复返回所有旧正文。

### 单个历史 Revision

通过 project + Edition binding + revisionId 校验归属后返回 immutable content。

不得允许拿一个任意 revision UUID 跨项目读取。

## 11. HTTP API

继续使用现有 S32 private auth、same-origin、no-store 和 fail-closed 语义。

### 读取 Note

```http
GET /api/private/s32/projects/:projectId/items/:bindingId/note
```

无 Note：
`200 { "note": null }`

### 创建第一条 Note

```http
POST /api/private/s32/projects/:projectId/items/:bindingId/note
Content-Type: application/json

{ "content": "..." }
```

成功：201。

已有 Note：409。

### 保存新 Revision

```http
POST /api/private/s32/projects/:projectId/items/:bindingId/note/revisions
Content-Type: application/json

{
  "baseRevisionId": "uuid",
  "content": "..."
}
```

成功：201。

base stale：409。

### 读取历史 Revision

```http
GET /api/private/s32/projects/:projectId/items/:bindingId/note/revisions/:revisionId
```

成功 200；不属于该 Note / Project item 返回 404。

M1-D **没有 Note DELETE、Revision DELETE、restore API**。

## 12. 错误语义

沿用既有鉴权顺序，auth fail 时不得访问 store。

- S32 disabled → 404
- private token 未配置 → 503
- missing token → 401
- wrong token → 403
- DB 未配置/不可用 → 503
- malformed UUID / malformed body / 空 content / >64KiB → 400
- project 不存在 → 404
- project inactive → 409
- Edition ProjectBinding 不存在/不属于 project/不是 EDITION → 404
- Edition inactive → 409
- Note 已存在 → 409
- Note 不存在（revision write/read）→ 404
- stale `baseRevisionId` → 409
- Revision 不属于当前 Note → 404
- unexpected → generic 500，不泄漏 SQL、connection string、token 或正文

## 13. 对 M1-C“移出项目”的安全收紧

M1-C 当前 DELETE Edition binding。

M1-D 后 Note 通过 `subjectBindingId` 依赖该 binding，因此不能让 binding 在 Note 存在时消失。

修改 removal transaction：

```text
BEGIN

SELECT target Edition ProjectBinding FOR UPDATE

若不存在/不属于 project/不是 EDITION → 404

检查是否存在 NOTE binding：
metadata.subjectBindingId = target binding id

若存在：
  409 PROJECT_ITEM_HAS_NOTE
  不删除 binding

否则：
  DELETE Edition ProjectBinding

COMMIT
```

Note 创建与 Edition removal **都锁同一 Edition ProjectBinding row**，避免：

```text
创建 Note 与删除 Edition binding 同时发生
```

产生悬空 subjectBindingId。

UI 收到 409 时显示：

> 这项资料已有研究笔记，暂不能直接移出项目。

M1-D 不提供“连同笔记一起删除”。

## 14. Web 交互

项目资料卡从：

```text
[查看书目] [移出项目]
```

变成：

```text
[查看书目] [研究笔记] [移出项目]
```

### 无 Note

点击“研究笔记”展开：

```text
研究笔记
[ textarea ]

[取消] [创建笔记]
```

创建成功后切换到阅读状态。

### 已有 Note

阅读：

```text
研究笔记

[current content]

[编辑]

历史版本
v3 当前
v2
v1
```

### 编辑

```text
[textarea prefilled with current content]

[取消] [保存新版本]
```

不是 autosave。

按钮一次成功保存对应一个新 Revision。

### stale 409

不得丢弃用户输入。

保留 textarea draft，并显示：

> 笔记已经发生变化。请重新加载最新版本后，再决定如何处理当前草稿。

提供“重新加载最新版本”。

不自动覆盖、不自动 merge、不自动清空草稿。

### 历史版本

点击历史 revision 后显示只读正文和 revision/time。

不提供：
- 修改旧版本
- 删除旧版本
- “恢复此版本”
- merge

## 15. 前端模块边界

建议保持研究模块内聚：

```text
apps/web/src/research/
  api.ts
  ProjectItems.tsx
  ProjectItemNote.tsx
  ProjectItemNote.test.tsx
```

`ProjectItems` 只负责资料卡和 Note panel 的挂载，不在其中实现 Note transaction/state machine。

S32 Note API client 继续 same-origin，不使用公共 `VITE_API_BASE_URL`。

不把 Note token 存新位置；复用当前 S32 session token。

## 16. 后端模块边界

建议：

```text
apps/api/src/s32/
  domain/
    note.ts
  application/
    project-item-notes.ts
  postgres/
    project-item-note-store.ts
  routes/
    project-item-note-routes.ts
```

现有 `project-binding-store.ts` 只做必要的“有 Note 时禁止移除”收紧，不把 Note create/edit 实现塞进去。

Note store 自己拥有：
- create first Note transaction
- append Revision transaction
- current/history reads

## 17. 测试 Gate

### Domain / unit

至少：
- CRLF/CR normalization
- blank content
- exactly 64KiB / over 64KiB UTF-8
- SHA256 deterministic
- invalid project/binding/revision IDs
- stale base mapping
- safe public error messages

### 真实 PostgreSQL 16

一次性 PG16 + unchanged M0 migration：

1. Project A + Edition X → create Note/R1。
2. transaction 后：
   - 1 Note
   - 1 R1
   - current_revision_id=R1
   - next_revision_no=2
   - 1 NOTE ProjectBinding
3. 重复 create → 409/exists，row count 不增加。
4. 并发 create → 只有一条 Note。
5. append R2：
   - R1 row/hash/content 完全不变；
   - R2 revision_no=2；
   - R2 parent=R1；
   - current=R2；
   - next=3。
6. 两个并发 `baseRevisionId=R2`：
   - 一个创建 R3；
   - 一个 stale conflict；
   - 只有一个 revision_no=3。
7. 历史读取 R1 仍返回最初内容。
8. Edition X 同时在 Project B：
   - Project B 可以创建独立 Note；
   - 不共享 Project A Note。
9. Note 存在时移出 Edition binding → 409，binding/Note/Revisions 均保留。
10. 无 Note 的 Edition binding 仍可按 M1-C 正常移出。
11. simulated transaction failure → 无 partial Note/Revision/NOTE binding。
12. Note write 不写 Claim/Assessment/Issue 等其他领域表。

### Web

至少：
- 无 Note → 创建第一版
- current Note 阅读
- 编辑 → 新 revision
- history 展开与旧正文
- stale 409 保留 draft
- failed create/save 不假成功
- clear token 后 Note 数据不继续展示
- Note exists 时移出资料的 409 文案
- request abort/stale response
- 390px 无水平溢出

### 本地浏览器验收

使用“北京古道研究”中的一项真实资料：

```text
打开项目
→ 展开研究笔记
→ 创建 R1
→ 刷新仍存在
→ 编辑保存 R2
→ 当前显示 R2
→ 查看历史 R1，内容不变
→ 用旧 base 提交，得到 409 且草稿保留
→ 重启 API/PG（保留卷）
→ Note + revision history 仍存在
→ 尝试移出该 Edition，得到 409
→ Note/Edition binding 均保留
```

## 18. 明确不做

M1-D 不做：

- 一个 Project Edition 多条独立 Note
- Note title UI
- Note 删除
- Note 归档/恢复
- Revision 删除/修改
- Revision restore
- branch/merge UI
- autosave
- rich-text/Markdown HTML preview
- AI 写笔记
- Agent 自动写入
- Note 搜索
- 标签
- Claim/Evidence extraction
- Notion/Drive 产品数据同步
- Project-level notebook
- M1-E 全局 rediscover/membership 状态
- 生产部署、扩盘、清盘、容量策略调整

## 19. 完成定义

M1-D 完成要求真实用户能本地完成：

```text
Project
→ Edition material
→ create Note/R1
→ refresh/restart recovery
→ edit/save R2
→ read R1 unchanged
→ stale edit rejected
→ Edition with Note cannot be removed
```

并且所有状态来自 PostgreSQL canonical state，不依赖浏览器临时状态作为 truth。

## 20. 下一 Gate

本设计规格获用户书面确认后：

1. 使用 writing-plans 生成 M1-D Implementation Plan；
2. 用户审阅并确认 Plan；
3. 才允许本地 Codex Native 实现。

当前：

```text
M1_C_IMPLEMENTATION=MERGED
M1_D_DESIGN=READY_FOR_USER_REVIEW
M1_D_IMPLEMENTATION=NOT_STARTED
PRODUCTION_CHANGED=NO
PRODUCTION_EXECUTION=HOLD_CAPACITY_AND_AUTHORIZATION
```
