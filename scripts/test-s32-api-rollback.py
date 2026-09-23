#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parent
AUTH=ROOT/"authorize-s32-production-rollback.sh"
ROLLBACK=ROOT/"rollback-s32-api-to-r0.sh"
FP="a"*64
SRC="b"*40
CTRL="c"*40

class Env:
    def __init__(self):
        self.t=tempfile.TemporaryDirectory()
        self.root=pathlib.Path(self.t.name)
        (self.root/"progress").mkdir()
        (self.root/"docker-compose.yml").write_text("services: {}\n")
        (self.root/"docker-compose.override.yml").write_text("services: {}\n")
        self.r0=self.root/"r0.env"
        self.r0.write_text("\n".join([
            "R0_FINAL=PASS",
            "WEB_CID=w1","WEB_STARTED_AT=wt","WEB_IMAGE=book-id-search-web:old","WEB_IMAGE_ID=wi","WEB_REVISION="+"d"*40,
            "API_CID=a1","API_STARTED_AT=at","API_IMAGE=book-id-search-api:old","API_IMAGE_ID=ai","API_REVISION="+"e"*40,
            "MEILISEARCH_CID=m1","MEILISEARCH_STARTED_AT=mt","MEILISEARCH_IMAGE=meili:old","MEILISEARCH_IMAGE_ID=mi","MEILISEARCH_REVISION=meili:old",
            "PUBLIC_HTTP_STATUS=200",
        ])+"\n")
        self.post=self.root/"post.json"
        self.post.write_text(json.dumps({
            "services":{
                "web":{"cid":"w1","startedAt":"wt","imageId":"wi","revision":"d"*40},
                "api":{"cid":"a2","startedAt":"at2","imageId":"ai","revision":"e"*40},
                "meilisearch":{"cid":"m1","startedAt":"mt","imageId":"mi","revision":"meili:old"},
            },
            "httpStatus":200,
            "postgresPresent":True,
            "s32EnvNames":[],
            "stats":{"numberOfDocuments":5115734,"isIndexing":False},
            "searches":{k:{"status":"PASS"} for k in ("ISBN","SSID","DXID","title","author","publisher")},
        }))
        self.log=self.root/"rollback.log"
        (self.root/"progress"/f"s32-rollout-{FP}-R4.start.env").write_text("STATUS=STARTED\n")

    def close(self):
        self.t.cleanup()

    def env(self):
        e=os.environ.copy()
        e.update({
            "BOOK_ID_SEARCH_REPO_ROOT":str(self.root),
            "S32_R0_RECEIPT":str(self.r0),
            "S32_API_ROLLBACK_TEST_MODE":"true",
            "S32_API_ROLLBACK_COMMAND_LOG":str(self.log),
            "S32_API_ROLLBACK_POST_FACTS_JSON":str(self.post),
        })
        return e

    def authorize(self):
        return subprocess.run(
            ["bash",str(AUTH),"--authorize-api-to-r0",FP,SRC,CTRL],
            text=True,capture_output=True,env=self.env()
        )

    def rollback(self):
        return subprocess.run(
            ["bash",str(ROLLBACK),"--rollback-api-to-r0",FP,SRC,CTRL],
            text=True,capture_output=True,env=self.env()
        )

class RollbackTests(unittest.TestCase):
    def test_authorization_is_mode_600_nonsecret_and_one_time(self):
        x=Env(); self.addCleanup(x.close)
        r=x.authorize(); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        path=x.root/"progress"/f"s32-rollback-authorization-{FP}-API_TO_R0.env"
        self.assertEqual(oct(path.stat().st_mode & 0o777),"0o600")
        text=path.read_text()
        self.assertIn("AUTHORIZED_ACTION=S32_PRODUCTION_ROLLBACK",text)
        self.assertIn("ROLLBACK_SCOPE=API_TO_R0",text)
        self.assertNotRegex(text,r"TOKEN|PASSWORD|DATABASE_URL")
        again=x.authorize(); self.assertNotEqual(again.returncode,0)
        self.assertIn("AUTHORIZATION_EXISTS",again.stdout+again.stderr)

    def test_rollback_changes_api_only_and_retains_postgres(self):
        x=Env(); self.addCleanup(x.close)
        self.assertEqual(x.authorize().returncode,0)
        r=x.rollback(); self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn("API_ROLLBACK=PASS",r.stdout)
        self.assertIn("POSTGRES_DATA_RETAINED=YES",r.stdout)
        command=x.log.read_text()
        self.assertIn("--no-build --no-deps api",command)
        self.assertNotIn("s32-production.override",command)
        self.assertNotIn(" postgres",command)
        result=list((x.root/"progress").glob("*API_TO_R0.result.env"))
        self.assertEqual(len(result),1)

    def test_rollback_requires_explicit_authorization_and_is_not_retryable(self):
        x=Env(); self.addCleanup(x.close)
        r=x.rollback(); self.assertNotEqual(r.returncode,0)
        self.assertIn("ROLLBACK_AUTHORIZATION_MISSING",r.stdout+r.stderr)

        y=Env(); self.addCleanup(y.close)
        self.assertEqual(y.authorize().returncode,0)
        self.assertEqual(y.rollback().returncode,0)
        again=y.rollback(); self.assertNotEqual(again.returncode,0)
        self.assertTrue(
            "ROLLBACK_AUTH_ALREADY_CLAIMED" in again.stdout+again.stderr
            or "INCOMPLETE_OR_TERMINAL_ROLLBACK" in again.stdout+again.stderr
        )

    def test_later_stage_blocks_api_only_rollback(self):
        x=Env(); self.addCleanup(x.close)
        self.assertEqual(x.authorize().returncode,0)
        (x.root/"progress"/f"s32-rollout-{FP}-R6.start.env").write_text("STATUS=STARTED\n")
        r=x.rollback(); self.assertNotEqual(r.returncode,0)
        self.assertIn("LATER_STAGE_PRESENT",r.stdout+r.stderr)
        self.assertFalse(x.log.exists())

    def test_post_rollback_identity_drift_fails_closed(self):
        x=Env(); self.addCleanup(x.close)
        self.assertEqual(x.authorize().returncode,0)
        facts=json.loads(x.post.read_text())
        facts["services"]["meilisearch"]["cid"]="changed"
        x.post.write_text(json.dumps(facts))
        r=x.rollback(); self.assertNotEqual(r.returncode,0)
        self.assertIn("POST_ROLLBACK_VERIFY_FAILED",r.stdout+r.stderr)
        self.assertTrue(any((x.root/"progress").glob("*API_TO_R0.start.env")))
        self.assertFalse(any((x.root/"progress").glob("*API_TO_R0.result.env")))

    def test_scripts_never_delete_pgdata_or_auto_down_stack(self):
        text=AUTH.read_text()+ROLLBACK.read_text()
        self.assertNotIn("rm -rf",text)
        self.assertNotIn("docker compose down",text)
        self.assertNotIn("docker system prune",text)
        self.assertNotIn("AUTO_ROLLBACK=true",text)

if __name__=="__main__":
    unittest.main()
