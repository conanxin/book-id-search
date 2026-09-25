#!/usr/bin/env python3
import hashlib,json,os,pathlib,subprocess,tempfile,unittest,sys
ROOT=pathlib.Path(__file__).resolve().parent
EXEC=ROOT/'execute-s32-r2-postgres.sh'
MAN=ROOT/'s32-release-manifest.py'
SRC='b'*40; CTRL='c'*40

def valid_manifest():
 return {'version':1,'sourceSha':SRC,'pnpmLockSha256':'1'*64,'apiImageTag':'book-id-search-api:s32-'+SRC,'apiImageId':'sha256:'+'2'*64,'apiOciRevision':SRC,'apiBaseDigest':'node@sha256:'+'3'*64,'webImageTag':'book-id-search-web:'+SRC,'webImageId':'sha256:'+'4'*64,'webOciRevision':SRC,'webStaticManifestSha256':'5'*64,'webS32Enabled':True,'webNodeBaseDigest':'node@sha256:'+'6'*64,'webNginxBaseDigest':'nginx@sha256:'+'7'*64,'pgImageRef':'postgres@sha256:'+'8'*64,'pgImageId':'sha256:'+'9'*64,'migrationPath':'db/migrations/001_s32_core_schema.sql','migrationSha256':'a1'*32,'roleBootstrapPath':'deploy/s32-production-roles.sql','roleBootstrapSha256':'b2'*32,'s32OverridePath':'deploy/s32-production.override.yml','s32OverrideSha256':'c3'*32}
def fp(d):
 out=subprocess.check_output([sys.executable,str(MAN),str(d)],text=True); return [x.split('=',1)[1] for x in out.splitlines() if x.startswith('S32_RELEASE_FINGERPRINT=')][0]
class Env:
 def __init__(self, hard=False):
  self.t=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.t.name); (self.root/'progress').mkdir(); (self.root/'deploy').mkdir(); (self.root/'docker-compose.yml').write_text('services: {}\n'); (self.root/'docker-compose.override.yml').write_text('services: {}\n'); (self.root/'deploy'/'s32-production.override.yml').write_text('services: {}\n')
  self.man=self.root/'manifest.json'; self.man.write_text(json.dumps(valid_manifest())); self.fp=fp(self.man)
  self.r0=self.root/'r0.env'; self.r0.write_text('\n'.join(['R0_FINAL=PASS','WEB_CID=w1','WEB_STARTED_AT=wt','WEB_IMAGE=book-id-search-web:old','WEB_IMAGE_ID=wi','WEB_REVISION='+'d'*40,'API_CID=a1','API_STARTED_AT=at','API_IMAGE=book-id-search-api:old','API_IMAGE_ID=ai','API_REVISION='+'e'*40,'MEILISEARCH_CID=m1','MEILISEARCH_STARTED_AT=mt','MEILISEARCH_IMAGE_ID=mi','MEILI_DOCUMENTS=5115734','PUBLIC_HTTP_STATUS=200'])+'\n')
  self.r1=self.root/'r1.env'; self.r1.write_text('CAPACITY_GATE='+('PASS_HARD_ONLY' if hard else 'PASS_PREFERRED')+'\nS32_RELEASE_FINGERPRINT='+self.fp+'\nRELEASE_SOURCE_SHA='+SRC+'\n')
  self.claim=self.root/'progress'/f's32-rollout-authorization-{self.fp}-R2_R3-claim.env'; self.claim.write_text('\n'.join(['STAGE_GROUP=R2_R3','S32_RELEASE_FINGERPRINT='+self.fp,'RELEASE_SOURCE_SHA='+SRC,'CONTROL_PLANE_SHA='+CTRL,'CAPACITY_HARD_ONLY_ACCEPTED='+('true' if hard else 'false')])+'\n'); os.chmod(self.claim,0o600)
  self.pgdata=self.root/'pgdata'; self.secrets=self.root/'postgres.env'; self.secrets.write_text('S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=dummy\n'); os.chmod(self.secrets,0o600)
  self.post=self.root/'post.json'; self.post.write_text(json.dumps({'services':{'web':{'cid':'w1','startedAt':'wt','imageId':'wi'},'api':{'cid':'a1','startedAt':'at','imageId':'ai'},'meilisearch':{'cid':'m1','startedAt':'mt','imageId':'mi'}},'httpStatus':200,'stats':{'numberOfDocuments':5115734,'isIndexing':False}}))
  self.log=self.root/'cmd.log'
 def close(self): self.t.cleanup()
 def env(self):
  e=os.environ.copy(); e.update(BOOK_ID_SEARCH_REPO_ROOT=str(self.root),S32_R0_RECEIPT=str(self.r0),S32_R1_RECEIPT=str(self.r1),S32_RELEASE_MANIFEST_JSON=str(self.man),S32_POSTGRES_ENV_FILE=str(self.secrets),S32_PG_DATA_DIR=str(self.pgdata),S32_R2_TEST_MODE='true',S32_R2_COMMAND_LOG=str(self.log),S32_R2_FAKE_PG_UID=str(os.getuid()),S32_R2_FAKE_PG_GID=str(os.getgid()),S32_R2_POST_FACTS_JSON=str(self.post)); return e
 def run(self): return subprocess.run(['bash',str(EXEC),'--execute-r2',self.fp,SRC,CTRL],text=True,capture_output=True,env=self.env())
