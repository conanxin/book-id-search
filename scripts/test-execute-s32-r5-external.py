#!/usr/bin/env python3
import json, os, pathlib, subprocess, tempfile, unittest

ROOT=pathlib.Path(__file__).resolve().parent
SCRIPT=ROOT/"execute-s32-r5-external.sh"
FP="a"*64
SRC="b"*40
TOOL="d"*40
API_TAG="book-id-search-api:s32-"+SRC
API_CONFIG="sha256:"+"2"*64
API_OBS="sha256:"+"3"*64
R0_API_ID="sha256:"+"4"*64
R0_API_REV="e"*40
WEB_REV="f"*40
TOKEN="1"*64
APP_PASSWORD="p@ss:word"

FAKE_SUDO=r'''#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
if a and a[0]=="-n": a=a[1:]
if a and a[0]=="env":
    env=os.environ.copy(); i=1
    while i<len(a) and "=" in a[i] and not a[i].startswith("-"):
        k,v=a[i].split("=",1); env[k]=v; i+=1
    os.execvpe(a[i],a[i:],env)
os.execvpe(a[0],a,os.environ)
'''

FAKE_DOCKER=r'''#!/usr/bin/env python3
import json,os,sys
a=sys.argv[1:]
state=os.environ["TEST_STATE"]
active=os.path.exists(state)
accepted=os.path.exists(os.environ["TEST_ACCEPT_STATE"])
if a and a[0]=="ps":
    t=" ".join(a)
    if "service=api" in t: print("api-active" if active else "api-dark")
    elif "service=meilisearch" in t: print("meili1")
    elif "service=postgres" in t: print("pg1")
    raise SystemExit(0)
if a and a[0]=="inspect":
    cid=a[1]; fmt=a[-1]
    if "Config.Env" in fmt:
        if cid=="meili1":
            print("MEILI_MASTER_KEY=KEY123")
        elif cid.startswith("api-"):
            print("S32_FEATURES_ENABLED="+("true" if active else "false"))
            print("S32_DATABASE_URL="+(os.environ["TEST_DBURL"] if active else ""))
            print("S32_PRIVATE_API_TOKEN="+(os.environ["TEST_TOKEN"] if active else ""))
            print("MEILI_MASTER_KEY=KEY123")
        raise SystemExit(0)
    if cid=="pg1" and ".State.StartedAt" in fmt:
        print("pgcid|2026-01-01T00:00:00Z|sha256:pg|healthy|[]")
        raise SystemExit(0)
if a and a[0]=="port":
    raise SystemExit(0)
if a and a[0]=="exec":
    sql=a[-1]
    if "SELECT current_user" in sql: print("s32_app")
    elif "pg_namespace" in sql: print("3")
    elif "count(*) FROM pg_roles" in sql: print("1")
    elif "rolsuper" in sql: print("0,0,0,0")
    elif "table_schema||'.'||table_name" in sql: print("\n".join([f"core.t{i}" for i in range(1,27)]))
    elif "SELECT EXISTS" in sql: print("t" if accepted and "core.t1" in sql else "f")
    else: raise SystemExit(71)
    raise SystemExit(0)
if a and a[0]=="compose":
    if "config" in a:
        print(json.dumps({"services":{"api":{
            "image":os.environ["TEST_API_TAG"],
            "environment":{
                "S32_FEATURES_ENABLED":"true",
                "S32_DATABASE_URL":os.environ["TEST_DBURL"],
                "S32_PRIVATE_API_TOKEN":os.environ["TEST_TOKEN"],
                "MEILI_MASTER_KEY":"KEY123"
            },
            "ports":["127.0.0.1:3001:3001"]
        }}}))
        raise SystemExit(0)
    if "up" in a:
        pathlib=__import__("pathlib")
        pathlib.Path(state).write_text("active")
        log=os.environ.get("TEST_DOCKER_LOG")
        if log: open(log,"a").write(" ".join(a)+"\n")
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
active=pathlib.Path(os.environ["TEST_STATE"]).exists()
out=pathlib.Path(sys.argv[sys.argv.index("--json-out")+1])
facts={
 "host":{"whoami":"ubuntu","hostname":"VM-0-4-ubuntu"},
 "checkoutSha":os.environ["TEST_CTRL"],"branch":"main","httpStatus":200,
 "services":{
   "web":{"cid":"w1","startedAt":"wt","image":"web-old","imageId":"wi","revision":os.environ["TEST_WEB_REV"]},
   "api":{"cid":"api-active" if active else "api-dark","startedAt":"t2" if active else "t1","image":os.environ["TEST_API_TAG"],"imageId":os.environ["TEST_API_OBS"],"revision":os.environ["TEST_SRC"]},
   "meilisearch":{"cid":"m1","startedAt":"mt","image":"meili-old","imageId":"mi","revision":"meili-old"},
 },
 "postgresPresent":True,
 "s32EnvNames":["S32_DATABASE_URL","S32_FEATURES_ENABLED","S32_PRIVATE_API_TOKEN"],
 "stats":{"numberOfDocuments":5115734,"isIndexing":False},
 "searches":{k:{"status":"PASS"} for k in ("ISBN","SSID","DXID","title","author","publisher")}
}
out.write_text(json.dumps(facts))
print("STATUS=PASS")
'''

