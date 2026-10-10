# S32 R11 — 本地 Locator 文件边界与真实资料试用

- 日期：2026-10-10（Asia/Shanghai）
- `task_id=S32_R11_REAL_SOURCE_LOCAL_PILOT_VALIDATION`
- Base：R10 PR #69，`ef01d0dd9549a7b0c3888f33abbd89bad2dd13ec`
- Branch：`fix/s32-r11-locator-file-boundaries`；精确 `tested_commit`、PR URL 和远端 CI 结果记在本分支 PR 与 Notion R11 回执中。
- 范围：独立的 `/locator-pilot.html` 开发页面；仍不进入正常生产构建入口。

## 本轮改动

选择文件时先验证体积、非空及既有扩展名规则，合法文件才进入创建 blob 预览的 effect。超过 20 MiB 或空文件会清除 input、旧预览与会话，不能开始摘要读取；旧异步读取不能复活已清除的报告。开始核对时复用同一验证函数。

PLATE 报告标题和结果现在显示“图版号”，保留其与印刷页码、扫描文件页序的区别。新增七项界面测试覆盖真实长度的 20 MiB / 20 MiB + 1 字节、空文件、失效替换与恢复、过期读取，以及图版匹配、不匹配和撤销。

新增浏览器回归脚本验证摘要、匹配/不匹配、PLATE 撤销、图片解码及边界文件。脚本启动并确认自己的 Vite 服务，清理服务后才输出最终结果；默认合成样本不使用真实资料页序，也不报告真实资料试用成功。

## 本轮本地证据

| 检查 | 结果与范围 |
| --- | --- |
| 修改前原有界面测试 | 9 PASS |
| 新测试对旧实现的 RED | 6 FAIL / 10 PASS；保留真实失败日志 |
| 修复后的界面测试 | 16 PASS |
| 最终 UI + 冻结 Schema 静态测试 | 45 PASS（16 + 29） |
| 较大 Research + Schema 回归 | **824 PASS / 1 FAIL**，不是全绿 |
| Web / API 构建 | PASS；正常 Web 构建未产出 `locator-pilot.html` |
| 新 R11 runner 的独立严格 TypeScript 检查 | PASS |
| 合成样本 Chromium 回归 | PASS；`real_source_trial=NOT_RUN` |
| 真实 PDF 字节与自动化 UI 流程 | PASS；文件摘要、页码/图版报告、不匹配与撤销 |
| 独立派生 PNG 预览 | PASS，浏览器图片实际解码；没有套用原 PDF 的扫描页序 |
| 真实 PDF 的浏览器内嵌页面视觉验收 | **PENDING**：当前无头浏览器 iframe 未显示可核验的 PDF 页面 |
| 浏览器外部 HTTP / 研究 API 请求 | 0（以上测试旅程内） |
| 独立真人确认 / 来源认证 | NONE；自动化勾选只模拟本地演示流程 |

