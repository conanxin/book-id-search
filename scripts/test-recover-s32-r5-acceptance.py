#!/usr/bin/env python3
import json, os, pathlib, subprocess, tempfile, unittest

ROOT=pathlib.Path(__file__).resolve().parent
SCRIPT=ROOT/"recover-s32-r5-acceptance.sh"
FP="a"*64
SRC="b"*40
TOOL="d"*40
API_OBS="sha256:"+"3"*64
API_CONFIG="sha256:"+"2"*64
R0_API_ID="sha256:"+"4"*64
R0_API_REV="e"*40
WEB_REV="f"*40
TOKEN="1"*64
PROJECT_ID="11111111-1111-4111-8111-111111111111"
ASSESSMENT_ID="22222222-2222-4222-8222-222222222222"

FAKE_DOCKER=r'''#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
if a and a[0]=="ps":
    t=" ".join(a)
    if "service=api" in t: print("api-active")
    elif "service=postgres" in t: print("pg1")
    elif "service=meilisearch" in t: print("meili1")
    raise SystemExit(0)
if a and a[0]=="inspect":
    cid=a[1]; fmt=a[-1]
    if "Config.Env" in fmt:
        if cid=="api-active":
            print("S32_FEATURES_ENABLED=true")
            print("S32_DATABASE_URL="+os.environ["TEST_DBURL"])
            print("S32_PRIVATE_API_TOKEN="+os.environ["TEST_TOKEN"])
            print("MEILI_MASTER_KEY=KEY123")
        raise SystemExit(0)
    if cid=="pg1" and ".State.Health" in fmt:
        print("healthy"); raise SystemExit(0)
if a and a[0]=="port":
    raise SystemExit(0)
if a and a[0]=="exec":
    sql=a[-1]
    if ":'" in sql:
        raise SystemExit(70)
    if "pg_namespace" in sql: print("3")
    elif "count(*) FROM pg_roles" in sql: print("1")
    elif "rolsuper" in sql: print("0,0,0,0")
    elif "table_schema||'.'||table_name" in sql: print("\n".join([f"core.t{i}" for i in range(1,27)]))
    elif "SELECT EXISTS" in sql: print("t" if "core.t1" in sql else "f")
    elif "FROM core.projects" in sql:
        print("1" if os.environ.get("TEST_PROJECT_OK","1")=="1" else "0")
    elif "FROM core.assessments" in sql:
        print("1" if os.environ.get("TEST_ASSESSMENT_OK","1")=="1" else "0")
    elif "FROM ops.idempotency_keys" in sql:
        print("1" if os.environ.get("TEST_RECEIPT_OK","1")=="1" else "0")
    else: raise SystemExit(71)
    raise SystemExit(0)
raise SystemExit(72)
'''

FAKE_CURL=r'''#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
header=""
if "-H" in a: header=a[a.index("-H")+1]
if not header: print("401",end="")
elif header=="Authorization: Bearer "+os.environ["TEST_TOKEN"]: print("200",end="")
else: print("403",end="")
'''

