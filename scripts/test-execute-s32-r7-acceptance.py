#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
EXEC = ROOT / "execute-s32-r7-acceptance.sh"
MAN = ROOT / "s32-release-manifest.py"
SRC = "b" * 40
CTRL = "c" * 40

def manifest():
    return {
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
        "migrationSha256": "a1" * 32,
        "roleBootstrapPath": "deploy/s32-production-roles.sql",
        "roleBootstrapSha256": "b2" * 32,
        "s32OverridePath": "deploy/s32-production.override.yml",
        "s32OverrideSha256": "c3" * 32,
    }

def fp(path):
    out = subprocess.check_output([sys.executable, str(MAN), str(path)], text=True)
    return [x.split("=", 1)[1] for x in out.splitlines() if x.startswith("S32_RELEASE_FINGERPRINT=")][0]

class Env:
    def __init__(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.t.name)
        (self.root / "progress").mkdir()
        self.man = self.root / "manifest.json"
        self.man.write_text(json.dumps(manifest()), encoding="utf-8")
        self.fp = fp(self.man)
        self.r6 = self.root / "progress" / f"s32-rollout-{self.fp}-R6.result.env"
        self.r6.write_text(
            f"STATUS=PASS\nSTAGE=R6\nR6_WEB=PASS\nS32_RELEASE_FINGERPRINT={self.fp}\n",
            encoding="utf-8",
        )
        os.chmod(self.r6, 0o600)
        self.claim = self.root / "progress" / f"s32-rollout-authorization-{self.fp}-R7-claim.env"
        self.write_claim()
        self.api = self.root / "api.env"
        self.api.write_text("S32_PRIVATE_API_TOKEN=TOKEN_SENTINEL\n", encoding="utf-8")
        os.chmod(self.api, 0o600)
        short = self.fp[:12]
        self.acceptance = self.root / "acceptance.env"
        self.acceptance.write_text(
            "\n".join([
                "STATUS=PASS",
                "PROJECT_ID=11111111-1111-4111-8111-111111111111",
                f"PROJECT_NAME=[S32 Production Acceptance] {short}",
                "ASSESSMENT_ID=81111111-1111-4111-8111-111111111111",
                "LEGACY_SEARCH_REGRESSION=PASS",
                "ASSESSMENT_REPLAY=PASS",
                "S32_BACKEND_ACCEPTANCE=PASS",
                "ACCEPTANCE_PROJECT_RETAINED=YES",
                "",
            ]),
            encoding="utf-8",
        )

    def write_claim(self):
        self.claim.write_text(
            "\n".join([
                "AUTHORIZATION_VERSION=1",
                "AUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT",
                "STAGE_GROUP=R7",
                f"S32_RELEASE_FINGERPRINT={self.fp}",
                f"RELEASE_SOURCE_SHA={SRC}",
                f"CONTROL_PLANE_SHA={CTRL}",
                "EXPLICIT_APPROVAL=true",
                "CONSUMABLE_ONCE=true",
                "CAPACITY_HARD_ONLY_ACCEPTED=false",
                "PRODUCTION_WRITE_EXECUTED=false",
                "",
            ]),
            encoding="utf-8",
        )
        os.chmod(self.claim, 0o600)

    def close(self):
        self.t.cleanup()

    def env(self, **extra):
        e = os.environ.copy()
        e.update(
            BOOK_ID_SEARCH_REPO_ROOT=str(self.root),
            S32_RELEASE_MANIFEST_JSON=str(self.man),
            S32_API_ENV_FILE=str(self.api),
            S32_R7_TEST_MODE="true",
            S32_R7_ACCEPTANCE_OUTPUT_FILE=str(self.acceptance),
            S32_R7_FAKE_ACCEPTANCE_EXIT="0",
        )
        e.update({k: str(v) for k, v in extra.items()})
        return e

    def run_api(self, **extra):
        return subprocess.run(
            ["bash", str(EXEC), "--execute-r7-api", self.fp, SRC, CTRL],
            text=True,
            capture_output=True,
            env=self.env(**extra),
        )

    def write_web_receipt(self, project_id="11111111-1111-4111-8111-111111111111"):
        path = self.root / "progress" / f"s32-rollout-{self.fp}-R7.web.env"
        path.write_text(
            "\n".join([
                "STATUS=PASS",
                "STAGE=R7_WEB",
                f"S32_RELEASE_FINGERPRINT={self.fp}",
                f"PROJECT_ID={project_id}",
                "S32_WEB_ACCEPTANCE=PASS",
                "MOBILE_390x844=PASS",
                "NO_HORIZONTAL_OVERFLOW=PASS",
                "",
            ]),
            encoding="utf-8",
        )
        os.chmod(path, 0o600)
        return path

    def complete(self, **extra):
        return subprocess.run(
            ["bash", str(EXEC), "--complete-r7", self.fp, SRC, CTRL],
            text=True,
            capture_output=True,
            env=self.env(**extra),
        )

