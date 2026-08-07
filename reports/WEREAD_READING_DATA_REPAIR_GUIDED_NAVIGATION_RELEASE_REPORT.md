# S27S Release Report — WeRead Guided Reading Data Repair Navigation

> 正式发布版本：`v0.24.0-weread-guided-repair-navigation`
> 状态：**PASS**

---

## STATUS

**PASS**

## RELEASE

- **target_version**: `v0.24.0-weread-guided-repair-navigation`
- **production_source_sha**: `1ab120c4798a403739ab57c729783b76fb1b89af`（生产运行的 Docker 镜像源码 commit）
- **release_metadata_commit**: `a2f7bc982119a4aa27bba3d589d3ca80bf855f8c`（文档 metadata commit，不影响生产运行的 Docker 镜像源码）
- **final_release_commit**: `a2f7bc982119a4aa27bba3d589d3ca80bf855f8c`（**这是 tag 指向的 commit**；本仓库沿用 S27R 单 commit 约定，`final_release_commit = release_metadata_commit`）
- 三者**不得混淆**：发布文档 commit 不影响生产运行的 Docker 镜像源码。
- **product_commits**:
  - `b74ac72` — Reading Data Repair Guided Navigation Model
  - `7268dfc` — Guided Reading Data Repair Navigation
  - `1ab120c` — Guided Repair Navigation Feedback Session

## ARTIFACT_PROVENANCE

- **candidate_image_tag**: `book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af`
- **candidate_image_id**: `sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce`
- **running_image_id**: `sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce`
- **candidate_manifest_sha256**: `743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a`
- **running_manifest_sha256**: `743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a`
- **live_manifest_match**: PASS
- **build_once**: PASS（S27S-R1 仅 1 次 docker build，候选镜像冻结）
- **deploy_same_image**: PASS（S27S-R2 deploy 脚本 `--no-build`，生产运行镜像 ID = 候选镜像 ID）
- **frozen_lockfile**: true（`pnpm-lock.yaml` SHA 前后一致：`fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134`）
- **exact_pnpm**: `10.33.0`

## LIVE_ASSETS

- **live_js**: `/assets/index-6SXb39Bm.js`
- **live_js_sha256**: `68d787c4d20d93231d1d0e6bcf464c037bb537792b12e2c3f643b04ab148ffdc`
- **live_css**: `/assets/index-DYqm4R_E.css`
- **live_css_sha256**: `7eee398f57a3e406e1746df9f97e1c3d141a52184e7e3f14cff18fb6a8f3f69d`

（上述 SHA 完整值取自 S27S-R1 candidate evidence 与 S27S-R2 REPORT.md，未使用 Telegram 截断摘要。）

## NAVIGATION_RESULT

- **navigation_targets**: 8（7 个真实 verified surface + 1 个 `no_surface`）
- **navigation_kinds**: 3（`scroll` / `focus` / `noop`）
- **repair_actions_covered**: 9（全部 S27R 动作；每个动作至少映射 1 个 Intent）
- **deterministic_mapping**: PASS（`(action, target, kind, sourceRepairAction, sourceRecommendationId)` 字典序）
- **automatic**: false
- **modifies_source_data**: false
- **runs_auto_retry**: false
- **executes_repair**: false（不调用任何修复 endpoint，不修改源数据）
- **runtime_whitelist**: PASS（编译期常量；7 surface + `no_surface`）
- **fail_closed_on_missing**: PASS
- **fail_closed_on_ambiguous**: PASS
- **scroll_once**: PASS
- **focus_once**: PASS
- **explicit_click_only**: PASS（无 mount/rerender/effect/timer 触发）

## FEEDBACK_RESULT

- **feedback_statuses**: 4（`navigation_complete` / `surface_unavailable` / `surface_ambiguous` / `request_rejected`）
- **feedback_kinds**: 3（`success` / `warning` / `error`）
- **neutral_chinese_ui_labels**: PASS
- **aria_live**: `polite`
- **feedback_means_navigation_complete**: PASS（`feedback.kind === "success"` **仅代表 NAVIGATION COMPLETE**，**不代表数据已被修复**）
- **no_repair_outcome_in_feedback**: PASS
- **no_evaluation_language**: PASS
- **no_user_evaluation**: PASS

