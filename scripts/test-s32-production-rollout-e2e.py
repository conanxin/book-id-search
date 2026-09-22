#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
MAN = ROOT / "s32-release-manifest.py"
AUTH = ROOT / "authorize-s32-production-rollout.sh"
CLAIM = ROOT / "claim-s32-production-rollout.sh"
R2 = ROOT / "execute-s32-r2-postgres.sh"
R3 = ROOT / "execute-s32-r3-schema.sh"
R4 = ROOT / "execute-s32-r4-api-dark.sh"
R5 = ROOT / "execute-s32-r5-activate.sh"
R6 = ROOT / "execute-s32-r6-web.sh"
R7 = ROOT / "execute-s32-r7-acceptance.sh"
PLANNER = ROOT / "plan-s32-production-rollout.py"
SRC = "b" * 40
CTRL = "c" * 40

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(cmd, env):
    return subprocess.run(cmd, text=True, capture_output=True, env=env)

def parse_fp(manifest_path):
    out = subprocess.check_output([sys.executable, str(MAN), str(manifest_path)], text=True)
    return [x.split("=", 1)[1] for x in out.splitlines() if x.startswith("S32_RELEASE_FINGERPRINT=")][0]

class RolloutE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        for p in ("progress", "deploy", "db/migrations", "db/tests", "static"):
            (self.root / p).mkdir(parents=True, exist_ok=True)
        (self.root / "docker-compose.yml").write_text("services: {}\n")
        (self.root / "docker-compose.override.yml").write_text("services: {}\n")
        self.migration = self.root / "db/migrations/001_s32_core_schema.sql"
        self.migration.write_text("BEGIN; CREATE SCHEMA core; CREATE SCHEMA ops; CREATE SCHEMA derived; COMMIT;\n")
        (self.root / "db/tests/001_s32_schema_assertions.sql").write_text("SELECT 1;\n")
        self.role = self.root / "deploy/s32-production-roles.sql"
        self.role.write_text('CREATE ROLE :"app_role";\n')
        self.override = self.root / "deploy/s32-production.override.yml"
        self.override.write_text("services: {}\n")
        self.manifest = self.root / "progress/s32-release-manifest.json"
        self.manifest.write_text(json.dumps({
            "version": 1,
            "sourceSha": SRC,
            "pnpmLockSha256": "1" * 64,
            "apiImageTag": "book-id-search-api:s32-" + SRC,
            "apiImageId": "sha256:" + "2" * 64,
            "apiOciRevision": SRC,
            "apiBaseDigest": "node@sha256:" + "3" * 64,
            "webImageTag": "book-id-search-web:" + SRC,
            "webImageId": "sha256:" + "4" * 64,
            "webOciRevision": SRC,
            "webStaticManifestSha256": "5" * 64,
            "webS32Enabled": True,
            "webNodeBaseDigest": "node@sha256:" + "6" * 64,
            "webNginxBaseDigest": "nginx@sha256:" + "7" * 64,
            "pgImageRef": "postgres@sha256:" + "8" * 64,
            "pgImageId": "sha256:" + "9" * 64,
            "migrationPath": "db/migrations/001_s32_core_schema.sql",
            "migrationSha256": sha(self.migration),
            "roleBootstrapPath": "deploy/s32-production-roles.sql",
            "roleBootstrapSha256": sha(self.role),
            "s32OverridePath": "deploy/s32-production.override.yml",
            "s32OverrideSha256": sha(self.override),
        }))
        self.fp = parse_fp(self.manifest)
        self.r0 = self.root / "progress/s32-r0.env"
        self.r0.write_text("\n".join([
            "STATUS=PASS", "STAGE=R0", "R0_FINAL=PASS",
            "WEB_CID=w1", "WEB_STARTED_AT=wt", "WEB_IMAGE=book-id-search-web:old", "WEB_IMAGE_ID=wi", "WEB_REVISION=" + "d" * 40,
            "API_CID=a1", "API_STARTED_AT=at", "API_IMAGE=book-id-search-api:old", "API_IMAGE_ID=ai", "API_REVISION=" + "e" * 40,
            "MEILISEARCH_CID=m1", "MEILISEARCH_STARTED_AT=mt", "MEILISEARCH_IMAGE_ID=mi",
            "PUBLIC_HTTP_STATUS=200", "",
        ]))
        self.r1 = self.root / "progress/s32-r1.env"
        self.r1.write_text(f"STATUS=PASS\nSTAGE=R1\nS32_RELEASE_FINGERPRINT={self.fp}\nCAPACITY_GATE=PASS_PREFERRED\n")
        os.chmod(self.r0, 0o600); os.chmod(self.r1, 0o600)
        self.pg = self.root / "postgres.env"
        self.pg.write_text("S32_POSTGRES_DB=book_id_search_s32\nS32_POSTGRES_USER=s32_admin\nS32_POSTGRES_PASSWORD=ADMIN_SENTINEL\nS32_APP_PASSWORD=APP_SENTINEL\n")
        os.chmod(self.pg, 0o600)
        self.api = self.root / "api.env"
        self.api.write_text("S32_DATABASE_URL=postgresql://s32_app:APP_SENTINEL@postgres/book_id_search_s32\nS32_PRIVATE_API_TOKEN=TOKEN_SENTINEL\n")
        os.chmod(self.api, 0o600)
        (self.root / "static/index.js").write_text("safe bundle")
        self.base_env = os.environ.copy()
        self.base_env.update(
            BOOK_ID_SEARCH_REPO_ROOT=str(self.root),
            S32_RELEASE_MANIFEST_JSON=str(self.manifest),
            S32_POSTGRES_ENV_FILE=str(self.pg),
            S32_API_ENV_FILE=str(self.api),
            S32_PG_DATA_DIR=str(self.root / "pgdata"),
        )

    def authorize_claim(self, stage):
        env = self.base_env.copy()
        env["S32_EXPLICIT_APPROVAL"] = "true"
        a = run(["bash", str(AUTH), "--authorize-production-rollout", stage, self.fp, SRC, CTRL], env)
        self.assertEqual(a.returncode, 0, a.stdout + a.stderr)
        c = run(["bash", str(CLAIM), "--claim-production-rollout", stage, self.fp, SRC, CTRL], env)
        self.assertEqual(c.returncode, 0, c.stdout + c.stderr)

    def test_r2_through_r7_receipts_form_one_complete_state_machine(self):
        # R2 / R3 share one stage-scoped claim.
        self.authorize_claim("R2_R3")
        r2_post = self.root / "r2-post.json"
        r2_post.write_text(json.dumps({
            "services": {
                "web": {"cid":"w1","startedAt":"wt","imageId":"wi"},
                "api": {"cid":"a1","startedAt":"at","imageId":"ai"},
                "meilisearch": {"cid":"m1","startedAt":"mt","imageId":"mi"},
            },
            "httpStatus": 200,
        }))
        env = self.base_env.copy()
        env.update(
            S32_R0_RECEIPT=str(self.r0), S32_R1_RECEIPT=str(self.r1),
            S32_R2_TEST_MODE="true", S32_R2_FAKE_PG_UID=str(os.getuid()),
            S32_R2_FAKE_PG_GID=str(os.getgid()), S32_R2_POST_FACTS_JSON=str(r2_post),
            S32_R2_COMMAND_LOG=str(self.root/"r2.log"),
        )
        r = run(["bash", str(R2), "--execute-r2", self.fp, SRC, CTRL], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

        env.update(S32_R2_RECEIPT=str(self.root / "progress" / f"s32-rollout-{self.fp}-R2.result.env"),
                   S32_R3_TEST_MODE="true", S32_R3_COMMAND_LOG=str(self.root/"r3.log"))
        r = run(["bash", str(R3), "--execute-r3", self.fp, SRC, CTRL], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

        # R4 / R5 share one claim and exact release identity.
        self.authorize_claim("R4_R5")
        cap4 = self.root / "r4-cap.env"; cap4.write_text("CAPACITY_GATE=PASS_PREFERRED\n")
        r4post = self.root / "r4-post.json"
        r4post.write_text(json.dumps({
            "services":{
                "web":{"cid":"w1","startedAt":"wt","imageId":"wi"},
                "api":{"cid":"newapi","startedAt":"newt","imageId":"sha256:"+"2"*64,"revision":SRC},
                "meilisearch":{"cid":"m1","startedAt":"mt","imageId":"mi"},
            },
            "httpStatus":200, "stats":{"numberOfDocuments":5115734,"isIndexing":False},
            "searches":{k:{"status":"PASS"} for k in ("ISBN","SSID","DXID","title","author","publisher")},
            "s32Enabled":False,
        }))
        r5post = self.root / "r5-post.json"
        r5post.write_text(json.dumps({
            "services":{
                "web":{"cid":"w1","startedAt":"wt","imageId":"wi"},
                "api":{"cid":"newapi2","startedAt":"newt2","imageId":"sha256:"+"2"*64,"revision":SRC},
                "meilisearch":{"cid":"m1","startedAt":"mt","imageId":"mi"},
            },
            "httpStatus":200, "backendAcceptance":"PASS",
        }))
        env.update(
            S32_R3_RECEIPT=str(self.root/"progress"/f"s32-rollout-{self.fp}-R3.result.env"),
            S32_R4_CAPACITY_RECEIPT=str(cap4), S32_R4_R5_TEST_MODE="true",
            S32_R4_POST_FACTS_JSON=str(r4post), S32_R5_POST_FACTS_JSON=str(r5post),
            S32_R4_R5_COMMAND_LOG=str(self.root/"r45.log"),
        )
        r = run(["bash", str(R4), "--execute-r4", self.fp, SRC, CTRL], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        r = run(["bash", str(R5), "--execute-r5", self.fp, SRC, CTRL], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

        # R6 switches only the Web in test mode.
        self.authorize_claim("R6")
        cap6 = self.root / "r6-cap.env"; cap6.write_text("CAPACITY_GATE=PASS_PREFERRED\n")
        candidate = self.root / "web-candidate.json"
        candidate.write_text(json.dumps({
            "tag":"book-id-search-web:"+SRC, "imageId":"sha256:"+"4"*64,
            "gitSha":SRC, "ociRevision":SRC, "webS32Enabled":True,
            "staticManifestSha256":"5"*64,
        }))
        pre6 = self.root / "r6-pre.json"
        pre6.write_text(json.dumps({
            "services":{
                "web":{"cid":"oldw","startedAt":"oldt","imageId":"oldwi","revision":"d"*40},
                "api":{"cid":"api","startedAt":"at","imageId":"sha256:"+"2"*64,"revision":SRC},
                "meilisearch":{"cid":"m","startedAt":"mt","imageId":"mi"},
                "postgres":{"cid":"p","startedAt":"pt","imageId":"sha256:"+"9"*64},
            },"httpStatus":200,
        }))
        post6 = self.root / "r6-post.json"
        post6.write_text(json.dumps({
            "services":{
                "web":{"cid":"neww","startedAt":"newt","imageId":"sha256:"+"4"*64,"revision":SRC},
                "api":{"cid":"api","startedAt":"at","imageId":"sha256:"+"2"*64,"revision":SRC},
                "meilisearch":{"cid":"m","startedAt":"mt","imageId":"mi"},
                "postgres":{"cid":"p","startedAt":"pt","imageId":"sha256:"+"9"*64},
            },"httpStatus":200,
            "searches":{k:{"status":"PASS"} for k in ("ISBN","SSID","DXID","title","author","publisher")},
        }))
        env.update(
            S32_R5_RECEIPT=str(self.root/"progress"/f"s32-rollout-{self.fp}-R5.result.env"),
            S32_R6_CAPACITY_RECEIPT=str(cap6), S32_R6_CANDIDATE_JSON=str(candidate),
            S32_R6_STATIC_DIR=str(self.root/"static"), S32_R6_TEST_MODE="true",
            S32_R6_PRE_FACTS_JSON=str(pre6), S32_R6_POST_FACTS_JSON=str(post6),
            S32_R6_COMMAND_LOG=str(self.root/"r6.log"),
        )
        r = run(["bash", str(R6), "--execute-r6", self.fp, SRC, CTRL], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

        # R7 consumes its own claim and records the retained canary.
        self.authorize_claim("R7")
        accept = self.root / "acceptance.env"
        accept.write_text("\n".join([
            "STATUS=PASS",
            "PROJECT_ID=11111111-1111-4111-8111-111111111111",
            f"PROJECT_NAME=[S32 Production Acceptance] {self.fp[:12]}",
            "ASSESSMENT_ID=81111111-1111-4111-8111-111111111111",
            "LEGACY_SEARCH_REGRESSION=PASS",
            "ASSESSMENT_REPLAY=PASS",
            "S32_BACKEND_ACCEPTANCE=PASS",
            "ACCEPTANCE_PROJECT_RETAINED=YES",
            "",
        ]))
        env.update(
            S32_R6_RECEIPT=str(self.root/"progress"/f"s32-rollout-{self.fp}-R6.result.env"),
            S32_R7_TEST_MODE="true", S32_R7_ACCEPTANCE_OUTPUT_FILE=str(accept),
            S32_R7_FAKE_ACCEPTANCE_EXIT="0",
        )
        r = run(["bash", str(R7), "--execute-r7-api", self.fp, SRC, CTRL], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("R7_ACCEPTANCE=PENDING_WEB", r.stdout)

        web_receipt = self.root / "progress" / f"s32-rollout-{self.fp}-R7.web.env"
        web_receipt.write_text("\n".join([
            "STATUS=PASS",
            "STAGE=R7_WEB",
            f"S32_RELEASE_FINGERPRINT={self.fp}",
            "PROJECT_ID=11111111-1111-4111-8111-111111111111",
            "S32_WEB_ACCEPTANCE=PASS",
            "MOBILE_390x844=PASS",
            "NO_HORIZONTAL_OVERFLOW=PASS",
            "",
        ]))
        os.chmod(web_receipt, 0o600)
        r = run(["bash", str(R7), "--complete-r7", self.fp, SRC, CTRL], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("R7_ACCEPTANCE=PASS", r.stdout)

        # The read-only planner must see the exact receipts emitted by executors.
        proc = run([
            sys.executable, str(PLANNER), "--state-dir", str(self.root/"progress"),
            "--release-fingerprint", self.fp,
        ], self.base_env)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("STATUS=ROLLOUT_COMPLETE", proc.stdout)
        self.assertIn("NEXT_STAGE=NONE", proc.stdout)
        print("ISOLATED_ROLLOUT_E2E=PASS")
        print("PRODUCTION_TOUCHED=NO")

if __name__ == "__main__":
    unittest.main()
