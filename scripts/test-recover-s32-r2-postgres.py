#!/usr/bin/env python3
"""Dynamic regressions for recover-s32-r2-postgres.sh (verify-only recovery).

Uses the REAL release manifest (validated fingerprint e6cef630…, source
106c140…) plus a fake `docker` stub and fake baseline JSON so the whole
recovery flow runs against the actual script. The fake repo's main HEAD is
CTRL. Cases: A (executor compose env on up AND ps), B (success), C/D
(terminal + start identity blocks), E/F/G (image/health/port blocks),
H/I (runtime + Meili drift), J/K (schema/role already present), L (receipt
audit + planner consumability), M (planner INCOMPLETE before recovery),
plus the verify-only static audit."""
import os,subprocess,tempfile,pathlib,unittest,json,hashlib
REPO=pathlib.Path(__file__).resolve().parent.parent
SCRIPT=REPO/'scripts'/'recover-s32-r2-postgres.sh'
EXEC=REPO/'scripts'/'execute-s32-r2-postgres.sh'
PLANNER=REPO/'scripts'/'plan-s32-production-rollout.py'
MANIFEST_SRC=pathlib.Path('/home/conanxin/codex-projects/book-id-search-s32-r0r1/progress/s32-release-manifest-106c140.json')
FP='e6cef630c7cc251b274e5bb1710ad5e1c3de2f8fe9db7baf63fefed7e5bb8426'
SRC='106c140c4f9ca5e2fbfc3c053a1f28f5c9fea661'
TOOL='d'*40
PG_DIGEST='721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
PG_ID='sha256:'+PG_DIGEST

def sh(args,cwd,env=None): return subprocess.run(args,cwd=cwd,env=env,text=True,capture_output=True)

DOCKER_STUB='''#!/usr/bin/env bash
case "$1" in
  ps) printf '%s' "${FAKE_CID:-c1abc}"; exit 0 ;;
  image)
      if [ "$2" = inspect ] && [ "${4:-}" = "--format" ]; then
        case "$5" in
          '{{.Id}}') printf '%s' "${FAKE_IMAGE_ID:-IDPLACEHOLDER}"; exit 0 ;;
          '{{json .RepoDigests}}') printf '["postgres@sha256:%s"]' "${FAKE_DIGEST:DIGPLACEHOLDER}"; exit 0 ;;
        esac
      fi
      exit 0 ;;
  inspect)
      case "${4:-}" in
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}') printf '%s' "${FAKE_HEALTH:-healthy}"; exit 0 ;;
        '{{.Image}}') printf '%s' "${FAKE_CONTAINER_IMAGE:-IMGPLACEHOLDER}"; exit 0 ;;
      esac
      printf '{}'; exit 0 ;;
  port) printf '%s' "${FAKE_PORTS:-}"; exit 0 ;;
  exec) f="${FAKE_COUNT_FILE:-/tmp/fake_docker_exec_count}"; c="$(cat "$f" 2>/dev/null || echo 0)"; c=$((c+1)); printf '%s' "$c" > "$f"; if [ "$c" = 2 ]; then printf '%s\n' "${FAKE_EXEC_SQL2:-0}"; else printf '%s\n' "${FAKE_EXEC_SQL1:-0}"; fi; exit 0 ;;
esac
exit 0
'''

def build_stub(docker_bin):
  stub=DOCKER_STUB.replace('IDPLACEHOLDER',PG_ID).replace('DIGPLACEHOLDER',PG_DIGEST).replace('IMGPLACEHOLDER',PG_ID)
  # escape ${FAKE_DIGEST:DIGPLACEHOLDER} colon syntax -> valid bash
  stub=stub.replace('${FAKE_DIGEST:%s}'%PG_DIGEST,'${FAKE_DIGEST:-%s}'%PG_DIGEST)
  docker_bin.write_text(stub); docker_bin.chmod(0o755)