FAKE_CURL=r'''#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
header=""
if "-H" in a:
    header=a[a.index("-H")+1]
if not header:
    print("401",end="")
elif header=="Authorization: Bearer "+os.environ["TEST_TOKEN"]:
    print("200",end="")
else:
    print("403",end="")
'''

FAKE_PNPM=r'''#!/usr/bin/env python3
import os,pathlib
pathlib.Path(os.environ["TEST_ACCEPT_STATE"]).write_text("accepted")
print("STATUS=PASS")
print("PROJECT_ID=11111111-1111-4111-8111-111111111111")
print("PROJECT_NAME=[S32 Production Acceptance] "+os.environ["TEST_FP"][:12])
print("ASSESSMENT_ID=22222222-2222-4222-8222-222222222222")
print("LEGACY_SEARCH_REGRESSION=PASS")
print("ASSESSMENT_REPLAY=PASS")
print("S32_BACKEND_ACCEPTANCE=PASS")
print("MEILI_DOCUMENTS=5115734")
print("ACCEPTANCE_PROJECT_RETAINED=YES")
'''

class Env:
    def __init__(self):
        self.t=tempfile.TemporaryDirectory()
        self.base=pathlib.Path(self.t.name)
        self.repo=self.base/"repo"; self.repo.mkdir()
        self.p=self.repo/"progress"; self.p.mkdir()
        (self.repo/"scripts").mkdir(); (self.repo/"deploy").mkdir()
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

        self.r4=self.p/f"s32-rollout-{FP}-R4.result.env"
        self.r4.write_text("\n".join([
            "STATUS=PASS","STAGE=R4","R4_API_DARK=PASS",f"S32_RELEASE_FINGERPRINT={FP}",f"RELEASE_SOURCE_SHA={SRC}",
            "MEILI_DOCUMENTS=5115734",f"API_IMAGE_ID={API_OBS}",f"API_CONFIG_DIGEST={API_CONFIG}",
            "API_IDENTITY_MODE=MANIFEST_DIGEST",f"API_REVISION={SRC}","S32_FEATURES_ENABLED=false",""
        ])); self.r4.chmod(0o600)

        self.claim=self.p/f"s32-rollout-authorization-{FP}-R4_R5-claim.env"
        self.claim.write_text("\n".join([
            "STAGE_GROUP=R4_R5",f"S32_RELEASE_FINGERPRINT={FP}",f"RELEASE_SOURCE_SHA={SRC}",
            f"CONTROL_PLANE_SHA={self.head}","EXPLICIT_APPROVAL=true","CONSUMABLE_ONCE=true",""
        ])); self.claim.chmod(0o600)

        self.pg=self.base/"postgres.env"
        self.pg.write_text(f"S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_APP_PASSWORD={APP_PASSWORD}\n"); self.pg.chmod(0o600)
        import urllib.parse
        self.dburl="postgresql://s32_app:"+urllib.parse.quote(APP_PASSWORD,safe="")+"@postgres/book_id_search_s32"
        self.api=self.base/"api.env"
        self.api.write_text(f"S32_DATABASE_URL={self.dburl}\nS32_PRIVATE_API_TOKEN={TOKEN}\n"); self.api.chmod(0o600)
        self.prod=self.repo/".env"; self.prod.write_text("MEILI_MASTER_KEY=KEY123\n")

        self.man=self.p/"s32-release-manifest.json"
        self.man.write_text(json.dumps({
            "apiImageTag":API_TAG,"apiImageId":API_CONFIG,"apiOciRevision":SRC,
            "pgImageRef":"postgres@sha256:"+"9"*64,
            "s32OverridePath":"deploy/s32-production.override.yml"
        }))
        (self.repo/"deploy/s32-production.override.yml").write_text("services: {}\n")
        self.apiov=self.base/"api.override.yml"; self.apiov.write_text("services: {}\n")
        self.webov=self.base/"web.override.yml"; self.webov.write_text("services: {}\n")
        (self.repo/"docker-compose.yml").write_text("services: {}\n")
        (self.repo/"docker-compose.override.yml").write_text("services: {}\n")

        self.man_tool=self.repo/"scripts/s32-release-manifest.py"; self.man_tool.write_text(FAKE_MANIFEST); self.man_tool.chmod(0o755)
        self.ver=self.repo/"scripts/verify-s32-local-image.sh"; self.ver.write_text(FAKE_VERIFY); self.ver.chmod(0o755)
        self.plan=self.repo/"scripts/plan-s32-production-baseline.py"; self.plan.write_text(FAKE_BASELINE); self.plan.chmod(0o755)

        self.bin=self.base/"bin"; self.bin.mkdir()
        for name,body in [("sudo",FAKE_SUDO),("docker",FAKE_DOCKER),("curl",FAKE_CURL),("pnpm",FAKE_PNPM)]:
            p=self.bin/name; p.write_text(body); p.chmod(0o755)
        self.state=self.base/"state"; self.accept=self.base/"accept"; self.log=self.base/"docker.log"

    def close(self): self.t.cleanup()

    def env(self):
        e=os.environ.copy()
        e.update({
          "PATH":str(self.bin)+os.pathsep+e.get("PATH",""),
          "BOOK_ID_SEARCH_REPO_ROOT":str(self.repo),
          "S32_R0_RECEIPT":str(self.r0),"S32_R4_RECEIPT":str(self.r4),
          "S32_RELEASE_MANIFEST_JSON":str(self.man),
          "S32_PRODUCTION_ENV_FILE":str(self.prod),"S32_POSTGRES_ENV_FILE":str(self.pg),"S32_API_ENV_FILE":str(self.api),
          "S32_R5_EXTERNAL_API_OVERRIDE":str(self.apiov),"S32_R5_EXTERNAL_WEB_OVERRIDE":str(self.webov),
          "TEST_FP":FP,"TEST_SRC":SRC,"TEST_CTRL":self.head,"TEST_API_TAG":API_TAG,
          "TEST_API_CONFIG":API_CONFIG,"TEST_API_OBS":API_OBS,"TEST_WEB_REV":WEB_REV,
          "TEST_TOKEN":TOKEN,"TEST_DBURL":self.dburl,"TEST_STATE":str(self.state),"TEST_ACCEPT_STATE":str(self.accept),
          "TEST_DOCKER_LOG":str(self.log)
        })
        return e

    def run(self,ctrl=None):
        return subprocess.run(["bash",str(SCRIPT),"--execute-r5-external",FP,SRC,ctrl or self.head,TOOL],
                              text=True,capture_output=True,env=self.env())

