BEGIN;

-- ResearchRun Gate 2 Task 5 acceptance fixture (disposable PG16 only).
-- Minimal canonical graph: two projects/issues, edition+source binding,
-- claim/assessment/resolution, project note + revision chain.

INSERT INTO core.projects (id, name, lifecycle_state) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Gate2 Run Project', 'ACTIVE'),
  ('12111111-1111-4111-8111-111111111111', 'Gate2 Foreign Project', 'ACTIVE');

INSERT INTO core.research_issues (id, title, question, lifecycle_state, updated_at) VALUES
  ('21111111-1111-4111-8111-111111111111', 'Gate2 Open Issue', 'Which claim holds?', 'OPEN', '2026-01-01T00:00:00Z'),
  ('22111111-1111-4111-8111-111111111111', 'Gate2 Foreign Issue', 'Foreign?', 'OPEN', '2026-01-01T00:00:00Z');

INSERT INTO core.project_bindings (id, project_id, target_type, target_id) VALUES
  ('c1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'RESEARCH_ISSUE', '21111111-1111-4111-8111-111111111111'),
  ('c2111111-1111-4111-8111-111111111111', '12111111-1111-4111-8111-111111111111', 'RESEARCH_ISSUE', '22111111-1111-4111-8111-111111111111');

INSERT INTO core.works (id, work_type, title, title_status) VALUES
  ('41111111-1111-4111-8111-111111111111', 'BOOK', 'Gate2 Evidence Work', 'KNOWN');

INSERT INTO core.editions (id, work_id, edition_type, publication_date_precision, lifecycle_state) VALUES
  ('51111111-1111-4111-8111-111111111111', '41111111-1111-4111-8111-111111111111', 'PRINT', 'YEAR', 'ACTIVE');

INSERT INTO core.sources (id, source_type, edition_id, lifecycle_state, observed_at) VALUES
  ('61111111-1111-4111-8111-111111111111', 'DATABASE_RECORD', '51111111-1111-4111-8111-111111111111', 'ACTIVE', '2026-09-29T00:00:00Z');

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

INSERT INTO core.claims (id, statement, lifecycle_state) VALUES
  ('31111111-1111-4111-8111-111111111111', 'Gate2 primary claim.', 'ACTIVE'),
  ('32111111-1111-4111-8111-111111111111', 'Gate2 foreign claim.', 'ACTIVE');

INSERT INTO core.research_issue_claims (issue_id, claim_id) VALUES
  ('21111111-1111-4111-8111-111111111111', '31111111-1111-4111-8111-111111111111'),
  ('22111111-1111-4111-8111-111111111111', '32111111-1111-4111-8111-111111111111');

-- Project item note + revision chain for produced-reference acceptance.
INSERT INTO core.notes (id, note_type, lifecycle_state, current_revision_id)
VALUES ('a1111111-1111-4111-8111-111111111111', 'PROJECT_ITEM_NOTE', 'ACTIVE', 'a4111111-1111-4111-8111-111111111112');

INSERT INTO core.note_revisions (id, note_id, revision_no, content_format, content, content_sha256)
VALUES
  ('a4111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 1, 'MARKDOWN', 'historical revision', repeat('a1', 32)),
  ('a4111111-1111-4111-8111-111111111112', 'a1111111-1111-4111-8111-111111111111', 2, 'MARKDOWN', 'current revision', repeat('b2', 32));

INSERT INTO core.project_bindings
  (id, project_id, target_type, target_id, binding_role, metadata)
VALUES (
  'b1111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  'NOTE',
  'a1111111-1111-4111-8111-111111111111',
  'ANNOTATION',
  '{"subjectBindingId":"81111111-1111-4111-8111-111111111111","subjectType":"EDITION","subjectId":"51111111-1111-4111-8111-111111111111"}'
);

-- Assessment on the primary claim and a working conclusion for the issue.
INSERT INTO core.assessments
  (id, claim_id, stance, confidence_level, reasoning, metadata)
VALUES
  ('91111111-1111-4111-8111-111111111111', '31111111-1111-4111-8111-111111111111', 'SUPPORTS', 'HIGH', 'Gate2 assessment', '{}'::jsonb);

INSERT INTO core.issue_resolutions
  (id, issue_id, resolution_type, preferred_claim_id, rationale)
VALUES
  ('d1111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111111', 'PREFERRED_CLAIM', '31111111-1111-4111-8111-111111111111', 'Gate2 working conclusion');

UPDATE core.research_issues SET current_resolution_id='d1111111-1111-4111-8111-111111111111' WHERE id='21111111-1111-4111-8111-111111111111';

COMMIT;
