-- Applied to frozen 001 after the existing M2-D synthetic fixture.
-- Includes a schema-valid historical NULL rationale and an active pointer.
BEGIN;
INSERT INTO core.evidence_manifests (id, purpose, manifest_sha256)
VALUES ('e1111111-1111-4111-8111-111111111111', 'M2E upgrade fixture', repeat('a', 64));
INSERT INTO core.evidence_manifest_items (id, manifest_id, ordinal, role, target_type, target_id)
VALUES ('e2111111-1111-4111-8111-111111111111', 'e1111111-1111-4111-8111-111111111111', 1, 'SUPPORTING', 'SOURCE', '61111111-1111-4111-8111-111111111111');
INSERT INTO core.assessments (id, claim_id, stance, confidence_level, evidence_manifest_id, reasoning)
VALUES ('e3111111-1111-4111-8111-111111111111', '31111111-1111-4111-8111-111111111111', 'SUPPORTS', 'LOW', 'e1111111-1111-4111-8111-111111111111', 'Synthetic pre-upgrade assessment');
INSERT INTO core.issue_resolutions (id, issue_id, resolution_type, preferred_claim_id, rationale, evidence_manifest_id)
VALUES ('e4111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111111', 'PREFERRED_CLAIM', '31111111-1111-4111-8111-111111111111', NULL, 'e1111111-1111-4111-8111-111111111111');
UPDATE core.research_issues SET current_resolution_id='e4111111-1111-4111-8111-111111111111'
WHERE id='21111111-1111-4111-8111-111111111111';
INSERT INTO ops.idempotency_keys (id, scope, idempotency_key, request_hash, status, resource_type, resource_id, result_payload, completed_at)
VALUES ('e5111111-1111-4111-8111-111111111111', 'S32:M2D:UPGRADE_FIXTURE', 'synthetic-assessment', repeat('b', 64), 'COMPLETED', 'ASSESSMENT', 'e3111111-1111-4111-8111-111111111111', '{"assessmentId":"e3111111-1111-4111-8111-111111111111"}', now());
COMMIT;
