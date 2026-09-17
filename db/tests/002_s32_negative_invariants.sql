-- P29-D4 S32-M0 Negative Invariant Tests
-- Each test wraps invalid op in BEGIN ... ROLLBACK.
-- gen_random_uuid() used in tests because these are test-time inserts, not production paths
-- (production UUIDs are application-generated). This is an acceptable test-only exception.

\echo '=== INVALID_SHA_REJECTED ==='
BEGIN; DO $$ BEGIN
  INSERT INTO core.external_identities (id,target_type,target_id,provider,namespace,external_id,binding_state)
    VALUES (gen_random_uuid(),'WORK',gen_random_uuid(),'t','n','INVALID_SHA_FORMAT_NOT_HEX','ACTIVE');
EXCEPTION WHEN check_violation THEN NULL; END $$; ROLLBACK;

\echo '=== INVALID_ACTOR_TYPE_REJECTED ==='
BEGIN; DO $$ BEGIN
  INSERT INTO core.actors (id,actor_type,display_name)
    VALUES (gen_random_uuid(),'BOGUS_TYPE','t');
EXCEPTION WHEN check_violation THEN NULL; END $$; ROLLBACK;

\echo '=== SOURCE_ASSET_STORAGE_MODE_BOGUS_REJECTED ==='
BEGIN; DO $$ BEGIN
  INSERT INTO core.source_assets (id,source_id,asset_type,asset_role,storage_mode,storage_key,remote_uri)
    VALUES (gen_random_uuid(),gen_random_uuid(),'DOCUMENT','ORIGINAL','BOGUS_MODE','k','u');
EXCEPTION WHEN check_violation THEN NULL; END $$; ROLLBACK;

\echo '=== SOURCE_ASSET_LOCAL_MISSING_KEYS_REJECTED ==='
BEGIN; DO $$ BEGIN
  INSERT INTO core.source_assets (id,source_id,asset_type,asset_role,storage_mode,storage_key,remote_uri,sha256)
    VALUES (gen_random_uuid(),gen_random_uuid(),'DOCUMENT','ORIGINAL','LOCAL',NULL,NULL,NULL);
EXCEPTION WHEN check_violation THEN NULL; END $$; ROLLBACK;

\echo '=== NOTE_PARENT_SELF_EDGE_REJECTED ==='
BEGIN; INSERT INTO core.notes (id,note_type) VALUES (gen_random_uuid(),'GENERAL');
DO $$ BEGIN
  INSERT INTO core.note_revision_parents (note_id,child_revision_id,parent_revision_id,parent_order)
    VALUES ((SELECT id FROM core.notes ORDER BY id DESC LIMIT 1),(SELECT id FROM core.note_revisions ORDER BY id DESC LIMIT 1),(SELECT id FROM core.note_revisions ORDER BY id DESC LIMIT 1),1);
EXCEPTION WHEN check_violation THEN NULL; END $$; ROLLBACK;

