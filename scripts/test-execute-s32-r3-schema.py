#!/usr/bin/env python3
import hashlib,json,os,pathlib,subprocess,tempfile,unittest,sys
ROOT=pathlib.Path(__file__).resolve().parent
EXEC=ROOT/'execute-s32-r3-schema.sh'; MAN=ROOT/'s32-release-manifest.py'; SRC='b'*40; CTRL='c'*40

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def base_manifest(migration,role,override):
 return {'version':1,'sourceSha':SRC,'pnpmLockSha256':'1'*64,'apiImageTag':'book-id-search-api:s32-'+SRC,'apiImageId':'sha256:'+'2'*64,'apiOciRevision':SRC,'apiBaseDigest':'node@sha256:'+'3'*64,'webImageTag':'book-id-search-web:'+SRC,'webImageId':'sha256:'+'4'*64,'webOciRevision':SRC,'webStaticManifestSha256':'5'*64,'webS32Enabled':True,'webNodeBaseDigest':'node@sha256:'+'6'*64,'webNginxBaseDigest':'nginx@sha256:'+'7'*64,'pgImageRef':'postgres@sha256:'+'8'*64,'pgImageId':'sha256:'+'9'*64,'migrationPath':'db/migrations/001_s32_core_schema.sql','migrationSha256':sha(migration),'roleBootstrapPath':'deploy/s32-production-roles.sql','roleBootstrapSha256':sha(role),'s32OverridePath':'deploy/s32-production.override.yml','s32OverrideSha256':sha(override)}
def fp(p):
 out=subprocess.check_output([sys.executable,str(MAN),str(p)],text=True); return [x.split('=',1)[1] for x in out.splitlines() if x.startswith('S32_RELEASE_FINGERPRINT=')][0]
class Env:
 def __init__(self):
  self.t=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.t.name); (self.root/'progress').mkdir(); (self.root/'db/migrations').mkdir(parents=True); (self.root/'db/tests').mkdir(parents=True); (self.root/'deploy').mkdir()
  self.mig=self.root/'db/migrations/001_s32_core_schema.sql'; self.mig.write_text('BEGIN; CREATE SCHEMA core; CREATE SCHEMA ops; CREATE SCHEMA derived; COMMIT;\n')
  self.assertions=self.root/'db/tests/001_s32_schema_assertions.sql'; self.assertions.write_text('SELECT 1;\n')
  self.negative=self.root/'db/tests/002_s32_negative_invariants.sql'; self.negative.write_text('INSERT INTO core.x VALUES (1);\n')
  self.role=self.root/'deploy/s32-production-roles.sql'; self.role.write_text('CREATE ROLE :"app_role";\n')
  self.override=self.root/'deploy/s32-production.override.yml'; self.override.write_text('services: {}\n')
  self.man=self.root/'manifest.json'; self.man.write_text(json.dumps(base_manifest(self.mig,self.role,self.override))); self.fp=fp(self.man)
  self.r2=self.root/'progress'/f's32-rollout-{self.fp}-R2.result.env'; self.r2.write_text(f'STATUS=PASS\nR2_POSTGRES=PASS\nS32_RELEASE_FINGERPRINT={self.fp}\nPG_IMAGE_ID=sha256:'+('9'*64)+'\n'); os.chmod(self.r2,0o600)
  self.claim=self.root/'progress'/f's32-rollout-authorization-{self.fp}-R2_R3-claim.env'; self.claim.write_text(f'STAGE_GROUP=R2_R3\nS32_RELEASE_FINGERPRINT={self.fp}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={CTRL}\n'); os.chmod(self.claim,0o600)
  self.pg=self.root/'postgres.env'; self.pg.write_text('S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=ADMIN_SENTINEL\nS32_APP_PASSWORD=APP_SENTINEL\n'); os.chmod(self.pg,0o600)
  self.log=self.root/'r3.log'
 def close(self): self.t.cleanup()
 def env(self,**kw):
  e=os.environ.copy(); e.update(BOOK_ID_SEARCH_REPO_ROOT=str(self.root),S32_R2_RECEIPT=str(self.r2),S32_RELEASE_MANIFEST_JSON=str(self.man),S32_POSTGRES_ENV_FILE=str(self.pg),S32_R3_TEST_MODE='true',S32_R3_COMMAND_LOG=str(self.log)); e.update({k:str(v) for k,v in kw.items()}); return e
 def run(self,args=None,**kw): return subprocess.run(['bash',str(EXEC),*(args or ['--execute-r3',self.fp,SRC,CTRL])],text=True,capture_output=True,env=self.env(**kw))
