#!/usr/bin/env python3
import hashlib, json, os, pathlib, subprocess, tempfile, unittest

ROOT=pathlib.Path(__file__).resolve().parent
SCRIPT=ROOT/"recover-s32-api-rollback.sh"
FP="a"*64
SRC="b"*40
CTRL="c"*40
TOOL="d"*40
R0_API_ID="sha256:"+"1"*64
R0_API_REV="e"*40

FAKE_DOCKER=r'''#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
if a[:2]==["image","inspect"]:
    if "{{.Id}}" in a:
        print(os.environ["R0_API_ID"])
        raise SystemExit(0)
if a and a[0]=="ps":
    text=" ".join(a)
    if "service=api" in text: print("api1")
    elif "service=meilisearch" in text: print("meili1")
    elif "service=postgres" in text: print("pg1")
    raise SystemExit(0)
if a and a[0]=="inspect":
    cid=a[1]
    fmt=a[-1] if "--format" in a else ""
    if "Config.Env" in fmt:
        if cid in ("api1","meili1"):
            print("MEILI_MASTER_KEY=KEY123")
        raise SystemExit(0)
    if ".State.Health" in fmt:
        print("healthy"); raise SystemExit(0)
if a and a[0]=="port":
    raise SystemExit(0)
if a and a[0]=="exec":
    sql=a[-1]
    if "pg_namespace" in sql: print("3")
    elif "count(*) FROM pg_roles" in sql: print("1")
    elif "rolsuper" in sql: print("0,0,0,0")
    elif "table_schema||'.'||table_name" in sql: print("core.t1\\ncore.t2\\ncore.t3\\ncore.t4\\ncore.t5\\ncore.t6\\ncore.t7\\ncore.t8\\ncore.t9\\ncore.t10\\ncore.t11\\ncore.t12\\ncore.t13\\ncore.t14\\ncore.t15\\ncore.t16\\ncore.t17\\ncore.t18\\ncore.t19\\ncore.t20\\ncore.t21\\ncore.t22\\ncore.t23\\ncore.t24\\ncore.t25\\ncore.t26")
    elif "SELECT EXISTS" in sql: print("f")
    else: raise SystemExit(71)
    raise SystemExit(0)
raise SystemExit(72)
'''

class Env:
    def __init__(self):
        self.t=tempfile.TemporaryDirectory()
        self.base=pathlib.Path(self.t.name)
        self.repo=self.base/"repo"
        self.repo.mkdir()
        self.p=self.repo/"progress"
        self.p.mkdir()
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
            "WEB_CID=w1","WEB_STARTED_AT=wt","WEB_IMAGE_ID=wi","WEB_REVISION="+"f"*40,
            "API_CID=a1","API_STARTED_AT=at","API_IMAGE=book-id-search-api:old","API_IMAGE_ID="+R0_API_ID,"API_REVISION="+R0_API_REV,
            "MEILISEARCH_CID=m1","MEILISEARCH_STARTED_AT=mt","MEILISEARCH_IMAGE_ID=mi","MEILISEARCH_REVISION=meili:old",
            "MEILI_DOCUMENTS=5115734",""
        ]))
        self.r0.chmod(0o600)

        self.auth=self.p/f"s32-rollback-authorization-{FP}-API_TO_R0.env"
        self.auth.write_text("\n".join([
            "AUTHORIZATION_VERSION=1",
            "AUTHORIZED_ACTION=S32_PRODUCTION_ROLLBACK",
            "ROLLBACK_SCOPE=API_TO_R0",
            f"S32_RELEASE_FINGERPRINT={FP}",
            f"RELEASE_SOURCE_SHA={SRC}",
            f"CONTROL_PLANE_SHA={self.head}",
            "EXPLICIT_APPROVAL=true",
            "CONSUMABLE_ONCE=true",
            "PRODUCTION_WRITE_EXECUTED=false",""
        ]))
        self.auth.chmod(0o600)
        self.claim=self.p/f"s32-rollback-authorization-{FP}-API_TO_R0-claim.env"
        os.link(self.auth,self.claim)

        self.start=self.p/f"s32-rollback-{FP}-API_TO_R0.start.env"
        self.start.write_text(f"STATUS=STARTED\nROLLBACK_SCOPE=API_TO_R0\nS32_RELEASE_FINGERPRINT={FP}\n")
        self.start.chmod(0o600)
        self.r4=self.p/f"s32-rollout-{FP}-R4.start.env"
        self.r4.write_text(f"STATUS=STARTED\nSTAGE=R4\nS32_RELEASE_FINGERPRINT={FP}\n")
        self.r4.chmod(0o600)

        self.pg=self.base/"postgres.env"
        self.pg.write_text("S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=x\n")
        self.pg.chmod(0o600)

        self.baseline=self.base/"baseline.json"
        self.baseline.write_text(json.dumps({
            "services":{
                "web":{"cid":"w1","startedAt":"wt","imageId":"wi","revision":"f"*40},
                "api":{"cid":"new-r0","startedAt":"newt","imageId":R0_API_ID,"revision":R0_API_REV},
                "meilisearch":{"cid":"m1","startedAt":"mt","imageId":"mi","revision":"meili:old"},
            },
            "httpStatus":200,
            "s32EnvNames":[],
            "stats":{"numberOfDocuments":5115734,"isIndexing":False},
            "searches":{k:{"status":"PASS"} for k in ("ISBN","SSID","DXID","title","author","publisher")},
        }))

        self.docker=self.base/"docker"
        self.docker.write_text(FAKE_DOCKER)
        self.docker.chmod(0o755)

    def close(self): self.t.cleanup()

    def env(self):
        e=os.environ.copy()
        e.update({
            "BOOK_ID_SEARCH_REPO_ROOT":str(self.repo),
            "S32_R0_RECEIPT":str(self.r0),
            "S32_ROLLBACK_RECOVERY_DOCKER":str(self.docker),
            "S32_ROLLBACK_RECOVERY_BASELINE_JSON":str(self.baseline),
            "S32_POSTGRES_ENV_PATH":str(self.pg),
            "R0_API_ID":R0_API_ID,
        })
        return e

    def run(self,ctrl=None):
        return subprocess.run(
            ["bash",str(SCRIPT),"--recover-api-to-r0-verify-only",FP,SRC,ctrl or self.head,TOOL],
            text=True,capture_output=True,env=self.env()
        )

