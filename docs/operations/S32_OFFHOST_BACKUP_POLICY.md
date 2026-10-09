# S32 P0 — 独立故障域的 PostgreSQL 加密备份与恢复策略（设计稿）

Task: `S32_P0_OFFHOST_BACKUP_POLICY_DESIGN_R1` · 2026-10-09
Canonical tracker: [GitHub Issue #56](https://github.com/conanxin/book-id-search/issues/56).
**Decision status: `DESIGN_PENDING_DESTINATION` · `BACKUP_OFF_HOST=NO` · `PRODUCTION_CHANGED=NO`.**

本文件是可审核的**备份实施决策设计**，不是生产操作手册的执行授权，也不暗示任何服务已经被选为备份目的地。相应 CI 仅使用合成数据和一次性 Docker PostgreSQL 16；不能称作真实用户数据的异机备份验证。

## 1. 已证事实与明确未知（严禁混淆）

| 证据类别 | 当前内容 | 解读 |
|---|---|---|
| VERIFIED_HISTORICAL | PG16 数据库 `book_id_search_s32` 曾完成 custom-format `pg_dump`（当时 78,434 bytes）；SHA256 `7f46bdb2eaecd946233bb6f7b2363bd9bfaab70a0b4a62aeaf5d75389be37213` | 这是 Issue #56 保留的历史回执，**不是最新容量测量或本轮重新访问生产** |
| VERIFIED_HISTORICAL | `pg_restore --list` 当时列出 84 objects；独立 scratch PG16 恢复通过，core 22 tables、projects 2 | 只能证明当时归档具备可恢复性 |
| VERIFIED_HISTORICAL | 唯一已知备份存在于腾讯云**同一台 VM** 的 PG bind volume 之外 | 存储位置仍处于同一个主机/管理故障域；`BACKUP_OFF_HOST=NO` |
| UNKNOWN | 备份现时大小、最近成功时间、数据库增长率、目标存储地区与服务商、网络可达性 | 不能用 78KB 推定真实费用或可用容量 |
| UNKNOWN | 密钥托管主体、备用解密密钥、独立审计权限、批准的恢复时间与数据丢失上限 | 未获得用户独立批准 |

范围仅为 **S32 关系数据库**及其完整恢复所需的 schema/role 文档。Meilisearch 图书索引、NAS 文件、环境私密变量、OAuth 会话、用户云盘属于**其他系统或授权域**，不会被此工作悄悄纳入备份。

## 2. 先选独立目的地（**尚未选定**）

| 方案 | 适用性 | 需要验证的条件 |
|---|---|---|
| **A：独立对象存储账户或独立存储域（优先评估）** | 更容易管理自动保留、加密对象、版本化和独立只读恢复凭据 | 用户选择提供商、数据存储国家/地区、费用限额；确认真正支持对象版本/不可变保留（例如经验证的 S3 Object Lock），上传凭据不具备 DeleteObject、改变 retention 或管理密钥的权限；独立账单/故障域 |
| **B：用户自行确认的异地 Synology NAS** | 若 NAS 与腾讯云不在同一地点、同一存储/电源域，可作为独立副本 | 必须得到用户明确授权；NAS 可用性、加密后接收路径、快照保护、抗勒索/误删、只读恢复账号与连通方式。不得默认 NAS 已连接/可用，**不得为了备份公开 NAS 管理端口** |
| **C：其他存储服务** | 可作为第二副本或短期替代 | 需验证对象保留、版本历史、下载完整性、地区、访问控制及成本，不假设 Google Drive/Dropbox 等自动符合不可变存储要求 |

**结论：选择规则优先独立故障域 + 客户端预先加密 + 可恢复下载 + 删除权限隔离 + 可验证的不可变/版本化。** 不以“空间免费”代替恢复保证。S3 的 Object Lock Governance 管理员在具备 bypass 权限时可绕过；Compliance 不可提前缩短且会增加锁定风险，启用前须另行批准实际保留策略。

## 3. 数据、机密和密钥边界

### 3.1 备份覆盖

- 建议第一版使用 PG16 `pg_dump -Fc` 生成整个授权数据库的单一一致逻辑快照，保留 schema、表数据、索引/约束所需定义、序列等，不只选择某几个业务表。PG16 官方文档规定逻辑 dump 的一致性，但它只涵盖**一个数据库**。
- `pg_dump` **不包含集群全局的角色及 tablespaces**。恢复必须通过经审核的 `deploy/s32-production-roles.sql`、PG16/bootstrap/extension 声明与独立管理的密码/角色恢复计划。是否额外需要加密备份 `pg_dumpall --globals-only` 须单独复核：它可能包含敏感角色凭据摘要，**不能默认上传/公开**。
- 当前不计划 WAL 归档/PITR 或增量备份；如无法满足批准后的 RPO/RTO 或数据库体量，另立 PITR/物理备份升级 Gate，不能称仅靠定期 `pg_dump` 可恢复到任意时刻。
- 原生产角色、授权边界以及 schema 迁移保持冻结。恢复只能去 **全新、独立、一次性 PG16**；没有任何自动将 dump restore 回生产数据库的路径。

### 3.2 保密与加密顺序

严格顺序：`pg_dump -Fc` 的标准输出 → **客户端本地 `age` 公钥接收者加密** → 临时加密对象 → 校验 ciphertext SHA-256 → 上传用户批准的远端 → 校验远端对象版本/下载字节 → 将不含敏感值的回执写入独立日志。

- **生产端只允许持有经过审核的 `age` 公钥（recipient），不持有私钥。** 私钥在单独可信设备生成，由用户选择管理员保存；至少一份与原私钥不同故障域的离线加密恢复副本，解密密码不在 GitHub、Notion、CI、聊天、NAS 日志或腾讯云生产镜像内。
- `age` 接收者加密提供篡改检测；**它不证明是谁上传了备份**，故还要远端对象版本/保留信息、独立读回哈希回执和上传者操作审计。不要把普通 SHA-256 视作独立签名。
- 备份加密必须在网络上传之前完成；若加密命令失败，**禁止**回退为传输明文，禁止不受保护的 `pg_dump` 中间落盘。正式实现需要 `set -euo pipefail`、最小权限、来源版本固定、TLS 校验，并记录进程退出码。
- 公钥轮换：先发布新公钥，仅用于新增快照；保留旧私钥直至对应旧快照全部过期且恢复演练通过；撤销或遗失最后一把旧私钥时必须 STOP 并记录恢复不可达风险，不允许静默销毁备份。
- 上传账号只获新增对象/有限校验能力；恢复账号独立只读；删除/保留期管理由独立授权主体掌握。不能通过同一凭据同时控制原 VM、远端数据及最后的私钥。

## 4. 初拟 SLA 与保留策略（**提案，非已生效设置**）

| 指标 | 候选值 | 重要限制 |
|---|---|---|
| 备份周期 | **每 6 小时 1 次**（候选 UTC 00:00 / 06:00 / 12:00 / 18:00） | 尚未创建 cron/timer。需先确定数据库增长和实际耗时 |
| RPO 目标 | **≤6 小时（设计目标）** | 仅在备份持续成功时近似成立；失败、监测延迟或外部故障都可能使实际 RPO 更大。生产不可宣称已达成 |
| RTO 目标 | **≤4 小时（设计目标）** | 只有完成异机下载→离线解密→全库 scratch restore→业务核对的计时演练后才能确认为达标 |
| 快照保留 | 最近 14 天保留全部每 6 小时快照（约 56）；每周额外保留 8 个；每月额外保留 12 个 | 每个对象的保留期、不可变模式和跨期重叠须经具体服务确认。保留前**不得**自动清理现有同机备份 |
| 首次恢复演练 | 真实远端数据被独立批准后：单独隔离的 PG16；每月一次加密文件读回/解密检验；至少每季度一次完整 scratch 恢复 | 演练时只能使用批准的受控环境；不可把真实用户 SQL 公开上传到 CI Artifact |
| 警告门槛 | 计划时点失败立即通知；距最后一次**已确认远端可恢复**备份超过 8 小时升级告警 | 没有调度/监控连接前，此为待执行政策，而非系统已自动提醒 |

容量/成本估算：设一次加密快照大小为 `B`，基础保留大约 `(56+8+12)×B`，还需加上版本化/WORM 重叠、存储 API 请求、远端读回与出口流量、恢复练习下载、未来增长。历史 **78,434 B** 不代表当前 `B`。必须在用户选定目的地、账号/地区后先做**脱敏容量预算**，超出预算则 STOP 讨论，不主动删存档。

## 5. 完整回执与恢复验收

每次成功记录一条仅包含最少必要元数据的独立回执（不要写 DB URL、对象访问密钥、原始文件名中的私人信息、age 身份文件或 SQL 内容）：

- `task_id` / 作业 ID / 批次 ID / 源镜像或客户端工具版本；
- `source_db_engine=PostgreSQL 16`（可以抽象为数据库标识，不写密码和连接串）；
- 逻辑 dump 开始和结束 UTC、结果、密文 SHA-256/字节数；
- 远端存储的**不可逆/已脱敏对象引用、版本 ID**、retention/lock 检验状态；
- 从远端重新独立读回的 SHA-256 匹配结果；
- 解密鉴别结果、`pg_restore --list`、scratch PG16 完整恢复结果、业务层不变式/权限回归、计时 RTO；
- RPO=自上次成功可恢复快照的 elapsed 时间，失败原因仅用无敏感信息代码。

**验收顺序：** (1) ciphertext bytes 完整（SHA-256）；(2) `age` 正常认证解密，故意篡改或错误私钥必须拒绝；(3) `pg_restore --list` 显示对象；(4) 在完全空的新 PG16 用 `pg_restore --exit-on-error` 恢复；(5) 核对核心 schema、表数量、序列、约束、权限与可用业务查询；(6) 禁止触及生产；(7) 记录实际 RTO 和可用快照时间。数据库恢复会执行 dump 中的 SQL，因此只恢复可信来源的、经审批的备份档案。

**丢失情景要真实证明：** 在**原腾讯云 VM 完全不可用**的前提下，独立账号能获取密文、拥有离线恢复密钥的授权人员能解密并在新服务器恢复；不依赖旧 VM 密码、存储访问 token 或唯一设备，否则不能把备份称为已具备灾难恢复能力。

## 6. 失败处理策略：不覆盖最后一个好副本

- 目的地不可达、证书错误、存储配额不足、对象不可变配置不符、密钥/加密故障、SHA/读回校验失败、恢复失败或超时：**STOP / FAIL / ALERT**；记录不含秘密的错误码，不更新“最后成功异机备份”指针，不能产生 `BACKUP_OFF_HOST=YES` 回执。
- 未被确认的上传对象保持未完成状态，禁止当作最新完整备份；重试必须使用原始批次 ID 以及固定的对象版本校验，禁止误覆盖旧对象。
- 无任何失败允许自动删除唯一好的本地或远端副本，禁止因空间压力静默触发 `prune`/清盘。保留期清理只能在两个可用且独立验证的远端恢复点出现后，经过另一个删除批准 Gate。
- 备份/恢复操作者、存储管理员、密钥保管人尽量分离；若人手有限，应有第二套离线恢复证明和最小权限控制作为补偿。

## 7. 授权 Gate 与 STOP 条件

| Gate | 所需证据 | 当前状态 |
|---|---|---|
| G0 目的地选择 | 用户确认服务/存储区域、资费、隐私边界、版本锁支持；NAS 也须明确选择 | **PENDING — 必须先定** |
| G1 密钥/凭据托管 | 离线私钥的双份恢复方案、公钥生成场所、上传凭据最小权限、轮换策略获批准 | **PENDING** |
| G2 设计/代码审查 | 此策略批准；独立 CI 的合成数据 `pg_dump→age→decrypt→scratch restore` 通过 | DESIGN / SYNTHETIC 之间，**不能视为生产验证** |
| G3 生产只读预检 | 另行授权只读评估 DB、PG16、大小、日志保护、网络与剩余空间、发布身份、角色可恢复性 | **NOT AUTHORIZED** |
| G4 首次生产上传 | 另行批准只对特定对象目的地上传加密内容，实际远端读回校验；不触碰服务和数据库 schema | **NOT AUTHORIZED** |
| G5 灾难恢复证据 | 在独立隔离环境完成真实密文的下载、离线解密、完整恢复、业务/权限/计时验证 | **NOT AUTHORIZED** |
| G6 定时调度与自动保留 | 独立批准 cron/timer、告警与不可变保留；回滚、故障演练和保留策略先验证 | **NOT AUTHORIZED** |

**不可跨越的限制：** Task 1 仅允许文档、与生产隔离的合成测试和审查用 Draft PR，不得执行生产 SSH 写操作、访问真实用户 SQL、向实际 NAS/云桶上传、创建新的定时任务、发布正式镜像、调整 DB、删除已有备份。即使 G2 PASS，只要 G0/G1 仍 PENDING，最终状态始终为 `DESIGN_PENDING_DESTINATION`、`BACKUP_OFF_HOST=NO`。

## 8. 官方依据与后续任务

- [PostgreSQL 16 — pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)：单数据库一致备份、custom archive、globals 边界与恢复安全注意事项。
- [PostgreSQL 16 — Backup and Restore](https://www.postgresql.org/docs/16/backup.html)：逻辑、物理、PITR 三种策略及适用性。
- [age — command reference](https://github.com/FiloSottile/age/blob/main/doc/age.1.ronn)：recipient 加密、identity 解密和篡改防护。
- [AWS S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)：版本与保留模式示例；**不意味着已选择 AWS**，非 AWS 服务须逐项核实。

下一步在方案证据与本地/CI 合成演练到齐后，**请用户只决定目标存储类型/区域和离线密钥托管人**。任何实际上传数据/连接个人 NAS 必须单独授权。

```text
TASK_ID=S32_P0_OFFHOST_BACKUP_POLICY_DESIGN_R1
BACKUP_OFF_HOST=NO
DESIGN_STATUS=DESIGN_PENDING_DESTINATION
PG16_SYNTHETIC_PROOF=SEPARATE_CI
RPO_PROPOSED=6H_NOT_ACTIVE
RTO_PROPOSED=4H_UNVERIFIED
PRIVATE_KEY_ON_PRODUCTION=FORBIDDEN
PRODUCTION_SSH=NOT_USED
PRODUCTION_DATA_READ=NO
EXTERNAL_TRANSFER=NO
MERGE=NO
PRODUCTION_CHANGED=NO
NEXT_GATE=USER_APPROVE_DESTINATION_REGION_AND_KEY_CUSTODY
```