## SESSION_RESULT

- **session_fields**: 5（`attempts` / `successful` / `unavailable` / `ambiguous` / `rejected`）
- **memory_only**: PASS（不写 storage）
- **deterministic_counters**: PASS
- **invariant**: PASS（任何时刻 `attempts ≥ successful + unavailable + ambiguous + rejected`）
- **plan_change_reset**: PASS（S27R plan 重新加载即重置）
- **unmount_reset**: PASS（组件 unmount 即重置）
- **no_persistence**: PASS（不写 localStorage / sessionStorage / IndexedDB / Meilisearch / Markdown / Telemetry）

## HOOK_ORDER_REGRESSION

- **repair_panel_zero_hook**: PASS（`ReadingDataRepairRecommendationsPanel` 0 hooks，S27R 已固化）
- **navigation_feedback_zero_hook**: PASS（`ReadingDataRepairNavigationFeedback` 0 hooks，纯 props）
- **guided_session_one_useState**: PASS（`ReadingDataRepairGuidedSessionController` 1 useState / 0 useEffect）
- **navigation_action_zero_hook**: PASS（`ReadingDataRepairNavigationAction` 0 hooks，纯函数按钮）
- **dashboard_no_new_hooks**: PASS（`ReadingArchiveDashboard` 未新增 hooks）
- **react_error_300**: 0

## SOURCE_PROVENANCE

- **production_source_sha**: `1ab120c4798a403739ab57c729783b76fb1b89af`
- **production_image_tag**: `book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af`
- **production_image_id**: `sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce`
- **frozen_manifest_sha**: `743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a`
- **live_js**: `/assets/index-6SXb39Bm.js`
- **live_js_sha256**: `68d787c4d20d93231d1d0e6bcf464c037bb537792b12e2c3f643b04ab148ffdc`
- **live_css**: `/assets/index-DYqm4R_E.css`
- **live_css_sha256**: `7eee398f57a3e406e1746df9f97e1c3d141a52184e7e3f14cff18fb6a8f3f69d`

## PRE_RELEASE_VALIDATION

- **targeted_tests**: 626 PASS（Guided Navigation Model + Navigation Feedback + Guided Session + Navigation Action + 既有 Repair Recommendations / Audit / Archive suites 的回归覆盖）
- **full_vitest**: 3244 PASS（88 files）
- **tsc**: PASS（`apps/web/tsconfig.json --noEmit` exit 0）
- **vite_build**: PASS
- **local_browser_smokes**:
  - S27S-3: 55/55 PASS
  - S27S-2: PASS（含 navigation / scroll / focus / Notes↔Archive / React #300=0 / 0 POST / 0 external / URL 不变）
- **verify**: docs=5,115,734 / status=PASS

## PRODUCTION_VALIDATION

**tracked suite coverage**（真实数据，非估算）：

- **TRACKED_SUITES**: 20
- **EXECUTED**: 18
- **EXECUTED_PASS**: 18

| 类别 | 数量 | PASS |
|------|------|------|
| DIRECT_PRODUCTION（直接命中 `https://books.conanxin.com/weread`） | 16 | 16/16 PASS |
| PREVIEW_MODE_DUE_TO_SCRIPT_LIMITATION（脚本 `waitForUrl` 硬编码 `http.get`，无法对 https production URL 工作；改用本地 vite preview 验证逻辑） | 2（S27S-2、S27S-3） | 2/2 PASS |
| PREVIEW_ONLY_NOT_RUN_DIRECTLY_ON_PRODUCTION（脚本自身硬编码 spawn Vite preview，无法重定向到 production） | 2（S27Q-3、S27R-3） | n/a（未执行） |

