#!/usr/bin/env python3
import json,os,pathlib,subprocess,tempfile,unittest,sys
ROOT=pathlib.Path(__file__).resolve().parent; EXEC=ROOT/'execute-s32-r6-web.sh'; MAN=ROOT/'s32-release-manifest.py'; SRC='b'*40; CTRL='c'*40

def manifest(): return {'version':1,'sourceSha':SRC,'pnpmLockSha256':'1'*64,'apiImageTag':'book-id-search-api:s32-'+SRC,'apiImageId':'sha256:'+'2'*64,'apiOciRevision':SRC,'apiBaseDigest':'node@sha256:'+'3'*64,'webImageTag':'book-id-search-web:'+SRC,'webImageId':'sha256:'+'4'*64,'webOciRevision':SRC,'webStaticManifestSha256':'5'*64,'webS32Enabled':True,'webNodeBaseDigest':'node@sha256:'+'6'*64,'webNginxBaseDigest':'nginx@sha256:'+'7'*64,'pgImageRef':'postgres@sha256:'+'8'*64,'pgImageId':'sha256:'+'9'*64,'migrationPath':'db/migrations/001_s32_core_schema.sql','migrationSha256':'a1'*32,'roleBootstrapPath':'deploy/s32-production-roles.sql','roleBootstrapSha256':'b2'*32,'s32OverridePath':'deploy/s32-production.override.yml','s32OverrideSha256':'c3'*32}
def fp(p):
 out=subprocess.check_output([sys.executable,str(MAN),str(p)],text=True); return [x.split('=',1)[1] for x in out.splitlines() if x.startswith('S32_RELEASE_FINGERPRINT=')][0]
class Env:
 def __init__(self):
  self.t=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.t.name); (self.root/'progress').mkdir(); (self.root/'static').mkdir(); (self.root/'docker-compose.yml').write_text('services: {}\n')
  self.man=self.root/'manifest.json'; self.man.write_text(json.dumps(manifest())); self.fp=fp(self.man)
  self.r0=self.root/'r0.env'; self.r0.write_text('MEILI_DOCUMENTS=5115734\n')
  self.r5=self.root/'progress'/f's32-rollout-{self.fp}-R5.result.env'; self.r5.write_text(f'R5_S32_ACTIVATION=PASS\nS32_RELEASE_FINGERPRINT={self.fp}\nAPI_IMAGE_ID=sha256:'+('2'*64)+'\n'); os.chmod(self.r5,0o600)
  self.cap=self.root/'r6-cap.env'; self.cap.write_text(f'CAPACITY_GATE=PASS_PREFERRED\nS32_RELEASE_FINGERPRINT={self.fp}\nRELEASE_SOURCE_SHA={SRC}\n')
  self.claim=self.root/'progress'/f's32-rollout-authorization-{self.fp}-R6-claim.env'; self.claim.write_text(f'STAGE_GROUP=R6\nS32_RELEASE_FINGERPRINT={self.fp}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={CTRL}\nCAPACITY_HARD_ONLY_ACCEPTED=false\n'); os.chmod(self.claim,0o600)
  self.api=self.root/'api.env'; self.api.write_text('S32_PRIVATE_API_TOKEN=TOKEN_SENTINEL\n'); os.chmod(self.api,0o600)
  self.candidate=self.root/'candidate.json'; self.candidate.write_text(json.dumps({'tag':'book-id-search-web:'+SRC,'imageId':'sha256:'+'4'*64,'gitSha':SRC,'ociRevision':SRC,'webS32Enabled':True,'staticManifestSha256':'5'*64}))
  self.pre=self.root/'pre.json'; self.pre.write_text(json.dumps({'services':{'web':{'cid':'oldw','startedAt':'oldt','imageId':'oldwi','revision':'d'*40},'api':{'cid':'api','startedAt':'at','imageId':'sha256:'+'2'*64,'revision':SRC},'meilisearch':{'cid':'m','startedAt':'mt','imageId':'mi'},'postgres':{'cid':'p','startedAt':'pt','imageId':'sha256:'+'9'*64}},'httpStatus':200}))
  self.post=self.root/'post.json'; self.post.write_text(json.dumps({'services':{'web':{'cid':'neww','startedAt':'newt','imageId':'sha256:'+'4'*64,'revision':SRC},'api':{'cid':'api','startedAt':'at','imageId':'sha256:'+'2'*64,'revision':SRC},'meilisearch':{'cid':'m','startedAt':'mt','imageId':'mi'},'postgres':{'cid':'p','startedAt':'pt','imageId':'sha256:'+'9'*64}},'httpStatus':200,'stats':{'numberOfDocuments':5115734,'isIndexing':False},'searches':{k:{'status':'PASS'} for k in ['ISBN','SSID','DXID','title','author','publisher']}}))
  (self.root/'static/index.js').write_text('safe bundle'); self.log=self.root/'cmd.log'
 def close(self): self.t.cleanup()
 def env(self):
  e=os.environ.copy(); e.update(BOOK_ID_SEARCH_REPO_ROOT=str(self.root),S32_R0_RECEIPT=str(self.r0),S32_R5_RECEIPT=str(self.r5),S32_R6_CAPACITY_RECEIPT=str(self.cap),S32_RELEASE_MANIFEST_JSON=str(self.man),S32_R6_CANDIDATE_JSON=str(self.candidate),S32_API_ENV_FILE=str(self.api),S32_R6_STATIC_DIR=str(self.root/'static'),S32_R6_TEST_MODE='true',S32_R6_PRE_FACTS_JSON=str(self.pre),S32_R6_POST_FACTS_JSON=str(self.post),S32_R6_COMMAND_LOG=str(self.log)); return e
 def run(self): return subprocess.run(['bash',str(EXEC),'--execute-r6',self.fp,SRC,CTRL],text=True,capture_output=True,env=self.env())
