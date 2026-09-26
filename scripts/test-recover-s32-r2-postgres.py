#!/usr/bin/env python3
"""Dynamic regressions for verify-only R2 recovery.

The suite is repository-contained: it generates a valid release manifest,
runs the real recovery script against fake read-only Docker/host probes, and
proves both success and fail-closed behavior without touching production.
"""
import hashlib,json,os,pathlib,subprocess,tempfile,unittest,sys

REPO=pathlib.Path(__file__).resolve().parent.parent
SCRIPT=REPO/'scripts'/'recover-s32-r2-postgres.sh'
PLANNER=REPO/'scripts'/'plan-s32-production-rollout.py'
MAN_TOOL=REPO/'scripts'/'s32-release-manifest.py'
SRC='a'*40
TOOL='d'*40
PG_REF='postgres@sha256:'+'8'*64
PG_CONFIG_ID='sha256:'+'9'*64
PG_MANIFEST_DIGEST='sha256:'+'8'*64

def valid_manifest():
 return {
  'version':1,'sourceSha':SRC,'pnpmLockSha256':'1'*64,
  'apiImageTag':'book-id-search-api:s32-'+SRC,'apiImageId':'sha256:'+'2'*64,'apiOciRevision':SRC,'apiBaseDigest':'node@sha256:'+'3'*64,
  'webImageTag':'book-id-search-web:'+SRC,'webImageId':'sha256:'+'4'*64,'webOciRevision':SRC,'webStaticManifestSha256':'5'*64,'webS32Enabled':True,
  'webNodeBaseDigest':'node@sha256:'+'6'*64,'webNginxBaseDigest':'nginx@sha256:'+'7'*64,
  'pgImageRef':PG_REF,'pgImageId':PG_CONFIG_ID,
  'migrationPath':'db/migrations/001_s32_core_schema.sql','migrationSha256':'a1'*32,
  'roleBootstrapPath':'deploy/s32-production-roles.sql','roleBootstrapSha256':'b2'*32,
  's32OverridePath':'deploy/s32-production.override.yml','s32OverrideSha256':'c3'*32,
 }

def fingerprint(data):
 with tempfile.NamedTemporaryFile('w',suffix='.json',delete=False) as f:
  json.dump(data,f); p=f.name
 try:
  out=subprocess.check_output([sys.executable,str(MAN_TOOL),p],text=True)
 finally:
  pathlib.Path(p).unlink(missing_ok=True)
 return next(line.split('=',1)[1] for line in out.splitlines() if line.startswith('S32_RELEASE_FINGERPRINT='))

MANIFEST=valid_manifest()
FP=fingerprint(MANIFEST)

def sh(args,cwd,env=None):
 return subprocess.run(args,cwd=cwd,env=env,text=True,capture_output=True)