class T(unittest.TestCase):

 def test_production_path_binds_to_verified_postgres_container(self):
  text=EXEC.read_text()
  self.assertIn('label=com.docker.compose.service=postgres', text)
  self.assertIn('EXPECTED_PG_IMAGE_ID', text)
  self.assertIn('ACTUAL_PG_IMAGE_ID', text)
  self.assertIn('docker exec -i "$PG_CID" psql', text)
  self.assertNotIn('docker compose exec -T postgres psql', text)

 def test_success_runs_migration_assertions_roles_and_empty_check(self):
  x=Env(); self.addCleanup(x.close); r=x.run(); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('R3_SCHEMA=PASS',r.stdout); log=x.log.read_text(); self.assertIn('MIGRATION',log); self.assertIn('SCHEMA_ASSERTIONS',log); self.assertIn('ROLE_BOOTSTRAP',log); self.assertIn('EMPTY_BASELINE',log); self.assertTrue(any(x.root.glob('progress/*R3.result.env')))
 def test_existing_schema_without_matching_partial_receipt_blocks(self):
  x=Env(); self.addCleanup(x.close); r=x.run(S32_R3_FAKE_SCHEMA_PRESENT='true'); self.assertNotEqual(r.returncode,0); self.assertIn('SCHEMA_STATE_UNKNOWN',r.stdout+r.stderr); self.assertFalse(x.log.exists())
 def test_migration_sha_mismatch_blocks_before_psql(self):
  x=Env(); self.addCleanup(x.close); x.mig.write_text('changed'); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('MIGRATION_SHA_MISMATCH',r.stdout+r.stderr); self.assertFalse(x.log.exists())
 def test_assertion_failure_after_commit_is_integrity_incident_no_drop(self):
  x=Env(); self.addCleanup(x.close); r=x.run(S32_R3_FAKE_ASSERTION_EXIT='1'); self.assertNotEqual(r.returncode,0); self.assertIn('SCHEMA_INTEGRITY_INCIDENT',r.stdout+r.stderr); self.assertNotIn('DROP',x.log.read_text().upper())
 def test_production_negative_invariants_are_hard_forbidden(self):
  text=EXEC.read_text() if EXEC.exists() else ''; self.assertIn('002_s32_negative_invariants.sql',text); self.assertNotIn('-f "$NEGATIVE_SQL"',text)
 def test_role_failure_allows_explicit_role_only_recovery_without_migration_rerun(self):
  x=Env(); self.addCleanup(x.close); r=x.run(S32_R3_FAKE_ROLE_EXIT='1'); self.assertNotEqual(r.returncode,0); self.assertIn('ROLE_BOOTSTRAP_FAILED',r.stdout+r.stderr); first=x.log.read_text().count('MIGRATION'); self.assertEqual(first,1)
  r=x.run(['--recover-role-only',x.fp,SRC,CTRL]); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertEqual(x.log.read_text().count('MIGRATION'),1)
 def test_secret_values_never_appear(self):
  x=Env(); self.addCleanup(x.close); r=x.run(); combined=r.stdout+r.stderr+(x.log.read_text() if x.log.exists() else ''); self.assertNotIn('ADMIN_SENTINEL',combined); self.assertNotIn('APP_SENTINEL',combined)
if __name__=='__main__': unittest.main()