> 说明：本发布验证路径共执行 18 套，全部通过；其中 16 套直接命中生产，2 套（S27S-2、S27S-3）受脚本限制只能以 preview 模式验证。**S27Q-3 与 S27R-3 因脚本硬编码 spawn Vite preview 而未在生产 URL 上执行**。本节**严禁**写为「20/20 production PASS」。

## CRITICAL_SECOND_ROUND

- **RUNNABLE**: 6（S27L / S27L-2 / S27O-3 / S27P-3 / S27S-2 / S27S-3）
- **PASS**: 6/6
- **PREVIEW_ONLY_SKIPPED**: 2（S27Q-3、S27R-3）

| Critical Suite | Exit | Elapsed | Result |
|----------------|------|---------|--------|
| s27l | 0 | 83s | PASS（request state machine，no auto-retry） |
| s27l2 | 0 | 31s | PASS（Notes↔Archive state restoration） |
| s27o3 | 0 | 7s | PASS（Hook-order regression clean） |
| s27p3 | 0 | 11s | PASS（timeline / Markdown / round-trip，env override to production） |
| s27s2 | 0 | 7s | PASS（explicit guided navigation；preview mode due to script limitation） |
| s27s3 | 0 | 11s | PASS（Feedback / Session；preview mode due to script limitation） |

> 说明：本节**严禁**写为「8/8 production critical PASS」。

## REQUEST_SAFETY

| 指标 | 结果 |
|------|------|
| automatic_retry | 0 |
| explicit_retry（s27l） | 1 → 2 |
| Top N cache miss（EXPLICIT_TOP_N_CACHE_MISS） | NA（production smoke 未捕获用户显式 Top N 切换） |
| navigation_request_delta | 0 |
| feedback_request_delta | 0 |
| export_request_delta | 0 |
| post_count | 0 |
| external_request_count | 0 |
| ai_request_count（早期 s27h2/i/i2） | ai=1（legit initial）；后续 s27j2/k/k2/l 中 ai-summary=0 |
| related_books_request_count | 0 |
| url_mutation_from_s27s | 0 |

> 说明：`NA` 表示该指标在 production smoke 中未被测量，**绝不**等同于 0。

## R2_RELEASE_PIPELINE_INCIDENT

- **INCIDENT_CLASS**: `RELEASE_PIPELINE_ENV_PROPAGATION_INCIDENT`
- **PRODUCT_DEFECT**: `false`

### 事件描述

S27S-R2 第一次 `docker compose up -d --no-deps web` 时，`BOOK_ID_SEARCH_WEB_IMAGE` 未正确跨 `sudo` 环境传递（`sudo` 默认 strip shell env），compose 默认引用本地旧 dev image：

- 短暂启动的 unintended image：`sha256:591f7951ae58dbe298220d135bf04f17bbc540f33bdd4ec58f1035faf964073e`

### 检测方式

立即执行 `docker inspect book-id-search-web-1 --format '{{.Image}}'`，发现 running image 与 R1 candidate 不一致。

### 处置

1. `docker compose stop web` + `docker compose rm -f web` 停止并删除错误容器；
2. 改用 `sudo env "BOOK_ID_SEARCH_WEB_IMAGE=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af" docker compose up -d --no-deps web`（`sudo` 需配合 `env` 才能传递 shell env）；
3. 重新部署 R1 frozen candidate；
4. 重新验证三层 artifact identity（Image ID / container manifest / live JS+CSS）。

### R3 closure

- **UNINTENDED_DEV_IMAGE_RUNNING_CONTAINERS**: 0（已用 `docker ps -a --no-trunc` 二次确认）
- 当前线上运行镜像仍为 R1 candidate `sha256:712ad4abc...d79ddf8ce`

### KNOWN_FOLLOW_UP

- deploy image override under `sudo` 需要工程化加固（deploy script 增加 explicit `sudo env` 包装或文档化）。本阶段不修。

## ARTIFACT_IDENTITY