class T(unittest.TestCase):
 def test_success_switches_web_only_and_records_parity(self):
  x=Env(); self.addCleanup(x.close); r=x.run(); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('R6_WEB=PASS',r.stdout); self.assertIn('--no-build --no-deps web',x.log.read_text()); self.assertTrue(any(x.root.glob('progress/*R6.result.env')))
 def test_api_must_already_match_release_source(self):
  x=Env(); self.addCleanup(x.close); f=json.loads(x.pre.read_text()); f['services']['api']['revision']='f'*40; x.pre.write_text(json.dumps(f)); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('API_RELEASE_PARITY_REQUIRED',r.stdout+r.stderr)
 def test_candidate_manifest_or_enablement_mismatch_blocks(self):
  x=Env(); self.addCleanup(x.close); c=json.loads(x.candidate.read_text()); c['staticManifestSha256']='0'*64; x.candidate.write_text(json.dumps(c)); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('WEB_CANDIDATE_MISMATCH',r.stdout+r.stderr)
  y=Env(); self.addCleanup(y.close); c=json.loads(y.candidate.read_text()); c['webS32Enabled']=False; y.candidate.write_text(json.dumps(c)); r=y.run(); self.assertNotEqual(r.returncode,0); self.assertIn('WEB_CANDIDATE_MISMATCH',r.stdout+r.stderr)
 def test_private_token_in_static_bundle_blocks(self):
  x=Env(); self.addCleanup(x.close); (x.root/'static/index.js').write_text('TOKEN_SENTINEL'); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('PRIVATE_TOKEN_IN_WEB_BUNDLE',r.stdout+r.stderr)
 def test_capacity_receipt_must_match_exact_release(self):
  x=Env(); self.addCleanup(x.close); x.cap.write_text(f'CAPACITY_GATE=PASS_PREFERRED\nS32_RELEASE_FINGERPRINT={"f"*64}\nRELEASE_SOURCE_SHA={SRC}\n'); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('CAPACITY_RELEASE_MISMATCH',r.stdout+r.stderr); self.assertFalse(any(x.root.glob('progress/*R6.start.env')))
 def test_meili_document_count_drift_blocks(self):
  x=Env(); self.addCleanup(x.close); p=json.loads(x.post.read_text()); p['stats']['numberOfDocuments']=5115735; x.post.write_text(json.dumps(p)); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('MEILI_DOCUMENT_COUNT_DRIFT',r.stdout+r.stderr)
 def test_post_switch_api_meili_postgres_must_not_drift(self):
  x=Env(); self.addCleanup(x.close); p=json.loads(x.post.read_text()); p['services']['postgres']['cid']='changed'; x.post.write_text(json.dumps(p)); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('UNINTENDED_SERVICE_DRIFT',r.stdout+r.stderr)
 def test_capacity_gate_required(self):
  x=Env(); self.addCleanup(x.close); x.cap.write_text('CAPACITY_GATE=BLOCKED_CAPACITY\n'); r=x.run(); self.assertNotEqual(r.returncode,0); self.assertIn('R6_CAPACITY_NOT_PASS',r.stdout+r.stderr)
if __name__=='__main__': unittest.main()
