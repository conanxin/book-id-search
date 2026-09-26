#!/usr/bin/env python3
import hashlib,io,json,os,pathlib,subprocess,tarfile,tempfile,unittest,sys
ROOT=pathlib.Path(__file__).resolve().parent
R4=ROOT/'execute-s32-r4-api-dark.sh'; R5=ROOT/'execute-s32-r5-activate.sh'; MAN=ROOT/'s32-release-manifest.py'; VERIFY=ROOT/'verify-s32-api-image-archive.py'; SRC='b'*40; CTRL='c'*40

def manifest(): return {'version':1,'sourceSha':SRC,'pnpmLockSha256':'1'*64,'apiImageTag':'book-id-search-api:s32-'+SRC,'apiImageId':'sha256:'+'2'*64,'apiOciRevision':SRC,'apiBaseDigest':'node@sha256:'+'3'*64,'webImageTag':'book-id-search-web:'+SRC,'webImageId':'sha256:'+'4'*64,'webOciRevision':SRC,'webStaticManifestSha256':'5'*64,'webS32Enabled':True,'webNodeBaseDigest':'node@sha256:'+'6'*64,'webNginxBaseDigest':'nginx@sha256:'+'7'*64,'pgImageRef':'postgres@sha256:'+'8'*64,'pgImageId':'sha256:'+'9'*64,'migrationPath':'db/migrations/001_s32_core_schema.sql','migrationSha256':'a1'*32,'roleBootstrapPath':'deploy/s32-production-roles.sql','roleBootstrapSha256':'b2'*32,'s32OverridePath':'deploy/s32-production.override.yml','s32OverrideSha256':'c3'*32}
def fp(path):
 out=subprocess.check_output([sys.executable,str(MAN),str(path)],text=True); return [x.split('=',1)[1] for x in out.splitlines() if x.startswith('S32_RELEASE_FINGERPRINT=')][0]

def digest(data): return 'sha256:'+hashlib.sha256(data).hexdigest()

