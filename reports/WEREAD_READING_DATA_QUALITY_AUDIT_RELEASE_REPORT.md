# S27Q Release Report — Reading Data Quality Audit

> 正式发布版本：`v0.22.1-weread-data-quality-audit-markdown`
> 状态：**PASS**
> 报告时间：S27Q-3C-1D

---

## STATUS

**PASS**

## RELEASE

- **target_version**: `v0.22.1-weread-data-quality-audit-markdown`
- **candidate_source_sha**: `4abec8e95d6f409cd8f5711a36fffcd6dcc65fce`
- **release_metadata_commit**: `PENDING`（在 D9 提交后回填）
- **final_tag_commit**: `tag_target_commit: documented in Git tag verification`
- **product_commits**:
  - `7699eaf` — Data Quality Audit Model
  - `6b8807d` — Data Quality Audit Dashboard
  - `4abec8e` — Data Quality Audit Markdown Export

## ARTIFACT_PROVENANCE

- **candidate_image_tag**: `book-id-search-web:4abec8e95d6f409cd8f5711a36fffcd6dcc65fce`
- **candidate_image_id**: `sha256:be41c44f0cba0d00169ad6a0fe53ef743363c1efa794d7e190cee4c3a8772f6f`
- **running_image_id**: `sha256:be41c44f0cba0d00169ad6a0fe53ef743363c1efa794d7e190cee4c3a8772f6f`
- **candidate_manifest_sha256**: `d3432ee74d82d5d5bdc3cbc5856cfbf0aad0cedf429b9267e85c0171600ebf57`
- **live_manifest_match**: PASS
- **build_once**: PASS
- **deploy_same_image**: PASS
- **frozen_lockfile**: true
- **exact_pnpm**: `10.33.0`

## MODEL_RESULT

- **coverage**: PASS（`yearClosureRatio`、`unaccountedYears`、`extraYears`、`failedYears` 校验）
- **year_metrics**: PASS（finite / non-negative / dated ≤ total / matched ≤ total / matchedBooks ≤ matchedRecords / activeMonths 0–12 / streak 一致性 / peakMonth 合法性 / months 12 项齐全 / 月内一致性）
- **top_n**: PASS（catalog 唯一 / rank 唯一且合法 / 公开元数据齐全 / 与 annual total 一致 / 排序一致）
- **yearLinks**: PASS（source/target 合法 / pair 唯一 / ratio ∈ [0,1] / 与 common/union 一致）
- **recurring**: PASS（catalog 唯一 / years 唯一且属于 loaded / latestYear ∈ years / rank 正整数）
- **summary_debug**: PASS（与 cache / debug snapshot 不互相干扰）

## FRONTEND_RESULT

- **neutral pass/warn/fail**: PASS
- **coverage panel**: PASS
- **ratios grid**: PASS
- **issue groups (error/warning/info)**: PASS
- **zero-hook Panel**: PASS（Audit Panel 保持 0 useState/useEffect/useMemo/useReducer）
- **loading/empty/pass states**: PASS（bootstrapLoading 禁用按钮 / 空档案可导出 / pass / warn / fail 均能导出）

## MARKDOWN_RESULT

- **structure**: PASS（元数据 / 隐私说明 / 完整性提示 / 审计总览 / 五项比例 / 年份覆盖 / 三档分组 / 限制 / 方法）
- **filename/MIME**: `weread-reading-data-quality-audit-YYYYMMDD.md` / `text/markdown;charset=utf-8`
- **browser-local download**: PASS（Blob + URL.createObjectURL + anchor.click + URL.revokeObjectURL）
- **privacy exclusions**: PASS（Issue ID / title / author / catalogId / note / 私有 ID / token / raw archive 全部排除）
- **partial/empty states**: PASS（失败年份有 integrity notice；空档案仍可导出）

## NOT_APPLICABLE

- **recurring best-rank recomputation**: 当前 recurring 数据不携带 per-year rank 映射，无法独立重算 `bestRank`。
- **latest-year rank verification**: 同上，`latestYear` 对应的具体 `latestRank` 无法核对。
- 模型**不虚构数据**，这两项在 Markdown 中以 `NOT_APPLICABLE` 出现。

## HOOK_ORDER_REGRESSION

- **Audit Panel zero-hook**: PASS
- **Dashboard no new hooks**: PASS
- **round-trip**: PASS（active → inactive → active / tab 切换不重新 fetch）
- **React error #300**: 0

## REQUEST_SAFETY

- **before_retry**: 1
- **after_retry**: 2
- **retry_delta**: 1
- **idle_stability_wait**: 2
- **automatic_retry**: none
- **value_3_only_after_explicit_top_n_cache_miss**: 部分 suite 的 stability=3 仅来自用户显式切换 Top N 12→18 触发的 cache miss
- **export_request_delta**: 0

## PRIVACY_RESULT

- **private fields excluded**: PASS（title / author / catalogId / note / 私有 ID / token 全部排除）
- **no AI**: PASS（不调用 MiniMax）
- **no storage/URL/upload**: PASS（不写 storage / 不修改 URL / 不上传）
- **no user evaluation language**: PASS（不出现「兴趣 / 能力 / 心理 / 优秀 / 较差 / 用户评分」）

## REGRESSION_RESULT

- **targeted tests**: 385 PASS（Audit 105 + Markdown 65 + Panel 72 + ExportAction 26 + Dashboard 107 + Center 10）
- **full_vitest**: 2516 PASS（76 files）
- **tsc**: PASS（exit 0）
- **build**: PASS（Vite production build 成功）
- **verify**: docs=5,115,734 / status=PASS
- **search_quality**: 17/0/0（PASS / WARN / FAIL）
- **production_smokes**: 9/9 PASS（S27L / S27L-2 / S27M / S27M-2 / S27N / S27N-2 / S27O-3 / S27P-3 / S27Q-3）
- **critical_second_round**: 5/5 PASS（S27L / S27L-2 / S27O-3 / S27P-3 / S27Q-3 second-round）

## DEPLOY_RESULT

- **web image**: 候选镜像已部署（`book-id-search-web:4abec8e...`），生产 live JS=`index-CSIDxlk8.js` / CSS=`index-B_2TNJiW.css`
- **API untouched**: book-id-search-api-1 uptime 3 days，未重置
- **Meilisearch untouched**: getmeili/meilisearch:v1.48.3 uptime 5 weeks，未重置
- **infrastructure untouched**: Caddy / DNS / nginx / compose 未修改

## LIMITATIONS

- 审计范围仅限当前浏览器已加载档案。
- 失败年份的内容不能被审计。
- 不与源服务器重新对账。
- 不自动修复任何 Issue。
- 不审计原始笔记正文。
- recurring per-year rank 不可用 → bestRank / latestRank NOT_APPLICABLE。
- Markdown 文件不会自动更新。
- 不支持 PDF，不支持公开分享。

## NEXT_STEP

S27R — Reading Data Repair Recommendations