FAKE_DOCKER='''#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
def fmt():
    return args[args.index('--format')+1] if '--format' in args else ''
if args[:2] == ['image','inspect']:
    f=fmt()
    if f == '{{.Id}}':
        sys.stdout.write(os.environ.get('FAKE_IMAGE_ID', os.environ['FAKE_MANIFEST_DIGEST']))
    elif f == '{{join .RepoDigests " "}}':
        sys.stdout.write('postgres@'+os.environ.get('FAKE_REPODIGEST', os.environ['FAKE_MANIFEST_DIGEST']))
    raise SystemExit(0)
if args and args[0] == 'ps':
    sys.stdout.write(os.environ.get('FAKE_CID','c1abc'))
    raise SystemExit(0)
if args and args[0] == 'inspect':
    f=fmt()
    if f == '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}':
        sys.stdout.write(os.environ.get('FAKE_HEALTH','healthy'))
    elif f == '{{.Image}}':
        sys.stdout.write(os.environ.get('FAKE_CONTAINER_IMAGE', os.environ.get('FAKE_IMAGE_ID', os.environ['FAKE_MANIFEST_DIGEST'])))
    elif f == '{{json .Mounts}}':
        source=os.environ.get('FAKE_MOUNT_SOURCE',os.environ['FAKE_PGDATA_PATH'])
        sys.stdout.write(json.dumps([{'Type':os.environ.get('FAKE_MOUNT_TYPE','bind'),'Source':source,'Destination':os.environ.get('FAKE_MOUNT_DEST','/var/lib/postgresql/data'),'RW':os.environ.get('FAKE_MOUNT_RW','true') == 'true'}]))
    else:
        sys.stdout.write('{}')
    raise SystemExit(0)
if args and args[0] == 'port':
    sys.stdout.write(os.environ.get('FAKE_PORTS',''))
    raise SystemExit(0)
if args and args[0] == 'exec':
    tail=args[2:]
    if tail == ['id','-u','postgres']:
        sys.stdout.write(os.environ.get('FAKE_PG_UID','70')); raise SystemExit(0)
    if tail == ['id','-g','postgres']:
        sys.stdout.write(os.environ.get('FAKE_PG_GID','70')); raise SystemExit(0)
    joined=' '.join(tail)
    if 'pg_namespace' in joined:
        sys.stdout.write(os.environ.get('FAKE_SCHEMA_COUNT','0')+'\\n'); raise SystemExit(0)
    if 'pg_roles' in joined:
        sys.stdout.write(os.environ.get('FAKE_ROLE_COUNT','0')+'\\n'); raise SystemExit(0)
    raise SystemExit(92)
raise SystemExit(91)
'''

FAKE_HOST_PRIV='''#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if args and args[0] == 'stat':
    form=args[args.index('-c')+1] if '-c' in args else ''
    if form == '%a':
        sys.stdout.write(os.environ.get('FAKE_PGDATA_MODE','700')+'\\n')
    elif form == '%u:%g':
        sys.stdout.write(os.environ.get('FAKE_PGDATA_OWNER','70:70')+'\\n')
    else:
        raise SystemExit(81)
    raise SystemExit(0)
if args and args[0] == 'find':
    if os.environ.get('FAKE_PGDATA_EMPTY','false') != 'true':
        sys.stdout.write(os.path.join(os.environ['FAKE_PGDATA_PATH'],'PG_VERSION')+'\\n')
    raise SystemExit(0)
raise SystemExit(80)
'''

