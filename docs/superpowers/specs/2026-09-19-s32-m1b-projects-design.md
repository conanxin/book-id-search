# S32-M1B：我的研究项目与最小页面

日期：2026-09-19。任务标识：S32_M1B_PROJECTS_UI_R1。
代码基线：main@19c0209acb9445b505f918f13bce9e2dc82f7917（PR #10 已合并）。
状态：用户已认可本地功能优先的路线与M1-B方向；本文件是具体应用契约和Codex交付说明。产品代码未在本轮编写，本地执行尚未启动或验证。

## 1. 目标与顺序

先让用户在本地页面完成“创建研究项目 → 列表找到它 → 打开详情 → 刷新/重启后仍存在”。不是仅交付API，也不是重新做数据库或部署审计。

PR #10 已仅合并源码；生产容量HOLD不阻断本地M1-B。后续顺序为M1-B项目、M1-C书目关联、M1-D笔记、M1-E重新查找；先本地可用，再单独决定生产上线。本轮不实现C/D/E，不新增备份演练、staging或回滚系统。

## 2. 已核对的代码事实

在上述基线读取：
- core.projects 已存在，列为 id(uuid)、name(text NOT NULL)、lifecycle_state(ACTIVE/ARCHIVED，默认ACTIVE)、metadata(jsonb)、created_at、updated_at。
- core.projects没有description、owner、slug等独立列；本轮不修改M0 migration，也不新增表。
- apps/api/src/s32/register.ts 已组装pg Pool、S32配置与私有promotion路由；新增项目路由应复用该边界，不依赖Meili。
- apps/web/src/main.tsx 已使用BrowserRouter；App.tsx使用React Router并承载查书界面，新增页面应独立成文件，不把整块业务继续堆进App.tsx。
- 现有WeRead前端使用sessionStorage管理其私有token；S32可以复用这种交互方式，但不能复用WeRead token、存储key或开关。

下列API、description映射、长度限制属于本轮新的应用契约，不冒称历史M0已经冻结了这些行为。

## 3. 用户界面

建议入口与路由：
- /research/projects：我的研究项目，含列表和新建表单。
- /research/projects/:projectId：项目详情。

沿用现有视觉样式、字体和组件，不引入新UI框架、不做整站重设计。新增模块建议放apps/web/src/research/。

新建表单只有：
- 项目名称，必填。
- 研究目的，选填，多行纯文本。

列表卡片显示名称、研究目的摘要、创建时间；点击打开详情。详情显示完整目的与基础时间信息，提供回列表入口。明确处理加载、空列表、校验失败、未鉴权、服务不可用、不存在项目、创建中状态。提交中禁用重复点击，POST失败不自动重试；允许相同名称的独立项目，不把名称当身份。

不实现编辑、删除、归档操作；不显示伪造资料数/笔记数，不提供看似可用的“加入书目/写笔记”空按钮。需要提示后续能力时，用静态说明，不能宣称已可用。

## 4. HTTP与数据契约

全部路径位于既有私有前缀，所有读写均受S32鉴权保护：

```text
POST /api/private/s32/projects
GET  /api/private/s32/projects
GET  /api/private/s32/projects/:projectId
```

POST输入只接收{name, description?}。
- name必须为字符串，trim后非空，最多120个Unicode码点。
- description可省略或为null；字符串trim后空视为null，最多2000个Unicode码点。
- 不接受客户端指定id、生命周期、时间或任意metadata；未声明的字段不得传给store。
- 用应用层UUID生成id，生命周期为ACTIVE，时间由数据库默认值生成。
- 研究目的写入metadata.description；只写入这一明确白名单键。读取时该键不存在/null返回description:null；不是字符串的旧值不强转成用户文本。

Project DTO：
```text
id, name, description, lifecycleState, createdAt, updatedAt
```

POST成功201返回{project: Project}；GET列表200返回{projects: Project[]}；GET详情200返回{project: Project}。列表按created_at DESC、id DESC稳定排序；M1-B个人小规模阶段不新增分页、检索、标签或多租户系统。详情id不合法400，不存在404。

配置/权限行为沿用M1-A：功能未开启404；token未配置503；未提供凭据401；错误凭据403；通过鉴权但DB未配置/连接不可用503；非法输入400；其他错误500且不透出数据库错误/连接串。列表接口在DB失败时不得返回成功的空数组。鉴权失败不调用项目store。

参数化SQL；项目操作只使用core.projects。单行INSERT不增加多余事务框架。复用已有pg和注册层，避免每次请求创建Pool；模块导入不能建立连接或启动容器。M1-A行为不改变。

## 5. 本地使用与鉴权

本地开发服务默认绑定回环地址。S32_FEATURES_ENABLED仍默认false；开发者只在本地忽略文件中配置S32_DATABASE_URL和独立S32_PRIVATE_API_TOKEN。

