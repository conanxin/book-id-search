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
 def test_claim_is_atomic_and_one_time(self):
  p=self.repo(); a=['--authorize-production-rollout','R6',FP,SRC,CTRL]; self.assertEqual(run(AUTH,a,p,{'S32_EXPLICIT_APPROVAL':'true'}).returncode,0)
  c=['--claim-production-rollout','R6',FP,SRC,CTRL]; r1=run(CLAIM,c,p); r2=run(CLAIM,c,p); self.assertEqual(r1.returncode,0,r1.stdout+r1.stderr); self.assertNotEqual(r2.returncode,0); self.assertIn('AUTHORIZATION_ALREADY_CLAIMED',r2.stdout+r2.stderr)
 def test_tamper_or_unsafe_file_blocks(self):
  p=self.repo(); a=['--authorize-production-rollout','R7',FP,SRC,CTRL]; run(AUTH,a,p,{'S32_EXPLICIT_APPROVAL':'true'}); f=next((p/'progress').glob('s32-rollout-authorization-*.env')); f.write_text(f.read_text().replace('SOURCE_SHA='+SRC,'SOURCE_SHA='+'d'*40)); os.chmod(f,0o600)
  r=run(CLAIM,['--claim-production-rollout','R7',FP,SRC,CTRL],p); self.assertNotEqual(r.returncode,0); self.assertIn('AUTHORIZATION_PLAN_MISMATCH',r.stdout+r.stderr)
 def test_artifact_contains_no_secret_keys(self):
  p=self.repo(); run(AUTH,['--authorize-production-rollout','R4_R5',FP,SRC,CTRL],p,{'S32_EXPLICIT_APPROVAL':'true'}); f=next((p/'progress').glob('s32-rollout-authorization-*.env')); up=f.read_text().upper()
  for word in ('PASSWORD','TOKEN','DATABASE_URL'): self.assertNotIn(word,up)
if __name__=='__main__': unittest.main()
