#!/usr/bin/env python3
import json, os, pathlib, subprocess, tempfile, unittest

ROOT=pathlib.Path(__file__).resolve().parent
SCRIPT=ROOT/"recover-s32-r4-after-rollback.sh"
FP="a"*64
SRC="b"*40
CTRL="c"*40
TOOL="d"*40
API_TAG="book-id-search-api:s32-"+SRC
API_CONFIG="sha256:"+"2"*64
API_OBS="sha256:"+"3"*64
R0_API_ID="sha256:"+"4"*64
R0_API_REV="e"*40
WEB_REV="f"*40

FAKE_SUDO=r'''#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
if a and a[0]=="-n": a=a[1:]
if a and a[0]=="env":
    env=os.environ.copy()
    i=1
    while i<len(a) and "=" in a[i] and not a[i].startswith("-"):
        k,v=a[i].split("=",1); env[k]=v; i+=1
    os.execvpe(a[i],a[i:],env)
os.execvpe(a[0],a,os.environ)
'''

FAKE_DOCKER=r'''#!/usr/bin/env python3
import json,os,sys
a=sys.argv[1:]
if a and a[0]=="ps":
    t=" ".join(a)
    if "service=meilisearch" in t: print("meili1")
    elif "service=postgres" in t: print("pg1")
    elif "service=api" in t: print("api1")
    raise SystemExit(0)
if a and a[0]=="inspect":
    cid=a[1]; fmt=a[-1]
    if "Config.Env" in fmt:
        if cid=="meili1": print("MEILI_MASTER_KEY=KEY123")
        elif cid=="api1":
            print("S32_FEATURES_ENABLED=false")
            print("S32_DATABASE_URL=")
            print("S32_PRIVATE_API_TOKEN=")
            print("MEILI_MASTER_KEY=KEY123")
        raise SystemExit(0)
    if cid=="pg1" and ".State.StartedAt" in fmt:
        print("pgcid|2026-01-01T00:00:00Z|sha256:pg|healthy|[]")
        raise SystemExit(0)
if a and a[0]=="port":
    raise SystemExit(0)
if a and a[0]=="exec":
    sql=a[-1]
    if "pg_namespace" in sql: print("3")
    elif "count(*) FROM pg_roles" in sql: print("1")
    elif "rolsuper" in sql: print("0,0,0,0")
    elif "table_schema||'.'||table_name" in sql: print("\n".join([f"core.t{i}" for i in range(1,27)]))
    elif "SELECT EXISTS" in sql: print("f")
    else: raise SystemExit(71)
    raise SystemExit(0)
if a and a[0]=="compose":
    if "config" in a:
        print(json.dumps({"services":{"api":{
            "image":os.environ["TEST_API_TAG"],
            "environment":{
                "S32_FEATURES_ENABLED":"false",
                "S32_DATABASE_URL":"",
                "S32_PRIVATE_API_TOKEN":"",
                "MEILI_MASTER_KEY":"KEY123"
            }
        }}}))
        raise SystemExit(0)
    if "up" in a:
        log=os.environ.get("TEST_DOCKER_LOG")
        if log:
            open(log,"a").write(" ".join(a)+"\n")
        raise SystemExit(0)
raise SystemExit(72)
'''

FAKE_MANIFEST=r'''#!/usr/bin/env python3
import os
print("STATUS=PASS")
print("SOURCE_SHA="+os.environ["TEST_SRC"])
print("S32_RELEASE_FINGERPRINT="+os.environ["TEST_FP"])
print("MANIFEST_VALIDATED=true")
'''

FAKE_VERIFY=r'''#!/usr/bin/env bash
echo STATUS=PASS
echo OBSERVED_IMAGE_ID="$TEST_API_OBS"
echo CONFIG_DIGEST="$TEST_API_CONFIG"
echo BACKEND_IDENTITY_MODE=MANIFEST_DIGEST
echo OCI_REVISION="$TEST_SRC"
'''