class Env:
 def __init__(self):
  self.td=tempfile.TemporaryDirectory(); self.add=pathlib.Path(self.td.name)
  self.root=self.add/'repo'; self.root.mkdir()
  self.p=self.root/'progress'; self.p.mkdir()
  self.docker=self.add/'fake-docker.py'; self.docker.write_text(FAKE_DOCKER); self.docker.chmod(0o755)
  self.host_priv=self.add/'fake-host-priv.py'; self.host_priv.write_text(FAKE_HOST_PRIV); self.host_priv.chmod(0o755)
  self.pgenv=self.add/'postgres.env'
  self.pgenv.write_text('S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=x\nS32_APP_PASSWORD=y\n'); self.pgenv.chmod(0o600)
  self.pgdata=self.add/'pgdata'; self.pgdata.mkdir(); (self.pgdata/'PG_VERSION').write_text('16\n'); self.pgdata.chmod(0o700)
  self.baseline=self.add/'baseline.json'
  self.baseline.write_text(json.dumps({
   'httpStatus':200,'stats':{'numberOfDocuments':5115734},
   'services':{'web':{'cid':'w1','startedAt':'t1','imageId':'i1'},
               'api':{'cid':'a1','startedAt':'t2','imageId':'i2'},
               'meilisearch':{'cid':'m1','startedAt':'t3','imageId':'i3'}}}))
  subprocess.check_call(['git','init','-b','main'],cwd=self.root,stdout=subprocess.DEVNULL)
  subprocess.check_call(['git','-C',str(self.root),'config','user.email','t@t'],stdout=subprocess.DEVNULL)
  subprocess.check_call(['git','-C',str(self.root),'config','user.name','t'],stdout=subprocess.DEVNULL)
  (self.root/'x').write_text('1')
  subprocess.check_call(['git','-C',str(self.root),'add','-A'],stdout=subprocess.DEVNULL)
  subprocess.check_call(['git','-C',str(self.root),'commit','-m','one'],stdout=subprocess.DEVNULL)
  self.head=subprocess.check_output(['git','-C',str(self.root),'rev-parse','HEAD'],text=True).strip()
 def close(self):
  try:
   if self.pgdata.exists(): self.pgdata.chmod(0o700)
  except OSError:
   pass
  self.td.cleanup()
 def make_canonical(self,capacity='PASS_PREFERRED',r1_fp=FP,r1_src=SRC,meili='5115734'):
  r0=self.p/'s32-r0.env'
  r0.write_text('R0_FINAL=PASS\nS32_RELEASE_FINGERPRINT=%s\nWEB_CID=w1\nWEB_STARTED_AT=t1\nWEB_IMAGE_ID=i1\nAPI_CID=a1\nAPI_STARTED_AT=t2\nAPI_IMAGE_ID=i2\nMEILISEARCH_CID=m1\nMEILISEARCH_STARTED_AT=t3\nMEILISEARCH_IMAGE_ID=i3\nMEILI_DOCUMENTS=%s\n'%(FP,meili)); r0.chmod(0o600)
  r1=self.p/'s32-r1.env'; r1.write_text('CAPACITY_GATE=%s\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\n'%(capacity,r1_fp,r1_src)); r1.chmod(0o600)
  m=self.p/'s32-release-manifest.json'; m.write_text(json.dumps(MANIFEST)); m.chmod(0o600)
 def make_start(self,fp=FP,src=SRC,ctrl=None):
  ctrl=ctrl or self.head
  s=self.p/f's32-rollout-{fp}-R2.start.env'
  s.write_text('STATUS=STARTED\nSTAGE=R2\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n'%(fp,src,ctrl)); s.chmod(0o600); return s
 def make_claim(self):
  c=self.p/f's32-rollout-authorization-{FP}-R2_R3-claim.env'
  c.write_text('AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\nSTAGE_GROUP=R2_R3\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\nEXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\nCAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n'%(FP,SRC,self.head)); c.chmod(0o600); return c