FAKE_BASELINE=r'''#!/usr/bin/env python3
import json,os,pathlib,sys
out=pathlib.Path(sys.argv[sys.argv.index("--json-out")+1])
facts={
 "host":{"whoami":"ubuntu","hostname":"VM-0-4-ubuntu"},
 "checkoutSha":os.environ["TEST_CTRL"],"branch":"main","httpStatus":200,
 "services":{
   "web":{"cid":"w1","startedAt":"wt","image":"web-old","imageId":"wi","revision":os.environ["TEST_WEB_REV"]},
   "api":{"cid":"api-active","startedAt":"t2","image":"s32","imageId":os.environ["TEST_API_OBS"],"revision":os.environ["TEST_SRC"]},
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

class Env:
    def __init__(self):
        self.t=tempfile.TemporaryDirectory()
        self.base=pathlib.Path(self.t.name)
        self.repo=self.base/"repo"; self.repo.mkdir()
        self.p=self.repo/"progress"; self.p.mkdir()
        (self.repo/"scripts").mkdir()
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
            "API_CID=r0","API_STARTED_AT=r0t","API_IMAGE=old","API_IMAGE_ID="+R0_API_ID,"API_REVISION="+R0_API_REV,
            "MEILISEARCH_CID=m1","MEILISEARCH_STARTED_AT=mt","MEILISEARCH_IMAGE=meili-old","MEILISEARCH_IMAGE_ID=mi","MEILISEARCH_REVISION=meili-old",
            "MEILI_DOCUMENTS=5115734",""
        ])); self.r0.chmod(0o600)

        self.r4=self.p/f"s32-rollout-{FP}-R4.result.env"
        self.r4.write_text("\n".join([
            "STATUS=PASS","STAGE=R4","R4_API_DARK=PASS",
            f"S32_RELEASE_FINGERPRINT={FP}",f"RELEASE_SOURCE_SHA={SRC}",
            f"API_IMAGE_ID={API_OBS}",f"API_CONFIG_DIGEST={API_CONFIG}",f"API_REVISION={SRC}",
            "S32_FEATURES_ENABLED=false",""
        ])); self.r4.chmod(0o600)

        self.claim=self.p/f"s32-rollout-authorization-{FP}-R4_R5-claim.env"
        self.claim.write_text("\n".join([
            "STAGE_GROUP=R4_R5",f"S32_RELEASE_FINGERPRINT={FP}",f"RELEASE_SOURCE_SHA={SRC}",
            f"CONTROL_PLANE_SHA={self.head}",""
        ])); self.claim.chmod(0o600)

        import urllib.parse
        self.pg=self.base/"postgres.env"
        self.pg.write_text("S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_APP_PASSWORD=p%40ss\n")
        self.pg.chmod(0o600)
        self.dburl="postgresql://s32_app:"+urllib.parse.quote("p%40ss",safe="")+"@postgres/book_id_search_s32"
        self.api=self.base/"api.env"
        self.api.write_text(f"S32_DATABASE_URL={self.dburl}\nS32_PRIVATE_API_TOKEN={TOKEN}\n"); self.api.chmod(0o600)

        self.start=self.p/f"s32-rollout-{FP}-R5.start.env"
        import hashlib
        claim_sha=hashlib.sha256(self.claim.read_bytes()).hexdigest()
        self.start.write_text("\n".join([
            "STATUS=STARTED","STAGE=R5",f"S32_RELEASE_FINGERPRINT={FP}",f"RELEASE_SOURCE_SHA={SRC}",
            f"CONTROL_PLANE_SHA={self.head}",f"R4_R5_CLAIM_SHA256={claim_sha}",
            "EXTERNAL_TOOL_SHA="+"c"*40,""
        ])); self.start.chmod(0o600)

        self.plan=self.repo/"scripts/plan-s32-production-baseline.py"
        self.plan.write_text(FAKE_BASELINE); self.plan.chmod(0o755)

        self.bin=self.base/"bin"; self.bin.mkdir()
        for name,body in [("docker",FAKE_DOCKER),("curl",FAKE_CURL)]:
            p=self.bin/name; p.write_text(body); p.chmod(0o755)

    def close(self): self.t.cleanup()

    def env(self,**extra):
        e=os.environ.copy()
        e.update({
          "PATH":str(self.bin)+os.pathsep+e.get("PATH",""),
          "BOOK_ID_SEARCH_REPO_ROOT":str(self.repo),
          "S32_R0_RECEIPT":str(self.r0),"S32_R4_RECEIPT":str(self.r4),
          "S32_POSTGRES_ENV_FILE":str(self.pg),"S32_API_ENV_FILE":str(self.api),
          "S32_R5_RECOVERY_DOCKER":str(self.bin/"docker"),
          "TEST_CTRL":self.head,"TEST_SRC":SRC,"TEST_WEB_REV":WEB_REV,
          "TEST_API_OBS":API_OBS,"TEST_DBURL":self.dburl,"TEST_TOKEN":TOKEN,
        })
        e.update(extra)
        return e

    def run(self,ctrl=None,project=PROJECT_ID,assessment=ASSESSMENT_ID,**extra):
        return subprocess.run(
            ["bash",str(SCRIPT),"--recover-r5-acceptance",FP,SRC,ctrl or self.head,TOOL,project,assessment],
            text=True,capture_output=True,env=self.env(**extra)
        )

class T(unittest.TestCase):
    def e(self):
        x=Env(); self.addCleanup(x.close); return x

    def test_success_writes_terminal_r5_result(self):
        x=self.e(); r=x.run()
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        result=x.p/f"s32-rollout-{FP}-R5.result.env"
        self.assertTrue(result.exists())
        self.assertEqual(result.stat().st_mode & 0o777,0o600)
        body=result.read_text()
        for item in (
            "STATUS=PASS","STAGE=R5","R5_S32_ACTIVATION=PASS",
            "BACKEND_ACCEPTANCE=PASS","R5_EXECUTION_MODE=EXTERNAL_ACCEPTANCE_RECOVERY",
            f"RECOVERY_TOOL_SHA={TOOL}",f"ACCEPTANCE_PROJECT_ID={PROJECT_ID}",
            f"ASSESSMENT_ID={ASSESSMENT_ID}","ASSESSMENT_REPLAY=PASS",
            "IDEMPOTENCY_RECEIPT_DB_PROOF=PASS","PRIVATE_UNAUTH_STATUS=401",
            "PRIVATE_WRONG_TOKEN_STATUS=403","PRIVATE_AUTHORIZED_STATUS=200"
        ): self.assertIn(item,body)

    def test_db_identity_mismatches_block_before_result(self):
        for key,reason in (
            ("TEST_PROJECT_OK","ACCEPTANCE_PROJECT_DB_MISMATCH"),
            ("TEST_ASSESSMENT_OK","ACCEPTANCE_ASSESSMENT_DB_MISMATCH"),
            ("TEST_RECEIPT_OK","ACCEPTANCE_IDEMPOTENCY_DB_MISMATCH"),
        ):
            x=self.e(); r=x.run(**{key:"0"})
            self.assertNotEqual(r.returncode,0)
            self.assertIn(reason,r.stdout+r.stderr)
            self.assertFalse((x.p/f"s32-rollout-{FP}-R5.result.env").exists())

    def test_wrong_head_or_existing_result_blocks(self):
        x=self.e(); r=x.run(ctrl="0"*40)
        self.assertNotEqual(r.returncode,0); self.assertIn("PRODUCTION_HEAD_MISMATCH",r.stdout+r.stderr)
        y=self.e(); result=y.p/f"s32-rollout-{FP}-R5.result.env"; result.write_text("x"); result.chmod(0o600)
        r=y.run(); self.assertNotEqual(r.returncode,0); self.assertIn("R5_ALREADY_TERMINAL",r.stdout+r.stderr)

    def test_static_no_container_mutation_and_syntax(self):
        syn=subprocess.run(["bash","-n",str(SCRIPT)],text=True,capture_output=True)
        self.assertEqual(syn.returncode,0,syn.stdout+syn.stderr)
        text=SCRIPT.read_text()
        for bad in ("compose ","docker restart","docker run","docker pull","docker load","docker build","docker rm","docker rmi"):
            self.assertNotIn(bad,text)
        self.assertNotIn(":'pid'",text)
        self.assertNotIn(":'aid'",text)
        self.assertNotIn("-v pid=",text)
        self.assertNotIn("-v aid=",text)
        self.assertIn("id::text='$PROJECT_ID'",text)
        self.assertIn("id::text='$ASSESSMENT_ID'",text)
        self.assertIn("R5_EXECUTION_MODE=EXTERNAL_ACCEPTANCE_RECOVERY",text)
        self.assertIn("IDEMPOTENCY_RECEIPT_DB_PROOF=PASS",text)

if __name__=="__main__":
    unittest.main()
