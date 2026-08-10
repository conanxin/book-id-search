# Web Release Plan and Isolated Orchestrator

STATUS: PASS

## PURPOSE

将：

SOURCE_SHA
→ Readiness Gate
→ Release Plan
→ Actual Deploy Script

绑定为机器身份链。

目标：

eliminate human candidate identity handoff.

In S27T-3A (Release Plan) and S27T-3B (Orchestrator), the only input a human operator
needs to provide is `SOURCE_SHA`. Every other identity field — `IMAGE_TAG`, `IMAGE_ID`,
`MANIFEST_SHA`, `LOCKFILE_SHA` — is read out of `progress/web-release-candidate-${SOURCE_SHA}/`
by the readiness gate, parsed, validated, fingerprinted, and bound into the deploy
script invocation. There is no human re-entry of any candidate identity anywhere
in the chain.

## RELEASE_PLAN

`scripts/plan-web-production-release.sh <SOURCE_SHA>`

输入：

SOURCE_SHA only.

输出 (machine-parseable `KEY=VALUE` lines):

- `SOURCE_SHA`           — the 40-hex commit
- `IMAGE_TAG`            — registry/image:tag from `candidate.json`
- `IMAGE_ID`             — `sha256:...` digest from `candidate.json`
- `MANIFEST_SHA`         — static-manifest TSV digest from `candidate.json`
- `LOCKFILE_SHA`         — `pnpm-lock.yaml` digest from `candidate.json`
- `RELEASE_PLAN_FINGERPRINT` — deterministic SHA-256 over the five identity fields
- `READINESS_GATE`        — `PASS` / `FAIL` (mirrored from gate output)
- `ISOLATED_E2E`          — `PASS` (forced by gate)
- `PRODUCTION_UNCHANGED`  — `PASS` (mirrored from gate)
- `RELEASE_PLAN_READY`    — `true` iff all identity fields validate AND fingerprint matches
- `DEPLOY_EXECUTED`       — `false` (Plan never deploys)
- `CURRENT_HEAD`          — informational only, NOT in fingerprint

Plan 行为保证：

- 不接受任何 `IMAGE_TAG` / `IMAGE_ID` / `MANIFEST` / `LOCKFILE` 的人工输入
- 唯一输入位置是 `positional arg 1`（`SOURCE_SHA`）
- 不调用 `docker compose up` / `docker build` / `docker pull` / `docker push`
- 不调用 `scripts/deploy-web-release-candidate.sh`
- 不修改 production、tracked worktree、tracked `progress/`、reports
- 不 `eval` / `source` / `bash -c` readiness gate 的输出
- Plan 内的 fingerprint 在 orchestrator 内部被 recompute 并 byte-compares（fail-closed）

## FINGERPRINT

固定字段（deterministic SHA-256）：

```
SOURCE_SHA
IMAGE_TAG
IMAGE_ID
MANIFEST_SHA
LOCKFILE_SHA
```

构造方法（与 orchestrator 内 `B11` 段落完全相同）：

```bash
printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=$SOURCE_SHA" \
  "IMAGE_TAG=$IMAGE_TAG" \
  "IMAGE_ID=$IMAGE_ID" \
  "MANIFEST_SHA=$MANIFEST_SHA" \
  "LOCKFILE_SHA=$LOCKFILE_SHA" \
| sha256sum | awk '{print $1}'
```

`CURRENT_HEAD` 是 informational only，**不参与 fingerprint**。这保证：

- 同一 SOURCE_SHA + 同一 candidate evidence → 同一 fingerprint
- 跨 HEAD / branch / dirty-worktree → 同一 fingerprint

## ORCHESTRATOR

`scripts/orchestrate-web-production-release.sh <mode> <SOURCE_SHA>`

当前唯一 mode：

```
isolated-e2e
```

`PRODUCTION_MODE: NOT_IMPLEMENTED`。

明确：这是**设计边界**，不是遗漏。

`case "$ORCHESTRATION_MODE"` 严格只匹配 `isolated-e2e)`。`""` 与 `*` 均 `block UNSUPPORTED_ORCHESTRATION_MODE`。

Orchestrator 行为保证：