class T(unittest.TestCase):
 def run_rec(self,e,ctrl=None,tool=TOOL,fp=FP,src=SRC,extra=None,baseline=None):
  env=os.environ.copy()
  env.update(
   BOOK_ID_SEARCH_REPO_ROOT=str(e.root),
   S32_POSTGRES_ENV_PATH=str(e.pgenv),
   S32_RECOVERY_BASELINE_JSON=str(baseline or e.baseline),
   S32_PGDATA_PATH=str(e.pgdata),
   S32_RECOVERY_DOCKER_CMD=str(e.docker),
   S32_RECOVERY_HOST_PRIV_CMD=str(e.host_priv),
   FAKE_PGDATA_PATH=str(e.pgdata),
   FAKE_MANIFEST_DIGEST=PG_MANIFEST_DIGEST,
   FAKE_PG_UID='70',FAKE_PG_GID='70',FAKE_PGDATA_OWNER='70:70',
  )
  if extra: env.update(extra)
  return sh(['bash',str(SCRIPT),'--recover-r2-verify-only',fp,src,ctrl or e.head,tool],e.add,env)

 def setup_ok(self):
  e=Env(); self.addCleanup(e.close)
  e.make_canonical(); e.make_start(); e.make_claim()
  return e

 def test_success_containerd_identity_and_receipt(self):
  e=self.setup_ok(); r=self.run_rec(e)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  res=e.p/f's32-rollout-{FP}-R2.result.env'
  self.assertTrue(res.exists()); self.assertEqual(res.stat().st_mode & 0o777,0o600)
  txt=res.read_text()
  for field in ('STATUS=PASS','R2_POSTGRES=PASS','R2_RECOVERY_MODE=VERIFY_ONLY','PG_MANIFEST_DIGEST='+PG_MANIFEST_DIGEST,'PG_IMAGE_ID='+PG_MANIFEST_DIGEST,'MEILI_DOCUMENTS=5115734','RECOVERY_TOOL_SHA='+TOOL):
   self.assertIn(field,txt)
  sha=hashlib.sha256((e.p/f's32-rollout-{FP}-R2.start.env').read_bytes()).hexdigest()
  self.assertIn('R2_START_SHA256='+sha,txt)

 def test_classic_config_image_identity_is_also_accepted(self):
  e=self.setup_ok(); r=self.run_rec(e,extra={'FAKE_IMAGE_ID':PG_CONFIG_ID,'FAKE_CONTAINER_IMAGE':PG_CONFIG_ID})
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  self.assertIn('PG_IMAGE_ID='+PG_CONFIG_ID,(e.p/f's32-rollout-{FP}-R2.result.env').read_text())

 def test_existing_result_blocks(self):
  e=self.setup_ok(); res=e.p/f's32-rollout-{FP}-R2.result.env'; res.write_text('x'); res.chmod(0o600)
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0); self.assertIn('R2_ALREADY_TERMINAL',r.stdout+r.stderr)

 def test_start_missing_and_identity_mismatch_block(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(); e.make_claim()
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0); self.assertIn('R2_RECOVERY_START_MISSING',r.stdout+r.stderr)
  e2=self.setup_ok(); s=e2.p/f's32-rollout-{FP}-R2.start.env'
  s.write_text('STATUS=STARTED\nSTAGE=R2\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n'%('0'*64,SRC,e2.head)); s.chmod(0o600)
  r2=self.run_rec(e2); self.assertNotEqual(r2.returncode,0); self.assertIn('R2_START_IDENTITY_MISMATCH',r2.stdout+r2.stderr)

 def test_r1_release_identity_is_bound(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(r1_src='f'*40); e.make_start(); e.make_claim()
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0); self.assertIn('R1_RELEASE_MISMATCH',r.stdout+r.stderr)

 def test_postgres_env_contract_is_validated_without_secret_output(self):
  e=self.setup_ok(); e.pgenv.write_text('S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=x\n'); e.pgenv.chmod(0o600)
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0); self.assertIn('POSTGRES_ENV_INVALID',r.stdout+r.stderr); self.assertNotIn('S32_POSTGRES_PASSWORD=x',r.stdout+r.stderr)

 def test_wrong_image_unhealthy_and_host_port_block(self):
  for extra,reason in [
   ({'FAKE_IMAGE_ID':'sha256:'+'1'*64},'PG_IMAGE_ID_MISMATCH'),
   ({'FAKE_HEALTH':'starting'},'POSTGRES_NOT_HEALTHY'),
   ({'FAKE_PORTS':'5432/tcp -> 0.0.0.0:5432'},'POSTGRES_PUBLIC_PORT_PRESENT')]:
   with self.subTest(reason=reason):
    e=self.setup_ok(); r=self.run_rec(e,extra=extra); self.assertNotEqual(r.returncode,0); self.assertIn(reason,r.stdout+r.stderr)
    self.assertFalse((e.p/f's32-rollout-{FP}-R2.result.env').exists())

 def test_repo_digest_mismatch_blocks(self):
  e=self.setup_ok(); r=self.run_rec(e,extra={'FAKE_REPODIGEST':'sha256:'+'2'*64})
  self.assertNotEqual(r.returncode,0); self.assertIn('PG_IMAGE_REPODIGEST_MISMATCH',r.stdout+r.stderr)

 def test_pgdata_privileged_read_probe_handles_unreadable_operator_path(self):
  e=self.setup_ok(); e.pgdata.chmod(0)
  r=self.run_rec(e)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)

 def test_pgdata_owner_must_match_running_postgres_uid_gid(self):
  e=self.setup_ok(); r=self.run_rec(e,extra={'FAKE_PGDATA_OWNER':'71:70'})
  self.assertNotEqual(r.returncode,0); self.assertIn('PGDATA_OWNER_MISMATCH',r.stdout+r.stderr)

 def test_exact_bind_mount_is_required(self):
  e=self.setup_ok(); r=self.run_rec(e,extra={'FAKE_MOUNT_SOURCE':'/wrong/source'})
  self.assertNotEqual(r.returncode,0); self.assertIn('POSTGRES_PGDATA_MOUNT_MISMATCH',r.stdout+r.stderr)

 def test_runtime_and_meili_drift_block_and_meili_comes_from_r0(self):
  e=self.setup_ok(); drift=e.add/'drift.json'; data=json.loads(e.baseline.read_text()); data['services']['web']['cid']='changed'; drift.write_text(json.dumps(data))
  r=self.run_rec(e,baseline=drift); self.assertNotEqual(r.returncode,0); self.assertIn('LEGACY_RUNTIME_DRIFT',r.stdout+r.stderr)
  e2=self.setup_ok(); e2.make_canonical(meili='42'); data=json.loads(e2.baseline.read_text()); data['stats']['numberOfDocuments']=42; e2.baseline.write_text(json.dumps(data))
  r2=self.run_rec(e2); self.assertEqual(r2.returncode,0,r2.stdout+r2.stderr); self.assertIn('MEILI_DOCUMENTS=42',(e2.p/f's32-rollout-{FP}-R2.result.env').read_text())

 def test_schema_or_role_already_present_blocks(self):
  for extra,reason in [
   ({'FAKE_SCHEMA_COUNT':'2'},'S32_SCHEMA_NAMESPACE_PRESENT'),
   ({'FAKE_ROLE_COUNT':'1'},'S32_APP_ROLE_PRESENT')]:
   with self.subTest(reason=reason):
    e=self.setup_ok(); r=self.run_rec(e,extra=extra); self.assertNotEqual(r.returncode,0); self.assertIn(reason,r.stdout+r.stderr)

 def test_receipt_is_consumable_by_planner(self):
  e=self.setup_ok(); r=self.run_rec(e); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  pr=sh([sys.executable,str(PLANNER),'--state-dir',str(e.p),'--release-fingerprint',FP,'--release-source-sha',SRC],e.add)
  self.assertEqual(pr.returncode,0,pr.stdout+pr.stderr); self.assertIn('STATUS=READY_FOR_R3',pr.stdout); self.assertIn('NEXT_STAGE=R3',pr.stdout)

 def test_planner_reports_incomplete_before_recovery(self):
  e=self.setup_ok(); pr=sh([sys.executable,str(PLANNER),'--state-dir',str(e.p),'--release-fingerprint',FP,'--release-source-sha',SRC],e.add)
  self.assertIn('INCOMPLETE_R2',pr.stdout)

 def test_script_is_verify_only_and_has_no_local_fixture_dependency(self):
  text=SCRIPT.read_text()
  for bad in ('docker compose up','compose down','docker compose restart','docker restart','docker run','docker pull','docker load','docker build','docker rm','mkdir -p "$PGDATA"','chmod 700 "$PGDATA"','chown','ls -A "$PGDATA"'):
   self.assertNotIn(bad,text,bad)
  for needed in ('R2_RECOVERY_MODE=VERIFY_ONLY','R2_START_SHA256','RECOVERY_TOOL_SHA','pgImageRef','pgImageId','MEILI_DOCUMENTS'):
   self.assertIn(needed,text)
  self.assertNotIn('/home/conanxin/',pathlib.Path(__file__).read_text())

if __name__=='__main__':
 unittest.main()