FAKE_BASELINE=r'''#!/usr/bin/env python3
import json,os,pathlib,sys
state=pathlib.Path(os.environ["TEST_BASELINE_STATE"])
n=int(state.read_text())+1 if state.exists() else 1
state.write_text(str(n))
out=pathlib.Path(sys.argv[sys.argv.index("--json-out")+1])
r0=n==1
api={
  "cid":"r0api" if r0 else "darkapi",
  "startedAt":"r0t" if r0 else "darkt",
  "image":"book-id-search-api:old" if r0 else os.environ["TEST_API_TAG"],
  "imageId":os.environ["TEST_R0_API_ID"] if r0 else os.environ["TEST_API_OBS"],
  "revision":os.environ["TEST_R0_API_REV"] if r0 else os.environ["TEST_SRC"],
}
facts={
 "host":{"whoami":"ubuntu","hostname":"VM-0-4-ubuntu"},
 "checkoutSha":os.environ["TEST_CTRL"],"branch":"main","httpStatus":200,
 "services":{
   "web":{"cid":"w1","startedAt":"wt","image":"web-old","imageId":"wi","revision":os.environ["TEST_WEB_REV"]},
   "api":api,
   "meilisearch":{"cid":"m1","startedAt":"mt","image":"meili-old","imageId":"mi","revision":"meili-old"},
 },
 "postgresPresent":True,
 "s32EnvNames":[] if r0 else ["S32_DATABASE_URL","S32_FEATURES_ENABLED","S32_PRIVATE_API_TOKEN"],
 "stats":{"numberOfDocuments":5115734,"isIndexing":False},
 "searches":{k:{"status":"PASS"} for k in ("ISBN","SSID","DXID","title","author","publisher")}
}
out.write_text(json.dumps(facts))
print("STATUS=PASS")
'''

