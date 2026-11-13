# 多来源网页原文对照

`task_id=BOOK_AI_WEB_SOURCE_COMPARISON_V1` · 2026-11-13

基线为已发布 PR #80 的合并提交 `2dba28930a9c142e21baef1eeb9451eeb2bfea06`。本阶段完成开发、定向验证、CI 和 PR；合并与生产发布状态分别记录。

## 用户流程

在本次联网研究结果内，用户先主动读取来源网页，再在“多来源原文对照”中勾选 2–3 篇。默认不勾选，不自动读取。问题默认带入本次研究问题，允许独立修改；只有点击“查找多来源原文依据”才发起一次模型请求。

结果按用户选择顺序分组，每篇展示 0–2 段原句、标题、地址、读取时间、截短提示和片段编号。某篇未选出足够相关原文时保留来源卡；不将空选择解释成整篇网页或其他资料没有答案。对照卡内可展开对应快照正文并定位高亮，复制包含同一问题、分源原句及出处。桌面和手机均采用纵向分组，保留现有侧栏布局。

这里的“对照”指用户查看不同网页各自的说法。模型只选择编号，服务器逐字回填；响应没有共同结论、冲突判断、可信度或事实综合字段。不同网页也不等同于相互独立的证据。个人介绍、笔记、微信读书材料和未保存编辑不进入服务，不提供写入个人内容的动作。

## HTTP 合同

`POST /api/ai/books/:bookId/research/sources/evidence`

请求严格仅包含：

```ts
{ snapshotTokens: string[]; question: string }
```

snapshotTokens 为 2–3 个原有 32 字符 base64url 凭据；question 去首尾空格后 1–1,000 UTF-16 字符。客户端不发送正文或 URL。

外层响应严格为：

```ts
{
  bookId: string;
  question: string;
  mode: "source_comparison";
  sources: BookWebSourceEvidenceResponse[];
  generatedAt: string;
}
```

sources 的数量、顺序与请求完全一致。每组复用单篇合同的完整字段：
bookId、sourceId、snapshotToken、question、mode="source_passages"、
status="selected"|"insufficient_evidence"、requestedUrl、finalUrl、title、
fetchedAt、sourceTruncated、passages、generatedAt。每来源最多两片，最多六片；
start/end 为 UTF-16 半开区间，text 必须严格等于该快照的 slice。各组以同一操作生成时间记录。

一次捕获所有快照，再调用模型。去重同时检查 snapshotToken、sourceId 和规范化 finalUrl。URL 使用 new URL 标准化并移除 hash，保留路径大小写、末尾斜线和查询语义。重复或跨书输入在模型前拒绝。

正文合计上限 60,000 UTF-16 字符；恰好上限可用，超出时要求减少来源，不截短正文或静默少一组。全部快照在请求开始时验证；后续 TTL 到期不会改变已捕获的不可变内容。任一开始时已过期则整次失败，已有正文继续保留。

## 模型合同

多来源对照使用自然段优先的候选分段，逐篇完整覆盖正文，保持 UTF-16 偏移及所有原始空白。超过 1,200 字符的长自然段沿用原分片器的句末与代理对安全边界。候选超过 64 片时，以最小堆优先合并最短的相邻片（合并后仍不得超过 1,200 字符；相同长度按原文起点排序），直至满足预算；保留原完整分片作为兜底，绝不丢段或截短。原单篇选段行为不变。

这样短页面的正文介绍、导航、分类和推荐信息可以保持为不同候选，模型能选择相关原句；它仍需通过真实内容相关性复核。每源至多选两片，完整上下文通过该来源快照定位查看。输入为：

```ts
{
  question,
  sources: [{
    sourceKey: "S1", // 按输入次序 S1/S2/S3，仅为本次内部别名
    title,
    sourceTruncated,
    passages: [{id, text}]
  }]
}
```

不向模型发送能力 token。公开网页内容均为待阅读的材料，其指令不改变选择规则。

唯一允许输出：

```json
{"sources":[
  {"sourceKey":"S1","passageIds":["P2"],"insufficientEvidence":false},
  {"sourceKey":"S2","passageIds":[],"insufficientEvidence":true}
]}
```

全部 S1…Sn 恰好一次，没有其他来源或字段。模型返回来源顺序不限；服务器恢复请求次序，片段按各篇原文顺序返回。每组 ID 真实、不重复、最多两个，空列表与 insufficientEvidence 必须一致。任一组不合法，整次拒绝。S1/P1 与 S2/P1 独立，不能混用。

一次操作最多一次 provider 调用，60 秒预算，requireCompleted=true；不自动重试、搜索或重抓网页。沿用 Google Owner、Origin/CSRF、no-store 与取消机制。

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| BOOK_COMPARISON_INVALID_INPUT | 400 | 数量、重复、问题、跨书或请求字段非法 |
| BOOK_COMPARISON_EXPIRED | 410 | 至少一份所选快照失效，需要重新读取该来源 |
| BOOK_COMPARISON_TEXT_LIMIT | 400 | 正文合计超过 60,000 字符，请减少来源后重试 |
| BOOK_COMPARISON_INVALID_OUTPUT | 502 | 模型输出未满足完整严格合同 |
| BOOK_COMPARISON_UNAVAILABLE | 503 | 功能未配置或暂不可用 |
| BOOK_COMPARISON_TIMEOUT | 504 | 模型请求超时 |

## 前端作用域与验证

本次研究结果登记已读快照，身份绑定 resultRevision、bookId、source.id、
source.readToken 与 snapshotToken。回调稳定，过期结果的回调不重新登记。

- 改变对照问题或选择：取消请求，清理结果、复制状态和高亮。
- 所选来源开始重读或清除：移除其选择并取消旧对照；重读成功后用户重新勾选。重读失败保留旧正文但不自动恢复选择。
- 未选择来源读取或清除：不清除已有有效对照。
- 新研究、修改联网研究问题、切书、切换模式或会话变化：随现有作用域清理全部对照状态。
- 手机侧栏仅收起：保留同书同次研究的有效状态，不增加请求。
- 结合 AbortController、作用域与请求序号拒绝迟到响应。

客户端验证外层严格字段、bookId、question、mode、时间及来源数/序，
逐组调用单篇原文校验并额外限制每源两片。全部通过后才展示、定位和复制。
不符合当前快照的响应整次拒绝。复制包含出处与时间，不包含能力 token；
失败可手动复制，异步结果不夺取主栏编辑焦点。

## 本阶段验证

定向测试覆盖 2/3 来源、一次 provider、不同来源的1935/1937原句、
部分/全部不足、完整出处、来源与片段排序、重复/过期/跨书/60,000边界、
模型缺组或自由字段拒绝、Unicode、授权/CSRF、取消与迟到响应。
Web 另覆盖未选择来源更新、所选重读、手动复制与会话隔离。

沿用现有 HTTP/合成 Owner/一次性 PostgreSQL Chromium 旅程，
新增多来源成功、定位/复制及手机操作，确认个人内容写请求为零、
实际 PostgreSQL 内容与未保存编辑保持原值；保留既有读取失败覆盖。
外部网页/模型夹具与真实模型证据分别记录。

如执行真实试跑，使用两篇确认的公开来源、同一问题、各读取一次及一次模型请求；
结构核对、相关性复核与真人审阅分开。保持过去自由综合 REQUIRES_REVISION 的历史结论。
无新依赖、服务、凭据或数据库迁移。
