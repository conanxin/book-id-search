#!/usr/bin/env python3
import os,pathlib,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parent
AUTH=ROOT/'authorize-s32-production-rollout.sh'; CLAIM=ROOT/'claim-s32-production-rollout.sh'
FP='a'*64; SRC='b'*40; CTRL='c'*40

def run(script,args,repo,extra=None):
 env=os.environ.copy(); env['BOOK_ID_SEARCH_REPO_ROOT']=str(repo); env.update(extra or {})
 return subprocess.run(['bash',str(script),*args],text=True,capture_output=True,env=env)
class T(unittest.TestCase):
 def repo(self):
  td=tempfile.TemporaryDirectory(); self.addCleanup(td.cleanup); p=pathlib.Path(td.name); (p/'progress').mkdir(); return p
 def test_authorize_allowed_stage_and_mode(self):
  p=self.repo(); r=run(AUTH,['--authorize-production-rollout','R2_R3',FP,SRC,CTRL],p,{'S32_EXPLICIT_APPROVAL':'true'}); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  f=next((p/'progress').glob('s32-rollout-authorization-*.env')); self.assertEqual(f.stat().st_mode&0o777,0o600); self.assertIn('STAGE_GROUP=R2_R3',f.read_text())
 def test_control_plane_sync_is_allowed(self):
  p=self.repo(); r=run(AUTH,['--authorize-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,CTRL],p,{'S32_EXPLICIT_APPROVAL':'true'}); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
 def test_invalid_stage_or_missing_approval_blocks(self):
  p=self.repo(); r=run(AUTH,['--authorize-production-rollout','R2,R6',FP,SRC,CTRL],p,{'S32_EXPLICIT_APPROVAL':'true'}); self.assertNotEqual(r.returncode,0); self.assertIn('INVALID_STAGE_GROUP',r.stdout+r.stderr)
  r=run(AUTH,['--authorize-production-rollout','R6',FP,SRC,CTRL],p); self.assertNotEqual(r.returncode,0); self.assertIn('EXPLICIT_APPROVAL_REQUIRED',r.stdout+r.stderr)
 def test_r2_r3_binds_hard_only_capacity_decision(self):
  p=self.repo(); args=['--authorize-production-rollout','R2_R3',FP,SRC,CTRL]
  r=run(AUTH,args,p,{'S32_EXPLICIT_APPROVAL':'true','S32_CAPACITY_HARD_ONLY_ACCEPTED':'true'}); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  f=next((p/'progress').glob('s32-rollout-authorization-*.env')); self.assertIn('CAPACITY_HARD_ONLY_ACCEPTED=true',f.read_text())
 def test_r6_can_bind_hard_only_capacity_decision(self):
  p=self.repo(); args=['--authorize-production-rollout','R6',FP,SRC,CTRL]
  r=run(AUTH,args,p,{'S32_EXPLICIT_APPROVAL':'true','S32_CAPACITY_HARD_ONLY_ACCEPTED':'true'}); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  f=next((p/'progress').glob('s32-rollout-authorization-*.env')); self.assertIn('CAPACITY_HARD_ONLY_ACCEPTED=true',f.read_text())
 def test_claim_is_atomic_and_one_time(self):
  p=self.repo(); a=['--authorize-production-rollout','R6',FP,SRC,CTRL]; self.assertEqual(run(AUTH,a,p,{'S32_EXPLICIT_APPROVAL':'true'}).returncode,0)
  c=['--claim-production-rollout','R6',FP,SRC,CTRL]; r1=run(CLAIM,c,p); r2=run(CLAIM,c,p); self.assertEqual(r1.returncode,0,r1.stdout+r1.stderr); self.assertNotEqual(r2.returncode,0); self.assertIn('AUTHORIZATION_ALREADY_CLAIMED',r2.stdout+r2.stderr)
 def test_tamper_or_unsafe_file_blocks(self):
  p=self.repo(); a=['--authorize-production-rollout','R7',FP,SRC,CTRL]; run(AUTH,a,p,{'S32_EXPLICIT_APPROVAL':'true'}); f=next((p/'progress').glob('s32-rollout-authorization-*.env')); f.write_text(f.read_text().replace('SOURCE_SHA='+SRC,'SOURCE_SHA='+'d'*40)); os.chmod(f,0o600)
  r=run(CLAIM,['--claim-production-rollout','R7',FP,SRC,CTRL],p); self.assertNotEqual(r.returncode,0); self.assertIn('AUTHORIZATION_PLAN_MISMATCH',r.stdout+r.stderr)
 def test_artifact_contains_no_secret_keys(self):
  p=self.repo(); run(AUTH,['--authorize-production-rollout','R4_R5',FP,SRC,CTRL],p,{'S32_EXPLICIT_APPROVAL':'true'}); f=next((p/'progress').glob('s32-rollout-authorization-*.env')); up=f.read_text().upper()
  for word in ('PASSWORD','TOKEN','DATABASE_URL'): self.assertNotIn(word,up)
 def test_cp_sync_two_ctrl_authorizations_coexist(self):
  # Case A: same fingerprint, two different target control-plane SHAs.
  CTRL_B='e'*40
  p=self.repo(); env={'S32_EXPLICIT_APPROVAL':'true'}
  ra=run(AUTH,['--authorize-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,CTRL],p,env); self.assertEqual(ra.returncode,0,ra.stdout+ra.stderr)
  rb=run(AUTH,['--authorize-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,CTRL_B],p,env); self.assertEqual(rb.returncode,0,rb.stdout+rb.stderr)
  fa=p/'progress'/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{CTRL}.env'; fb=p/'progress'/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{CTRL_B}.env'
  self.assertTrue(fa.exists() and fb.exists())
  self.assertIn('CONTROL_PLANE_SHA='+CTRL,fa.read_text()); self.assertIn('CONTROL_PLANE_SHA='+CTRL_B,fb.read_text())
  # Neither file was overwritten by the other; re-authorizing either blocks.
  self.assertNotEqual(run(AUTH,['--authorize-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,CTRL],p,env).returncode,0)
  self.assertNotEqual(run(AUTH,['--authorize-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,CTRL_B],p,env).returncode,0)
 def test_cp_sync_claims_independent_one_time_per_ctrl(self):
  # Case B: each CTRL claims exactly once, hard-linked to its own auth.
  CTRL_B='e'*40
  p=self.repo(); env={'S32_EXPLICIT_APPROVAL':'true'}
  for c in (CTRL,CTRL_B):
   self.assertEqual(run(AUTH,['--authorize-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,c],p,env).returncode,0)
   r1=run(CLAIM,['--claim-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,c],p); self.assertEqual(r1.returncode,0,r1.stdout+r1.stderr)
   auth=p/'progress'/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{c}.env'; claim=p/'progress'/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC-{c}-claim.env'
   self.assertEqual(os.stat(auth).st_ino,os.stat(claim).st_ino)
   self.assertEqual(claim.stat().st_mode&0o777,0o600)
   r2=run(CLAIM,['--claim-production-rollout','CONTROL_PLANE_SYNC',FP,SRC,c],p); self.assertNotEqual(r2.returncode,0); self.assertIn('AUTHORIZATION_ALREADY_CLAIMED',r2.stdout+r2.stderr)
 def test_cp_sync_legacy_auth_untouched_and_other_stage_paths_unchanged(self):
  # Case F: R2_R3 keeps the fingerprint+stage path (no CTRL suffix), and a
  # pre-existing legacy CONTROL_PLANE_SYNC auth is never deleted or renamed.
  p=self.repo(); env={'S32_EXPLICIT_APPROVAL':'true'}
  legacy=p/'progress'/f's32-rollout-authorization-{FP}-CONTROL_PLANE_SYNC.env'; legacy.write_text('legacy first-sync evidence\n'); os.chmod(legacy,0o600)
  self.assertEqual(run(AUTH,['--authorize-production-rollout','R2_R3',FP,SRC,CTRL],p,env).returncode,0)
  f=next((p/'progress').glob(f's32-rollout-authorization-{FP}-R2_R3*.env')); self.assertEqual(f.name,f's32-rollout-authorization-{FP}-R2_R3.env')
  self.assertTrue(legacy.exists()); self.assertEqual(legacy.read_text(),'legacy first-sync evidence\n')
if __name__=='__main__': unittest.main()
