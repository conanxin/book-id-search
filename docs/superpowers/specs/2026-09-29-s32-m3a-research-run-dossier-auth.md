# S32 M3-A — ResearchRun + Research Dossier + Google Identity / Credential Linking

Status: DISCOVERY / DESIGN  
Date: 2026-09-29  
Base: `main@1bd8843136df50ad46f6d07ae48e4100d6ab3989`

## 0. Context

M2-E is terminal PASS and production deployed.

Current production state:
- Tasks 1–12 PASS;
- Task 13A source gate PASS;
- Task 13B live preflight PASS;
- Task 13C production deploy PASS;
- PostgreSQL 16 healthy;
- migration 002 applied;
- private M2-E Current / History / Detail / Composer / same-key replay PASS;
- public search/stats PASS;
- production acceptance Resolution `c248145e-05eb-4176-b54d-e09c3e9d2059` retained as immutable evidence.

M3-A starts the next layer: research activity + synthesis. It must not restart M2-E or silently introduce a second truth model.

## 1. Discovery findings

Three real research cases were pressure-tested:
1. National Museum Buddhist-head provenance (1930–1949);
2. Mœbius 1986 multi-limbed machine artwork identification;
3. Jingzhang route / Liuxiangdian historical geography.

Result:

```text
PRESSURE_TESTS=3_PASS
NEW_TOP_LEVEL_DOMAIN_ENTITY_REQUIRED=NO
RESEARCH_RUN_REQUIRED=YES_EXISTING_MODEL
DOSSIER_CAN_BE_DERIVED_VIEW=YES
SPATIAL_PRESENTATION_GAP=YES_DERIVED_FIRST
```

## 2. Executable-schema reality

The executable 001 schema already contains `core.research_runs`:

```text
id uuid PK
schema_version integer
issue_id uuid NULL
evidence_manifest_id uuid NOT NULL
status RUNNING | SUCCEEDED | FAILED | CANCELLED
procedure jsonb
execution_contract jsonb
environment jsonb
output jsonb NULL
knowledge_cutoff timestamptz NULL
replay_of uuid NULL
started_at timestamptz
completed_at timestamptz NULL
created_at timestamptz
```

Important differences from older architecture notes:
- executable status values are RUNNING / SUCCEEDED / FAILED / CANCELLED;
- there is no first-class `reproducibility_level` column;
- there is no `project_id` on ResearchRun;
- current `project_bindings` CHECK does not include RESEARCH_RUN;
- `contributions` does include RESEARCH_RUN;
- one ResearchRun has at most one direct `issue_id`;
- one immutable EvidenceManifest is required.

For M3-A v0.1, executable schema is authoritative.

## 3. ResearchRun v0.1 contract

### 3.1 Scope

M3-A v0.1 is **Issue-scoped**.

Application contract:
- `issue_id` MUST be non-null for M3-A-created runs even though the DB permits null;
- owning Project is derived from the same existing Project/ResearchIssue authorization path used by M2;
- no multi-Issue ResearchRun in v0.1;
- broader Project-level or multi-Issue runs are deferred until a real use case proves a helper relation is needed.

This avoids a migration for the first implementation.

### 3.2 Required evidence snapshot

Every Run references exactly one existing immutable EvidenceManifest.

Meaning:
- “available knowledge” is not equal to “used evidence”;
- Run evidence is frozen through the manifest;
- later evidence does not silently enter an old Run.

### 3.3 Versioned JSON contracts

`procedure` v1:

```json
{
  "version": 1,
  "objective": "string",
  "method": "string",
  "steps": [
    {
      "kind": "SEARCH|READ|COMPARE|FIELDWORK|MAP_ANALYSIS|IMAGE_ANALYSIS|OTHER",
      "description": "string"
    }
  ]
}
```

`execution_contract` v1:

```json
{
  "version": 1,
  "mode": "HUMAN|HUMAN_AI|AUTOMATED",
  "reproducibilityLevel": "EXACT|PROCEDURE|AUDIT",
  "tools": [
    {
      "name": "string",
      "version": "string|null"
    }
  ]
}
```

The JSON placement of `reproducibilityLevel` is an M3-A compatibility decision, not a claim that a first-class column exists. If it becomes a frequent query/filter dimension, a later additive migration may promote it to a column.

`environment` v1:
- only non-secret execution facts;
- no access tokens, cookies, passwords, database URLs, or private API tokens.

`output` v1:

```json
{
  "version": 1,
  "summary": "string",
  "produced": {
    "claimIds": [],
    "assessmentIds": [],
    "resolutionIds": [],
    "noteRevisionIds": []
  },
  "gaps": [
    {
      "description": "string",
      "status": "OPEN|BLOCKED|DEFERRED"
    }
  ]
}
```

These IDs are references for audit/navigation, not ownership. Canonical objects remain independent.

### 3.4 Lifecycle

Create:
- status = RUNNING;
- started_at set;
- completed_at NULL.

Complete:
- SUCCEEDED;
- output required;
- completed_at set.

Failure:
- FAILED;
- completed_at set;
- output may contain safe failure summary/gaps.

Cancel:
- CANCELLED;
- completed_at set.

Replay:
- create a new Run;
- `replay_of` points to the prior Run;
- prior terminal Run remains unchanged.

Terminal Run semantic fields are treated as immutable.

## 4. Research Dossier v0.1

Dossier is a derived view, not a new canonical table.

Primary route candidate:

`/research/projects/:projectId/issues/:issueId/dossier`

Sections:

1. Question
2. Current Working Conclusion
3. Competing Claims
4. Evidence
5. Assessments
6. Resolution History
7. Research Runs
8. What Changed?
9. Sources / Stable Citations
10. Spatial panel when applicable
11. Export (later phase)

Rules:
- Current Conclusion comes only from the authoritative Issue current-resolution pointer;
- latest ResearchRun does not define the current conclusion;
- “What Changed?” is derived from Resolution history + ResearchRun chronology;
- a spatial Map/Route panel is derived presentation, not a new SpatialHypothesis canonical entity;
- no Dossier table in v0.1;
- persisted Dossier snapshots are deferred until a historical export/citation use case requires them.

## 5. User flow

### 5.1 Issue → Run

Issue Detail:
- Current Working Conclusion
- Candidate Claims / Evidence / Assessments
- button: “开始研究轮次”

Start Research Run:
1. objective;
2. method;
3. choose/finalize EvidenceManifest;
4. execution mode (Human / Human+AI / Automated);
5. start.

Running:
- show Run ID, knowledge cutoff, evidence snapshot, procedure;
- existing M2 commands continue to create Claims/Assessments/Resolutions normally;
- Run output references produced object IDs only when explicitly attached/completed.

Complete:
- summary;
- produced objects;
- open gaps;
- status SUCCEEDED.

### 5.2 Issue → Dossier

Issue page adds “研究档案 / Research Dossier”.

The Dossier assembles current and historical reasoning into one readable artifact without copying canonical truth.

## 6. Google/Gmail login feasibility

### 6.1 Corrected credential inventory

Current BOOK-ID-SEARCH has **two application-owned private bearer tokens** in the browser UX:

| UI / route family | Browser storage | Server secret | Meaning |
|---|---|---|---|
| WeRead Center `/api/private/weread/*` | `book-id-search:weread-private-token` in sessionStorage | `WEREAD_PRIVATE_API_TOKEN` | Protects BOOK-ID-SEARCH private WeRead overlay APIs |
| S32 Research `/api/private/s32/*` | `book-id-search:s32-private-token:v1` in sessionStorage | `S32_PRIVATE_API_TOKEN` | Protects BOOK-ID-SEARCH private research APIs |

These are **not**:
- a Google/Gmail password;
- an upstream WeRead/Tencent login cookie;
- a WeRead account credential;
- a Project ID.

This distinction changes the auth design substantially: Google login can replace both manual browser token prompts for human access without needing to “validate a WeRead account credential”.

### 6.2 Decision

Use **Google Identity Services / OpenID Connect** for human login.

Do not use Gmail API just to authenticate.

Identity scopes:
- `openid`
- `email`
- `profile`

The server verifies the Google ID token and uses Google `sub` as the stable principal identifier. Email is display/bootstrap allowlist metadata, not the canonical account ID.

### 6.3 What Google login can and cannot prove

| Question | Decision |
|---|---|
| Can a Gmail/Google account log into BOOK-ID-SEARCH? | YES |
| Can Google session replace manual WeRead private-token entry? | YES |
| Can Google session replace manual S32 private-token entry? | YES |
| Does Gmail mailbox/API access need to be granted? | NO |
| Can Google directly prove a future upstream Tencent/WeRead session or cookie is valid? | NO |
| If future live WeRead sync exists, can a logged-in user manage that separate connection? | YES, but WeRead validation remains independent |

