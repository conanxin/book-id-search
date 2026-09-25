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

 def test_executor_consumes_only_requested_ctrl_claim(self):
  # Case C: claims for CTRL_A and CTRL_B both exist; executing toward
  # CTRL_B must read only the CTRL_B-scoped claim (never A's).
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  ctrl_a=first; ctrl_b=second
  p=w/'progress'; p.mkdir(exist_ok=True)
  for c in (ctrl_a,ctrl_b):
   body=('AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\nSTAGE_GROUP=CONTROL_PLANE_SYNC\n'
    f'S32_RELEASE_FINGERPRINT={FP}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={c}\n'
    'EXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\nCAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n')
   (p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{c}-claim.env').write_text(body)
  for f in p.glob('*.env'): f.chmod(0o600)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w))
  pre=pathlib.Path(td.name)/'c.json'; post=pathlib.Path(td.name)/'d.json'; facts(pre); facts(post)
  env.update(S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,ctrl_b],w,env)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),ctrl_b)
  # A's claim evidence is intact and untouched.
  self.assertTrue((p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{ctrl_a}-claim.env').exists())

 def test_executor_rejects_legacy_claim_bound_to_other_ctrl(self):
  # Case D: only a legacy (non-CTRL-scoped) claim exists and it binds
  # CTRL_A; requesting CTRL_B must BLOCK, never reuse the old grant.
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w))
  legacy=claim(w,first)  # binds CONTROL_PLANE_SHA=first
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertNotEqual(r.returncode,0); self.assertIn('CONTROL_PLANE_SYNC_CLAIM_MISSING',r.stdout+r.stderr)
  self.assertTrue(legacy.exists())  # untouched, not deleted/rewritten

 def test_executor_accepts_matching_legacy_claim(self):
  # Case E: legacy claim whose internal CTRL equals the requested CTRL
  # still authorizes (backward compatibility for first-sync evidence).
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  claim(w,second)  # legacy path, binds second
  pre=pathlib.Path(td.name)/'pre.json'; post=pathlib.Path(td.name)/'post.json'; facts(pre); facts(post)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w),S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('CONTROL_PLANE_SYNC=PASS',r.stdout)

 def test_executor_prefers_ctrl_scoped_claim_over_legacy(self):
  # With both present, the CTRL-scoped claim wins; a mismatching legacy
  # file must not interfere with a valid scoped authorization.
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  p=w/'progress'; p.mkdir(exist_ok=True)
  body=('AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\nSTAGE_GROUP=CONTROL_PLANE_SYNC\n'
   f'S32_RELEASE_FINGERPRINT={FP}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={second}\n'
   'EXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\nCAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n')
  scoped=p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{second}-claim.env'; scoped.write_text(body); scoped.chmod(0o600)
  claim(w,first)  # legacy binds first — must be ignored
  pre=pathlib.Path(td.name)/'pre.json'; post=pathlib.Path(td.name)/'post.json'; facts(pre); facts(post)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w),S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)

 def test_same_claim_cannot_execute_twice(self):
  # Case G: execute A→B succeeds once; the same B claim is terminal replay.
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  p=w/'progress'; p.mkdir(exist_ok=True)
  body=('AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\nSTAGE_GROUP=CONTROL_PLANE_SYNC\n'
   f'S32_RELEASE_FINGERPRINT={FP}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={second}\n'
   'EXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\nCAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n')
  (p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{second}-claim.env').write_text(body)
  for f in p.glob('*.env'): f.chmod(0o600)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w))
  pre=pathlib.Path(td.name)/'pre.json'; post=pathlib.Path(td.name)/'post.json'; facts(pre); facts(post)
  env.update(S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  r1=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertEqual(r1.returncode,0,r1.stdout+r1.stderr)
  self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),second)
  result=p/f's32-rollout-{FP}-CONTROL_PLANE_SYNC-{second}.result.env'; start=p/f's32-rollout-{FP}-CONTROL_PLANE_SYNC-{second}.start.env'
  self.assertTrue(result.exists()); self.assertTrue(start.exists())
  self.assertIn('PRE_CONTROL_PLANE_SHA='+first,start.read_text())
  self.assertIn('POST_CONTROL_PLANE_SHA='+second,result.read_text())
  r2=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertNotEqual(r2.returncode,0); self.assertIn('CONTROL_PLANE_ALREADY_TERMINAL',r2.stdout+r2.stderr)
  self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),second)

 def test_old_claim_cannot_rollback_after_forward_syncs(self):
  # Case H: A→B→C; sync to B, then to C; replaying B's claim must BLOCK
  # (non-forward) and the checkout must stay at C.
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  subprocess.check_call(['git','reset','--hard',second],cwd=w,stdout=subprocess.DEVNULL)
  (w/'x').write_text('3'); subprocess.check_call(['git','commit','-am','three'],cwd=w,stdout=subprocess.DEVNULL)
  subprocess.check_call(['git','push'],cwd=w,stdout=subprocess.DEVNULL)
  third=subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip()
  subprocess.check_call(['git','reset','--hard',first],cwd=w,stdout=subprocess.DEVNULL)
  p=w/'progress'; p.mkdir(exist_ok=True)
  for c in (second,third):
   body=('AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\nSTAGE_GROUP=CONTROL_PLANE_SYNC\n'
    f'S32_RELEASE_FINGERPRINT={FP}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={c}\n'
    'EXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\nCAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n')
   (p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{c}-claim.env').write_text(body)
  for f in p.glob('*.env'): f.chmod(0o600)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w))
  pre=pathlib.Path(td.name)/'pre.json'; post=pathlib.Path(td.name)/'post.json'; facts(pre); facts(post)
  env.update(S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  self.assertEqual(sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env).returncode,0)
  self.assertEqual(sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,third],w,env).returncode,0)
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertNotEqual(r.returncode,0)
  # Either terminal replay (RESULT B exists) or non-forward — both are
  # fail-closed; the task accepts either explicit reason.
  self.assertTrue('CONTROL_PLANE_ALREADY_TERMINAL' in r.stdout+r.stderr or 'CONTROL_PLANE_NON_FORWARD_TARGET' in r.stdout+r.stderr, r.stdout+r.stderr)
  self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),third)

 def test_current_equals_target_blocks_before_reset(self):
  # Case I: HEAD already == target; must BLOCK before any mutation.
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  subprocess.check_call(['git','reset','--hard',second],cwd=w,stdout=subprocess.DEVNULL)
  p=w/'progress'; p.mkdir(exist_ok=True)
  body=('AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\nSTAGE_GROUP=CONTROL_PLANE_SYNC\n'
   f'S32_RELEASE_FINGERPRINT={FP}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={second}\n'
   'EXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\nCAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n')
  (p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{second}-claim.env').write_text(body); 
  for f in p.glob('*.env'): f.chmod(0o600)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w))
  pre=pathlib.Path(td.name)/'pre.json'; post=pathlib.Path(td.name)/'post.json'; facts(pre); facts(post)
  env.update(S32_SYNC_PRE_FACTS_JSON=str(pre),S32_SYNC_POST_FACTS_JSON=str(post))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertNotEqual(r.returncode,0); self.assertIn('CONTROL_PLANE_ALREADY_AT_TARGET',r.stdout+r.stderr)
  self.assertFalse(any(p.glob(f's32-rollout-{FP}-CONTROL_PLANE_SYNC-{second}.start.env')))
  self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),second)

 def test_start_without_result_never_retries(self):
  # An orphaned START (INCOMPLETE/UNKNOWN) blocks any re-execution for the
  # same FP+CTRL, even with a fresh valid claim present.
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  p=w/'progress'; p.mkdir(exist_ok=True)
  body=('AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\nSTAGE_GROUP=CONTROL_PLANE_SYNC\n'
   f'S32_RELEASE_FINGERPRINT={FP}\nRELEASE_SOURCE_SHA={SRC}\nCONTROL_PLANE_SHA={second}\n'
   'EXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\nCAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n')
  (p/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{second}-claim.env').write_text(body)
  orphan=p/f's32-rollout-{FP}-CONTROL_PLANE_SYNC-{second}.start.env'
  orphan.write_text('STATUS=STARTED\n'); orphan.chmod(0o600)
  for f in p.glob('*.env'): f.chmod(0o600)
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,second],w,env)
  self.assertNotEqual(r.returncode,0); self.assertIn('INCOMPLETE_CONTROL_PLANE_SYNC',r.stdout+r.stderr)
  self.assertTrue(orphan.exists())
  self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),first)

 def test_legacy_claim_cannot_rollback_when_head_newer(self):
  # §4: legacy claim bound to an old CTRL must not mutate the checkout
  # once production HEAD has moved past it (non-forward BLOCK).
  td,w,first,second=repo(); self.addCleanup(td.cleanup)
  subprocess.check_call(['git','reset','--hard',second],cwd=w,stdout=subprocess.DEVNULL)
  claim(w,first)  # legacy binds first; HEAD=second is newer
  env=os.environ.copy(); env.update(BOOK_ID_SEARCH_REPO_ROOT=str(w))
  r=sh(['bash',str(EXEC),'--execute-control-plane-sync',FP,SRC,first],w,env)
  self.assertNotEqual(r.returncode,0); self.assertIn('CONTROL_PLANE_NON_FORWARD_TARGET',r.stdout+r.stderr)
  self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),second)
if __name__=='__main__': unittest.main()