class Env:
    def __init__(self):
        self.t=tempfile.TemporaryDirectory()
        self.base=pathlib.Path(self.t.name)
        self.repo=self.base/"repo"; self.repo.mkdir()
        self.p=self.repo/"progress"; self.p.mkdir()
        (self.repo/"scripts").mkdir()
        (self.repo/"deploy").mkdir()
        subprocess.check_call(["git","init","-b","main"],cwd=self.repo,stdout=subprocess.DEVNULL)
        subprocess.check_call(["git","-C",str(self.repo),"config","user.email","t@t"],stdout=subprocess.DEVNULL)
        subprocess.check_call(["git","-C",str(self.repo),"config","user.name","t"],stdout=subprocess.DEVNULL)
        (self.repo/"x").write_text("x")
        subprocess.check_call(["git","-C",str(self.repo),"add","-A"],stdout=subprocess.DEVNULL)
        subprocess.check_call(["git","-C",str(self.repo),"commit","-m","x"],stdout=subprocess.DEVNULL)
        self.head=subprocess.check_output(["git","-C",str(self.repo),"rev-parse","HEAD"],text=True).strip()

        self.r0=self.p/"s32-r0.env"
        self.r0.write_text("\n".join([
            "R0_FINAL=PASS",
            "WEB_CID=w1","WEB_STARTED_AT=wt","WEB_IMAGE=web-old","WEB_IMAGE_ID=wi","WEB_REVISION="+WEB_REV,
            "API_CID=r0api","API_STARTED_AT=r0t","API_IMAGE=book-id-search-api:old","API_IMAGE_ID="+R0_API_ID,"API_REVISION="+R0_API_REV,
            "MEILISEARCH_CID=m1","MEILISEARCH_STARTED_AT=mt","MEILISEARCH_IMAGE=meili-old","MEILISEARCH_IMAGE_ID=mi","MEILISEARCH_REVISION=meili-old",
            "MEILI_DOCUMENTS=5115734",""
        ])); self.r0.chmod(0o600)

        self.r3=self.p/f"s32-rollout-{FP}-R3.result.env"
        self.r3.write_text(f"STATUS=PASS\nR3_SCHEMA=PASS\nS32_RELEASE_FINGERPRINT={FP}\n"); self.r3.chmod(0o600)

        self.cap=self.p/"s32-r4-capacity.env"
        self.cap.write_text(f"STATUS=PASS\nCAPACITY_GATE=PASS_PREFERRED\nS32_RELEASE_FINGERPRINT={FP}\nRELEASE_SOURCE_SHA={SRC}\n"); self.cap.chmod(0o600)

        self.auth=self.p/f"s32-rollout-authorization-{FP}-R4_R5.env"
        self.auth.write_text("\n".join([
            "AUTHORIZATION_VERSION=1","AUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT","STAGE_GROUP=R4_R5",
            f"S32_RELEASE_FINGERPRINT={FP}",f"RELEASE_SOURCE_SHA={SRC}",f"CONTROL_PLANE_SHA={self.head}",
            "EXPLICIT_APPROVAL=true","CONSUMABLE_ONCE=true","CAPACITY_HARD_ONLY_ACCEPTED=false","PRODUCTION_WRITE_EXECUTED=false",""
        ])); self.auth.chmod(0o600)
        self.claim=self.p/f"s32-rollout-authorization-{FP}-R4_R5-claim.env"; os.link(self.auth,self.claim)

        self.r4start=self.p/f"s32-rollout-{FP}-R4.start.env"
        self.r4start.write_text(f"STATUS=STARTED\nSTAGE=R4\nS32_RELEASE_FINGERPRINT={FP}\n"); self.r4start.chmod(0o600)

        self.rb=self.p/f"s32-rollback-{FP}-API_TO_R0.result.env"
        self.rb.write_text("\n".join([
            "STATUS=PASS","ROLLBACK_SCOPE=API_TO_R0","API_ROLLBACK=PASS",
            f"S32_RELEASE_FINGERPRINT={FP}",f"RELEASE_SOURCE_SHA={SRC}",f"CONTROL_PLANE_SHA={self.head}",
            "LEGACY_RUNTIME_RESTORED=PASS",""
        ])); self.rb.chmod(0o600)

        self.pg=self.base/"postgres.env"
        self.pg.write_text("S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\n"); self.pg.chmod(0o600)
        self.prod=self.repo/".env"; self.prod.write_text("MEILI_MASTER_KEY=KEY123\n")

        self.man=self.p/"s32-release-manifest.json"
        self.man.write_text(json.dumps({
            "apiImageTag":API_TAG,"apiImageId":API_CONFIG,"apiOciRevision":SRC,
            "pgImageRef":"postgres@sha256:"+"9"*64,
            "s32OverridePath":"deploy/s32-production.override.yml"
        }))
        self.override=self.repo/"deploy/s32-production.override.yml"; self.override.write_text("services: {}\n")
        self.apiov=self.base/"api.override.yml"; self.apiov.write_text("services: {}\n")
        self.webov=self.base/"web.override.yml"; self.webov.write_text("services: {}\n")
        (self.repo/"docker-compose.yml").write_text("services: {}\n")
        (self.repo/"docker-compose.override.yml").write_text("services: {}\n")

        self.man_tool=self.repo/"scripts/s32-release-manifest.py"; self.man_tool.write_text(FAKE_MANIFEST); self.man_tool.chmod(0o755)
        self.ver=self.repo/"scripts/verify-s32-local-image.sh"; self.ver.write_text(FAKE_VERIFY); self.ver.chmod(0o755)
        self.plan=self.repo/"scripts/plan-s32-production-baseline.py"; self.plan.write_text(FAKE_BASELINE); self.plan.chmod(0o755)

        self.bin=self.base/"bin"; self.bin.mkdir()
        self.sudo=self.bin/"sudo"; self.sudo.write_text(FAKE_SUDO); self.sudo.chmod(0o755)
        self.docker=self.bin/"docker"; self.docker.write_text(FAKE_DOCKER); self.docker.chmod(0o755)
        self.state=self.base/"baseline-state"
        self.log=self.base/"docker.log"

    def close(self): self.t.cleanup()

    def env(self):
        e=os.environ.copy()
        e.update({
          "PATH":str(self.bin)+os.pathsep+e.get("PATH",""),
          "BOOK_ID_SEARCH_REPO_ROOT":str(self.repo),
          "S32_R0_RECEIPT":str(self.r0),
          "S32_R3_RECEIPT":str(self.r3),
          "S32_R4_CAPACITY_RECEIPT":str(self.cap),
          "S32_RELEASE_MANIFEST_JSON":str(self.man),
          "S32_PRODUCTION_ENV_FILE":str(self.prod),
          "S32_POSTGRES_ENV_FILE":str(self.pg),
          "S32_R4_RECOVERY_API_OVERRIDE":str(self.apiov),
          "S32_R4_RECOVERY_WEB_OVERRIDE":str(self.webov),
          "TEST_FP":FP,"TEST_SRC":SRC,"TEST_CTRL":self.head,
          "TEST_API_TAG":API_TAG,"TEST_API_CONFIG":API_CONFIG,"TEST_API_OBS":API_OBS,
          "TEST_R0_API_ID":R0_API_ID,"TEST_R0_API_REV":R0_API_REV,"TEST_WEB_REV":WEB_REV,
          "TEST_BASELINE_STATE":str(self.state),"TEST_DOCKER_LOG":str(self.log)
        })
        return e

    def run(self,ctrl=None):
        return subprocess.run(
          ["bash",str(SCRIPT),"--recover-r4-after-rollback",FP,SRC,ctrl or self.head,TOOL],
          text=True,capture_output=True,env=self.env()
        )