Google authenticates the human principal. BOOK-ID-SEARCH then decides what that principal may access.

## 7. Recommended auth architecture

### 7.1 Phase A — one Google login, one BOOK-ID-SEARCH session

This is the recommended first implementation for the current single-user personal deployment.

Flow:

1. user clicks “使用 Google 账号登录”;
2. Google returns an ID token;
3. backend verifies signature / issuer / audience / expiry;
4. backend requires the configured owner Google principal;
5. stable identity = Google `sub`;
6. backend creates a BOOK-ID-SEARCH web session;
7. browser receives an `HttpOnly; Secure; SameSite=Lax` (or stricter where compatible) session cookie;
8. both private route families accept the human web session:
   - `/api/private/weread/*`
   - `/api/private/s32/*`
9. the two manual browser token forms disappear from the normal user flow.

Legacy tokens remain:
- `WEREAD_PRIVATE_API_TOKEN` for machine/admin/acceptance compatibility;
- `S32_PRIVATE_API_TOKEN` for machine/admin/acceptance compatibility.

Human Google-session auth and machine bearer-token auth are parallel authentication methods for the same private capabilities, not aliases of each other.

### 7.2 Single-user owner binding

For this personal project, prefer explicit pre-binding over one-time token linking.

Recommended bootstrap configuration:

```text
GOOGLE_CLIENT_ID=...
BOOK_ID_SEARCH_OWNER_GOOGLE_SUB=...
```

Optional display/bootstrap metadata:

```text
BOOK_ID_SEARCH_OWNER_EMAIL=...@gmail.com
```

Rules:
- `sub` is the durable principal key;
- email may be shown and checked during initial setup, but should not become the durable database identity;
- no Gmail read/send scopes.

### 7.3 Session persistence decision

For v0.1, prefer a **server-verifiable signed session cookie** without adding an account/session table, because:
- single user;
- low traffic;
- no multi-device session administration requirement yet;
- minimizes schema delta.

Cookie/session payload should contain only:
- principal `sub`;
- issued-at / expiry;
- auth version;
- optional display email.

It must not contain:
- S32 token;
- WeRead private token;
- WeRead upstream credentials;
- database URL/password.

If later requirements include explicit remote session revocation, device lists, or multiple users, add a server session table then.

### 7.4 Upstream WeRead connection is a separate future concern

The current WeRead Center does **not** ask for an upstream Tencent/WeRead account credential. It asks for BOOK-ID-SEARCH's own private API token.

Therefore Phase A does **not** need:
- `/weread/verify` against Tencent;
- a WeRead credential vault;
- Gmail-to-WeRead account linking.

If a future feature performs live WeRead synchronization, define a separate connection model then:

```text
Google principal
  → BOOK-ID-SEARCH session
  → manage upstream WeRead connection
  → WeRead-specific read-only validation
```

Google login would authorize who may manage that connection; it would not validate the WeRead session itself.

## 8. UI target

### 8.1 Shared logged-out state

```text
私人空间

[ 使用 Google 账号登录 ]

登录后可访问：
✓ 我的研究项目
✓ 私人微信读书数据
```

No private-token textbox in the normal UI.

### 8.2 Logged-in header / account panel

```text
账户
Google                  已登录
研究项目                可访问
微信读书私人数据        可访问

[进入研究项目]
[进入微信读书中心]
[退出登录]
```

### 8.3 Transitional fallback

During rollout only, an operator/debug affordance may retain “使用私有令牌” behind a non-primary advanced path. It is not the normal human UX.

## 9. Minimal server API candidate

```text
POST /api/auth/google
POST /api/auth/logout
GET  /api/auth/session
```

Private domain routes remain unchanged.

Auth middleware becomes dual-mode:

```text
human browser:
  valid BOOK-ID-SEARCH session cookie

OR

machine/admin:
  existing Bearer / X-Private-Token
```

The session must be checked before reaching domain services, preserving the existing privacy-safe route behavior.

Auth/session infrastructure is not a research-domain concept:
- login account != Actor;
- Google identity != authorship;
- authentication event != Contribution;
- private API token != Source identity.

## 10. Relationship to old PR #19 / #20

PR #19 and PR #20 are historical research-v0 prototypes.

Useful ideas to retain:
- explicit source capabilities;
- policy/entitlement separation;
- false-closure protection;
- typed research runtime errors;
- isolated research-runtime experiments.

They predate the now-production S32 M1/M2 canonical model and must not be merged directly into current main.