class T(unittest.TestCase):
    def e(self):
        x=Env(); self.addCleanup(x.close); return x

    def test_success_activates_and_terminalizes_r5(self):
        x=self.e(); r=x.run()
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn("R5_S32_ACTIVATION=PASS",r.stdout)
        result=x.p/f"s32-rollout-{FP}-R5.result.env"
        self.assertTrue(result.exists())
        body=result.read_text()
        for item in (
          "STATUS=PASS","R5_S32_ACTIVATION=PASS","S32_FEATURES_ENABLED=true",
          "BACKEND_ACCEPTANCE=PASS",f"EXTERNAL_TOOL_SHA={TOOL}",
          "PRIVATE_UNAUTH_STATUS=401","PRIVATE_WRONG_TOKEN_STATUS=403","PRIVATE_AUTHORIZED_STATUS=200",
          "ASSESSMENT_REPLAY=PASS","ACCEPTANCE_PROJECT_RETAINED=YES"
        ): self.assertIn(item,body)
        self.assertIn("--no-build --no-deps api",x.log.read_text())

    def test_wrong_head_or_existing_start_blocks(self):
        x=self.e(); r=x.run(ctrl="0"*40)
        self.assertNotEqual(r.returncode,0); self.assertIn("PRODUCTION_HEAD_MISMATCH",r.stdout+r.stderr)
        y=self.e(); (y.p/f"s32-rollout-{FP}-R5.start.env").write_text("x")
        r=y.run(); self.assertNotEqual(r.returncode,0)
        self.assertIn("R5_ALREADY_STARTED",r.stdout+r.stderr)

    def test_bad_api_env_blocks_before_start(self):
        x=self.e(); x.api.write_text("S32_DATABASE_URL=postgresql://wrong\nS32_PRIVATE_API_TOKEN="+TOKEN+"\n")
        r=x.run(); self.assertNotEqual(r.returncode,0)
        self.assertIn("API_ENV_CONTRACT_INVALID",r.stdout+r.stderr)
        self.assertFalse((x.p/f"s32-rollout-{FP}-R5.start.env").exists())

    def test_static_boundary_and_syntax(self):
        syn=subprocess.run(["bash","-n",str(SCRIPT)],text=True,capture_output=True)
        self.assertEqual(syn.returncode,0,syn.stdout+syn.stderr)
        text=SCRIPT.read_text()
        for bad in ("docker compose down","docker system prune","docker pull","docker load","docker build"):
            self.assertNotIn(bad,text)
        self.assertIn("--no-build --no-deps api",text)
        self.assertIn("PRIVATE_UNAUTH_STATUS=401",text)
        self.assertIn("ASSESSMENT_REPLAY=PASS",text)

if __name__=="__main__":
    unittest.main()