def oci_archive(path, revision=SRC, tamper_layer=False):
 config=json.dumps({'config':{'Labels':{'org.opencontainers.image.revision':revision}}},sort_keys=True,separators=(',',':')).encode()
 config_digest=digest(config)
 layer=b'layer-bytes-for-s32-api-test'
 layer_digest=digest(layer)
 manifest=json.dumps({
  'schemaVersion':2,
  'config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':config_digest,'size':len(config)},
  'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar','digest':layer_digest,'size':len(layer)}],
 },sort_keys=True,separators=(',',':')).encode()
 manifest_digest=digest(manifest)
 index=json.dumps({
  'schemaVersion':2,
  'manifests':[{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':manifest_digest,'size':len(manifest)}],
 },sort_keys=True,separators=(',',':')).encode()
 with tarfile.open(path,'w') as tf:
  for name,data in [
   ('index.json',index),
   ('blobs/sha256/'+manifest_digest.split(':',1)[1],manifest),
   ('blobs/sha256/'+config_digest.split(':',1)[1],config),
   ('blobs/sha256/'+layer_digest.split(':',1)[1],layer+b'X' if tamper_layer else layer),
  ]:
   info=tarfile.TarInfo(name); info.size=len(data); tf.addfile(info,io.BytesIO(data))
 return manifest_digest,config_digest
class Env:
 def __init__(self):
  self.t=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.t.name); (self.root/'progress').mkdir(); (self.root/'deploy').mkdir(); (self.root/'docker-compose.yml').write_text('services: {}\n'); (self.root/'docker-compose.override.yml').write_text('services: {}\n'); (self.root/'deploy/s32-production.override.yml').write_text('services: {}\n')
  self.man=self.root/'manifest.json'; self.man.write_text(json.dumps(manifest())); self.fp=fp(self.man)
  self.r0=self.root/'r0.env'; self.r0.write_text('\n'.join(['R0_FINAL=PASS','WEB_CID=w1','WEB_STARTED_AT=wt','WEB_IMAGE_ID=wi','WEB_REVISION='+'d'*40,'API_CID=a1','API_STARTED_AT=at','API_IMAGE=book-id-search-api:old','API_IMAGE_ID=oldai','API_REVISION='+'e'*40,'MEILISEARCH_CID=m1','MEILISEARCH_STARTED_AT=mt','MEILISEARCH_IMAGE_ID=mi','MEILI_DOCUMENTS=5115734','PUBLIC_HTTP_STATUS=200'])+'\n')
  self.r3=self.root/'progress'/f's32-rollout-{self.fp}-R3.result.env'; self.r3.write_text(f'STATUS=PASS\nR3_SCHEMA=PASS\nS32_RELEASE_FINGERPRINT={self.fp}\n'); os.chmod(self.r3,0o600)
  self.cap=self.root/'r4-cap.env'; self.cap.write_text(f'CAPACITY_GATE=PASS_PREFERRED\nS32_RELEASE_FINGERPRINT={self.fp}\nRELEASE_SOURCE_SHA={SRC}\n')
  self.claim=self.root/'progress'/f's32-rollout-authorization-{self.fp}-R4_R5-claim.env'; self.claim.write_text(f'STAGE_GROUP=R4_R5\nS32_RELEASE_FINGERPRINT={self.fp}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={CTRL}\n'); os.chmod(self.claim,0o600)
  self.pg=self.root/'postgres.env'; self.pg.write_text('S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=pgsentinel\n'); os.chmod(self.pg,0o600)
  self.api=self.root/'api.env'; self.api.write_text('S32_DATABASE_URL=postgresql://s32_app:appsentinel@postgres/book_id_search_s32\nS32_PRIVATE_API_TOKEN=TOKEN_SENTINEL\n'); os.chmod(self.api,0o600)
  self.r4post=self.root/'r4post.json'; self.r4post.write_text(json.dumps({'services':{'web':{'cid':'w1','startedAt':'wt','imageId':'wi'},'api':{'cid':'newapi','startedAt':'newt','imageId':'sha256:'+'2'*64,'revision':SRC},'meilisearch':{'cid':'m1','startedAt':'mt','imageId':'mi'}},'httpStatus':200,'stats':{'numberOfDocuments':5115734,'isIndexing':False},'searches':{k:{'status':'PASS'} for k in ['ISBN','SSID','DXID','title','author','publisher']},'s32Enabled':False}))
  self.r5post=self.root/'r5post.json'; self.r5post.write_text(json.dumps({'services':{'web':{'cid':'w1','startedAt':'wt','imageId':'wi'},'api':{'cid':'newapi2','startedAt':'newt2','imageId':'sha256:'+'2'*64,'revision':SRC},'meilisearch':{'cid':'m1','startedAt':'mt','imageId':'mi'}},'httpStatus':200,'postgresPresent':True,'s32EnvNames':['S32_FEATURES_ENABLED','S32_DATABASE_URL','S32_PRIVATE_API_TOKEN'],'stats':{'numberOfDocuments':5115734,'isIndexing':False},'searches':{k:{'status':'PASS'} for k in ['ISBN','SSID','DXID','title','author','publisher']},'backendAcceptance':'PASS'}))
  self.log=self.root/'cmd.log'
 def close(self): self.t.cleanup()
 def env(self,**kw):
  e=os.environ.copy(); e.update(BOOK_ID_SEARCH_REPO_ROOT=str(self.root),S32_R0_RECEIPT=str(self.r0),S32_R3_RECEIPT=str(self.r3),S32_R4_CAPACITY_RECEIPT=str(self.cap),S32_RELEASE_MANIFEST_JSON=str(self.man),S32_POSTGRES_ENV_FILE=str(self.pg),S32_API_ENV_FILE=str(self.api),S32_R4_R5_TEST_MODE='true',S32_R4_POST_FACTS_JSON=str(self.r4post),S32_R5_POST_FACTS_JSON=str(self.r5post),S32_R4_R5_COMMAND_LOG=str(self.log)); e.update({k:str(v) for k,v in kw.items()}); return e
 def r4(self,**kw): return subprocess.run(['bash',str(R4),'--execute-r4',self.fp,SRC,CTRL],text=True,capture_output=True,env=self.env(**kw))
 def r5(self,**kw): return subprocess.run(['bash',str(R5),'--execute-r5',self.fp,SRC,CTRL],text=True,capture_output=True,env=self.env(**kw))
class T(unittest.TestCase):
 def test_archive_identity_verifier_accepts_manifest_config_and_layers(self):
  x=tempfile.TemporaryDirectory(); self.addCleanup(x.cleanup); archive=pathlib.Path(x.name)/'image.tar'
  manifest_digest,config_digest=oci_archive(archive)
  with archive.open('rb') as fh:
   r=subprocess.run([sys.executable,str(VERIFY),'--expected-manifest-digest',manifest_digest,'--expected-config-digest',config_digest,'--expected-revision',SRC],stdin=fh,text=True,capture_output=True)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('IMAGE_ARCHIVE_IDENTITY=PASS',r.stdout); self.assertIn('LAYER_COUNT=1',r.stdout)

 def test_archive_identity_verifier_fails_closed_on_config_revision_or_layer_tamper(self):
  x=tempfile.TemporaryDirectory(); self.addCleanup(x.cleanup); archive=pathlib.Path(x.name)/'image.tar'
  manifest_digest,config_digest=oci_archive(archive)
  with archive.open('rb') as fh:
   r=subprocess.run([sys.executable,str(VERIFY),'--expected-manifest-digest',manifest_digest,'--expected-config-digest','sha256:'+'f'*64,'--expected-revision',SRC],stdin=fh,text=True,capture_output=True)
  self.assertNotEqual(r.returncode,0); self.assertIn('CONFIG_DIGEST_MISMATCH',r.stdout+r.stderr)
  with archive.open('rb') as fh:
   r=subprocess.run([sys.executable,str(VERIFY),'--expected-manifest-digest',manifest_digest,'--expected-config-digest',config_digest,'--expected-revision','f'*40],stdin=fh,text=True,capture_output=True)
  self.assertNotEqual(r.returncode,0); self.assertIn('OCI_REVISION_MISMATCH',r.stdout+r.stderr)
  bad=pathlib.Path(x.name)/'bad.tar'; oci_archive(bad,tamper_layer=True)
  with bad.open('rb') as fh:
   r=subprocess.run([sys.executable,str(VERIFY),'--expected-manifest-digest',manifest_digest,'--expected-config-digest',config_digest,'--expected-revision',SRC],stdin=fh,text=True,capture_output=True)
  self.assertNotEqual(r.returncode,0); self.assertIn('BLOB_DIGEST_MISMATCH',r.stdout+r.stderr)

 def test_r4_r5_accept_containerd_host_id_and_bind_receipts_to_it(self):
  x=Env(); self.addCleanup(x.close); host_id='sha256:'+'a'*64
  f=json.loads(x.r4post.read_text()); f['services']['api']['imageId']=host_id; x.r4post.write_text(json.dumps(f))
  f=json.loads(x.r5post.read_text()); f['services']['api']['imageId']=host_id; x.r5post.write_text(json.dumps(f))
  r=x.r4(S32_R4_R5_FAKE_API_HOST_ID=host_id); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  receipt=next(x.root.glob('progress/*R4.result.env')).read_text()
  self.assertIn('API_IMAGE_ID='+host_id,receipt)
  self.assertIn('API_CONFIG_DIGEST=sha256:'+'2'*64,receipt)
  self.assertIn('API_IDENTITY_MODE=OCI_MANIFEST',receipt)
  r=x.r5(S32_R4_R5_FAKE_API_HOST_ID=host_id); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  r5=next(x.root.glob('progress/*R5.result.env')).read_text()
  self.assertIn('API_IMAGE_ID='+host_id,r5)
  self.assertIn('API_CONFIG_DIGEST=sha256:'+'2'*64,r5)

 def test_backend_identity_gate_is_archive_proven_and_r5_binds_r4_host_id(self):
  r4=R4.read_text(); r5=R5.read_text()
  self.assertIn('docker image save "$API_TAG"',r4)
  self.assertIn('verify-s32-api-image-archive.py',r4)
  self.assertIn('API_IMAGE_ARCHIVE_IDENTITY_MISMATCH',r4)
  self.assertIn('API_CONFIG_DIGEST=%s',r4)
  self.assertIn('get "$R4" API_IMAGE_ID',r5)
  self.assertIn('get "$R4" API_CONFIG_DIGEST',r5)
  self.assertIn('API_RUNTIME_BINDING_MISMATCH',r5)
  self.assertIn('verify-s32-api-image-archive.py',r5)

 def test_r4_changes_api_only_and_s32_stays_disabled(self):
  x=Env(); self.addCleanup(x.close); r=x.r4(); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('R4_API_DARK=PASS',r.stdout); log=x.log.read_text(); self.assertIn('--no-build --no-deps api',log); self.assertIn('S32_FEATURES_ENABLED=false',log); self.assertNotIn('TOKEN_SENTINEL',log)
 def test_r4_requires_fresh_capacity_and_exact_api_identity(self):
  x=Env(); self.addCleanup(x.close); x.cap.write_text('CAPACITY_GATE=BLOCKED_CAPACITY\n'); r=x.r4(); self.assertNotEqual(r.returncode,0); self.assertIn('R4_CAPACITY_NOT_PASS',r.stdout+r.stderr)
  y=Env(); self.addCleanup(y.close); f=json.loads(y.r4post.read_text()); f['services']['api']['revision']='f'*40; y.r4post.write_text(json.dumps(f)); r=y.r4(); self.assertNotEqual(r.returncode,0); self.assertIn('API_RELEASE_IDENTITY_MISMATCH',r.stdout+r.stderr)
 def test_r4_rejects_stale_capacity_receipt_before_start(self):
  x=Env(); self.addCleanup(x.close); x.cap.write_text(f'CAPACITY_GATE=PASS_PREFERRED\nS32_RELEASE_FINGERPRINT={"f"*64}\nRELEASE_SOURCE_SHA={SRC}\n'); r=x.r4(); self.assertNotEqual(r.returncode,0); self.assertIn('CAPACITY_RELEASE_MISMATCH',r.stdout+r.stderr); self.assertFalse(any(x.root.glob('progress/*R4.start.env')))
 def test_r4_meili_document_count_drift_blocks(self):
  x=Env(); self.addCleanup(x.close); facts=json.loads(x.r4post.read_text()); facts['stats']['numberOfDocuments']=5115735; x.r4post.write_text(json.dumps(facts)); r=x.r4(); self.assertNotEqual(r.returncode,0); self.assertIn('MEILI_DOCUMENT_COUNT_DRIFT',r.stdout+r.stderr)
 def test_r4_legacy_search_or_meili_drift_blocks(self):
  x=Env(); self.addCleanup(x.close); f=json.loads(x.r4post.read_text()); f['searches']['SSID']['status']='FAIL'; x.r4post.write_text(json.dumps(f)); r=x.r4(); self.assertNotEqual(r.returncode,0); self.assertIn('LEGACY_SEARCH_REGRESSION',r.stdout+r.stderr)
  y=Env(); self.addCleanup(y.close); f=json.loads(y.r4post.read_text()); f['services']['meilisearch']['cid']='changed'; y.r4post.write_text(json.dumps(f)); r=y.r4(); self.assertNotEqual(r.returncode,0); self.assertIn('UNINTENDED_SERVICE_DRIFT',r.stdout+r.stderr)
 def test_r5_requires_r4_pass_and_s32_app_url(self):
  x=Env(); self.addCleanup(x.close); r=x.r5(); self.assertNotEqual(r.returncode,0); self.assertIn('R4_RECEIPT_MISSING',r.stdout+r.stderr)
  self.assertEqual(x.r4().returncode,0); x.api.write_text('S32_DATABASE_URL=postgresql://s32_admin:x@postgres/book_id_search_s32\nS32_PRIVATE_API_TOKEN=TOKEN_SENTINEL\n'); os.chmod(x.api,0o600); r=x.r5(); self.assertNotEqual(r.returncode,0); self.assertIn('API_DATABASE_ROLE_INVALID',r.stdout+r.stderr)
 def test_r5_enables_s32_and_token_never_leaks(self):
  x=Env(); self.addCleanup(x.close); self.assertEqual(x.r4().returncode,0); r=x.r5(); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('R5_S32_ACTIVATION=PASS',r.stdout); combined=r.stdout+r.stderr+x.log.read_text(); self.assertNotIn('TOKEN_SENTINEL',combined); self.assertNotIn('appsentinel',combined); self.assertIn('S32_FEATURES_ENABLED=true',x.log.read_text())

 def test_r5_rejects_unsafe_or_ambiguous_secret_files(self):
  x=Env(); self.addCleanup(x.close); self.assertEqual(x.r4().returncode,0)
  x.api.write_text('S32_DATABASE_URL=postgresql://s32_app:a@postgres/book_id_search_s32\nS32_DATABASE_URL=postgresql://s32_app:b@postgres/book_id_search_s32\nS32_PRIVATE_API_TOKEN=TOKEN_SENTINEL\n')
  os.chmod(x.api,0o600)
  r=x.r5(); self.assertNotEqual(r.returncode,0); self.assertIn('API_ENV_CONTRACT_INVALID',r.stdout+r.stderr)

  y=Env(); self.addCleanup(y.close); self.assertEqual(y.r4().returncode,0)
  target=y.root/'api-target.env'; target.write_text(y.api.read_text()); os.chmod(target,0o600)
  y.api.unlink(); y.api.symlink_to(target)
  r=y.r5(); self.assertNotEqual(r.returncode,0); self.assertIn('API_ENV_UNSAFE',r.stdout+r.stderr)

 def test_r5_fails_if_web_or_meili_drift_or_s32_runtime_env_is_missing(self):
  x=Env(); self.addCleanup(x.close); self.assertEqual(x.r4().returncode,0)
  facts=json.loads(x.r5post.read_text()); facts['services']['web']['cid']='changed'; x.r5post.write_text(json.dumps(facts))
  r=x.r5(); self.assertNotEqual(r.returncode,0); self.assertIn('R5_POSTVERIFY_FAILED',r.stdout+r.stderr)

  y=Env(); self.addCleanup(y.close); self.assertEqual(y.r4().returncode,0)
  facts=json.loads(y.r5post.read_text()); facts['s32EnvNames']=['S32_FEATURES_ENABLED']; y.r5post.write_text(json.dumps(facts))
  r=y.r5(); self.assertNotEqual(r.returncode,0); self.assertIn('R5_POSTVERIFY_FAILED',r.stdout+r.stderr)

 def test_r5_meili_document_count_drift_blocks(self):
  x=Env(); self.addCleanup(x.close); self.assertEqual(x.r4().returncode,0); facts=json.loads(x.r5post.read_text()); facts['stats']['numberOfDocuments']=5115735; x.r5post.write_text(json.dumps(facts)); r=x.r5(); self.assertNotEqual(r.returncode,0); self.assertIn('R5_POSTVERIFY_FAILED',r.stdout+r.stderr)
 def test_r5_backend_acceptance_uses_environment_flag(self):
  text=R5.read_text() if R5.exists() else ''
  self.assertIn('S32_ACCEPTANCE_BACKEND_ONLY=true',text)
  self.assertNotIn('-- --backend-only',text)

 def test_no_auto_rollback_or_pg_delete(self):
  text=(R4.read_text() if R4.exists() else '')+(R5.read_text() if R5.exists() else '')
  self.assertNotIn('rm -rf',text); self.assertNotIn('docker compose down',text); self.assertNotIn('AUTO_ROLLBACK=true',text)
if __name__=='__main__': unittest.main()
