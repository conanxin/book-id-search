BEGIN;

INSERT INTO core.projects (id, name, lifecycle_state) VALUES
  ('11111111-1111-4111-8111-111111111111', 'M2E Active Project', 'ACTIVE'),
  ('12111111-1111-4111-8111-111111111111', 'M2E Foreign Project', 'ACTIVE');

INSERT INTO core.works (id, work_type, title, title_status)
VALUES ('41111111-1111-4111-8111-111111111111', 'BOOK', 'M2E Evidence Work', 'KNOWN');

INSERT INTO core.editions (id, work_id, edition_type, publication_date_precision, lifecycle_state)
VALUES ('51111111-1111-4111-8111-111111111111', '41111111-1111-4111-8111-111111111111', 'PRINT', 'YEAR', 'ACTIVE');

INSERT INTO core.sources (id, source_type, edition_id, lifecycle_state, observed_at)
VALUES ('61111111-1111-4111-8111-111111111111', 'DATABASE_RECORD', '51111111-1111-4111-8111-111111111111', 'ACTIVE', '2026-09-29T00:00:00Z');

INSERT INTO core.project_bindings
  (id, project_id, target_type, target_id, binding_role, metadata)
VALUES (
  '81111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  'EDITION',
  '51111111-1111-4111-8111-111111111111',
  NULL,
  '{"sourceId":"61111111-1111-4111-8111-111111111111"}'
);

INSERT INTO core.research_issues (id, title, question, lifecycle_state, updated_at) VALUES
  ('21111111-1111-4111-8111-111111111111', 'M2E Open Issue', 'Which working conclusion fits the evidence?', 'OPEN', '2026-01-01T00:00:00Z'),
  ('22111111-1111-4111-8111-111111111111', 'M2E Foreign Issue', 'Foreign issue?', 'OPEN', '2026-01-01T00:00:00Z');

INSERT INTO core.project_bindings (id, project_id, target_type, target_id) VALUES
  ('c1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'RESEARCH_ISSUE', '21111111-1111-4111-8111-111111111111'),
  ('c2111111-1111-4111-8111-111111111111', '12111111-1111-4111-8111-111111111111', 'RESEARCH_ISSUE', '22111111-1111-4111-8111-111111111111');

INSERT INTO core.claims (id, statement, lifecycle_state) VALUES
  ('31111111-1111-4111-8111-111111111111', 'Primary M2E candidate.', 'ACTIVE'),
  ('32111111-1111-4111-8111-111111111111', 'Foreign M2E candidate.', 'ACTIVE');

INSERT INTO core.research_issue_claims (issue_id, claim_id) VALUES
  ('21111111-1111-4111-8111-111111111111', '31111111-1111-4111-8111-111111111111'),
  ('22111111-1111-4111-8111-111111111111', '32111111-1111-4111-8111-111111111111');

COMMIT;
