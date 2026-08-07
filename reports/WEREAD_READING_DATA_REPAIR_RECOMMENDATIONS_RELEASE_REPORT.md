# S27R Release Report — Reading Data Repair Recommendations

> 正式发布版本：`v0.23.1-weread-data-repair-recommendations-markdown`
> 状态：**PASS**
> 报告时间：S27R-3C-1D

---

## STATUS

**PASS**

## RELEASE

- **target_version**: `v0.23.1-weread-data-repair-recommendations-markdown`
- **production_source_sha**: `86b6b7b5d8927b9624cf2fb399d934c828815175`
- **release_metadata_commit**: `aaecef9754ca4f3a6944ff0eac6abf912b8aaf42`（文档 metadata commit，不影响 Docker 镜像源码）
- **final_tag_commit**: `tag_target_commit: documented in Git tag verification`（tag 指向本 commit 之后的下一个 commit）
- **product_commits**:
  - `a0126a5` — Reading Data Repair Recommendation Model
  - `2162083` — Reading Data Repair Recommendations Dashboard
  - `86b6b7b` — Browser-local Reading Data Repair Plan Markdown Export

## ARTIFACT_PROVENANCE

- **candidate_image_tag**: `book-id-search-web:86b6b7b5d8927b9624cf2fb399d934c828815175`
- **candidate_image_id**: `sha256:1ed3021391c1fd353562b033f5ebe7d4e0de27d265095173b36a93fe701a40e3`
- **running_image_id**: `sha256:1ed3021391c1fd353562b033f5ebe7d4e0de27d265095173b36a93fe701a40e3`
- **candidate_manifest_sha256**: `5377e87f60cabd10fd23eda7af21fc3588fe87c6521e24e6ee2280c4d3625a9a`
- **running_manifest_sha256**: `5377e87f60cabd10fd23eda7af21fc3588fe87c6521e24e6ee2280c4d3625a9a`
- **live_manifest_match**: PASS
- **build_once**: PASS（仅 1 次 docker build，候选镜像冻结）
- **deploy_same_image**: PASS（deploy 脚本 `--no-build`，生产运行镜像 ID = 候选镜像 ID）
- **frozen_lockfile**: true（`pnpm-lock.yaml` SHA 前后一致）
- **exact_pnpm**: `10.33.0`

## LIVE_ASSETS

- **live_js**: `/assets/index-BzF2dDpj.js`
- **live_js_sha256**: `579c033657837cde33fc3a8c6dd98a89b61cf09b33b610a3d1b12528545e80c0`
- **live_css**: `/assets/index-DYqm4R_E.css`
- **live_css_sha256**: `7eee398f57a3e406e1746df9f97e1c3d141a52184e7e3f14cff18fb6a8f3f69d`

## MODEL_RESULT

- **issue_codes**: 36（当前 IssueCode 字典）
- **actions**: 9
- **capabilities**: 5
- **priorities**: 4
- **guidance_keys**: 9
- **deterministic_ordering**: PASS（`(priority, action, capability, guidance, sourceIssueCode, positionText)` 字典序）
- **automatic**: false
- **modifies_source_data**: false
- **runs_auto_retry**: false
- **has_execution_button**: false（面板内不存在任何执行修复动作的按钮）

## DASHBOARD_RESULT

- **zero_hook_parent_panel**: PASS（`ReadingDataRepairRecommendationsPanel` 0 hooks）
- **child_export_action_isolated**: PASS（`ReadingDataRepairExportAction` 内部 2 useState + 1 useEffect，父 Panel 通过 React `key` 触发 remount）
- **audit_to_repair_to_evolution_flow**: PASS（审计 → 修复建议 → 时间线）
- **loading_state**: PASS（审计未完成时禁用导出按钮）
- **empty_state**: PASS（无建议时仍可导出空集）
- **responsive**: PASS（桌面 1440 + 移动 360 无横向溢出）
- **no_evaluation_language**: PASS（无「更爱阅读/兴趣/能力/心理/优秀/较差」等措辞）

## MARKDOWN_RESULT

- **structure**: PASS（元数据 / 安全说明 / 建议总览 / 建议明细 / 三档分组列表 / 方法说明）
- **filename**: `weread-reading-data-repair-plan-YYYYMMDD.md`
- **mime**: `text/markdown;charset=utf-8`
- **browser_local_download**: PASS（Blob + `URL.createObjectURL` + `anchor.click` + `URL.revokeObjectURL`）
- **forbidden_patterns_defense**: PASS（序列化前 + 序列化后双重正则防御）
- **privacy_exclusions**: PASS（Recommendation ID / Issue ID / actual / expected / title / author / catalogId / note / private IDs / raw audit / raw plan / token / evaluation language 全部排除）
- **zero_network**: PASS
- **zero_storage**: PASS
- **zero_url_write**: PASS

## UNSUPPORTED_BRANCH

- **current_state**: `MODEL_SUPPORTED_BUT_NOT_REACHABLE_WITH_CURRENT_ISSUE_UNION`
- **reason**: 当前 Archive 不暴露 recurring per-year rank 映射；S27Q 当前 audit 结果中不存在两个 reserved recurring rank IssueCode。
- **display**: `unsupported_with_current_fields` 分支在当前实现下**永远不会**被实际触发；建议模型仍保留入口以便未来 Archive 扩展。
- **documented_in_methodology**: PASS