- `PRODUCTION_DEPLOY_EXECUTED=false` 无条件 emit（无论 PASS 还是 BLOCK）
- 不 build、不 pull、不 retag、不 delete image
- 真实 `sudo docker compose up` 仅在 `/tmp/.../isolated project` 内
- `IMAGE_TAG` 来自 Plan，永不来自用户或 SOURCE_SHA 字符串重建
- `HANDOFF_IMAGE_TAG=$PLAN_IMAGE_TAG`（line 405 源碼路径，不可篡改）
- `BOOK_ID_SEARCH_WEB_IMAGE=$HANDOFF_IMAGE_TAG`（line 437 源碼路径）
- 不存在 `book-id-search-web:$SOURCE_SHA` 字符串重建模式
- 不 `eval` / `source` / `bash -c` Plan 输出

## FAIL-CLOSED CHAIN

每个 fail-closed path 都有 source-level guard 与 regression test 双重证据：

| Failure | Source-level guard | Regression test |
|---------|--------------------|-----------------|
| Readiness BLOCK | `STATUS=BLOCKED` 由 gate emit | Plan T2 readiness nonzero exit |
| Plan BLOCK | `RELEASE_PLAN_READY=false` 由 Plan emit | Orchestrator T4 plan READY=false |
| Plan fingerprint mismatch | `RELEASE_PLAN_FINGERPRINT_MISMATCH` | Orchestrator T9 fingerprint |
| Plan SOURCE_SHA mismatch | `SOURCE_IDENTITY_MISMATCH` | Orchestrator T8 source mismatch |
| Pre-deploy Image ID mismatch | `PRE_DEPLOY_IMAGE_IDENTITY_CHANGED` | Orchestrator T12 TOCTOU |
| Candidate evidence mismatch | `PRE_DEPLOY_CANDIDATE_EVIDENCE_CHANGED` | Orchestrator T13 evidence |
| Production compose up by orchestrator | 无 code path（mode=production 阻塞） | Orchestrator T1/T17 mode rejected |
| Plan not ready | `RELEASE_PLAN_NOT_READY` | Orchestrator T4 |

每条路径均 `deploy invocation count = 0`（verified via R3-7 hard gate test）。

## TOCTOU

Plan Image ID / pre-deploy image inspect / isolated container Image / post-deploy image inspect — 四者必须完全相同。

历史 frozen candidate（S27S frozen candidate, SOURCE_SHA=1ab120c4798a403739ab57c729783b76fb1b89af）：

```
sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
```

该 Image ID 是 S27T-3B-R3 / S27T-3C 全部 E2E 验证的目标值。

四向 identity 链路：

1. Plan IMAGE_ID（emit by Plan, line 198）
2. pre-deploy `sudo docker image inspect ${PLAN_IMAGE_TAG} --format '{{.Id}}'`（orchestrator line ~389, blocks on mismatch）
3. isolated container `.Image` field after `sudo docker compose up`（orchestrator line ~419, blocks on mismatch）
4. post-deploy `sudo docker image inspect ${PLAN_IMAGE_TAG} --format '{{.Id}}'`（orchestrator line ~445, blocks on mismatch）

任何一步 mismatch → orchestrator `block` with enum reason。成功路径所有四步 `= sha256:712ad4abc...`。

## HANDOFF

`HANDOFF_IDENTITY_SOURCE: RELEASE_PLAN`

IMAGE_TAG / IMAGE_ID 来自 Plan，不从 SOURCE_SHA 字符串重建。即使 IMAGE_ID  与 SOURCE_SHA 字符串巧合相同，源碼路径仍：

```
PLAN_IMAGE_TAG   ── emits in Plan output key IMAGE_TAG
HANDOFF_IMAGE_TAG = $PLAN_IMAGE_TAG              (orchestrator line 405)
BOOK_ID_SEARCH_WEB_IMAGE = $HANDOFF_IMAGE_TAG    (orchestrator line 437)
```

无 `book-id-search-web:${SOURCE_SHA}` 重建模式。

L1 test 14 显式验证：使用 `FAKE_PLAN_IMAGE_TAG=registry.example.test/team/web:sha-plan-not-from-source`（与 SOURCE_SHA 完全不同），deploy log 必须包含 `BOOK_ID_SEARCH_WEB_IMAGE=registry.example.test/team/web:sha-plan-not-from-source`，且 deploy log 不能包含 `book-id-search-web:${CANON_SHA}`。PASS。

## ACTUAL DEPLOY

actual deploy script 行为：

