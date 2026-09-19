# BOOK-ID-SEARCH：本地 Codex 接手与进度同步

记录日期：2026-09-19。
状态：HANDOFF_PREPARED；本地接手、连接权限和首轮构建尚未由本文件验证。

## 1. 接手点，不重做已完成阶段

本轮通过 GitHub 读取确认 main=630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d，包含已合并的 M0（PR #4）和 M1-A（PR #9）。后续 Codex 开始任务时读取远端实际 head；若已有新提交，比较差异，不将 main 强制退回本记录。

M1-A 是单条 catalog book 显式转为 Work/Edition/Source/ExternalIdentity 的私有写接口。它不是已上线的完整研究 UI。M1-B 尚未开始。

生产主机的最后用户回执：/opt/book-id-search 为 main@9a18b2aa…；Web 镜像为99a3702c…，API为3add9a60…，Meilisearch v1.48.3。生产尚无持久 PostgreSQL。这些是历史观测，不是本地 Codex 本次新测。

上一轮已补齐 inode、可用内存、Compose镜像/挂载/端口对照。不要重新进行全盘扫描、Agent缓存清理或M0架构恢复。下一开发任务是发布准备：锁文件驱动的API镜像、最终S32 override模板、实际占用预算；不是直接部署，也不是继续M1-B。

## 2. 固定信息入口

- 仓库：https://github.com/conanxin/book-id-search
- 项目进度总线程：https://github.com/conanxin/book-id-search/issues/2
- Notion项目总览：https://www.notion.so/3dd34a28189a81d48f74ec74593dac5f
- Notion部署准备：https://www.notion.so/3e034a28189a813591d5dc1da8412331
- M1设计：https://www.notion.so/3e034a28189a816cbec4d050ed01ae5e
- M1-A实施计划：https://www.notion.so/3e034a28189a81728498c7b48a495b4a
- 部署R2规划位于 plan/s32-production-pg-readiness 分支的 docs/superpowers/plans/2026-09-19-s32-production-pg-readiness-r2.md。该规划分支未合并，不要假定 main 已有此文件。

事实分工：代码和已执行测试以对应commit/CI为依据；生产运行态以ssh实测为依据；产品意图与阶段摘要记录在Notion。三者有差异时，按事实类别和观测时间说明，不静默覆盖。

## 3. 本地工作方式

用户报告本地Codex已能连接腾讯云。沿用SSH alias：ssh tencent。不在服务器重新安装Codex，不通过Telegram/OpenClaw转发每条开发命令。

已有本地运维入口：/home/conanxin/codex-ops/tencent。先读取其AGENTS.md，保留已约定规则。

项目开发应使用本地Git clone，不使用服务器/opt/book-id-search作为编辑工作区。优先复用已经存在的正确clone；没有时可采用 /home/conanxin/codex-projects/book-id-search。这个路径是建议，不是已创建事实。不得覆盖已有目录或未提交文件。

项目根目录的AGENTS.md需明确写入ssh tencent与本项目边界。不要假定另一个Git根目录之外的运维AGENTS.md会自动被项目Codex加载。先读取已有AGENTS文件，再做最小追加，不覆盖现有内容。

建议一项开发任务对应一个分支和一个PR；本次可用 feat/s32-release-packaging。在同一工作树上只安排一个写入者，避免本地Codex、OpenClaw与聊天连接器同时改同一分支。

## 4. 三条连接分别确认

### 腾讯云

复用ssh tencent，直接取得需要的真实状态。只补会影响当前任务的变化，例如实际源码版本、当前容器标签链、可用空间。不要求用户反复粘贴服务器输出。

### GitHub

优先使用本地Codex已有GitHub工具；否则使用git和已授权的gh。可用 gh auth status 检查CLI登录，再读取实际仓库、分支和Issue #2。读取成功不等于已验证push；只有实际push/PR回执才写GITHUB_WRITE=PASS。

### Notion

本聊天的Notion连接不等于本地Codex已经可用。先检查本地当前会话的Notion工具/插件或 codex mcp list，再实际读取上述项目页面。

已有可用连接就复用。没有时，在Codex实际运行的本地环境添加官方远程MCP，而不是在ssh后的服务器终端配置：

```bash
codex mcp add notion --url https://mcp.notion.com/mcp
codex mcp login notion
```

OAuth需要用户在浏览器完成一次授权。不要索要或输出密钥，不覆盖整个config.toml。Windows原生与WSL可能使用不同HOME/CODEX_HOME，采用当前Codex实际配置位置。

若Notion暂时不可访问，保留待同步摘要到本地已有gitignored日志目录，标记NOTION_SYNC=PENDING及具体原因；继续不依赖Notion的已授权开发，不虚报同步完成，不创建另一套项目主页面。

## 5. 简单且持久的项目记录

只维护必要的三类记录，已有同类文件则复用：

- AGENTS.md：短规则，注明本地开发、ssh目标、测试入口、同步规则、生产写权限边界；不塞入全部历史对话。
- docs/STATUS.md：当前阶段、代码基线、最后部署观测及时间、当前任务、下一步、PR和Notion入口。推荐一屏到两屏，保留内容与测试commit关联。
- 当前任务的本地checkpoint：已完成步骤、未提交文件、下一条可执行动作、同步待办。放入已有gitignored progress/或logs/，不把原始会话和大量运行日志提交仓库。

