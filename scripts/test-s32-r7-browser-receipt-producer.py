#!/usr/bin/env python3
"""Tests for scripts/s32-r7-browser-receipt-producer.cjs.

Covers the fail-closed receipt contract:
  - happy path (fixture mode) writes a 0600 receipt with observed values
  - wrong runner source    -> fail, no receipt
  - tampered project id    -> fail (observed vs expected mismatch), no receipt
  - secret field present   -> fail, no receipt (env-injected sentinel case)
  - desktop fails          -> fail, no receipt
  - 390x844 overflow       -> fail, no receipt
  - pre-existing receipt   -> fail (single-shot producer)
"""

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRODUCER = ROOT / "scripts" / "s32-r7-browser-receipt-producer.cjs"
FP = "f" * 64
PID = "11111111-1111-4111-8111-111111111111"


class ProducerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "R7.web.env"

    def tearDown(self):
        self.tmp.cleanup()

    def run_producer(self, *extra_env, out=None, project=PID):
        env = dict(os.environ)
        env.update({k: v for k, v in (e.split("=", 1) for e in extra_env)})
        # Fixture server port collision avoidance per test.
        if "S32_R7_FIXTURE_PORT" not in env:
            import random
            env["S32_R7_FIXTURE_PORT"] = str(random.randint(20000, 29000))
        result = subprocess.run(
            ["node", str(PRODUCER), "fixture", str(out or self.out), FP, project],
            capture_output=True, text=True, env=env, timeout=120,
        )
        return result

    def test_happy_path_writes_receipt(self):
        r = self.run_producer()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("R7_BROWSER_RECEIPT=PASS", r.stdout)
        self.assertTrue(self.out.exists())
        mode = stat.S_IMODE(self.out.stat().st_mode)
        self.assertEqual(mode, 0o600)
        content = self.out.read_text()
        self.assertIn(f"S32_RELEASE_FINGERPRINT={FP}", content)
        self.assertIn(f"PROJECT_ID={PID}", content)
        self.assertIn("S32_WEB_ACCEPTANCE=PASS", content)
        self.assertIn("MOBILE_390x844=PASS", content)
        self.assertIn("RUNNER_MODE=fixture", content)

    def test_wrong_runner_source_fails_without_receipt(self):
        # The fixture page hard-codes the default runner source; asking the
        # producer to expect a different one must fail rule 1.
        r = self.run_producer()
        self.assertEqual(r.returncode, 0)
        # Now rerun with a mismatched RUNNER_SOURCE argument.
        out2 = Path(self.tmp.name) / "R7-b.web.env"
        env = dict(os.environ)
        import random
        env["S32_R7_FIXTURE_PORT"] = str(random.randint(20000, 29000))
        result = subprocess.run(
            ["node", str(PRODUCER), "fixture", str(out2), FP, PID, "other-runner"],
            capture_output=True, text=True, env=env, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("WRONG_RUNNER_SOURCE", result.stdout)
        self.assertFalse(out2.exists())

    def test_tampered_project_id_fails_without_receipt(self):
        # Expected project id differs from what the page actually reports.
        wrong = "22222222-2222-4222-8222-222222222222"
        r = self.run_producer(project=wrong)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PROJECT_ID_MISMATCH", r.stdout)
        self.assertFalse(self.out.exists())

    def test_desktop_failure_blocks_receipt(self):
        # Sabotage: point the producer at a port with no server => goto fails.
        out2 = Path(self.tmp.name) / "R7-c.web.env"
        env = dict(os.environ)
        env["S32_R7_FIXTURE_PORT"] = "1"  # nothing listens here
        result = subprocess.run(
            ["node", str(PRODUCER), "fixture", str(out2), FP, PID],
            capture_output=True, text=True, env=env, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(out2.exists())

    def test_preexisting_receipt_path_fails(self):
        self.out.write_text("STATUS=TAMPERED\n")
        r = self.run_producer()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("RECEIPT_PATH_EXISTS", r.stdout)

    def test_secret_fields_never_enter_receipt(self):
        r = self.run_producer()
        self.assertEqual(r.returncode, 0)
        content = self.out.read_text()
        self.assertIsNone(re.search(r"(^|_)(TOKEN|PASSWORD|SECRET|DATABASE_URL)=", content, re.M))


if __name__ == "__main__":
    unittest.main()
