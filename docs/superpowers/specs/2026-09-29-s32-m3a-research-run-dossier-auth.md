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

### 6.1 Decision

Use **Google Identity Services / OpenID Connect** for login.

Do not use Gmail API just to authenticate.

Requested identity scopes:
- `openid`
- `email`
- `profile`

Server verifies the Google ID token and uses Google `sub` as the stable principal identifier. Email is display/allowlist metadata, not the canonical user ID.

Official references:
- https://developers.google.com/identity/gsi/web/
- https://developers.google.com/identity/openid-connect/openid-connect

### 6.2 What Google login can and cannot prove

| Question | Decision |
|---|---|
| Can a Gmail/Google account log into BOOK-ID-SEARCH? | YES |
| Can Google login replace manual browser S32 token entry? | YES |
| Can Google itself prove a WeRead credential is valid? | NO |
| Can a logged-in Google user submit a WeRead credential for BOOK-ID-SEARCH to validate separately? | YES |
| Can Google identity be linked to a verified WeRead connection? | YES |
| Is Gmail API mailbox access required? | NO |

Google proves ownership/control of the Google account. It does not attest a Tencent/WeRead session.

## 7. Recommended auth architecture

### 7.1 Phase A — Google login replaces browser S32 token

This is the highest-value first change.

Current browser contract:
- manual S32 credential;
- token stored session-only at `book-id-search:s32-private-token:v1`;
- bearer/private token used for `/api/private/s32/*`.

Target:
1. user signs in with Google;
2. backend verifies Google ID token;
3. backend creates a BOOK-ID-SEARCH web session;
4. browser receives an HttpOnly + Secure + SameSite session cookie;
5. S32 browser routes authorize via the web session;
6. legacy `S32_PRIVATE_API_TOKEN` remains available for machine/admin/acceptance use, not normal human browser login.

For this personal single-user project:
- initially allow only one configured Google account;
- use Google `sub` as the actual principal ID;
- email may be used as bootstrap display/allowlist input, but not as persistent identity.

No Gmail mailbox scope is needed.

### 7.2 Research access binding

Two valid migration options:

A. Pre-bind the owner's Google account:
- best for current single-user deployment;
- first successful Google login immediately grants private research access;
- manual S32 token input disappears from the UI.

B. One-time legacy-token linking:
- Google login first;
- user enters current S32 token once;
- backend validates it;
- backend records “Google principal has research access”;
- token is never needed again in the browser.

For the current personal deployment, **A is preferred**.

### 7.3 WeRead credential linking

Google login is the identity gate, but WeRead must be verified independently.

Flow:

1. authenticated Google session;
2. “连接微信读书”;
3. user supplies the current WeRead credential in the format the existing adapter expects;
4. backend makes a read-only authenticated WeRead validation request;
5. success → mark connection VALID and show non-secret account/status metadata;
6. failure/expiry → mark EXPIRED/INVALID and ask to reconnect.

Important:
- do not infer WeRead validity from Gmail address;
- do not assume Gmail and WeRead account emails are related;
- do not put WeRead credential in a URL;
- do not expose it in browser logs or public static assets.

### 7.4 WeRead credential persistence phases

Phase A (recommended first):
- validate credential;
- retain only for the active server/browser session using the current mechanism where practical;
- improve connection status UI;
- no new long-term credential vault yet.

Phase B:
- if repeated manual re-entry is still painful, add a server-side credential vault keyed by Google `sub`;
- encrypted at rest / secret-file backed;
- never return raw credential to browser;
- explicit reconnect/forget controls.

Phase B is not required for Google login itself.

## 8. UI target

Logged out:

```text
我的研究项目

[ 使用 Google 登录 ]

登录后可访问私人研究项目。
微信读书连接将在登录后单独验证。
```

Logged in:

```text
账户
Google             已登录
私人研究空间       已授权
微信读书           已连接 / 已过期 / 未连接

[进入我的研究项目]
[管理微信读书连接]
```

The current “研究项目访问凭据” textbox should disappear from the normal browser flow once Google-session authorization is active.

## 9. Minimal server API candidate

```text
POST /api/auth/google
POST /api/auth/logout
GET  /api/auth/session

POST /api/private/account/weread/verify
GET  /api/private/account/connections
DELETE /api/private/account/weread
```

S32 domain endpoints remain unchanged.

Auth/session infrastructure must not be modeled as Actor or Contribution:
- login account != research Actor;
- Google identity != authorship;
- WeRead credential != canonical Source identity.

## 10. Relationship to old PR #19 / #20

PR #19 and #20 are historical research-v0 prototypes.

Useful ideas to retain:
- explicit source capabilities;
- policy/entitlement separation;
- false-closure protection;
- typed research runtime errors;
- isolated `/api/research/v0` experiments.

They predate the now-production S32 M1/M2 canonical model and must not be merged directly into current main.

M3-A should reuse their lessons, not their parallel in-memory truth model.

Recommended state:
- keep draft/unmerged during M3-A design;
- annotate as superseded-by/research prior art;
- close or archive after M3-A spec is accepted.

## 11. Implementation order

### Gate 0 — design only
- freeze this spec;
- no production mutation.

### Gate 1 — auth UX / Google session
- add Google login;
- replace manual human S32 token prompt;
- keep machine S32 token path;
- add WeRead validation status.

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
- Current/Claims/Evidence/Assessments/History/Runs/What Changed.

### Gate 5 — whole-slice acceptance
- real PG16;
- Google-session auth;
- credential boundary;
- ResearchRun lifecycle;
- Dossier rendering;
- existing M2 regression.

## 12. Open questions before implementation

1. Exact current WeRead credential format and verification endpoint in BOOK-ID-SEARCH must be re-read from the implementation before writing the validator.
2. Decide Google-login session storage:
   - signed/encrypted cookie only, or
   - server session table.
3. Decide whether WeRead credential is session-only in Phase A or stored server-side immediately.
4. Decide whether M3-A requires a first-class reproducibility-level column now; default recommendation: no migration for v0.1.
5. Decide whether v0.1 Run output JSON references are sufficient for produced objects; default recommendation: yes.
6. Multi-Issue / Project-level ResearchRun is deferred.

## 13. Current checkpoint

```text
TASK_ID=S32_M3A_RESEARCH_RUN_DOSSIER_AUTH_DESIGN_R1
STATUS=DESIGN_READY_FOR_REVIEW
M2E_PRODUCTION=PASS
RESEARCHRUN_EXECUTABLE_SCHEMA=EXISTS
RESEARCHRUN_V0_1_SCOPE=ISSUE_SCOPED
DOSSIER=DERIVED_VIEW
GOOGLE_LOGIN_FEASIBLE=YES
GMAIL_API_REQUIRED=NO
GOOGLE_CAN_VALIDATE_S32_BROWSER_ACCESS=YES_VIA_SESSION_AUTHORIZATION
GOOGLE_CAN_VALIDATE_WEREAD_CREDENTIAL_DIRECTLY=NO
WEREAD_SEPARATE_VERIFICATION_REQUIRED=YES
IMPLEMENTATION_STARTED=NO
SCHEMA_CHANGED=NO
PRODUCTION_CHANGED=NO
NEXT_ACTION=REVIEW_AUTH_SESSION_AND_WEREAD_LINKING_DECISIONS
```
