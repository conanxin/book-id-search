BEGIN;
-- Gate 4 Task 4: disposable PG16 only. Applied after Gate2 and Gate3 fixtures.
-- 24 RUNNING research rounds (25+ total with any later UI writes), intentionally
-- more than the 20-row first page. No persisted production data or release effects.
INSERT INTO core.research_runs
  (id, issue_id, evidence_manifest_id, status, procedure, execution_contract, environment, output, completed_at, started_at)
SELECT
  ('e4000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '21111111-1111-4111-8111-111111111111'::uuid,
  '81111111-1111-4111-8111-111111111112'::uuid,
  CASE WHEN n = 24 THEN 'SUCCEEDED' ELSE 'RUNNING' END,
  jsonb_build_object('version', 1, 'objective', 'Gate4 研究轮次 #' || n, 'method', '只读检索',
    'steps', jsonb_build_array(jsonb_build_object('kind', 'READ', 'description', '阅读来源'))),
  '{"version":1,"mode":"HUMAN","reproducibilityLevel":"AUDIT","tools":[]}'::jsonb,
  '{}'::jsonb,
  CASE WHEN n = 24 THEN
    '{"version":1,"summary":"Gate4 terminal summary","produced":{"claimIds":[],"assessmentIds":[],"resolutionIds":[],"noteRevisionIds":[]},"gaps":[]}'::jsonb
    ELSE NULL END,
  CASE WHEN n = 24 THEN now() ELSE NULL END,
  now() - interval '3 days' + (n * interval '1 minute')
FROM generate_series(1, 24) n;

-- Historical, non-current Resolution records newer than the chosen Current
-- by stored timestamps. Their existence must NEVER override current pointer.
INSERT INTO core.issue_resolutions
  (id, issue_id, resolution_type, preferred_claim_id, rationale, evidence_manifest_id, created_at)
SELECT
  ('d4000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '21111111-1111-4111-8111-111111111111'::uuid,
  'NO_WORKING_CONCLUSION',
  NULL,
  'Gate4 historical Resolution #' || n,
  CASE WHEN n = 24 THEN '81111111-1111-4111-8111-111111111112'::uuid ELSE NULL END,
  now() + n * interval '1 second'
FROM generate_series(1, 24) n;

-- Explicit separate empty Issue in the same authorized Project.
INSERT INTO core.research_issues (id, title, question, lifecycle_state, updated_at)
VALUES ('25111111-1111-4111-8111-111111111111', 'Gate4 Empty Dossier', 'Where are the records?', 'OPEN', now());
INSERT INTO core.project_bindings (id, project_id, target_type, target_id)
VALUES ('c5111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  'RESEARCH_ISSUE',
  '25111111-1111-4111-8111-111111111111');

-- Re-assert the authoritative Current pointer despite newer history.
UPDATE core.research_issues
SET current_resolution_id = 'd1111111-1111-4111-8111-111111111111'
WHERE id = '21111111-1111-4111-8111-111111111111';
COMMIT;
