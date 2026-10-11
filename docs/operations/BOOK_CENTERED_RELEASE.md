# 书籍中心累计候选：增量发布说明

`TASK_ID=BOOK_CENTERED_RELEASE_PREP_R1` · 2026-10-11。准备源基线：`7d71e796ee90e2e18059db634f860ff72181dba2`，累计 [PR #72](https://github.com/conanxin/book-id-search/pull/72)。本文同时适用于在该候选上接续、经核对的提交，实际执行时必须记录完整源 SHA。

本批包含统一书页、介绍与独立笔记、电子版外链、同书微信读书记录、人工关联管理、本书 AI 助手，以及后续的关联书目、笔记检索定位、阅读排版和来源跳转，也包含 PR 中此前接续的研究页面改造。发布对象是同一源提交构建的 **API + Web**，以及既有 PostgreSQL 的增量迁移。电子版仍是外链登记，无需增加上传空间或文件服务。

**当前只进行开发、真实模型试跑和发布准备。尚无合并 PR 或腾讯云写入授权。** 本文不是执行授权；腾讯云实际配置、Compose 文件链及数据库迁移状态尚未在本轮重新核对，不能使用旧回执替代现场结果。

## 1. 先确认已有环境

在现有本地开发环境完成以下准备，并通过 `ssh tencent` 只读核对线上对应事实。读取仓库 `AGENTS.md`；腾讯云操作规则文件 `/home/conanxin/codex-ops/tencent/AGENTS.md` 可用时也需读取。远端身份应现场确认是 `ubuntu` / `VM-0-4-ubuntu`，需要 sudo 时仅用 `sudo -n`。

| 核对项 | 实际需要确认的内容 |
| --- | --- |
| 源码 | PR 当前完整 SHA、分支、本地工作区状态和 `origin/main`；保留已有未提交工作。 |
| Google | 后端已启用 Google；Owner、Session Secret 和公网 Origin 已配置；Web 构建使用与后端相同的公开 Client ID。仅记录配置存在性及一致性，不输出密钥或会话。 |
| PostgreSQL | 现有数据库、运行容器、API实际连接角色及连接方式；确认002已应用，以及003、004是否尚缺；新表已存在时核对该角色的实际权限。 |
| 微信读书 | 现有数据目录、只读挂载及有效人工关联读取可用，`WEREAD_OVERLAY_ENABLED=true`。 |
| AI | 现有 `AI_FEATURES_ENABLED`、MiniMax模型、协议和地址；只记录 API Key 是否存在。 |
| 运行方式 | 当前 API/Web 镜像、源 revision、实际 Compose 项目、按顺序生效的 `-f` 文件与 `--env-file`，以及现有运行覆盖文件。 |

**书籍工作台仍需要 `S32_FEATURES_ENABLED=true` 和有效的 `S32_DATABASE_URL`。** 不要为了隐藏旧研究导航而关闭这个开关，否则介绍、笔记和电子版保存接口会不可用。界面已经调整了导航，权限继续使用 Google 会话与写操作 CSRF。

保留现有 `.env`、Google配置、数据库、微信读书目录和所有有效 Compose 覆盖层。下面使用的路径、容器 ID、Client ID 与 Compose 参数都必须来自本次现场读取；示例不提供未经核对的生产值。

## 2. 真实书籍 AI 试跑

在包含 `scripts/book-ai-live-trial.ts` 的已提交本地工作区，使用现有可访问的开发配置。按[真实书籍选择与试跑说明](../development/BOOK_AI_REAL_PROVIDER_READINESS.md)从实际搜索响应选一本书，核对完整 ID、作者和版次信息，并确认同一 ID 存在于试跑配置指向的 Meilisearch 目录；记录其已保存介绍、个人笔记或微信读书记录。

以下为填写现场值后的调用模板，尖括号内容不能原样执行：

```bash
cd '<本次已核对的本地候选工作区>'
DOTENV_CONFIG_PATH='<现有且可访问其数据源的 .env 绝对路径>' \
  node --import tsx scripts/book-ai-live-trial.ts \
  --book-id '<实际目录 ID>' \
  --action introduction \
  --out-dir progress/book-ai-live
```

先一本书、一个动作、运行一次：有实际可读笔记时将操作改为 `--action notes_summary`，否则使用 `introduction`。无笔记的摘要可零调用返回资料不足，不能计作真实模型试跑。即使生成介绍，CLI也需要可达的PostgreSQL及003；启用微信读书还需要004和当前WSL进程可读的真实导入目录。脚本不写数据库，结果保存在本地 `progress/`，生成不等于保存。

核对实际输出是否有用、引用是否对应摘录、资料不足是否明确说明。配置字段未满足前置检查为 `BLOCKED_CONFIGURATION`；缺表、数据源不可达或读取／模型失败为 `FAILED`，不自动反复调用模型。如果 `.env` 中的数据库地址只在容器网络内可达，先报告现有执行环境的差异，不开放生产端口或修改生产配置来配合试跑。私人摘录和完整生成内容留在本地；项目同步只记录必要结果和脱敏问题。

## 3. 数据库仅应用缺少的增量

在已有002的数据库上，按顺序应用：

| 迁移 | 内容 |
| --- | --- |
| `003_book_library.sql` | `core.library_books`、`core.library_book_notes`、`core.library_book_resources`，及下述标准角色的新表权限。 |
| `004_weread_binding_overrides.sql` | `core.weread_binding_overrides` 及下述标准角色权限，保存人工关联、解除和恢复导入匹配。 |

002可通过 `core.issue_resolutions` 上的 `fk_ir_preferred_claim_same_issue` 约束等结构确认。003应检查三张表，004检查人工关联表；若只有部分预期结构，先说明差异，不推断整份迁移已经成功或直接重放。两份增量 SQL 自带事务且不是重复执行脚本，只应用本次确认尚缺的迁移。

两份迁移只向已存在的 `s32_app`、`s32_readonly` 自动授权；原角色bootstrap允许其他 `app_role`，不能推定新表权限已覆盖API实际连接角色。若现场发现该既有角色缺少权限，在获准清单中只补相应新表的 `GRANT`：003三表为 `SELECT, INSERT, UPDATE, DELETE`，004表为 `SELECT, INSERT, UPDATE`；无需重建角色或重跑bootstrap。

**以下写入命令仅供后续取得发布授权后使用。** `$BOOK_PG_CID`、`$BOOK_DB_ADMIN`、`$BOOK_DB_NAME` 和当前目录均须来自现场核对；当前目录须包含获准源提交的迁移文件。

```bash
sudo -n docker exec -i "$BOOK_PG_CID" \
  psql -X -v ON_ERROR_STOP=1 -U "$BOOK_DB_ADMIN" -d "$BOOK_DB_NAME" \
  < db/migrations/003_book_library.sql

sudo -n docker exec -i "$BOOK_PG_CID" \
  psql -X -v ON_ERROR_STOP=1 -U "$BOOK_DB_ADMIN" -d "$BOOK_DB_NAME" \
  < db/migrations/004_weread_binding_overrides.sql
```

不要重跑001、已应用的002、角色 bootstrap 或临时测试库初始化工具。如果现场尚未应用002，需把它列入实际发布差异，不能宣称仅需003／004。

## 4. 获得授权后的最少发布动作

1. 合并获准的 PR 源码，在本地 `git fetch origin main` 后固定将要发布的完整 SHA。现有 API/Web release builder 都要求该 SHA 已包含于 `origin/main`，准备阶段不绕过这个限制。
2. 在本地从相同 SHA 构建两个镜像，Web 使用已核对的公开 Google Client ID；使用现有脚本输出的镜像文件传到腾讯云并载入。
3. 应用本次确认尚缺的数据库增量；在保留实际 Compose 链与 `.env` 的前提下更新 API/Web 镜像选择，仅重新创建这两个服务。
4. 核对首页搜索、Google 登录、真实书页介绍／笔记保存、微信读书同书关联和一次 AI 生成后的明确保存；回执区分源码已合并、镜像已运行、功能已实际使用。

本地构建模板，运行前需在已核对工作区设置 `$BOOK_RELEASE_SHA`，并将 `VITE_GOOGLE_CLIENT_ID` 导出到当前环境：

```bash
BOOK_ID_SEARCH_REPO_ROOT="$PWD" \
  scripts/build-s32-api-release-candidate.sh "$BOOK_RELEASE_SHA"

BOOK_ID_SEARCH_REPO_ROOT="$PWD" \
  scripts/build-web-release-candidate.sh "$BOOK_RELEASE_SHA"
```

服务更新使用既有完整 Compose 参数，仅执行 `up -d --no-deps --no-build api web`。应将现场读取到的项目、文件顺序及环境文件填成最终命令后再提交发布审批，不能只复制基础 `docker-compose.yml`，也不能复制旧日志里的 override 路径。

仓库模板的镜像变量是API的 `S32_API_IMAGE` 和Web的 `BOOK_ID_SEARCH_WEB_IMAGE`，实际以最后生效的override为准。若该层引用变量，使用 `sudo -n env S32_API_IMAGE="$BOOK_API_IMAGE" BOOK_ID_SEARCH_WEB_IMAGE="$BOOK_WEB_IMAGE" docker compose` 并接上上述完整参数和服务更新命令；不要依赖sudo保留外层export。若最后一层是固定镜像值，需更新那个生效位置，单传环境变量不会替换它。S32开关也应核对实际容器环境，不能仅凭某个 `.env` 文件认定生效。

不要用 `scripts/deploy/deploy-app.sh` 升级：它会覆盖 `.env` 并执行全局构建；也不要用 `scripts/deploy-web-release-candidate.sh`，它只更新Web、未传入现场完整Compose参数，且sudo回退未使用 `-n`。直接用基础 Compose 构建 Web 也缺少 Google Client ID 与 S32 构建参数。旧 R3 要求空库，旧 R4 的匿名404检查和 R5/R7的 Bearer 验收不适用于本批严格 Google 登录；本次无需重新运行首次 S32 初始化发布流程。

## 5. 可转发给本地 Hermes 的准备任务

> TASK_ID=BOOK_CENTERED_RELEASE_PREP_R1。在原Windows／WSL开发机接续BOOK-ID-SEARCH累计PR #72，读取本地仓库及腾讯云操作规则，保留主工作区与已有改动；在独立候选工作区核对7d71e796ee90e2e18059db634f860ff72181dba2或其经核对的后续提交，复用已有CI证据。通过 `ssh tencent` 只读确认ubuntu／VM-0-4-ubuntu、运行源码和镜像、Google／S32／WeRead／AI配置存在性、实际数据库角色与002／003／004结构及新表权限、完整Compose项目／文件顺序／env-file／最终镜像选择，不输出密钥。按真实模型试跑说明从搜索响应选一本实际书，核对完整ID和作者版次，确认同一ID在本机试跑目录存在；使用现有可达配置，有实际笔记选notes_summary，否则选introduction，只运行一次现有live-trial、最多一次模型调用、不写数据库，审阅输出与引用，完整结果留在本地progress。交付实际源SHA、真实试跑结果或具体缺项、待应用迁移及必要GRANT、Google公开Client ID来源、两个镜像构建与载入位置和完整Compose更新命令。当前不合并、不写腾讯云、不运行初始化脚本；准备齐全后仅就这份确定清单请求最终合并与发布授权。