| 层 | 检查 | 结果 |
|----|------|------|
| Build once | R1 docker build 仅 1 次（候选镜像冻结） | PASS |
| Deploy same image | R2 compose up `--no-build`，生产 Image ID = 候选 Image ID | PASS |
| A. Docker identity | candidate Image ID = production Image ID | PASS |
| B. Container static identity | candidate manifest = running-container manifest | PASS |
| C. Public live asset identity | live JS / CSS filename + SHA = frozen candidate | PASS |
| R3 二次复核 | web CID / Image ID / running manifest / live JS+CSS 全部不变 | PASS |

## INFRASTRUCTURE

- **api_untouched**: book-id-search-api-1 uptime 5+ days（startedAt 2026-08-02T23:42:05Z），未重置
- **meilisearch_untouched**: getmeili/meilisearch:v1.48.3 uptime 5+ weeks（startedAt 2026-06-30T13:35:18Z），未重置
- **infrastructure_untouched**: Caddy / DNS / nginx / compose 未修改
- **health**: root `/` 200, `/weread` 200, `/api/stats` 200, Meilisearch `/health` 200
- **docs**: `numberOfDocuments = 5,115,734`（未变）
- **search_quality**: 17 PASS / 0 WARN / 0 FAIL

## PRIVACY

- **recommendation_id_excluded**: PASS
- **issue_id_excluded**: PASS
- **surfaceKey_locator_excluded**: PASS
- **raw_request_result_excluded**: PASS
- **actual_expected_excluded**: PASS
- **title_author_catalogId_excluded**: PASS
- **note_text_comment_excluded**: PASS
- **private_note_ids_excluded**: PASS
- **token_api_key_excluded**: PASS
- **no_evaluation_language**: PASS
- **no_user_evaluation**: PASS

## KNOWN_LIMITATIONS

- 引导式导航仅命中当前 `WereadCenter` 已挂载的 7 个视图区域；不命中其他子页面 / 其他路由 / 其他面板。
- 引导式导航在 plan 加载未完成时点击 NavigationAction 会落入 `surface_unavailable`；这是 fail closed 行为，不是缺陷。
- 引导式导航的会话不跨页面 / 不跨 tab / 不跨 reload 保留。
- 引导式导航不修改 URL；不发起 `/related-books` / MiniMax / 其他后端 endpoint。
- 引导式导航不读取笔记正文 / 笔记评论 / 章节标题 / 划线正文 / AI 概要。
- 引导式导航的 Feedback 只描述本次跳转状态，不描述数据修复结果。
- 引导式导航的 S27S-2 / S27S-3 浏览器本地 smoke 受脚本 `waitForUrl` 仅支持 `http://` 的限制，目前只能在本地 vite preview 中运行；该限制是脚本层限制，不影响产品功能正确性。
- S27Q-3 / S27R-3 是 preview-oriented smoke 脚本（硬编码 spawn Vite preview），本发布验证路径未在生产 URL 上执行。
- 引导式导航目前不支持跨工作区跳转；不支持跨 tab 跳转；不支持跳转到非 `WereadCenter` 子页面。
- `sudo` 默认 strip shell env 是已知发布流程工程债务，本阶段未修复。

## RELEASE_BOUNDARY

- apps/api unchanged
- apps/web/src unchanged
- package/lockfile unchanged
- Docker/compose unchanged
- build/deploy scripts unchanged
- production already deployed before documentation commit（R2 部署于 2026-08-07 23:04 UTC，文档 commit 在 R4 阶段）

## EVIDENCE

仅引用 progress 目录名称，不提交其中内容：

- S27S-R1 candidate evidence: `progress/s27s-r1-candidate-20260807-221856/` + `progress/web-release-candidate-1ab120c4798a403739ab57c729783b76fb1b89af/`
- S27S-R2 deploy evidence: `progress/s27s-r2-deploy-20260807-230109/`（含 `UNINTENDED-dev-image-deployed.txt`）
- S27S-R3 production smoke evidence: `progress/s27s-r3-production-smoke-20260808-071734/`
- S27S-R4 release documentation evidence: `progress/s27s-r4-release-docs-20260808-073746/` + 本目录 + git tag 输出

## NEXT_STEP

S27S RELEASE COMPLETE