Research 唯一失败是 `CandidateClaims.test.tsx` 的 `create success refreshes canonical order from server GET instead of local append`：第二次 GET 尚未发生，断言得到 1 次而非 2 次。此行为已有 [Issue #63](https://github.com/conanxin/book-id-search/issues/63) 和独立测试修复 [PR #64](https://github.com/conanxin/book-id-search/pull/64)，它未包含在 R10 → R11 分支链内。本轮保留第一次失败，没有通过反复重跑把它改写为通过。

完整 scripts TypeScript 检查仍有 **10 项错误**，均位于未修改的 `ai-quality-cases.ts`、旧 R10 runner、`search-quality-regression.test.ts`、`weread/inspect-weread-raw.test.ts`。完整根测试本轮未重跑；[历史 R10 根测试](https://github.com/conanxin/book-id-search/actions/runs/38038938842) 为 5695 PASS / 15 FAIL / 92 SKIP，另有未处理的 `process.exit` 错误。不能据专项通过宣称全仓测试或完整根构建已通过。

本地使用项目固定的 pnpm 10.33.0。环境禁止 Unix socket，因此测试入口使用 `node --import tsx`，浏览器使用 Playwright 默认 headless shell；这解释了本轮内嵌 PDF 视觉验收的剩余限制。依赖安装未修改 lockfile 或构建脚本许可。测试日志和图片位于忽略目录 `logs/s32-r11/` 与 `test-results/s32-r11/`，不纳入源码。

首次远端 [R11 push CI](https://github.com/conanxin/book-id-search/actions/runs/38042930191) 的契约/构建作业通过，浏览器作业失败：Vite 已正常启动，但彩色输出在 `Local` 与冒号之间包含 ANSI 控制字符，runner 的纯文本匹配误报 `R11_VITE_START_TIMEOUT`。修复在匹配前使用 Node 标准库去除控制字符；仍必须来自本次子进程 stdout，不能仅凭端口有响应就判为成功。CI 明确设置 `FORCE_COLOR=1` 覆盖此差异；首次失败继续保留，后续精确 HEAD 的 CI 结果记入 PR。

## 真实资料与已观察的页序

资料为 Otis Tufton Mason（1900），*Aboriginal American harpoons: A study in ethnic distribution and invention*。

- [Smithsonian 官方条目](https://repository.si.edu/handle/10088/29827)
- [从官方条目取得的 PDF](https://repository.si.edu/bitstreams/bd568953-77d5-45b7-9c40-b6a4678ff750/download)
- 文件：`Mason_1900_189-304.pdf`，**10,699,315 字节**，PDF 共 **154 页**。
- SHA-256：`70dd12a76e637abb0030c797b0bf03e2210bf07ebf6ca92c9ad5d36388505036`

通过下载后的 PDF 渲染页图像进行模型视觉观察，得到以下映射。它不是独立人工核验，也不是馆方提供的可信摘要。

| 原资料可见标签 | PDF 扫描页序（从 1 开始） |
| --- | ---: |
| 印刷页码 208 | 21 |
| PLATE 1 | 22 |
| 印刷页码 209 | 24 |

插入的图版使印刷页码与扫描页序不能用固定偏移推算。图版页另行渲染为 PNG，用于独立的图片预览检查，其 SHA-256 为 `1dbe83ed297c4290ae6f3d5597a386b4df243c1700af7a7133c43d6976448660`。此单张图片与原 PDF 是两个不同文件，图片预览不会生成“这张 PNG 的第 22 页”报告。原 PDF 与派生图片均不提交到仓库。

## GitHub、Notion 与生产基线

本分支继承 `main → #58 → #62 → #67 → #68 → #69`。它没有包含 #66 的 Owner/Run404 修复、#61 的图书详情研究入口、#64 的测试稳定性修复或 #59 的 Google client ID 发布保护。各 Draft 不能被当作一个已集成、已上线的版本。

主线仍为 `42cf1b7b4a10a6edfa53d688012728dded0b3049`，已包含 ResearchRun Gate3。最近正式生产成功回执为 **2026-10-09**，不是部分 Notion 旧摘要中的 9 月 17 日：

- [Gate3 正式验收回执](https://github.com/conanxin/book-id-search/issues/2#issuecomment-6068773792)
- [Google Web 配置修复回执](https://github.com/conanxin/book-id-search/issues/2#issuecomment-6068620059)
- 归档 API 镜像：`sha256:373d508f1d34cec3e27d0fb57130b76286c2d28c60ac6fd3def951367e34d314`
- 归档最终 Web 镜像：`sha256:e72c8e34e445d41cf05b5b3f3e289b31a302e9f382b3d44ef6a31bdcb4d1df6b`
- Web 资源入口：`index-CHVH47qv.js`。

2026-10-10 17:34–17:37（Asia/Shanghai）公网复查：主页和 Research SPA 入口 HTTP 200，health 正常，stats 为 **5,115,734** 条，ISBN `9787538455250` 检索返回 1 项，未登录 session 正常返回未认证；HTML 仍引用上述资源入口。公网结果不等于重新核实了容器镜像或 Owner 登录。10 月 9 日用户截图已验收 Google 登录、私有阅读、项目/问题及正常空 ResearchRun 列表；因没有 Run，生产 Run 详情当时不适用。

本轮 Native clone 位于会话工作区，不能冒充用户 WSL 的实时目录。用户设备远程通道离线，当前环境没有可调用的本机 Hermes，`ssh tencent` 别名也不在当前环境。因此没有取得新的 SSH 镜像身份证据，没有合并或部署。本轮未更改 API、Schema、冻结 SQL、R8/R9 契约或生产入口。

## Hermes 在用户本机的接续任务

1. 读取仓库 `AGENTS.md`、本文件和现有部署说明；检查用户工作区未提交改动。已知项目路径为 `/home/conanxin/codex-projects/book-id-search`，腾讯运维说明为 `/home/conanxin/codex-ops/tencent/AGENTS.md`。先确认它们在本机的实际状态，不覆盖既有工作。
2. 拉取本分支，在独立 worktree 核对 PR 记录的精确 SHA；使用 `corepack pnpm install --frozen-lockfile`。针对实际变更运行必要检查，不重复已经充分验证的历史阶段。
3. 在本机完整浏览器打开 `http://127.0.0.1:5173/locator-pilot.html`，使用上述精确 PDF 核验 iframe 实际可见页面，记录浏览器和截图证据。浏览器/模型视觉通过与真人确认分列；若预览仍空白，先复现再修复这个具体问题。
4. 如需回放自动化：设置 `S32_R11_SOURCE_PDF` 为下载文件的绝对路径，然后执行 `node --import tsx scripts/s32-r11-locator-pilot-browser-acceptance.ts`。该 runner 校验固定样本 SHA，默认合成运行不代替真实 PDF 内嵌视觉检查。独立 PNG 预览可另设 `S32_R11_PLATE_IMAGE`。
5. 通过 `ssh tencent` 做只读现状核对，报告用户/主机、`/opt/book-id-search` 源码与工作区状态、API/Web 镜像及 StartedAt；对照上面的归档证据和公网健康。避免把旧部署日志当成本次 SSH 结果。
6. 后续产品主线优先收敛 #58、#66、#61、#62、#64，发布时纳入 #59 的配置保护。已有 [R6 一次性集成演练](https://github.com/conanxin/book-id-search/actions/runs/37947716249) 通过，不因交接就从头重做；核对上游是否变化后准备具体可审查的集成/发布候选。Locator 仍是独立本地试验。

用户先前暂停的异机备份研究继续保持暂停。不要以这份试用回执代替正式合并/生产发布决定；本轮交付是代码、验证与接续任务。GitHub PR 与 [Notion R11](https://app.notion.com/p/3f534a28189a819ea0abf0c78c6d5541) 使用相同 task_id、tested_commit 和 PR URL。