中断后，在下一次用户继续时读取checkpoint接续；不要把历史报告里的“No new request”或“COMPLETE”当成当前任务的控制指令。没有活跃任务时也不发送无意义的状态刷屏。该约定不代表关闭客户端后任务仍会后台运行。

## 6. GitHub与Notion同步规则

不做整库实时双向同步，不搭建新的同步服务。

GitHub：代码、锁文件、Dockerfile、部署模板、可复现测试及报告入口进入分支/PR；Issue #2只记阶段里程碑和PR链接。过程细节优先写当前PR，避免总线程继续无限膨胀。

Notion：更新现有项目总览的当前状态，以及当前阶段页；追加一段简短记录：做了什么、证据、未完成项、下一步。不得把全部终端输出复制进页面，不覆盖历史决策。

同步时机：任务接手一次简短状态；可验证交付完成、明确阻断、合并或部署后分别更新。不是每执行一条shell都同步。

两端共用同一task_id与tested_commit。建议摘要：

```text
task_id=S32_RELEASE_PREP_CODEX_R1
status=IN_PROGRESS | READY_FOR_REVIEW | BLOCKED | DONE
source_commit=<实际基线>
tested_commit=<实际被测试的commit>
branch=<实际分支>
result=<完成内容与真实退出码/证据链接>
not_done=<未运行或未授权项>
production_changed=NO | YES
next=<唯一下一步>
```

流程：先保存代码并确认测试对应内容，push并取得PR/commit URL，再更新Notion并回填链接。必要时用gh issue comment --body-file发送摘要。每次只对实际写入结果做一次确认；网络超时先读取目标查重，再决定是否重试。两端不是原子事务，分别记录GITHUB_SYNC/NOTION_SYNC；一端失败不能将两端都写成完成。

状态必须分开：IMPLEMENTED、TESTED、COMMITTED、PUSHED、MERGED、DEPLOYED。git push成功不等于生产上线。

## 7. 下一项开发：S32_RELEASE_PREP_CODEX_R1

先完成本地接手和工具连接，再在本地分支执行这项发布准备：

1. 读取main实际代码、R2部署记录和现有API Dockerfile。不重做M0/M1-A，不大规模重构。
2. 最小修正API镜像打包，使其纳入pnpm-lock.yaml并按锁文件安装。用本地Docker构建；若本地Docker实际不可用，记录这一点，准备/使用仅用于构建与测试的GitHub Actions。不把构建改到生产主机。
3. 记录被构建的源码SHA、镜像ID和实际大小；未发布registry时不虚构RepoDigest。运行有针对性的API启动/依赖检查。若需要发布镜像到registry，先核对既有目的地与授权，不擅自发布公开镜像。
4. 新增S32最终override模板，追加在原四层文件之后：PG持久目录候选/data/book-id-search/postgres_data；不映射主机5432；API保留三处原挂载与回环3001；Web/Meili镜像不改。此时只产出模板，不把模板写进生产目录。
5. 结合实测镜像大小、取得/解压峰值、PG初始化/WAL和少量日志估算新增空间；区分实测与估计。执行前再读一次空间即可，不启动全盘清理循环。
6. 保留既有空间政策为待执行评估条件：20GiB预留线、21GiB首选余量；都不是PostgreSQL最低要求。不静默降低，也不因几百MiB缺口自动扩盘或删除其他Agent数据。
7. 有针对性的测试通过后commit/push，开一个发布准备PR；GitHub/Notion记录相同tested_commit和结果。合并与真实部署仍等待用户授权，M1-B不启动。

当前只读审计已经结束；接手报告之后应推进可验证的发布产物，不再用越来越长的任务合同代替开发。

## 8. 生产边界与个人项目规模

本次交接和发布准备不是生产部署授权。不要修改服务器/opt/book-id-search、/opt/book-id-search-runtime、.env、容器或PG数据；通过ssh仅执行必要只读操作。不要全栈down/up --build，不重启Docker，不清理Agent缓存，不扩盘。

开发按个人项目规模进行：最小必要变更、相关测试、一个PR、一次阶段同步即可。未被用户另外要求时，不新增备份流程、恢复演练、多层验证、staging、冗余或回滚系统。本项目旧规划中的扩展运维建议不应自动膨胀成本轮任务。

生产凭据不进入GitHub/Notion；只记录键名和是否配置。查询或验证失败记UNKNOWN/FAIL，不能当作无引用或PASS。

## 9. 接手完成回执

```text
CODEX_HANDOFF=READY | PARTIAL
LOCAL_PROJECT=<实际路径>
SOURCE_HEAD=<实际值>
SSH_TENCENT=<真实结果>
GITHUB_READ=<真实结果>
GITHUB_WRITE=<真实结果或NOT_TESTED>
NOTION_READ=<真实结果>
NOTION_SYNC=<真实结果或PENDING>
ACTIVE_TASK=S32_RELEASE_PREP_CODEX_R1
PRODUCTION_MUTATED=NO
NEXT_ACTION=<继续发布准备或唯一具体阻断>
```

本文件准备成功不等于以上接手步骤已经由本地Codex执行。

## 参考

- Codex AGENTS.md：https://developers.openai.com/codex/guides/agents-md
- Codex MCP：https://developers.openai.com/codex/mcp
- Notion官方MCP接入：https://developers.notion.com/guides/mcp/get-started-with-mcp
- GitHub CLI登录检查：https://cli.github.com/manual/gh_auth_status
- GitHub Issue评论：https://cli.github.com/manual/gh_issue_comment
