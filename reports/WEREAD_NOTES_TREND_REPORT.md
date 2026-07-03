# WeRead Notes Trend 报告

STATUS: WARN

## SCOPE

- WeRead notes trend dashboard
- counts-only
- no note/highlight text
- no public search behavior change
- no Meilisearch write

## API_RESULT

- `GET /api/private/weread/trends`
- unauthorized: 401 + `{"ok":false,"error":"Missing token."}`
- windows: 7/30/90/allTime
- confirmedOnly stats: 281
- coverage stats: notesWithDate=6989, notesWithoutDate=0, ratio=1.0
- response redacted: ✅ no wereadBookId / noteId / highlightId / chapterTitle / comment / text / title / author / token

## FRONTEND_RESULT

- WeRead Center trend section: ✅ implemented
- trend cards: ✅ 最近 7/30/90 天新增、活跃天数、活跃书籍、已匹配书目笔记记录
- activity level pill: ✅ 静默期/正常/活跃/非常活跃
- type distribution: ✅ 划线 / 想法 / 书评 / 未知
- date coverage label: ✅ 百分比
- 30-day daily bars: ✅ TrendBars CSS-only
- browser smoke: ⚠️ 工具超时，未完成；API live 验证 + build + 472 测试 PASS 作为支撑

## DATA_RESULT

| 指标 | 数值 |
|---|---|
| notesCount | 6989 |
| notesWithDate | 6989 |
| notesWithoutDate | 0 |
| days7 total | 6 |
| days30 total | 12 |
| days90 total | 60 |
| allTime total | 6989 |
| confirmedOnly total | 281 |

## PRIVACY_RESULT

| 项 | 状态 |
|---|---|
| no token in build | ✅ |
| no note/highlight text | ✅ |
| no private IDs | ✅ |
| no private data committed | ✅ |
| unauthorized response 无敏感信息 | ✅ |

## REGRESSION_RESULT

| 检查 | 结果 |
|---|---|
| vitest | ✅ 472 PASS |
| api tsc | ✅ PASS |
| web tsc | ✅ PASS |
| weread:validate | ✅ STATUS=PASS |
| verify | ✅ STATUS=PASS |
| search:quality | ✅ 17 PASS / 0 WARN / 0 FAIL |
| web build | ✅ PASS |
| docs count | 5,115,734（未变） |

## DEPLOY_RESULT

| 项 | 状态 |
|---|---|
| api rebuilt | ✅ yes |
| web rebuilt | ✅ yes |
| Meilisearch untouched | ✅ |
| Caddy untouched | ✅ |

## LIMITATIONS

- date quality depends on WeRead export fields
- no note text by design
- only trends/counts

## NEXT_STEP

- 完成浏览器手动 smoke 后再打 tag `v0.9.1-weread-notes-trend`
- 进入 S27C WeRead Match Center