## SOURCE_VS_RELEASE_COMMIT_DISTINCTION

- **production_source_sha**: `86b6b7b5d8927b9624cf2fb399d934c828815175`（**这是 Docker 镜像内嵌的源码 SHA**）
- **release_metadata_commit**: 见仓库 tag 引用（**这是文档 commit，不影响 Docker 镜像源码**）
- **final_release_commit**: 见仓库 tag 引用（**这是 tag 指向的 commit**）
- 三者**不得混淆**：发布文档 commit 不影响生产运行的 Docker 镜像源码。

## HOOK_ORDER_REGRESSION

- **repair_panel_zero_hook**: PASS（`ReadingDataRepairRecommendationsPanel` 0 hooks）
- **dashboard_no_new_hooks**: PASS（`ReadingArchiveDashboard` 未新增 hooks）
- **round_trip**: PASS（active → inactive → active / tab 切换不重新 fetch）
- **react_error_300**: 0

## REQUEST_SAFETY

- **before_retry**: 1
- **after_retry**: 2
- **retry_delta**: 1
- **idle_stability_wait**: 2
- **automatic_retry**: none
- **value_3_only_after_explicit_top_n_cache_miss**: 部分 suite 的 stability=3 仅来自用户显式切换 Top N 6→12→18 触发的 cache miss
- **export_request_delta**: 0
- **post_count**: 0
- **external_request_count**: 0
- **ai_request_count**: 0
- **related_books_request_count**: 0

## PRIVACY_RESULT

- **recommendation_id_excluded**: PASS（FORBIDDEN_PATTERNS 正则防御）
- **issue_id_excluded**: PASS
- **actual_expected_excluded**: PASS
- **title_author_catalogId_excluded**: PASS
- **note_text_comment_excluded**: PASS
- **private_note_ids_excluded**: PASS
- **raw_audit_excluded**: PASS
- **raw_repair_plan_excluded**: PASS
- **token_api_key_excluded**: PASS
- **no_evaluation_language**: PASS
- **no_user_evaluation**: PASS

## REGRESSION_RESULT

- **targeted_tests**: 202 PASS（Repair Recommendation Model 70 + Repair Markdown 50 + ExportAction 15 + Panel 12 + Dashboard existing + existing Audit 55）
- **full_vitest**: 2823 PASS（80 files，31.36 s）
- **tsc**: PASS（`apps/web/tsconfig.json --noEmit` exit 0）
- **vite_build**: PASS
- **verify**: docs=5,115,734 / status=PASS
- **search_quality**: 17/0/0（PASS / WARN / FAIL）
- **local_browser_smokes**:
  - S27R-3: 45/45 PASS
  - S27Q-3: 43/43 PASS
  - S27L: PASS
- **production_browser_smokes**: 18/18 PASS（覆盖 S27H → S27R-3 全部 18 套 tracked smoke）
- **production_current_core_smokes**: 10/10 PASS（S27L / S27L-2 / S27M / S27M-2 / S27N / S27N-2 / S27O-3 / S27P-3 / S27Q-3 / S27R-3）
- **critical_second_round**: 6/6 PASS（S27L / S27L-2 / S27O-3 / S27P-3 / S27Q-3 / S27R-3 重跑）

## DEPLOY_RESULT

- **web_image**: 候选镜像已部署（`book-id-search-web:86b6b7b...`），生产 live JS=`index-BzF2dDpj.js` / CSS=`index-DYqm4R_E.css`
- **api_untouched**: book-id-search-api-1 uptime 4+ days，未重置
- **meilisearch_untouched**: getmeili/meilisearch:v1.48.3 uptime 5+ weeks，未重置
- **infrastructure_untouched**: Caddy / DNS / nginx / compose 未修改

## LIMITATIONS

- 建议范围仅限当前浏览器已加载档案 + 当前审计结果。
- 失败 / 未加载 / unaccounted 的年份**不会**产出建议。
- 不与源服务器重新对账，不会调用任何后端 endpoint。
- 不自动修复任何 Issue。
- 不读取原始笔记正文 / 评论 / 划线。
- 当前档案不暴露 recurring per-year rank 映射 → `unsupported_with_current_fields` 分支当前不可达。
- Markdown 文件不会自动更新。
- 不支持 PDF，不支持公开分享（不上传到任何第三方服务）。

## EVIDENCE

仅引用 progress 目录名称，不提交其中内容：

- S27R-3C-1A evidence: `progress/web-release-candidate-86b6b7b5d8927b9624cf2fb399d934c828815175/` + `progress/s27r3c1a-candidate-20260807-081908/`
- S27R-3C-1B evidence: `progress/s27r3c1b-deploy-20260807-082759/`
- S27R-3C-1C evidence: `progress/s27r3c1c-smoke-20260807-132726/`
- S27R-3C-1D evidence: 本目录 + git tag 输出

## NEXT_STEP

S27R RELEASE COMPLETE