前端可以新增默认false的VITE_S32_ENABLED控制入口，但它只是显示开关，不代替后端权限检查。不能用VITE_*注入任何token、数据库凭据，不能把token编进bundle。页面输入访问token，使用独立的S32 sessionStorage key并提供清除访问凭据的操作；清除后同时清空内存中的项目列表/详情。存储不可用时回退到内存，不因浏览器设置导致页面崩溃。既有WeRead授权与数据保持独立。

本轮是单人访问，不建设账号、OAuth、RBAC或团队协作系统。前端私有GET响应不应长期缓存；页面请求使用同源/api/private/s32前缀。

本地开发PG必须有独立的持久volume/bind，用来保存用户试用项目，不能照搬测试脚本的tmpfs。测试PG必须另建一次性实例，不得把清表测试指向开发试用库，更不得指向腾讯云。首次空开发库才应用已有migration；重启开发服务不重跑CREATE TABLE迁移，不自动清库/删卷。开发中没有Meili数据也必须能完成项目create/list/get；不复制完整catalog、不通过SSH写生产数据。

如需开发PG启动说明，使用一个独立本地配置或简短命令，采用现有可用镜像。不要改生产第五层模板来当本地测试环境。

## 6. 建议代码落点

按现有模块方式最小实现，可以调整小文件命名，不需逐项申请：
- apps/api/src/s32/domain/project.ts（DTO、输入验证）
- apps/api/src/s32/application/projects.ts（create/list/get）
- apps/api/src/s32/postgres/project-store.ts
- apps/api/src/s32/routes/project-routes.ts
- 对应的单元与PG集成测试，及register.ts最小装配变更。
- apps/web/src/research/下的API client、独立S32访问状态、项目列表/详情、组件测试。
- App.tsx只增加必要导航和路由；样式局限新模块，保留查书/WeRead入口。
- 可选本地PG配置/启动说明；.env.example仅记录开关及键名，不含真实值。
- docs/STATUS.md记录实际进展，新增简短M1-B启动/验收说明。

## 7. 交付验收

必须交付一个可运行的本地页面，不接受仅接口或纯mock页面作为完成。

1. 相关单元/API测试：输入、created/list/get、404、鉴权及DB异常；DB失败不假装空列表。
2. 一次隔离PG16集成：真实写入core.projects，读取同一id/name/description，重复GET不写数据，合法同名项目不自动合并；项目操作不写Work/Edition/Source/Note等表。
3. 本地真实浏览器：创建“北京古道研究”，填研究目的，进入详情，返回列表，刷新。重启本地API/开发PG但保留卷后，重新打开仍能看到同一项目。可以用现有自动化或记录手工操作结果；截图/录屏是展示，不能替代持久化证明。浏览器未跑就标NOT_RUN，不虚报全通过。
4. API/Web编译、受影响的现有查书测试通过。不要求每小改动重复全仓/M0所有审计；不把本阶段未运行的历史测试记PASS。
5. 记录tested_commit、真实命令/退出码、页面实际本地URL和证据路径；确认代码已进入提交再push。开一个M1-B PR，不自动merge、不部署。

界面输入、数据保存和测试均限定本地。原M0 migration与两份SQL、生产Compose、Web/API/Meili运行容器和腾讯云空间策略保持不变。

## 8. Codex执行与同步

本地路径优先复用 /home/conanxin/codex-projects/book-id-search。先保留未提交工作，fetch远端，使用包含PR #10的main创建feat/s32-m1b-projects-ui，不在旧release分支继续开发。AGENTS.md中“不启动M1-B”是上一发布准备任务边界；本次用户已认可进入M1-B，可最小更新为新的阶段范围，但不可移除生产授权规则。

此文档位于plan/s32-m1b-projects分支；读取后可将本规格纳入自己的功能PR，不合并其他规划分支。先核对具体契约及本地依赖，列出短实施清单，按用户认可的Native流程推进；发现需要新增schema/扩大C-D功能的冲突时才停下来确认。

同步分开记录GitHub和Notion的成功/失败。在完成可验证交付、真实阻断和PR提交时更新，Issue #2只写阶段摘要。源代码以commit为准；项目数据存本地PG；Notion在此仅保存开发进度，不是产品项目数据的替代数据库。

状态在本次文档准备时：
```text
PR10_MERGED=YES
CODE_BASELINE=19c0209acb9445b505f918f13bce9e2dc82f7917
M1B_SCOPE=PROJECTS_AND_MINIMAL_UI
M1B_DESIGN=READY_FOR_CODEX_REVIEW
M1B_IMPLEMENTATION=NOT_STARTED_IN_THIS_SESSION
M1B_RUNTIME_VERIFICATION=NOT_RUN
PRODUCTION_EXECUTION=HOLD_CAPACITY_AND_AUTHORIZATION
```

## 9. 参考

既有M1设计：https://www.notion.so/3e034a28189a816cbec4d050ed01ae5e
代码事实：上述固定基线的db/migrations/001_s32_core_schema.sql、apps/api/src/s32/register.ts、apps/web/src/main.tsx及wereadPrivate.ts。
Vite环境变量与客户端bundle：https://vite.dev/guide/env-and-mode
Docker持久卷：https://docs.docker.com/engine/storage/volumes/
