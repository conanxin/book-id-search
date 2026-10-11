# 以书籍为中心：第一批实现

`task_id=BOOK_CENTERED_LIBRARY_V1_IMPLEMENTATION` · 2026-10-11

## 使用流程

普通书目搜索无需登录。打开一本书后，使用现有 Google Owner 账号登录，回到原书页，可以补充介绍、写多篇笔记、登记电子版外链。首次保存任意内容会把书加入“我的书籍”；也可以先收藏、稍后补内容。下次从“我的书籍”回访同一个书页。

每篇笔记独立保存，编辑产生历史版本，删除从当前书页移除并保留旧版本。介绍或笔记发生并发冲突时，编辑器保留草稿，允许读取最新内容、对照后再保存。

电子版可填写 PDF、EPUB、网盘或阅读页面的 HTTP(S) 地址，同时记录版本说明和来源备注。这里只登记及打开外链；服务器不会下载文件，AI 也不会因此自动获得全文。

## 页面与登录

| 页面 | 行为 |
| --- | --- |
| `/` | 匿名书目搜索；AI 找书模式需 Google 登录 |
| `/books/:bookId` | 登录后的统一书页：书目、介绍、笔记、电子版、已有微信读书状态、AI 书目分析、相关图书 |
| `/library` | 已收藏／整理的书；可按关键词、介绍、笔记、电子版筛选 |
| `/weread` | 原有微信读书资料，使用统一导航和 Google 会话 |
| `/account` | 统一登录／退出；登录后恢复原请求页面 |
| `/research/projects/...` | 原研究功能及原数据保留，从“更多→专题研究”进入 |

全站共用导航、字体、色彩变量、卡片、表单与交互焦点。书页以内容整理为主，原始记录及专题研究操作收起为次级区域。原“研究与判断”能力没有被删除，首页及主导航的核心内容入口改为“我的书籍”。

后端 `/api/books`、`/api/ai`、`/api/private` 全部要求有效的 Google Owner session。旧 Bearer／private token 不能替代登录。写请求同时要求同源 Origin 与该会话的 CSRF。`/api/search`、统计和健康端点保持公开。现有单 Owner 部署模型未改为多用户服务。

## 数据与接口

复用既有 PostgreSQL 与 catalog promotion：`Work → Edition → Source`。读未收藏的书不写数据库；第一次收藏或保存时建立书籍内容归属，整个流程无需创建 Project。

新增 `003_book_library.sql`：

- `core.library_books`：目录书 ID、Edition／Source、手工介绍和介绍版本。
- `core.library_book_notes`：书籍与独立 Note 的一对多关系；内容及历史使用原 `core.notes`／`core.note_revisions`。
- `core.library_book_resources`：电子版展示信息；地址保存于 canonical `REMOTE SourceAsset`。

001、002 和冻结 M0 SQL 测试均保持原字节。兼容 runner 在 001 阶段执行固定表集合断言，再执行后续迁移；追加表不会伪装为旧 schema。003 向已经存在的 `s32_app`／`s32_readonly` 补授新表权限，不重建角色。

接口根路径：`/api/private/s32/library`。

| 方法／相对路径 | 内容 |
| --- | --- |
| `GET /` | 我的书籍分页；`q`、`filter=all/introduction/notes/resources` |
| `GET /books/:bookId` | 整本书的个人内容，无保存时返回空工作区 |
| `PUT /books/:bookId` | `{}` 收藏；`{introduction, baseVersion}` 保存介绍 |
| `POST /books/:bookId/notes` | 新建独立笔记 |
| `PUT /books/:bookId/notes/:noteId` | 根据 `baseRevisionId` 编辑，冲突返回 409 |
| `DELETE /books/:bookId/notes/:noteId` | 归档笔记 |
| `GET /books/:bookId/notes/:noteId/revisions/:revisionId` | 读取该笔记的历史版本 |
| `POST /books/:bookId/resources` | 登记外链 |
| `PUT /books/:bookId/resources/:resourceId` | 编辑资源信息 |
| `DELETE /books/:bookId/resources/:resourceId` | 移除登记，保留 canonical SourceAsset |

介绍及笔记正文上限 50,000 字符。该路由在全局 parser 之前使用 512 KiB JSON parser，容纳合法长文本的 JSON 转义开销。跨书的笔记／资源 ID 不可读取或修改；错误响应不暴露数据库内部信息。

## 验证与运行

安装沿用 `corepack pnpm install --frozen-lockfile`，分别构建 `@book-id-search/api` 与 `@book-id-search/web`。新增测试位于 `apps/api/src/s32/**/book-library*`、`apps/api/src/auth/google-owner-request.test.ts`、`apps/web/src/library` 和 `apps/web/src/api-session.test.ts`；路由及旧研究浏览器用例已经适配新的 Google 登录边界和折叠入口。

`.github/workflows/book-library.yml` 使用一次 disposable PostgreSQL 16 + Chromium job：先应用001／002、初始化受限应用角色，再应用003，执行真实 PG 合同和页面保存、刷新、回访、编辑、删除、退出流程。浏览器使用真实签名会话和 CSRF，但目录为两本合成书，未进行实际 Google OAuth 或生产数据验证。

本机已完成接口／界面定向测试、API／Web 构建及1440／390宽度的合成数据视觉检查。Native 环境只映射 uid0，不能正常启动 PostgreSQL；真实 PG 结论以对应提交的 CI 为准，不能把本机跳过记为通过。完整证据、源码 SHA 与 CI 链接记录在本次 PR。

## 与后续工作的关系

“我的书籍”后续增加[笔记内容检索与具体位置回访](BOOK_LIBRARY_CONTENT_SEARCH_V1.md)：搜索当前笔记标题／正文，显示实际命中摘录，并直接打开对应介绍或笔记，刷新与Google登录保留定位。

书页原有相关图书已在后续[关联图书排序与关系说明](BOOK_RELATED_DISCOVERY_V1.md)完善：独立读取书名等候选，按实际目录依据排序，并使用共用卡片显示关联理由与独立加载状态。

本分支在 PR #71 的 `fe22a6d` 候选代码上开发，复用其通用修复和保留的研究能力。PR #71 本身及 main 不因本次开发自动合并。

后续同书微信读书记录与双向入口已经接续实现，见[同一本书里的微信读书记录](BOOK_WEREAD_NOTES_V1.md)。下一阶段补充持久化的人工关联确认／修正，再加入基于实际介绍和笔记的 AI 草稿、摘要与带来源问答。电子书全文解析及 R11 Locator 按后续资料读取需要接入；本批没有将实验 PDF runner 放入生产功能。

上线本批需要在已有002的数据库上应用003，并发布配套 API／Web；沿用现有 Google 配置。旧仅 Bearer 的私有验收调用需使用 Google 会话及写操作 CSRF。不要对现有库重复执行旧角色 bootstrap 或空库初始化。本轮只完成开发及 PR 验证，没有变更腾讯云数据库、镜像或运行服务。