class T(unittest.TestCase):
    def e(self):
        x=Env(); self.addCleanup(x.close); return x

    def test_success_terminalizes_r4_with_recovery_provenance(self):
        x=self.e()
        r=x.run()
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn("R4_RECOVERY=AFTER_API_TO_R0_ROLLBACK_PASS",r.stdout)
        result=x.p/f"s32-rollout-{FP}-R4.result.env"
        self.assertTrue(result.exists())
        self.assertEqual(result.stat().st_mode & 0o777,0o600)
        body=result.read_text()
        for item in (
          "STATUS=PASS","R4_API_DARK=PASS","R4_RECOVERY_MODE=AFTER_API_TO_R0_ROLLBACK",
          f"RECOVERY_TOOL_SHA={TOOL}",f"API_IMAGE_ID={API_OBS}",f"API_CONFIG_DIGEST={API_CONFIG}",
          "S32_FEATURES_ENABLED=false"
        ):
            self.assertIn(item,body)
        rec=x.p/f"s32-rollout-{FP}-R4.recovery.start.env"
        self.assertTrue(rec.exists())
        self.assertIn("ROLLBACK_RESULT_SHA256=",body)
        self.assertIn("R4_START_SHA256=",body)
        self.assertIn("--no-build --no-deps api",x.log.read_text())

    def test_wrong_head_or_missing_rollback_terminal_blocks_before_recovery_start(self):
        x=self.e()
        r=x.run(ctrl="0"*40)
        self.assertNotEqual(r.returncode,0); self.assertIn("PRODUCTION_HEAD_MISMATCH",r.stdout+r.stderr)
        y=self.e(); y.rb.unlink()
        r=y.run()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse((y.p/f"s32-rollout-{FP}-R4.recovery.start.env").exists())

    def test_recovery_is_one_shot(self):
        x=self.e(); self.assertEqual(x.run().returncode,0)
        again=x.run()
        self.assertNotEqual(again.returncode,0)
        self.assertTrue("R4_ALREADY_TERMINAL" in again.stdout+again.stderr or "R4_RECOVERY_ALREADY_STARTED" in again.stdout+again.stderr)

    def test_static_boundary_and_syntax(self):
        syn=subprocess.run(["bash","-n",str(SCRIPT)],text=True,capture_output=True)
        self.assertEqual(syn.returncode,0,syn.stdout+syn.stderr)
        text=SCRIPT.read_text()
        self.assertNotIn("docker compose down",text)
        self.assertNotIn("docker system prune",text)
        self.assertNotIn("docker pull",text)
        self.assertNotIn("docker load",text)
        self.assertNotIn("docker build",text)
        self.assertIn("--no-build --no-deps api",text)
        self.assertIn("R4_RECOVERY_MODE=AFTER_API_TO_R0_ROLLBACK",text)
        self.assertIn("ROLLBACK_RESULT_SHA256",text)
        self.assertIn("RECOVERY_TOOL_SHA",text)

if __name__=="__main__":
    unittest.main()
