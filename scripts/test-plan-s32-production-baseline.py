#!/usr/bin/env python3
import json, pathlib, subprocess, sys, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parent
SCRIPT=ROOT/'plan-s32-production-baseline.py'

def good():
    return {
      'host':{'whoami':'ubuntu','hostname':'VM-0-4-ubuntu'},
      'checkoutSha':'9a18b2aa86c7cb1b27f6e99f9f5911e80b7b61ec',
      'branch':'main',
      'httpStatus':200,
      'services':{
        'web':{'cid':'w1','startedAt':'2026-09-13T00:00:00Z','image':'book-id-search-web:99a','imageId':'sha256:'+'1'*64,'revision':'9'*40},
        'api':{'cid':'a1','startedAt':'2026-09-13T00:00:00Z','image':'book-id-search-api:3add','imageId':'sha256:'+'2'*64,'revision':'3'*40},
        'meilisearch':{'cid':'m1','startedAt':'2026-09-01T00:00:00Z','image':'getmeili/meilisearch:v1.48.3','imageId':'sha256:'+'3'*64,'revision':'v1.48.3'},
      },
      'postgresPresent':False,'s32EnvNames':[],
      'stats':{'numberOfDocuments':5115734,'isIndexing':False},
      'searches':{k:{'status':'PASS'} for k in ['ISBN','SSID','DXID','title','author','publisher']}
    }

def run(facts):
    with tempfile.TemporaryDirectory() as td:
      p=pathlib.Path(td)/'facts.json'; p.write_text(json.dumps(facts))
      return subprocess.run([sys.executable,str(SCRIPT),'--facts-json',str(p)],text=True,capture_output=True)

class T(unittest.TestCase):
  def test_good_baseline_passes(self):
    r=run(good()); self.assertEqual(r.returncode,0,r.stderr); self.assertIn('R0_FINAL=PASS',r.stdout); self.assertIn('R0_LEGACY_SEARCH_SMOKE=PASS',r.stdout)
  def test_missing_search_blocks(self):
    f=good(); del f['searches']['SSID']; r=run(f); self.assertNotEqual(r.returncode,0); self.assertIn('MISSING_SEARCH:SSID',r.stdout+r.stderr)
  def test_duplicate_service_identity_blocks(self):
    f=good(); f['services']['api']=[f['services']['api'],dict(f['services']['api'])]; r=run(f); self.assertNotEqual(r.returncode,0); self.assertIn('SERVICE_IDENTITY_INVALID:api',r.stdout+r.stderr)
  def test_http_or_indexing_failure_blocks(self):
    f=good(); f['httpStatus']=503; r=run(f); self.assertNotEqual(r.returncode,0); self.assertIn('PUBLIC_HTTP_FAILED',r.stdout+r.stderr)
    f=good(); f['stats']['isIndexing']=True; r=run(f); self.assertNotEqual(r.returncode,0); self.assertIn('MEILI_INDEXING_ACTIVE',r.stdout+r.stderr)
  def test_live_mode_anchors_git_and_runtime_discovery(self):
    text=SCRIPT.read_text() if SCRIPT.exists() else ''
    self.assertIn('BOOK_ID_SEARCH_REPO_ROOT',text)
    self.assertIn("'git','-C',str(repo)",text)
    self.assertIn('com.docker.compose.project',text)
    self.assertIn('com.docker.compose.service',text)

  def test_script_contains_no_mutating_docker_verbs(self):
    text=SCRIPT.read_text() if SCRIPT.exists() else ''
    for bad in ['docker compose up','docker compose down','docker restart','docker pull','docker build','docker rm']:
      self.assertNotIn(bad,text)
if __name__=='__main__': unittest.main()
