# 本书 AI：实际模型兼容与只读试跑

`TASK_ID=BOOK_CENTERED_AI_REAL_PROVIDER_READINESS_R1` · 2026-10-11

接续 `9645283d89327125084de79b44e6ac76fecae818`，在现有 [PR #72](https://github.com/conanxin/book-id-search/pull/72) 上修复实际提供方兼容问题，并提供读取真实书籍资料的试跑入口。

## 本次修复

现有 MiniMax Responses 请求发送 `max_tokens`。按本次打开的[官方 Responses 文档](https://platform.minimax.io/docs/api-reference/responses-create)，该协议使用 `max_output_tokens`，响应可以同时包含推理块和最终消息；输出预算不足可返回 `incomplete`。

本次改为正确的输出参数，只从已完成的最终 assistant 消息中按顺序拼接 `output_text`，不把推理文本当正文，也不接受明确失败或未完成的响应。缺少结构化 `output` 属性时保留顶层 `output_text` 的既有兼容。Anthropic 分支按[官方格式](https://platform.minimax.io/docs/api-reference/text-anthropic-api)只拼接 `type=text`；Chat Completions、模型默认值、地址和凭据配置不变。

本书助手还向模型传递实际采用／可用的笔记数量及每项来源的节选标记。此前这些信息只出现在页面响应中，模型看不到。新增提示要求按实际提供的范围归纳，不能声称覆盖未提供的记录。

这修复了可由代码和官方合同确认的问题；并不证明某个实际账户、网络或模型效果已通过。

## 一次试跑

在已有依赖和实际数据配置的开发工作区执行：

```bash
DOTENV_CONFIG_PATH=/实际位置/现有.env \
  corepack pnpm run book-ai:trial --book-id 实际书目ID \
  --action question --question '当前资料支持哪些下一步阅读线索？'
```

将示例路径和书目ID替换为该机器上实际读取的值。书目ID使用目录中的完整 `ssid_dxid`；不根据书名自行编造。已有进程环境变量优先于 `.env`。其他动作是 `--action introduction` 和 `--action notes_summary`，这两种不传 `--question`。

脚本复用实际 MiniMax 客户端、本书资料收集器、Meilisearch 目录、PostgreSQL 书籍读取与微信读书有效关联。一次调用至多请求一次模型，不切换提供方或协议，不创建介绍、笔记、关联或迁移。它是拥有本地配置权限的命令行读取，不代表浏览器Google登录验收。

需要已有 `AI_FEATURES_ENABLED`、`MINIMAX_API_KEY`、`S32_DATABASE_URL` 及可访问的目录。沿用 `MINIMAX_BASE_URL/MODEL/WIRE_API`、`MEILI_HOST/MASTER_KEY/INDEX`；启用微信读书时还需要真实导入目录和004表。缺少配置时先输出 `BLOCKED_CONFIGURATION`，不创建网络连接，也不填入合成资料补足。尚未应用003／004或没有真实来源时如实记录，试跑脚本不会代为部署。

输出为 `progress/book-ai-live/` 下每次运行独立目录中的 `receipt.json` 和 `review.md`，可用 `--out-dir` 指定仓库内其他已被Git忽略的目录。报告保留生成正文、真实引用摘录、源码身份、来源计数、模型调用次数与耗时；不记录密钥、数据库连接串或提供方原始错误。来源和生成稿只保留在本地，项目PR只同步不含私人正文的结果摘要。

| 状态 | 含义 |
| --- | --- |
| `STRUCTURAL_PASS_REVIEW_PENDING` | 实际请求与本书输出合同通过，内容质量仍待审阅 |
| `INSUFFICIENT_CONTEXT` | 当前资料不足；可能由零调用的空笔记判断产生，也可能由实际模型返回 |
| `BLOCKED_CONFIGURATION` | 缺少运行配置，模型调用为0；不是模型验收通过 |
| `FAILED` | 资料读取、实际请求或输出合同失败 |

## 实际书籍选择与审阅

先挑两至三本**实际存在且有可读取内容**的书，最多四次生成即可：

1. 只有书目的一本：介绍应限于可确认的出版资料。
2. 有独立笔记的一本：摘要应保留笔记里的具体信息、未定说法和个人判断。若实际已保存，可优先考虑最近在读的《中国古代旅行之研究》。
3. 有微信读书记录的一本：问一个摘录能支持的问题，核对答案与引用，并区分原文与自己的想法。书名和关联以实际记录为准。
4. 用上一本书问一个材料未涉及的具体问题，检查是否诚实返回资料不足。

目前资料选择仍是最近笔记及其前缀，不是全文检索。答案位于未选中的旧笔记或节选以外时，应保留“当前资料不足”，不能因整本书可能有答案而判为模型必须回答。报告中的内容质量与人工审阅默认均为待确认；结构通过不能自动替代它们。

## 当前交付边界

当前ChatGPT开发环境没有MiniMax／数据库配置，没有用户WSL路径、Hermes命令或有效的 `tencent` SSH别名。因此本轮可完成代码修复、定向测试、配置缺失路径实跑及交接准备，真实模型与真实用户资料试跑仍待具备配置的机器执行。最终测试数量与精确提交在PR #72记录。

累计版本的发布方式见[简洁增量发布说明](../operations/BOOK_CENTERED_RELEASE.md)。本次没有合并、发布镜像或改动腾讯云。
