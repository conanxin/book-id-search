BEGIN;

-- Gate 3 Task 5 browser whole-slice acceptance fixture (disposable PG16 only).
-- ADDITIVE to scripts/fixtures/s32-m3a-gate2-researchrun.sql; run after it.
-- Adds: authorized EvidenceManifest (referenced by an assessment), archived
-- project + archived issue, and a second authorized manifest for replay.

-- Authorized manifests, referenced by NEW append-only assessments on the
-- primary claim of the open issue (Gate2's existing assessment stays untouched).
INSERT INTO core.evidence_manifests (id, purpose, manifest_sha256) VALUES
  ('81111111-1111-4111-8111-111111111112', 'CLAIM_ASSESSMENT', 'cc0caccf3f202d3252d979dc71ac7dd2d3bf42791437b8f1e303e15ff8e4f3db'),
  ('81111111-1111-4111-8111-111111111113', 'CLAIM_ASSESSMENT', '33886e0d195104d384fdabf6a0018fecf33b3163f298f520d109865eb408d176');

INSERT INTO core.evidence_manifest_items
  (id, manifest_id, ordinal, role, target_type, target_id, note)
VALUES
  ('82111111-1111-4111-8111-111111111112', '81111111-1111-4111-8111-111111111112', 1, 'SUPPORTING', 'SOURCE', '61111111-1111-4111-8111-111111111111', 'Gate3 browser primary source'),
  ('82111111-1111-4111-8111-111111111113', '81111111-1111-4111-8111-111111111112', 2, 'CONTEXTUAL', 'NOTE_REVISION', 'a4111111-1111-4111-8111-111111111112', null),
  ('82111111-1111-4111-8111-111111111114', '81111111-1111-4111-8111-111111111113', 1, 'SUPPORTING', 'SOURCE', '61111111-1111-4111-8111-111111111111', 'Gate3 browser second source');

INSERT INTO core.assessments (id, claim_id, stance, confidence_level, reasoning, evidence_manifest_id, metadata)
VALUES
  ('91111111-1111-4111-8111-111111111112', '31111111-1111-4111-8111-111111111111', 'SUPPORTS', 'MEDIUM', 'Gate3 browser first assessment (authorized manifest)', '81111111-1111-4111-8111-111111111112', '{}'::jsonb),
  ('91111111-1111-4111-8111-111111111113', '31111111-1111-4111-8111-111111111111', 'SUPPORTS', 'LOW', 'Gate3 browser second assessment (evidence paging)', '81111111-1111-4111-8111-111111111113', '{}'::jsonb);

-- Archived project + issue (read-only acceptance), still bound for browsing.
INSERT INTO core.projects (id, name, lifecycle_state) VALUES
  ('13111111-1111-4111-8111-111111111111', 'Gate3 Archived Project', 'ARCHIVED');

INSERT INTO core.research_issues (id, title, question, lifecycle_state, updated_at) VALUES
  ('23111111-1111-4111-8111-111111111111', 'Gate3 Archived Issue', 'Read-only?', 'ARCHIVED', '2026-01-02T00:00:00Z'),
  ('24111111-1111-4111-8111-111111111111', 'Gate3 Open Issue in Archived Project', 'Write gate?', 'OPEN', '2026-01-02T00:00:00Z');

INSERT INTO core.project_bindings (id, project_id, target_type, target_id) VALUES
  ('c3111111-1111-4111-8111-111111111111', '13111111-1111-4111-8111-111111111111', 'RESEARCH_ISSUE', '23111111-1111-4111-8111-111111111111'),
  ('c4111111-1111-4111-8111-111111111111', '13111111-1111-4111-8111-111111111111', 'RESEARCH_ISSUE', '24111111-1111-4111-8111-111111111111');

INSERT INTO core.claims (id, statement, lifecycle_state) VALUES
  ('33111111-1111-4111-8111-111111111111', 'Gate3 archived-scope claim.', 'ACTIVE');

INSERT INTO core.research_issue_claims (issue_id, claim_id) VALUES
  ('23111111-1111-4111-8111-111111111111', '33111111-1111-4111-8111-111111111111'),
  ('24111111-1111-4111-8111-111111111111', '33111111-1111-4111-8111-111111111111');

-- A historical RUNNING run inside the archived project so archived history/detail stays visible.
INSERT INTO core.research_runs
  (id, issue_id, evidence_manifest_id, status, procedure, execution_contract, environment)
VALUES (
  'e1111111-1111-4111-8111-111111111111',
  '23111111-1111-4111-8111-111111111111',
  '81111111-1111-4111-8111-111111111112',
  'RUNNING',
  '{"version":1,"objective":"归档范围历史目标","method":"归档范围历史方法","steps":[{"kind":"SEARCH","description":"历史检索"}]}'::jsonb,
  '{"version":1,"mode":"HUMAN","reproducibilityLevel":"EXACT","tools":[]}'::jsonb,
  '{}'::jsonb
);

COMMIT;
