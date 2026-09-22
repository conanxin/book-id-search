#!/usr/bin/env python3
import json,pathlib,subprocess,sys,tempfile,unittest
S=pathlib.Path(__file__).resolve().parent/'plan-s32-production-capacity.py'
G=1024**3

def facts(free,used,api=100_000_000,web=100_000_000,separate=False,data_free=None,data_used=10):
  return {'releaseFingerprint':'a'*64,'releaseSourceSha':'b'*40,
    'api':{'sourceSha':'b'*40,'compressedBytes':api,'tarBytes':api,'imageBytes':api},
    'web':{'sourceSha':'b'*40,'compressedBytes':web,'tarBytes':web,'imageBytes':web},
    'filesystems':{'docker':{'id':'root','freeBytes':free,'usedPercent':used},'release':{'id':'root','freeBytes':free,'usedPercent':used},'data':{'id':'data' if separate else 'root','freeBytes':data_free if separate else free,'usedPercent':data_used if separate else used}}}

def run(f):
 with tempfile.TemporaryDirectory() as d:
  p=pathlib.Path(d)/'f.json'; p.write_text(json.dumps(f)); return subprocess.run([sys.executable,str(S),'--facts-json',str(p)],text=True,capture_output=True)
class T(unittest.TestCase):
 def test_preferred(self):
  r=run(facts(25*G,50)); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('CAPACITY_GATE=PASS_PREFERRED',r.stdout)
 def test_hard_only(self):
  r=run(facts(int(22.5*G),50)); self.assertEqual(r.returncode,0,r.stdout+r.stderr); self.assertIn('CAPACITY_GATE=PASS_HARD_ONLY',r.stdout)
 def test_below_reserve_blocks(self):
  r=run(facts(int(20.3*G),50)); self.assertNotEqual(r.returncode,0); self.assertIn('CAPACITY_GATE=BLOCKED_CAPACITY',r.stdout)
 def test_used_over_80_blocks(self):
  r=run(facts(30*G,82)); self.assertNotEqual(r.returncode,0); self.assertIn('USED_AFTER_PEAK_LIMIT',r.stdout+r.stderr)
 def test_separate_data_requires_its_own_headroom(self):
  r=run(facts(30*G,50,separate=True,data_free=int(19*G),data_used=70)); self.assertNotEqual(r.returncode,0); self.assertIn('DATA_FILESYSTEM_CAPACITY',r.stdout+r.stderr)
 def test_source_mismatch_blocks(self):
  f=facts(30*G,50); f['web']['sourceSha']='c'*40; r=run(f); self.assertNotEqual(r.returncode,0); self.assertIn('SOURCE_SHA_MISMATCH',r.stdout+r.stderr)
if __name__=='__main__': unittest.main()