class Env:
 def __init__(self):
  self.td=tempfile.TemporaryDirectory(); self.add=self.td.name
  self.bin=pathlib.Path(self.add)/'bin'; self.bin.mkdir(); build_stub(self.bin/'docker')
  self.root=pathlib.Path(self.add)/'repo'; self.root.mkdir()
  self.p=self.root/'progress'; self.p.mkdir()
  self.pgenv=pathlib.Path(self.add)/'postgres.env'
  self.pgenv.write_text('S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=x\nS32_APP_PASSWORD=y\n'); self.pgenv.chmod(0o600)
  self.pgdata=pathlib.Path(self.add)/'pgdata'; self.pgdata.mkdir()
  (self.pgdata/'PG_VERSION').write_text('16\n'); self.pgdata.chmod(0o700)
  self.baseline=pathlib.Path(self.add)/'baseline.json'
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
 def close(self): self.td.cleanup()
 def make_canonical(self,capacity='PASS_PREFERRED'):
  f=self.p/'s32-r0.env'
  f.write_text('STATUS=PASS\nS32_RELEASE_FINGERPRINT=%s\nWEB_CID=w1\nWEB_STARTED_AT=t1\nWEB_IMAGE_ID=i1\nAPI_CID=a1\nAPI_STARTED_AT=t2\nAPI_IMAGE_ID=i2\nMEILISEARCH_CID=m1\nMEILISEARCH_STARTED_AT=t3\nMEILISEARCH_IMAGE_ID=i3\nMEILI_DOCUMENTS=5115734\n'%FP); f.chmod(0o600)
  r1=self.p/'s32-r1.env'; r1.write_text('STATUS=PASS\nCAPACITY_GATE=%s\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\n'%(capacity,FP,SRC)); r1.chmod(0o600)
  m=self.p/'s32-release-manifest.json'; m.write_bytes(MANIFEST_SRC.read_bytes()); m.chmod(0o600)
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
  env['BOOK_ID_SEARCH_REPO_ROOT']=str(e.root)
  env['PATH']=str(e.bin)+':'+env['PATH']
  env['S32_POSTGRES_ENV_PATH']=str(e.pgenv)
  env['S32_RECOVERY_BASELINE_JSON']=str(baseline or e.baseline)
  env['S32_PGDATA_PATH']=str(e.pgdata)
  env.setdefault('S32_RECOVERY_DOCKER','docker')
  cnt=pathlib.Path(e.add)/'exec_count'; cnt.write_text('0'); env['FAKE_COUNT_FILE']=str(cnt)
  if extra: env.update(extra)
  return sh(['bash',str(SCRIPT),'--recover-r2-verify-only',fp,src,ctrl or e.head,tool],e.add,env)

 def setup_ok(self):
  e=Env(); self.addCleanup(e.close)
  e.make_canonical(); e.make_start(); e.make_claim()
  return e

 def test_case_A_executor_compose_env_up_and_ps(self):
  text=EXEC.read_text()
  self.assertIn('compose_pg() {',text)
  self.assertIn('"${CMD[@]}"',text)
  self.assertIn('CID="$(compose_pg ps -q postgres)"',text)
  # up command must still reference the same helper semantics: env vars set
  self.assertIn('"S32_POSTGRES_IMAGE=$PG_IMAGE" "S32_API_IMAGE=$BASE_API_IMAGE" "S32_PG_DATA_DIR=$PGDATA"',text)

 def test_case_B_recovery_success(self):
  e=self.setup_ok()
  r=self.run_rec(e)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  res=e.p/f's32-rollout-{FP}-R2.result.env'
  self.assertTrue(res.exists())
  self.assertEqual(res.stat().st_mode & 0o777,0o600)
  txt=res.read_text()
  for field in ('STATUS=PASS','R2_POSTGRES=PASS','R2_RECOVERY_MODE=VERIFY_ONLY','PG_MANIFEST_DIGEST=sha256:'+PG_DIGEST,'PG_IMAGE_ID='+PG_ID,'RECOVERY_TOOL_SHA='+TOOL):
   self.assertIn(field,txt)
  start=e.p/f's32-rollout-{FP}-R2.start.env'
  sha=hashlib.sha256(start.read_bytes()).hexdigest()
  self.assertIn('R2_START_SHA256='+sha,txt)

 def test_case_C_result_exists_blocks(self):
  e=self.setup_ok()
  res=e.p/f's32-rollout-{FP}-R2.result.env'; res.write_text('x'); res.chmod(0o600)
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0)
  self.assertIn('R2_ALREADY_TERMINAL',r.stdout+r.stderr)

 def test_case_D_start_missing_and_identity(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(); e.make_claim()
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0)
  self.assertIn('R2_RECOVERY_START_MISSING',r.stdout+r.stderr)
  e2=self.setup_ok()
  start=e2.p/f's32-rollout-{FP}-R2.start.env'
  start.write_text('STATUS=STARTED\nSTAGE=R2\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n'%('0'*64,SRC,e2.head)); start.chmod(0o600)
  r2=self.run_rec(e2); self.assertNotEqual(r2.returncode,0)
  self.assertIn('R2_START_IDENTITY_MISMATCH',r2.stdout+r2.stderr)

 def test_case_E_wrong_container_image_blocks(self):
  e=self.setup_ok()
  r=self.run_rec(e,extra={'FAKE_CONTAINER_IMAGE':'sha256:'+'1'*64})
  self.assertNotEqual(r.returncode,0)
  self.assertIn('POSTGRES_IMAGE_BINDING_MISMATCH',r.stdout+r.stderr)
  self.assertFalse((e.p/f's32-rollout-{FP}-R2.result.env').exists())

 def test_case_F_unhealthy_blocks(self):
  e=self.setup_ok()
  r=self.run_rec(e,extra={'FAKE_HEALTH':'starting'})
  self.assertNotEqual(r.returncode,0)
  self.assertIn('POSTGRES_NOT_HEALTHY',r.stdout+r.stderr)

 def test_case_G_host_port_blocks(self):
  e=self.setup_ok()
  r=self.run_rec(e,extra={'FAKE_PORTS':'5432/tcp -> 0.0.0.0:5432'})
  self.assertNotEqual(r.returncode,0)
  self.assertIn('POSTGRES_PUBLIC_PORT_PRESENT',r.stdout+r.stderr)

 def test_case_H_runtime_drift_blocks(self):
  e=self.setup_ok()
  drift=pathlib.Path(e.add)/'drift.json'
  data=json.loads(e.baseline.read_text()); data['services']['web']['cid']='changed'; drift.write_text(json.dumps(data))
  r=self.run_rec(e,baseline=drift)
  self.assertNotEqual(r.returncode,0)
  self.assertIn('LEGACY_RUNTIME_DRIFT',r.stdout+r.stderr)
  self.assertFalse((e.p/f's32-rollout-{FP}-R2.result.env').exists())

 def test_case_I_meili_drift_blocks(self):
  e=self.setup_ok()
  drift=pathlib.Path(e.add)/'meili.json'
  data=json.loads(e.baseline.read_text()); data['stats']['numberOfDocuments']=1; drift.write_text(json.dumps(data))
  r=self.run_rec(e,baseline=drift)
  self.assertNotEqual(r.returncode,0)
  self.assertIn('LEGACY_RUNTIME_DRIFT',r.stdout+r.stderr)

 def test_case_J_schema_already_present_blocks(self):
  e=self.setup_ok()
  r=self.run_rec(e,extra={'FAKE_EXEC_SQL1':'2'})
  self.assertNotEqual(r.returncode,0)
  self.assertIn('S32_SCHEMA_NAMESPACE_PRESENT',r.stdout+r.stderr)

 def test_case_K_role_already_present_blocks(self):
  e=self.setup_ok()
  r=self.run_rec(e,extra={'FAKE_EXEC_SQL1':'0','FAKE_EXEC_SQL2':'1'})
  self.assertNotEqual(r.returncode,0)
  self.assertIn('S32_APP_ROLE_PRESENT',r.stdout+r.stderr)

 def test_case_L_receipt_consumable_by_planner(self):
  e=self.setup_ok()
  r=self.run_rec(e); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  res=e.p/f's32-rollout-{FP}-R2.result.env'; txt=res.read_text()
  self.assertIn('PG_IMAGE_ID=',txt)
  pr=sh(['python3',str(PLANNER),'--state-dir',str(e.p),'--release-fingerprint',FP,'--release-source-sha',SRC],e.add)
  self.assertEqual(pr.returncode,0,pr.stdout+pr.stderr)
  self.assertIn('STATUS=READY_FOR_R3',pr.stdout)
  self.assertIn('NEXT_STAGE=R3',pr.stdout)

 def test_case_M_planner_incomplete_before_recovery(self):
  e=self.setup_ok()
  pr=sh(['python3',str(PLANNER),'--state-dir',str(e.p),'--release-fingerprint',FP,'--release-source-sha',SRC],e.add)
  self.assertIn('INCOMPLETE_R2',pr.stdout)

 def test_static_verify_only_audit(self):
  text=SCRIPT.read_text()
  for bad in ('docker compose up','compose down','docker compose restart','docker restart','docker run','docker pull','docker load','docker build','docker rm'):
   self.assertNotIn(bad,text,bad)
  for needed in ('R2_RECOVERY_MODE=VERIFY_ONLY','R2_START_SHA256','RECOVERY_TOOL_SHA'):
   self.assertIn(needed,text)
  self.assertNotIn('mkdir -p "$PGDATA"',text)
  self.assertNotIn('chmod 700 "$PGDATA"',text)
  self.assertNotIn('chown',text)

if __name__=='__main__': unittest.main()