class T(unittest.TestCase):
    def e(self):
        x=Env(); self.addCleanup(x.close); return x

    def test_verify_only_recovery_writes_terminal_receipt(self):
        x=self.e()
        r=x.run()
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        result=x.p/f"s32-rollback-{FP}-API_TO_R0.result.env"
        self.assertTrue(result.exists())
        self.assertEqual(result.stat().st_mode & 0o777,0o600)
        body=result.read_text()
        for item in [
            "STATUS=PASS","API_ROLLBACK=PASS","ROLLBACK_RECOVERY_MODE=VERIFY_ONLY",
            "LEGACY_RUNTIME_RESTORED=PASS",f"RECOVERY_TOOL_SHA={TOOL}",
            "POSTGRES_DATA_RETAINED=YES","MEILI_UNCHANGED=YES"
        ]:
            self.assertIn(item,body)
        self.assertIn("ROLLBACK_START_SHA256="+hashlib.sha256(x.start.read_bytes()).hexdigest(),body)
        self.assertIn("R4_START_SHA256="+hashlib.sha256(x.r4.read_bytes()).hexdigest(),body)

    def test_wrong_head_or_terminal_receipt_blocks(self):
        x=self.e()
        r=x.run(ctrl="0"*40)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("PRODUCTION_HEAD_MISMATCH",r.stdout+r.stderr)
        y=self.e()
        (y.p/f"s32-rollback-{FP}-API_TO_R0.result.env").write_text("x")
        r=y.run()
        self.assertNotEqual(r.returncode,0)
        self.assertIn("ROLLBACK_ALREADY_TERMINAL",r.stdout+r.stderr)

    def test_runtime_or_key_drift_blocks_before_write(self):
        x=self.e()
        d=json.loads(x.baseline.read_text()); d["searches"]["SSID"]["status"]="FAIL"
        x.baseline.write_text(json.dumps(d))
        r=x.run()
        self.assertNotEqual(r.returncode,0)
        self.assertIn("LEGACY_RUNTIME_NOT_R0",r.stdout+r.stderr)
        self.assertFalse((x.p/f"s32-rollback-{FP}-API_TO_R0.result.env").exists())

    def test_static_verify_only_boundary(self):
        text=SCRIPT.read_text()
        for bad in ("docker compose up","compose down","docker restart","docker run","docker pull","docker load","docker build","docker rm","docker rmi"):
            self.assertNotIn(bad,text)
        for needed in ("ROLLBACK_RECOVERY_MODE=VERIFY_ONLY","ROLLBACK_START_SHA256","R4_START_SHA256","RECOVERY_TOOL_SHA"):
            self.assertIn(needed,text)

if __name__=="__main__":
    unittest.main()