class R7ExecutorTests(unittest.TestCase):
    def test_success_requires_api_then_web_evidence_before_terminal_receipt(self):
        x = Env(); self.addCleanup(x.close)
        api = x.run_api()
        self.assertEqual(api.returncode, 0, api.stdout + api.stderr)
        self.assertIn("R7_API_ACCEPTANCE=PASS", api.stdout)
        self.assertIn("R7_ACCEPTANCE=PENDING_WEB", api.stdout)
        result = x.root / "progress" / f"s32-rollout-{x.fp}-R7.result.env"
        self.assertFalse(result.exists())

        missing = x.complete()
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("R7_WEB_ACCEPTANCE_MISSING", missing.stdout + missing.stderr)

        x.write_web_receipt()
        done = x.complete()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("R7_ACCEPTANCE=PASS", done.stdout)
        self.assertTrue(result.is_file())
        text = result.read_text()
        self.assertIn(f"S32_RELEASE_FINGERPRINT={x.fp}", text)
        self.assertIn("S32_WEB_ACCEPTANCE=PASS", text)
        self.assertIn("MOBILE_390x844=PASS", text)
        self.assertIn("ACCEPTANCE_PROJECT_RETAINED=YES", text)
        self.assertNotIn("TOKEN_SENTINEL", api.stdout + api.stderr + done.stdout + done.stderr + text)

    def test_missing_or_wrong_claim_blocks_before_acceptance(self):
        x = Env(); self.addCleanup(x.close)
        x.claim.unlink()
        r = x.run_api()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("R7_CLAIM_MISSING", r.stdout + r.stderr)
        self.assertFalse((x.root / "progress" / f"s32-rollout-{x.fp}-R7.start.env").exists())

        y = Env(); self.addCleanup(y.close)
        y.claim.write_text(y.claim.read_text().replace("STAGE_GROUP=R7", "STAGE_GROUP=R6"))
        os.chmod(y.claim, 0o600)
        r = y.run_api()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("R7_CLAIM_MISMATCH", r.stdout + r.stderr)

    def test_failed_acceptance_leaves_incomplete_and_never_auto_retries(self):
        x = Env(); self.addCleanup(x.close)
        r = x.run_api(S32_R7_FAKE_ACCEPTANCE_EXIT="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("R7_ACCEPTANCE_FAILED", r.stdout + r.stderr)
        start = x.root / "progress" / f"s32-rollout-{x.fp}-R7.start.env"
        result = x.root / "progress" / f"s32-rollout-{x.fp}-R7.result.env"
        self.assertTrue(start.is_file())
        self.assertFalse(result.exists())

        r2 = x.run_api()
        self.assertNotEqual(r2.returncode, 0)
        self.assertIn("INCOMPLETE_R7", r2.stdout + r2.stderr)

    def test_wrong_canary_identity_blocks_and_no_secret_leaks(self):
        x = Env(); self.addCleanup(x.close)
        x.acceptance.write_text(
            x.acceptance.read_text().replace(
                f"[S32 Production Acceptance] {x.fp[:12]}",
                "[S32 Production Acceptance] WRONG",
            )
        )
        r = x.run_api()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("R7_ACCEPTANCE_CONTRACT_INVALID", r.stdout + r.stderr)
        self.assertNotIn("TOKEN_SENTINEL", r.stdout + r.stderr)

    def test_web_receipt_must_match_release_and_api_canary(self):
        x = Env(); self.addCleanup(x.close)
        self.assertEqual(x.run_api().returncode, 0)
        x.write_web_receipt(project_id="99999999-9999-4999-8999-999999999999")
        r = x.complete()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("R7_WEB_ACCEPTANCE_CONTRACT_INVALID", r.stdout + r.stderr)

    def test_no_destructive_or_global_compose_commands(self):
        text = EXEC.read_text() if EXEC.exists() else ""
        for bad in ("docker compose down", "docker system prune", "rm -rf", "DROP DATABASE", "DROP SCHEMA"):
            self.assertNotIn(bad, text)

if __name__ == "__main__":
    unittest.main()
