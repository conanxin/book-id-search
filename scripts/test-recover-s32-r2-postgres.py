#!/usr/bin/env python3
"""Dynamic regressions for recover-s32-r2-postgres.sh (verify-only recovery).

The fake repo's real main-branch HEAD serves as CTRL so the production
identity gates pass; FP/SRC stay fixed constants. Covers: start missing /
already terminal / R3 artifact present / start identity mismatch / R1 not
preferred blocks, plus a static audit that the tool is verify-only (no
compose up, no docker run, no mkdir/chmod on PGDATA, no DDL) and binds
R2_RECOVERY_MODE / R2_START_SHA256 / RECOVERY_TOOL_SHA into the receipt."""
import os,subprocess,tempfile,pathlib,unittest
REPO=pathlib.Path(__file__).resolve().parent.parent
SCRIPT=REPO/'scripts'/'recover-s32-r2-postgres.sh'
FP='e'*64; SRC='a'*40; TOOL='d'*40

def sh(args,cwd,env=None): return subprocess.run(args,cwd=cwd,env=env,text=True,capture_output=True)

class Env:
 def __init__(self):
  self.td=tempfile.TemporaryDirectory(); self.add=self.td.name
  self.root=pathlib.Path(self.add)/'repo'; self.root.mkdir()
  self.p=self.root/'progress'; self.p.mkdir()
  subprocess.check_call(['git','init','-b','main'],cwd=self.root,stdout=subprocess.DEVNULL)
  subprocess.check_call(['git','-C',str(self.root),'config','user.email','t@t'],stdout=subprocess.DEVNULL)
  subprocess.check_call(['git','-C',str(self.root),'config','user.name','t'],stdout=subprocess.DEVNULL)
  (self.root/'x').write_text('1')
  subprocess.check_call(['git','-C',str(self.root),'add','-A'],stdout=subprocess.DEVNULL)
  subprocess.check_call(['git','-C',str(self.root),'commit','-m','one'],stdout=subprocess.DEVNULL)
  self.head=subprocess.check_output(['git','-C',str(self.root),'rev-parse','HEAD'],text=True).strip()
 def close(self): self.td.cleanup()
 def make_canonical(self,capacity='PASS_PREFERRED'):
  f=self.p/'s32-r0.env'; f.write_text('STATUS=PASS\n'); f.chmod(0o600)
  r1=self.p/'s32-r1.env'; r1.write_text('STATUS=PASS\nCAPACITY_GATE=%s\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\n'%(capacity,FP,SRC)); r1.chmod(0o600)
  m=self.p/'s32-release-manifest.json'; m.write_text('{}\n'); m.chmod(0o600)
 def make_start(self,fp=FP,src=SRC,ctrl=None):
  ctrl=ctrl or self.head
  s=self.p/f's32-rollout-{fp}-R2.start.env'
  s.write_text('STATUS=STARTED\nSTAGE=R2\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n'%(fp,src,ctrl)); s.chmod(0o600); return s

class T(unittest.TestCase):
 def run_rec(self,e,ctrl=None,tool=TOOL,fp=FP,src=SRC):
  env=os.environ.copy(); env['BOOK_ID_SEARCH_REPO_ROOT']=str(e.root)
  return sh(['bash',str(SCRIPT),'--recover-r2-verify-only',fp,src,ctrl or e.head,tool],e.add,env)

 def test_start_missing_blocks(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical()
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0)
  self.assertIn('R2_RECOVERY_START_MISSING',r.stdout+r.stderr)

 def test_existing_result_blocks(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(); e.make_start()
  res=e.p/f's32-rollout-{FP}-R2.result.env'; res.write_text('x'); res.chmod(0o600)
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0)
  self.assertIn('R2_ALREADY_TERMINAL',r.stdout+r.stderr)

 def test_r3_artifact_blocks(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(); e.make_start()
  s=e.p/f's32-rollout-{FP}-R3.start.env'; s.write_text('x'); s.chmod(0o600)
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0)
  self.assertIn('R3_ARTIFACT_PRESENT',r.stdout+r.stderr)

 def test_start_identity_mismatch_blocks(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(); e.make_start(ctrl='9'*40)
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0)
  self.assertIn('R2_START_IDENTITY_MISMATCH',r.stdout+r.stderr)

 def test_r1_not_preferred_blocks(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(capacity='PASS_HARD_ONLY'); e.make_start()
  r=self.run_rec(e); self.assertNotEqual(r.returncode,0)
  self.assertIn('R1_NOT_PREFERRED',r.stdout+r.stderr)

 def test_head_mismatch_blocks(self):
  e=Env(); self.addCleanup(e.close); e.make_canonical(); e.make_start()
  r=self.run_rec(e,ctrl='7'*40); self.assertNotEqual(r.returncode,0)
  self.assertIn('PRODUCTION_HEAD_MISMATCH',r.stdout+r.stderr)

 def test_script_is_verify_only_by_static_audit(self):
  text=SCRIPT.read_text()
  for bad in ('docker compose up','compose down','docker rm','docker run','mkdir -p "$PGDATA"','CREATE ','ALTER ','DROP '):
   self.assertNotIn(bad,text,bad)
  self.assertIn('R2_RECOVERY_MODE=VERIFY_ONLY',text)
  self.assertIn('R2_START_SHA256',text)
  self.assertIn('RECOVERY_TOOL_SHA',text)
  self.assertIn('ln -- "$TMP_RESULT" "$RESULT"',text)

if __name__=='__main__': unittest.main()
