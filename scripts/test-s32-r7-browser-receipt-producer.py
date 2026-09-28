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

import hashlib
import http.server
import os
import re
import stat
import subprocess
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRODUCER = ROOT / "scripts" / "s32-r7-browser-receipt-producer.cjs"
FP = "f" * 64
PID = "11111111-1111-4111-8111-111111111111"
CTRL = "c" * 40


@contextmanager
def production_like_server(*, overflow=False):
    project_name = f"[S32 Production Acceptance] {FP[:12]}"

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            wide = '<div style="width:900px">wide</div>' if overflow else ""
            page = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BOOK-ID-SEARCH</title>
<style>
* {{ box-sizing: border-box; }}
body {{ margin: 0; }}
main {{ max-width: 100%; padding: 16px; }}
a {{ overflow-wrap: anywhere; }}
</style>
</head>
<body>
<script>
const token = sessionStorage.getItem("book-id-search:s32-private-token:v1");
const projectId = {PID!r};
const projectName = {project_name!r};
const listPath = "/research/projects";
const detailPath = "/research/projects/" + projectId;
if (location.pathname === listPath) {{
  document.body.innerHTML = token
    ? '<main><h1>我的研究项目</h1><a href="' + detailPath + '">' + projectName + '</a></main>'
    : '<main><h1>我的研究项目</h1></main>';
}} else if (location.pathname === detailPath) {{
  document.body.innerHTML = token
    ? '<main class="research-detail"><h1>' + projectName + '</h1>{wide}</main>'
    : '<main><h1>需要凭据</h1></main>';
}} else {{
  document.body.innerHTML = '<main><h1>404</h1></main>';
}}
</script>
</body>
</html>"""
            encoded = page.encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ProducerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "R7.web.env"

    def tearDown(self):
        self.tmp.cleanup()

    def run_producer(self, *extra_env, out=None, project=PID):
        env = dict(os.environ)
        env["TMPDIR"] = self.tmp.name
        env.update({k: v for k, v in (e.split("=", 1) for e in extra_env)})
        # Fixture server port collision avoidance per test.
        if "S32_R7_FIXTURE_PORT" not in env:
            import random
            env["S32_R7_FIXTURE_PORT"] = str(random.randint(20000, 29000))
        result = subprocess.run(
            ["node", str(PRODUCER), "fixture", str(out or self.out), FP, project, CTRL],
            capture_output=True, text=True, env=env, timeout=120,
        )
        return result

    def run_browser_producer(self, base_url, *, project=PID, token="TOKEN_SENTINEL"):
        env = dict(os.environ)
        env["TMPDIR"] = self.tmp.name
        env["S32_R7_BROWSER_URL"] = f"{base_url}/research/projects"
        env["S32_R7_BROWSER_TOKEN"] = token
        return subprocess.run(
            ["node", str(PRODUCER), "browser", str(self.out), FP, project, CTRL],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )

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
        self.assertIn("RUNNER_VERSION=1", content)
        self.assertIn(f"RUNNER_SOURCE_SHA={CTRL}", content)
        import hashlib
        lines = content.splitlines()
        receipt_hash = [line.split("=", 1)[1] for line in lines if line.startswith("RECEIPT_SHA256=")][0]
        base = "\n".join(line for line in lines if not line.startswith("RECEIPT_SHA256=")) + "\n"
        self.assertEqual(receipt_hash, hashlib.sha256(base.encode()).hexdigest())

    def test_invalid_runner_source_sha_fails_without_receipt(self):
        out2 = Path(self.tmp.name) / "R7-b.web.env"
        env = dict(os.environ)
        import random
        env["S32_R7_FIXTURE_PORT"] = str(random.randint(20000, 29000))
        result = subprocess.run(
            ["node", str(PRODUCER), "fixture", str(out2), FP, PID, "not-a-commit"],
            capture_output=True, text=True, env=env, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("INVALID_RUNNER_SOURCE_SHA", result.stdout)
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

    def test_browser_mode_validates_real_project_list_and_detail(self):
        with production_like_server() as base:
            r = self.run_browser_producer(base)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        content = self.out.read_text()
        self.assertIn("RUNNER_MODE=browser", content)
        self.assertIn(f"PROJECT_ID={PID}", content)
        self.assertIn("S32_WEB_ACCEPTANCE=PASS", content)
        self.assertIn("MOBILE_390x844=PASS", content)
        self.assertIn("NO_HORIZONTAL_OVERFLOW=PASS", content)
        self.assertNotIn("TOKEN_SENTINEL", content)
        lines = content.splitlines()
        expected = next(line.split("=", 1)[1] for line in lines if line.startswith("RECEIPT_SHA256="))
        base_body = "\n".join(line for line in lines if not line.startswith("RECEIPT_SHA256=")) + "\n"
        self.assertEqual(expected, hashlib.sha256(base_body.encode()).hexdigest())

    def test_browser_mode_wrong_project_blocks_without_receipt(self):
        wrong = "22222222-2222-4222-8222-222222222222"
        with production_like_server() as base:
            r = self.run_browser_producer(base, project=wrong)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PROJECT_LIST_TIMEOUT", r.stdout)
        self.assertFalse(self.out.exists())

    def test_browser_mode_mobile_overflow_blocks_without_receipt(self):
        with production_like_server(overflow=True) as base:
            r = self.run_browser_producer(base)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("MOBILE_390_OVERFLOW", r.stdout)
        self.assertFalse(self.out.exists())

    def test_browser_mode_rejects_untrusted_non_loopback_origin_before_token_injection(self):
        env = dict(os.environ)
        env["S32_R7_BROWSER_URL"] = "https://example.com/research/projects"
        env["S32_R7_BROWSER_TOKEN"] = "TOKEN_SENTINEL"
        r = subprocess.run(
            ["node", str(PRODUCER), "browser", str(self.out), FP, PID, CTRL],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("BROWSER_URL_UNTRUSTED_ORIGIN", r.stdout)
        self.assertFalse(self.out.exists())

    def test_browser_mode_rejects_wrong_project_list_path(self):
        with production_like_server() as base:
            env = dict(os.environ)
            env["S32_R7_BROWSER_URL"] = f"{base}/wrong"
            env["S32_R7_BROWSER_TOKEN"] = "TOKEN_SENTINEL"
            r = subprocess.run(
                ["node", str(PRODUCER), "browser", str(self.out), FP, PID, CTRL],
                capture_output=True,
                text=True,
                env=env,
                timeout=120,
            )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("BROWSER_URL_NOT_PROJECT_LIST", r.stdout)
        self.assertFalse(self.out.exists())

    def test_browser_token_is_removed_from_chromium_child_env(self):
        text = PRODUCER.read_text()
        self.assertIn("delete chromeEnv.S32_R7_BROWSER_TOKEN", text)
        self.assertIn("env: chromeEnv", text)

    def assert_no_runtime_profile_leak(self):
        leftovers = list(Path(self.tmp.name).glob("s32-r7-chrome-profile-*"))
        self.assertEqual(leftovers, [], f"leftover profile dirs: {leftovers}")
        ps = subprocess.run(
            ["ps", "-eo", "args="],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(ps.returncode, 0, ps.stderr)
        marker = f"--user-data-dir={self.tmp.name}/s32-r7-chrome-profile-"
        self.assertNotIn(marker, ps.stdout)

    def test_chromium_profile_and_process_cleanup_on_success(self):
        r = self.run_producer()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assert_no_runtime_profile_leak()

    def test_chromium_profile_and_process_cleanup_on_handled_failure(self):
        wrong = "22222222-2222-4222-8222-222222222222"
        r = self.run_producer(project=wrong)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PROJECT_ID_MISMATCH", r.stdout)
        self.assert_no_runtime_profile_leak()

    def test_chromium_uses_isolated_nondefault_user_data_dir(self):
        text = PRODUCER.read_text()
        self.assertIn('fs.mkdtempSync(path.join(os.tmpdir(), "s32-r7-chrome-profile-"))', text)
        self.assertIn('--user-data-dir=${chromeProfileDir}', text)
        self.assertIn('process.kill(-chrome.pid, "SIGKILL")', text)
        self.assertIn('process.kill(-chrome.pid, 0)', text)
        self.assertIn('await terminateChromeGroup()', text)
        self.assertNotIn('if (chrome.exitCode !== null || chrome.signalCode !== null) return;', text)
        self.assertIn('fs.rmSync(chromeProfileDir, { recursive: true, force: true })', text)
        self.assertIn('if (fs.existsSync(chromeProfileDir))', text)
        self.assertNotIn("process.exit(0)", text)

    def test_pass_receipt_is_published_only_after_teardown(self):
        text = PRODUCER.read_text()
        write_pos = text.index('fs.writeFileSync(pendingReceiptPath, receipt')
        teardown_pos = text.index('await terminateChromeGroup()')
        profile_cleanup_pos = text.index('fs.rmSync(chromeProfileDir, { recursive: true, force: true })')
        publish_pos = text.index('fs.linkSync(pendingReceiptPath, OUT)')
        pass_pos = text.index('R7_BROWSER_RECEIPT=PASS')
        self.assertLess(write_pos, teardown_pos)
        self.assertLess(teardown_pos, profile_cleanup_pos)
        self.assertLess(profile_cleanup_pos, publish_pos)
        self.assertLess(publish_pos, pass_pos)
        self.assertNotIn('fs.renameSync(tmp, OUT)', text)


if __name__ == "__main__":
    unittest.main()