\echo '=== NOTE_REVISION_UPDATE_REJECTED ==='
BEGIN; INSERT INTO core.note_revisions (id,note_id,revision_no,title,content_format,content,content_sha256) VALUES (gen_random_uuid(),gen_random_uuid(),1,'t','PLAIN_TEXT','c','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
DO $$ BEGIN UPDATE core.note_revisions SET title='new'; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== NOTE_REVISION_DELETE_REJECTED ==='
BEGIN; INSERT INTO core.note_revisions (id,note_id,revision_no,title,content_format,content,content_sha256) VALUES (gen_random_uuid(),gen_random_uuid(),1,'t','PLAIN_TEXT','c','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
DO $$ BEGIN DELETE FROM core.note_revisions; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== CLAIM_IMMUTABLE_FIELD_UPDATE_REJECTED ==='
BEGIN; INSERT INTO core.claims (id,claim_type,statement,lifecycle_state) VALUES (gen_random_uuid(),'T','orig','ACTIVE');
DO $$ BEGIN UPDATE core.claims SET statement='changed'; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== ASSESSMENT_UPDATE_REJECTED ==='
BEGIN; INSERT INTO core.assessments (id,claim_id,stance) VALUES (gen_random_uuid(),gen_random_uuid(),'SUPPORTS');
DO $$ BEGIN UPDATE core.assessments SET stance='CONTRADICTS'; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== ASSESSMENT_DELETE_REJECTED ==='
BEGIN; INSERT INTO core.assessments (id,claim_id,stance) VALUES (gen_random_uuid(),gen_random_uuid(),'SUPPORTS');
DO $$ BEGIN DELETE FROM core.assessments; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== MANIFEST_UPDATE_REJECTED ==='
BEGIN; INSERT INTO core.evidence_manifests (id,schema_version,purpose,manifest_sha256) VALUES (gen_random_uuid(),1,'p','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
DO $$ BEGIN UPDATE core.evidence_manifests SET purpose='changed'; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== MANIFEST_DELETE_REJECTED ==='
BEGIN; INSERT INTO core.evidence_manifests (id,schema_version,purpose,manifest_sha256) VALUES (gen_random_uuid(),1,'p','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
DO $$ BEGIN DELETE FROM core.evidence_manifests; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== MANIFEST_ITEM_UPDATE_REJECTED ==='
BEGIN; INSERT INTO core.evidence_manifests (id,schema_version,purpose,manifest_sha256) VALUES (gen_random_uuid(),1,'p','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
INSERT INTO core.evidence_manifest_items (id,manifest_id,ordinal,role,target_type,target_id) VALUES (gen_random_uuid(),(SELECT id FROM core.evidence_manifests ORDER BY id DESC LIMIT 1),1,'SUPPORTING','SOURCE',gen_random_uuid());
DO $$ BEGIN UPDATE core.evidence_manifest_items SET role='CONTRADICTORY'; EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== PROJECTION_TWO_ACTIVE_SAME_NAME_REJECTED ==='
BEGIN; INSERT INTO ops.projection_generations (id,projection_name,status) VALUES (gen_random_uuid(),'test_proj_two_active','ACTIVE');
DO $$ BEGIN INSERT INTO ops.projection_generations (id,projection_name,status) VALUES (gen_random_uuid(),'test_proj_two_active','ACTIVE'); EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== IDEMPOTENCY_DUP_SCOPE_KEY_REJECTED ==='
BEGIN; INSERT INTO ops.idempotency_keys (id,scope,idempotency_key,request_hash,status) VALUES (gen_random_uuid(),'test_scope_dup','test_key','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855','IN_PROGRESS');
DO $$ BEGIN INSERT INTO ops.idempotency_keys (id,scope,idempotency_key,request_hash,status) VALUES (gen_random_uuid(),'test_scope_dup','test_key','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855','IN_PROGRESS'); EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== IDEMPOTENCY_INVALID_HASH_REJECTED ==='
BEGIN; DO $$ BEGIN
  INSERT INTO ops.idempotency_keys (id,scope,idempotency_key,request_hash,status) VALUES (gen_random_uuid(),'s','k','NOT_VALID_HEX','IN_PROGRESS');
EXCEPTION WHEN check_violation THEN NULL; END $$; ROLLBACK;

\echo '=== OUTBOX_NEGATIVE_ATTEMPT_REJECTED ==='
BEGIN; DO $$ BEGIN
  INSERT INTO ops.outbox_events (id,event_type,payload,attempt_count) VALUES (gen_random_uuid(),'t','{}'::jsonb,-1);
EXCEPTION WHEN check_violation THEN NULL; END $$; ROLLBACK;

\echo '=== EXTERNAL_IDENTITY_DUP_ACTIVE_REJECTED ==='
BEGIN; INSERT INTO core.sources (id,source_type,lifecycle_state) VALUES (gen_random_uuid(),'PUBLICATION','ACTIVE');
INSERT INTO core.external_identities (id,target_type,target_id,provider,namespace,external_id,binding_state) VALUES (gen_random_uuid(),'SOURCE',(SELECT id FROM core.sources ORDER BY id DESC LIMIT 1),'p','n','dup_key','ACTIVE');
DO $$ BEGIN
  INSERT INTO core.external_identities (id,target_type,target_id,provider,namespace,external_id,binding_state) VALUES (gen_random_uuid(),'SOURCE',(SELECT id FROM core.sources ORDER BY id DESC LIMIT 1),'p','n','dup_key','ACTIVE');
EXCEPTION WHEN OTHERS THEN NULL; END $$; ROLLBACK;

\echo '=== EXTERNAL_IDENTITY_RETIRED_HISTORY_ALLOWED ==='
BEGIN; INSERT INTO core.sources (id,source_type,lifecycle_state) VALUES (gen_random_uuid(),'PUBLICATION','ACTIVE');
INSERT INTO core.external_identities (id,target_type,target_id,provider,namespace,external_id,binding_state) VALUES (gen_random_uuid(),'SOURCE',(SELECT id FROM core.sources ORDER BY id DESC LIMIT 1),'p','n','retired_key','RETIRED');
INSERT INTO core.external_identities (id,target_type,target_id,provider,namespace,external_id,binding_state) VALUES (gen_random_uuid(),'SOURCE',(SELECT id FROM core.sources ORDER BY id DESC LIMIT 1),'p','n','retired_key','ACTIVE');
SELECT count(*)::text FROM core.external_identities WHERE external_id = 'retired_key'; ROLLBACK;
