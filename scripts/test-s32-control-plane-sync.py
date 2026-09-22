#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parent
PLAN=ROOT/'plan-s32-control-plane-sync.py'; EXEC=ROOT/'execute-s32-control-plane-sync.sh'
FP='f'*64
SRC='b'*40

def sh(args,cwd,env=None): return subprocess.run(args,cwd=cwd,env=env,text=True,capture_output=True)

def repo():
 td=tempfile.TemporaryDirectory(); d=pathlib.Path(td.name); bare=d/'origin.git'; work=d/'work'
 subprocess.check_call(['git','init','--bare',str(bare)],stdout=subprocess.DEVNULL)
 subprocess.check_call(['git','init','-b','main',str(work)],stdout=subprocess.DEVNULL)
 subprocess.check_call(['git','config','user.email','t@example.com'],cwd=work); subprocess.check_call(['git','config','user.name','t'],cwd=work)
 (work/'x').write_text('1'); subprocess.check_call(['git','add','.'],cwd=work); subprocess.check_call(['git','commit','-m','one'],cwd=work,stdout=subprocess.DEVNULL)
 subprocess.check_call(['git','remote','add','origin',str(bare)],cwd=work); subprocess.check_call(['git','push','-u','origin','main'],cwd=work,stdout=subprocess.DEVNULL)
 first=subprocess.check_output(['git','rev-parse','HEAD'],cwd=work,text=True).strip()
 (work/'x').write_text('2'); subprocess.check_call(['git','commit','-am','two'],cwd=work,stdout=subprocess.DEVNULL); subprocess.check_call(['git','push'],cwd=work,stdout=subprocess.DEVNULL)
 second=subprocess.check_output(['git','rev-parse','HEAD'],cwd=work,text=True).strip(); subprocess.check_call(['git','reset','--hard',first],cwd=work,stdout=subprocess.DEVNULL)
 return td,work,first,second


def claim(work, ctrl):
 p=work/'progress'; p.mkdir(exist_ok=True)
 f=p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-claim.env'
 f.write_text(
  'AUTHORIZATION_VERSION=1\n'
  'AUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\n'
  'STAGE_GROUP=CONTROL_PLANE_SYNC\n'
  f'S32_RELEASE_FINGERPRINT={FP}\n'
  f'RELEASE_SOURCE_SHA={SRC}\n'
  f'CONTROL_PLANE_SHA={ctrl}\n'
  'EXPLICIT_APPROVAL=true\n'
  'CONSUMABLE_ONCE=true\n'
  'CAPACITY_HARD_ONLY_ACCEPTED=false\n'
  'PRODUCTION_WRITE_EXECUTED=false\n'
 )
 f.chmod(0o600)
 return f

def facts(path,cid='w1'):
 f={'services':{'web':{'cid':cid,'startedAt':'t1','imageId':'i1'},'api':{'cid':'a1','startedAt':'t2','imageId':'i2'},'meilisearch':{'cid':'m1','startedAt':'t3','imageId':'i3'}},'httpStatus':200}; path.write_text(json.dumps(f)); return f
class T(unittest.TestCase):
 def test_plan_ready_only_for_clean_main_reachable_target(self):
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  r=sh([sys.executable,str(PLAN),'--repo',str(w),'--target',second],w); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('STATUS=READY',r.stdout)
 def test_dirty_or_not_main_blocks(self):
  td,w,first,second=repo(); self.addCleanup(td.cleanup); (w/'dirty').write_text('x')
  r=sh([sys.executable,str(PLAN),'--repo',str(w),'--target',second],w); self.assertNotEqual(r.returncode,0); self.assertIn('WORKTREE_NOT_CLEAN',r.stdout+r.stderr)
  subprocess.check_call(['git','clean','-fd'],cwd=w,stdout=subprocess.DEVNULL); subprocess.check_call(['git','checkout','-b','other'],cwd=w,stdout=subprocess.DEVNULL)
  r=sh([sys.executable,str(PLAN),'--repo',str(w),'--target',second],w); self.assertNotEqual(r.returncode,0); self.assertIn('NOT_MAIN_BRANCH',r.stdout+r.stderr)
 def test_executor_requires_one_time_claim_and_detects_runtime_drift(self):
  td,w,first,second=repo(); self.addCleanup(td.cleanup); pre=pathlib.Path(td.name)/'pre.json'; post=pathlib.Path(td.name)/'post.json'; facts(pre); facts(post,'changed')
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w),S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env); self.assertNotEqual(r.returncode,0); self.assertIn('CONTROL_PLANE_SYNC_CLAIM_MISSING',r.stdout+r.stderr)
  claim(w,second)
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env); self.assertNotEqual(r.returncode,0); self.assertIn('CONTROL_PLANE_RUNTIME_DRIFT',r.stdout+r.stderr)
 def test_executor_success_changes_only_checkout(self):
  td,w,first,second=repo(); self.addCleanup(td.cleanup); pre=pathlib.Path(td.name)/'pre.json'; post=pathlib.Path(td.name)/'post.json'; facts(pre); facts(post); claim(w,second)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w),S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('CONTROL_PLANE_SYNC=PASS',r.stdout); self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),second)
 def test_executor_uses_tool_bundle_baseline_planner(self):
  text=EXEC.read_text() if EXEC.exists() else ''
  self.assertIn('SCRIPT_DIR=',text)
  self.assertIn('"$SCRIPT_DIR/plan-s32-production-baseline.py"',text)
  self.assertNotIn('"$ROOT/scripts/plan-s32-production-baseline.py"',text)

 def test_executor_has_no_runtime_mutation_commands(self):
  text=EXEC.read_text() if EXEC.exists() else ''
  for bad in ['docker compose up','docker compose down','docker restart','docker pull','docker build','docker rm']:
   self.assertNotIn(bad,text)
if __name__=='__main__': unittest.main()