class T(unittest.TestCase):

 def test_default_postgres_secret_path_is_release_scoped_runtime_path(self):
  text=EXEC.read_text()
  self.assertIn('/opt/book-id-search-runtime/s32/${FP}/postgres.env', text)
  self.assertNotIn('$ROOT/.s32-postgres.env', text)

 def test_success_targets_postgres_only_and_writes_receipt(self):
  x=Env(); self.addCleanup(x.close); r=x.run(); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('R2_POSTGRES=PASS',r.stdout); cmd=x.log.read_text(); self.assertIn('--no-build --no-deps postgres',cmd); self.assertNotIn(' web',cmd); self.assertTrue(any(x.root.glob('progress/*R2.result.env')))
 def test_nonempty_or_symlink_pgdata_blocks_before_command(self):
  x=Env(); self.addCleanup(x.close); x.pgdata.mkdir(); (x.pgdata/'x').write_text('x'); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('PGDATA_NOT_EMPTY',r.stdout+r.stderr); self.assertFalse(x.log.exists())
  y=Env(); self.addCleanup(y.close); target=y.root/'target'; target.mkdir(); y.pgdata.symlink_to(target); r=y.run(); self.assertNotEqual(r.returncode,0); self.assertIn('PGDATA_SYMLINK',r.stdout+r.stderr)
 def test_hard_only_requires_bound_acceptance(self):
  x=Env(hard=False); self.addCleanup(x.close); x.r1.write_text('CAPACITY_GATE=PASS_HARD_ONLY\nS32_RELEASE_FINGERPRINT='+x.fp+'\nRELEASE_SOURCE_SHA='+SRC+'\n'); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('HARD_ONLY_NOT_ACCEPTED',r.stdout+r.stderr)
  y=Env(hard=True); self.addCleanup(y.close); r=y.run(); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
 def test_capacity_receipt_is_bound_to_exact_release(self):
  x=Env(); self.addCleanup(x.close); x.r1.write_text('CAPACITY_GATE=PASS_PREFERRED\nS32_RELEASE_FINGERPRINT='+'f'*64+'\nRELEASE_SOURCE_SHA='+SRC+'\n'); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('CAPACITY_RELEASE_MISMATCH',r.stdout+r.stderr); self.assertFalse(any(x.root.glob('progress/*R2.start.env')))
  y=Env(); self.addCleanup(y.close); y.r1.write_text('CAPACITY_GATE=PASS_PREFERRED\nS32_RELEASE_FINGERPRINT='+y.fp+'\nRELEASE_SOURCE_SHA='+'f'*40+'\n'); r=y.run(); self.assertNotEqual(r.returncode,0); self.assertIn('CAPACITY_RELEASE_MISMATCH',r.stdout+r.stderr); self.assertFalse(any(y.root.glob('progress/*R2.start.env')))
 def test_meili_document_count_drift_fails_closed(self):
  x=Env(); self.addCleanup(x.close); facts=json.loads(x.post.read_text()); facts['stats']['numberOfDocuments']=5115735; x.post.write_text(json.dumps(facts)); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('MEILI_DOCUMENT_COUNT_DRIFT',r.stdout+r.stderr)
 def test_legacy_identity_drift_fails_closed(self):
  x=Env(); self.addCleanup(x.close); f=json.loads(x.post.read_text()); f['services']['api']['cid']='changed'; x.post.write_text(json.dumps(f)); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('LEGACY_RUNTIME_DRIFT',r.stdout+r.stderr); self.assertTrue(any(x.root.glob('progress/*R2.start.env')))
 def test_incomplete_attempt_never_retries(self):
  x=Env(); self.addCleanup(x.close); start=x.root/'progress'/f's32-rollout-{x.fp}-R2.start.env'; start.write_text('STATUS=STARTED\n'); os.chmod(start,0o600); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('INCOMPLETE_R2',r.stdout+r.stderr); self.assertFalse(x.log.exists())
if __name__=='__main__': unittest.main()