M3-A should reuse their lessons, not their parallel in-memory truth model.

Recommended state:
- keep draft/unmerged during M3-A design;
- annotate both PRs as prior art superseded by PR #47's canonical design direction;
- close/archive after M3-A spec is accepted.

## 11. Implementation order

### Gate 0 — design review
- freeze this spec;
- no production mutation.

### Gate 1 — Google session auth
- add Google Identity sign-in;
- add server verification + owner binding;
- issue HttpOnly session cookie;
- make both WeRead-private and S32-private route middleware accept the session;
- keep existing token auth for machines/admin;
- remove the two token boxes from normal human UX.

### Gate 2 — ResearchRun backend
- issue-scoped v0.1;
- no migration if executable schema contract is sufficient;
- strict versioned JSON validation;
- terminal immutability;
- Project authorization via existing Issue ownership.

### Gate 3 — ResearchRun UI
- start/run/complete/replay;
- link produced objects.

### Gate 4 — Dossier derived view
- no Dossier table;
- Current / Claims / Evidence / Assessments / History / Runs / What Changed.

### Gate 5 — whole-slice acceptance
- real PostgreSQL 16;
- Google-session auth for both private surfaces;
- legacy bearer compatibility;
- ResearchRun lifecycle;
- Dossier rendering;
- existing M1/M2 regressions.

## 12. Implementation decisions now sufficiently resolved

### Auth
- provider: Google Identity Services / OIDC;
- Gmail API: not required;
- principal key: Google `sub`;
- deployment model: single configured owner;
- human session: signed HttpOnly cookie v0.1;
- manual S32 browser token: remove from normal path;
- manual WeRead browser token: remove from normal path;
- machine/admin token paths: retain.

### ResearchRun
- v0.1 scope: one ResearchIssue;
- `issue_id` required by application for new M3-A runs;
- Project ownership derived through existing authorization;
- one immutable EvidenceManifest per Run;
- no schema migration required for first slice unless implementation review finds an invariant impossible to enforce safely;
- reproducibility level lives in versioned `execution_contract` JSON initially;
- produced canonical IDs live in versioned `output` references initially.

### Dossier
- derived view;
- no canonical Dossier table;
- current conclusion always comes from authoritative IssueResolution pointer.

## 13. Remaining implementation questions

1. Pick concrete cookie signing/encryption library already compatible with the API runtime; avoid a new session framework if not needed.
2. Define CSRF treatment for cookie-authenticated write routes.
3. Define Google client ID / owner-`sub` production env wiring and health checks.
4. Decide token-form transition period (immediate removal vs one-release advanced fallback).
5. Decide whether to implement auth Gate 1 as a separate PR before ResearchRun, recommended YES.
6. Re-read old PR #19/#20 only for transferable tests/ideas; do not merge their in-memory runtime.

## 14. Current checkpoint

```text
TASK_ID=S32_M3A_RESEARCH_RUN_DOSSIER_AUTH_DESIGN_R2
STATUS=DESIGN_ALIGNED_WITH_EXECUTABLE_CODE
M2E_PRODUCTION=PASS
RESEARCHRUN_EXECUTABLE_SCHEMA=EXISTS
RESEARCHRUN_V0_1_SCOPE=ISSUE_SCOPED
DOSSIER=DERIVED_VIEW

GOOGLE_LOGIN_FEASIBLE=YES
GMAIL_API_REQUIRED=NO
GOOGLE_PRINCIPAL=SUB
GOOGLE_SESSION_REPLACES_WEREAD_PRIVATE_BROWSER_TOKEN=YES
GOOGLE_SESSION_REPLACES_S32_PRIVATE_BROWSER_TOKEN=YES
CURRENT_WEREAD_UI_TOKEN_IS_APP_PRIVATE_TOKEN=YES
CURRENT_S32_UI_TOKEN_IS_APP_PRIVATE_TOKEN=YES
UPSTREAM_WEREAD_CREDENTIAL_IN_CURRENT_LOGIN_FLOW=NO
FUTURE_UPSTREAM_WEREAD_VALIDATION_SEPARATE=YES

AUTH_IMPLEMENTATION_RECOMMENDATION=SEPARATE_GATE1_PR
IMPLEMENTATION_STARTED=NO
SCHEMA_CHANGED=NO
PRODUCTION_CHANGED=NO
NEXT_ACTION=REVIEW_PR47_THEN_IMPLEMENT_GOOGLE_SESSION_AUTH_GATE1
```