- exact-byte copy from repo into `/tmp/.../isolated project`（`DEPLOY_SCRIPT_BYTES_BEFORE == DEPLOY_SCRIPT_BYTES_AFTER` source guard, line ~360）
- real `sudo -n` invocations
- real `docker compose up --no-build --no-deps`
- isolated compose project：`name: s27t3b-<sha8>-<H%M%S>-<pid>`（与 production `book-id-search` 互不重叠）
- isolated service：`web only`（`SVC_COUNT=1`）
- isolated port：`127.0.0.1:<free loopback>`（不暴露外网）
- pull_policy: `never`（无 pull）
- no production network / no production volume
- dev fallback `false`（`DEV_FALLBACK_USED=false`）

HTTP smoke：`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${FREE_PORT}/` 必须 `200`；否则 `block HTTP_SMOKE_FAILED`。S27T-3B-R3 / S27T-3C 实测 `/` 与 `/weread` 均 `200`。

## PORTABILITY

Fresh-checkout (`git clone` + no historical `progress/`) 上：

| Test | Result |
|------|--------|
| `scripts/test-deploy-web-release-candidate.sh` | 16/16 PASS |
| `scripts/test-verify-web-release-readiness.sh` | 12/12 PASS |
| `scripts/test-plan-web-production-release.sh` | 29/29 PASS |
| `scripts/test-orchestrate-web-production-release.sh` | 23/23 PASS |

无 `progress/web-release-candidate-.../` historical fixture dependency。所有 test self-bootstrap fakes in `$RUN_TMP`。

## TEST RESULT

S27T-3C 真实回归（2026-08-10 上午，C22 TSC 0 errors）：

| Suite | Result |
|-------|--------|
| Deploy regression run 1 (`scripts/test-deploy-web-release-candidate.sh`) | 16/16 PASS（RUN_TMP=/tmp/s27t-Am9vsk） |
| Deploy regression run 2（independent） | 16/16 PASS（RUN_TMP=/tmp/s27t-A3mF2p，独立路径） |
| Readiness regression | 12/12 PASS |
| Plan regression | 29/29 PASS |
| Orchestrator Level-1 | 23/23 PASS（含 TOCTOU 负向 Test 12 + production-mode rejection Test 1/17） |
| Full Vitest (`npx vitest run`) | 88 files / 3244 tests / 38.69s / 全 PASS |
| TSC (`tsc -p apps/web/tsconfig.json --noEmit`) | PASS（0 errors） |
| Verify (`scripts/verify.ts`) | `status=PASS`，`numberOfDocuments=5115734` |
| Search Quality (`scripts/search-quality-regression.ts`) | 17 PASS / 0 WARN / 0 FAIL |
| Real Plan (`scripts/plan-web-production-release.sh 1ab120c4798a403739ab57c729783b76fb1b89af`) | `STATUS=PASS`，`RELEASE_PLAN_FINGERPRINT=2870efcd213a711ec2d8ab467ac2dfe2fb034020f2f309737e2ed1250a1fd292` |
| Real Orchestrator (`scripts/orchestrate-web-production-release.sh isolated-e2e 1ab120c4798a403739ab57c729783b76fb1b89af`) | `STATUS=PASS`，`ORCHESTRATOR_ISOLATED_E2E_VERIFIED=true` |
| Historical frozen candidate Plan + Orchestrator | PASS（同一 fingerprint 跨 HEAD） |
| Clean-checkout portability | PASS（无 historical fixture dependency） |

## PRODUCTION BOUNDARY

| Service | Before (C2) | After (C25) |
|---------|-------------|-------------|
| Web CID | `f5901063b956…` | identical ✅ |
| Web StartedAt | `2026-08-07T23:04:36Z` | identical ✅ |
| Web Image ID | `sha256:712ad4abc…` | identical ✅ |
| Web Config.Image | `book-id-search-web:1ab120c4…` | identical ✅ |
| API CID | `c408d8a0a44a…` | identical ✅ |
| API StartedAt | `2026-08-02T23:42:05Z` | identical ✅ |
| Meilisearch CID | `ef247a985c28…` | identical ✅ |
| Meilisearch StartedAt | `2026-06-30T13:35:18Z` | identical ✅ |

- production deploy: NO (`PRODUCTION_DEPLOY_EXECUTED=false`)
- production build: NO
- production retag / pull / delete: NO
- production compose up by orchestrator: NO (mode=production 拒绝)
- real `sudo docker compose` 仅用于 orchestrator 自身 `/tmp/.../isolated project`

## CURRENT LIMITATION

当前 orchestrator 只支持：

```
isolated-e2e
```

不支持 `production` mode。

未来如实现 production mode，必须作为独立阶段设计并验证，不得通过隐藏 flag 开启。