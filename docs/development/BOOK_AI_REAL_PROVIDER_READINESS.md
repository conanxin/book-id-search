# 本书 AI：实际模型兼容与只读试跑

`TASK_ID=BOOK_CENTERED_RELEASE_PREP_R1` · 2026-10-11

准备源：`7d71e796ee90e2e18059db634f860ff72181dba2`，累计 [PR #72](https://github.com/conanxin/book-id-search/pull/72)。提供方修复与现有试跑入口由此前 `BOOK_CENTERED_AI_REAL_PROVIDER_READINESS_R1` 完成；本轮细化真实书籍选择和执行前提。

## 既有提供方修复

修复前MiniMax Responses 请求发送 `max_tokens`。按当时核对的[官方 Responses 文档](https://platform.minimax.io/docs/api-reference/responses-create)，该协议使用 `max_output_tokens`，响应可以同时包含推理块和最终消息；输出预算不足可返回 `incomplete`。

现已改为正确的输出参数，只从已完成的最终 assistant 消息中按顺序拼接 `output_text`，不把推理文本当正文，也不接受明确失败或未完成的响应。缺少结构化 `output` 属性时保留顶层 `output_text` 的既有兼容。Anthropic 分支按[官方格式](https://platform.minimax.io/docs/api-reference/text-anthropic-api)只拼接 `type=text`；Chat Completions、模型默认值、地址和凭据配置不变。

本书助手还向模型传递实际采用／可用的笔记数量及每项来源的节选标记。此前这些信息只出现在页面响应中，模型看不到。新增提示要求按实际提供的范围归纳，不能声称覆盖未提供的记录。

这修复了可由代码和官方合同确认的问题；并不证明某个实际账户、网络或模型效果已通过。

## 一次试跑

先从真实搜索响应选书。以下调用公开的 `GET /api/search?q=中国古代旅行之研究&page=1&limit=20`，不需要Google登录：

```bash
curl --fail --silent --show-error --get \
  'https://books.conanxin.com/api/search' \
  --data-urlencode 'q=中国古代旅行之研究' \
  --data 'page=1' --data 'limit=20' |
  jq '.items[] | {id, title, author, publisher, year, pages, isbn, rawInfo}'
```

从响应核对完整 `ssid_dxid`、书名、作者、出版社及版次信息，不默认采用第一条，不自行拼造ID；响应缺少的版次信息保留未确认。还须确认同一ID在本次 `.env` 指向的Meilisearch目录存在，公网搜索结果不证明本地目录已有该书。

在已有依赖和实际数据配置的开发工作区，只选一本、一个动作运行一次。有可读的个人笔记或同书微信读书笔记时用 `notes_summary`；否则先用 `introduction`：

```bash
DOTENV_CONFIG_PATH='<本机已核对且数据源可达的 .env 绝对路径>' \
  corepack pnpm run book-ai:trial --book-id '<已核对的完整 ssid_dxid>' \
  --action introduction
```

将示例路径和ID替换为该机器现场值。已有进程环境变量优先于 `.env`。无笔记的 `notes_summary` 可零调用返回 `INSUFFICIENT_CONTEXT`，不能计作真实模型试跑；以回执的 `provider.calls` 为准。问答留作后续需要时使用：`--action question --question '当前资料支持哪些下一步阅读线索？'`；介绍和摘要不传 `--question`。

脚本复用实际 MiniMax 客户端、本书资料收集器、Meilisearch 目录、PostgreSQL 书籍读取与微信读书有效关联。一次调用至多请求一次模型，不切换提供方或协议，不创建介绍、笔记、关联或迁移。它是拥有本地配置权限的命令行读取，不代表浏览器Google登录验收。

需要已有 `AI_FEATURES_ENABLED`、`MINIMAX_API_KEY`、`S32_DATABASE_URL` 及可访问的目录，沿用 `MINIMAX_BASE_URL/MODEL/WIRE_API`、`MEILI_HOST/MASTER_KEY/INDEX`。即使只运行 `introduction`，CLI仍会读取书籍工作区，需要可达的PostgreSQL及已应用的003。启用微信读书还需要004，以及 `WEREAD_PRIVATE_DATA_DIR` 指向当前WSL进程可读的真实导入目录，不能照抄容器内路径。

配置字段缺失或无效、未通过前置检查时才输出 `BLOCKED_CONFIGURATION`，尚未连接数据源；配置通过后，缺表、数据源不可达或读取失败记为 `FAILED`。没有保存过该书的介绍／笔记与003缺失是两种情况：前者可返回空工作区，后者是读取失败。脚本不会代为应用迁移或填入合成资料。

输出为 `progress/book-ai-live/` 下每次运行独立目录中的 `receipt.json` 和 `review.md`，可用 `--out-dir` 指定仓库内其他已被Git忽略的目录。报告保留生成正文、真实引用摘录、源码身份、来源计数、模型调用次数与耗时；不记录密钥、数据库连接串或提供方原始错误。来源和生成稿只保留在本地，项目PR只同步不含私人正文的结果摘要。

| 状态 | 含义 |
| --- | --- |
| `STRUCTURAL_PASS_REVIEW_PENDING` | 实际请求与本书输出合同通过，内容质量仍待审阅 |
| `INSUFFICIENT_CONTEXT` | 当前资料不足；可能由零调用的空笔记判断产生，也可能由实际模型返回 |
| `BLOCKED_CONFIGURATION` | 配置字段缺失或无效，未通过前置检查，模型调用为0 |
| `FAILED` | 缺表、数据源连接／读取、实际请求或输出合同失败 |

## 可选后续审阅参考

首次只完成上面的一本书试跑。需要进一步观察效果时，再按实际资料选择以下场景；不是本轮必须追加的调用：

1. 只有书目的一本：介绍应限于可确认的出版资料。
2. 有独立笔记的一本：摘要应保留笔记里的具体信息、未定说法和个人判断。若实际已保存，可优先考虑最近在读的《中国古代旅行之研究》。
3. 有微信读书记录的一本：问一个摘录能支持的问题，核对答案与引用，并区分原文与自己的想法。书名和关联以实际记录为准。
4. 用上一本书问一个材料未涉及的具体问题，检查是否诚实返回资料不足。

目前资料选择仍是最近笔记及其前缀，不是全文检索。答案位于未选中的旧笔记或节选以外时，应保留“当前资料不足”，不能因整本书可能有答案而判为模型必须回答。报告中的内容质量与人工审阅默认均为待确认；结构通过不能自动替代它们。

## 执行环境与交付边界

历史记录：2026-10-11此前提供方修复阶段的ChatGPT开发环境没有MiniMax／数据库配置，也没有可用的用户WSL路径、Hermes命令或 `tencent` SSH别名，当时完成了代码修复、定向测试和配置缺失路径实跑。该记录不是本轮原机或腾讯云状态证明；本轮实际配置、连通性、迁移和真实模型结果以现场回执为准，尚未取得的项目保持待确认。已有开发测试数量与精确提交见PR #72，本轮文档整理不要求重跑已有构建和功能验收。

累计版本的发布方式见[简洁增量发布说明](../operations/BOOK_CENTERED_RELEASE.md)。本次没有合并、发布镜像或改动腾讯云。
