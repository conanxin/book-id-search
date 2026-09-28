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
import json
import http.server
import os
import re
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
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


@contextmanager
def production_like_signal_server():
    project_name = f"[S32 Production Acceptance] {FP[:12]}"
    token_reload_seen = threading.Event()
    list_requests = {"count": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/research/projects"):
                list_requests["count"] += 1
                if list_requests["count"] >= 2:
                    token_reload_seen.set()

            page = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BOOK-ID-SEARCH</title>
</head>
<body>
<script>
const token = sessionStorage.getItem("book-id-search:s32-private-token:v1");
const projectName = {project_name!r};
document.body.innerHTML = token
  ? '<main><h1>我的研究项目</h1><p data-token-state="present">' + projectName + '</p></main>'
  : '<main><h1>我的研究项目</h1></main>';
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
        yield f"http://{host}:{port}", token_reload_seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ProducerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "R7.web.env"
        self.observation = Path(self.tmp.name) / "spawn.json"
        preload = Path(self.tmp.name) / "observe-spawn.cjs"
        preload.write_text("""
const cp = require('child_process');
const original = cp.spawn;
cp.spawn = function(exe, args, opts) {
  const child = original.apply(this, arguments);
  require('fs').writeFileSync(process.env.S32_TEST_SPAWN, JSON.stringify({
    profile: args.find(a => a.startsWith('--user-data-dir=')).split('=')[1],
    pid: child.pid, port: Number(args.find(a => a.startsWith('--remote-debugging-port=')).split('=')[1])
  }));
  return child;
};
""")
        from unittest.mock import patch
        self.env_patch = patch.dict(os.environ, NODE_OPTIONS=f"--require={preload}", S32_TEST_SPAWN=str(self.observation))
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

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

    def wait_for_devtools_closed(self, port, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.2)
            try:
                if sock.connect_ex(("127.0.0.1", port)) != 0:
                    return True
            finally:
                sock.close()
            time.sleep(0.05)
        return False

    def run_signal_cleanup_case(self, sig, *, repeat_during_cleanup=False):
        out2 = Path(self.tmp.name) / f"signal-{sig.name.lower()}.web.env"
        env = dict(os.environ)
        env["TMPDIR"] = self.tmp.name
        env["S32_R7_BROWSER_TOKEN"] = "TOKEN_SENTINEL"
        node_options = []
        cleanup_entered = Path(self.tmp.name) / "cleanup-entered"
        cleanup_release = Path(self.tmp.name) / "cleanup-release"
        if repeat_during_cleanup:
            # Delay the real profile deletion so a second OS signal arrives
            # after the first signal's handler, while teardown is still active.
            preload = Path(self.tmp.name) / "slow-profile-cleanup.cjs"
            preload.write_text("""
const fs = require('fs');
const path = require('path');
const originalRm = fs.rmSync;
fs.rmSync = function(target, ...args) {
  if (path.basename(String(target)) === 'profile' && String(target).startsWith('/tmp/s32-r7-')) {
    fs.writeFileSync(path.join(process.env.TMPDIR, 'cleanup-entered'), 'ready');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(process.env.TMPDIR, 'cleanup-release')) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return originalRm.call(this, target, ...args);
};
""")
            node_options = ["--require", str(preload)]

        with production_like_signal_server() as (base, token_reload_seen):
            env["S32_R7_BROWSER_URL"] = f"{base}/research/projects"
            proc = subprocess.Popen(
                ["node", *node_options, str(PRODUCER), "browser", str(out2), FP, PID, CTRL],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            devtools_port = 10000 + (proc.pid % 50000)
            self.assertTrue(
                token_reload_seen.wait(timeout=20),
                "browser never reached the post-token reload",
            )
            profile_deadline = time.monotonic() + 5
            while time.monotonic() < profile_deadline:
                profiles = [Path(json.loads(self.observation.read_text())["profile"])] if self.observation.exists() else []
                if profiles:
                    break
                time.sleep(0.05)
            self.assertTrue(profiles, "isolated Chromium profile never appeared")

            proc.send_signal(sig)
            if repeat_during_cleanup:
                deadline = time.monotonic() + 10
                while not cleanup_entered.exists() and proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(cleanup_entered.exists(), "producer did not reach profile teardown")
                proc.send_signal(sig)
                time.sleep(0.1)
                cleanup_release.touch()
            stdout, stderr = proc.communicate(timeout=30)

        self.assertNotEqual(proc.returncode, 0, stdout + stderr)
        self.assertIn(f"TERMINATED_BY_{sig.name}", stdout)
        self.assertFalse(out2.exists(), "canonical PASS receipt survived signal teardown")
        self.assertEqual(
            list(Path(self.tmp.name).glob(".r7-web-receipt.*.tmp")),
            [],
            "pending receipt survived signal teardown",
        )
        self.assert_no_runtime_profile_leak()
        self.assertTrue(
            self.wait_for_devtools_closed(devtools_port),
            f"DevTools TCP endpoint still reachable on {devtools_port}",
        )

    def test_sigterm_after_token_reload_routes_through_teardown(self):
        self.run_signal_cleanup_case(signal.SIGTERM)

    def test_sigint_after_token_reload_routes_through_teardown(self):
        self.run_signal_cleanup_case(signal.SIGINT)

    def test_repeated_sigterm_during_profile_cleanup_stays_structured(self):
        self.run_signal_cleanup_case(signal.SIGTERM, repeat_during_cleanup=True)

    def test_repeated_sigint_during_profile_cleanup_stays_structured(self):
        self.run_signal_cleanup_case(signal.SIGINT, repeat_during_cleanup=True)

    def run_first_signal_during_cleanup_case(self, sig, *, phase="profile"):
        # The page succeeds and creates pending evidence before the FIRST
        # signal arrives while synchronous profile deletion blocks JS callbacks.
        entered = Path(self.tmp.name) / "first-signal-cleanup-entered"
        release = Path(self.tmp.name) / "first-signal-cleanup-release"
        preload = Path(self.tmp.name) / "first-signal-cleanup.cjs"
        preload.write_text("""
const fs = require('fs');
const path = require('path');
const originalRm = fs.rmSync;
function pauseAt(phase) {
  if (process.env.S32_TEST_SIGNAL_PHASE === phase) {
    fs.writeFileSync(path.join(process.env.TMPDIR, 'first-signal-cleanup-entered'), 'ready');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(process.env.TMPDIR, 'first-signal-cleanup-release')) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
fs.rmSync = function(target, ...args) {
  if (path.basename(String(target)) === 'profile' && String(target).startsWith('/tmp/s32-r7-')) pauseAt('profile');
  return originalRm.call(this, target, ...args);
};
const originalLink = fs.linkSync;
fs.linkSync = function(...args) {
  pauseAt('link');
  return originalLink.apply(this, args);
};
const originalUnlink = fs.unlinkSync;
fs.unlinkSync = function(target, ...args) {
  if (path.basename(String(target)).startsWith('.r7-web-receipt.')) pauseAt('unlink');
  return originalUnlink.call(this, target, ...args);
};
const originalWrite = process.stdout.write;
process.stdout.write = function(chunk, ...args) {
  if (String(chunk).startsWith('R7_BROWSER_RECEIPT=PASS')) pauseAt('stdout');
  return originalWrite.call(this, chunk, ...args);
};
""")
        env = dict(os.environ)
        env.update(TMPDIR=self.tmp.name, S32_R7_BROWSER_TOKEN="TOKEN_SENTINEL", S32_TEST_SIGNAL_PHASE=phase)
        with production_like_server() as base:
            env["S32_R7_BROWSER_URL"] = f"{base}/research/projects"
            proc = subprocess.Popen(
                ["node", "--require", str(preload), str(PRODUCER), "browser", str(self.out), FP, PID, CTRL],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
            )
            deadline = time.monotonic() + 30
            while not entered.exists() and proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            reached_cleanup = entered.exists()
            pending_before_signal = list(Path(self.tmp.name).glob(".r7-web-receipt.*.tmp"))
            canonical_before_signal = self.out.exists()
            if reached_cleanup:
                proc.send_signal(sig)
                time.sleep(0.1)
            release.touch()
            stdout, stderr = proc.communicate(timeout=30)

        self.assertTrue(reached_cleanup, stdout + stderr)
        self.assertEqual(len(pending_before_signal), 0 if phase == "stdout" else 1)
        self.assertEqual(canonical_before_signal, phase in ("unlink", "stdout"))
        self.assert_no_runtime_profile_leak()
        self.assertTrue(self.wait_for_devtools_closed(10000 + proc.pid % 50000))
        self.assertNotEqual(proc.returncode, 0, stdout + stderr)
        self.assertIn(f"TERMINATED_BY_{sig.name}", stdout)
        if phase != "stdout":
            self.assertNotIn("R7_BROWSER_RECEIPT=PASS", stdout)
        self.assertFalse(self.out.exists(), "queued signal still published canonical PASS")
        self.assertEqual(list(Path(self.tmp.name).glob(".r7-web-receipt.*.tmp")), [])

    def test_first_sigterm_during_profile_cleanup_blocks_publication(self):
        self.run_first_signal_during_cleanup_case(signal.SIGTERM)

    def test_first_sigint_during_profile_cleanup_blocks_publication(self):
        self.run_first_signal_during_cleanup_case(signal.SIGINT)

    def test_sigterm_during_canonical_link_fails_closed(self):
        self.run_first_signal_during_cleanup_case(signal.SIGTERM, phase="link")

    def test_sigint_during_canonical_link_fails_closed(self):
        self.run_first_signal_during_cleanup_case(signal.SIGINT, phase="link")

    def test_sigterm_during_pending_unlink_fails_closed(self):
        self.run_first_signal_during_cleanup_case(signal.SIGTERM, phase="unlink")

    def test_sigint_during_pending_unlink_fails_closed(self):
        self.run_first_signal_during_cleanup_case(signal.SIGINT, phase="unlink")

    def test_sigterm_during_pass_stdout_fails_closed(self):
        self.run_first_signal_during_cleanup_case(signal.SIGTERM, phase="stdout")

    def test_sigint_during_pass_stdout_fails_closed(self):
        self.run_first_signal_during_cleanup_case(signal.SIGINT, phase="stdout")

    def run_failed_pass_output_case(self, *, broken_pipe):
        env = dict(os.environ, TMPDIR=self.tmp.name)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            env["S32_R7_FIXTURE_PORT"] = str(sock.getsockname()[1])
        node_args = []
        if not broken_pipe:
            preload = Path(self.tmp.name) / "throw-pass-output.cjs"
            preload.write_text("""
const originalWrite = process.stdout.write;
process.stdout.write = function(chunk, ...args) {
  if (String(chunk).startsWith('R7_BROWSER_RECEIPT=PASS')) {
    throw Object.assign(new Error('local failing sink'), {code: 'EIO'});
  }
  return originalWrite.call(this, chunk, ...args);
};
""")
            node_args = ["--require", str(preload)]
        proc = subprocess.Popen(
            ["node", *node_args, str(PRODUCER), "fixture", str(self.out), FP, PID, CTRL],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        if broken_pipe:
            # An actual OS pipe with no reader, not a mocked callback/error.
            proc.stdout.close()
            proc.stdout = None
        _, stderr = proc.communicate(timeout=60)
        self.assertNotEqual(proc.returncode, 0)
        self.assert_no_runtime_profile_leak()
        self.assertTrue(self.wait_for_devtools_closed(10000 + proc.pid % 50000))
        self.assertFalse(self.out.exists(), "failed PASS output left canonical evidence")
        self.assertEqual(list(Path(self.tmp.name).glob(".r7-web-receipt.*.tmp")), [])
        self.assertIn("R7_BROWSER_RECEIPT=FAIL", stderr)
        self.assertIn("PASS_STDOUT_FAILED:" + ("EPIPE" if broken_pipe else "EIO"), stderr)
        self.assertNotIn("Unhandled 'error' event", stderr)

    def test_closed_stdout_pipe_withdraws_receipt(self):
        self.run_failed_pass_output_case(broken_pipe=True)

    def test_throwing_pass_stdout_withdraws_receipt(self):
        self.run_failed_pass_output_case(broken_pipe=False)

    def test_settled_cdp_timeout_does_not_keep_node_alive(self):
        # Run the real helper with a real Node timer: either settled branch
        # must allow natural process exit without waiting for the deadline.
        source = PRODUCER.read_text()
        helper = source[source.index("async function withTimeout("):source.index("\nasync function produce()")]
        for promise in ("Promise.resolve('ready')", "Promise.reject(new Error('connect failed'))"):
            with self.subTest(promise=promise):
                script = helper + f"\nwithTimeout({promise}, 10000, 'deadline').then(() => {{}}, () => {{}});\n"
                try:
                    result = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=2)
                except subprocess.TimeoutExpired:
                    self.fail("settled CDP race left its 10-second timer alive")
                self.assertEqual(result.returncode, 0, result.stderr)

    def run_temp_topology_case(self, *, long_parent, fake=False):
        parent = Path(self.tmp.name) / ("orchestrator-" + "x" * (65 if long_parent else 1))
        parent.mkdir(mode=0o700)
        observation = Path(self.tmp.name) / "chrome-topology.json"
        preload = Path(self.tmp.name) / "observe-topology.cjs"
        preload.write_text("""
const fs = require('fs');
const cp = require('child_process');
const original = cp.spawn;
cp.spawn = function(exe, args, options) {
  const child = original.apply(this, arguments);
  const profile = args.find(x => x.startsWith('--user-data-dir=')).split('=')[1];
  fs.writeFileSync(process.env.S32_TEST_TOPOLOGY, JSON.stringify({
    profile, tmpdir: options.env.TMPDIR, pid: child.pid,
    profileMode: fs.statSync(profile).mode & 0o777,
    tmpMode: fs.statSync(options.env.TMPDIR).mode & 0o777,
    rootMode: fs.statSync(require('path').dirname(profile)).mode & 0o777,
    port: Number(args.find(x => x.startsWith('--remote-debugging-port=')).split('=')[1]),
  }));
  return child;
};
""")
        env = dict(os.environ, TMPDIR=str(parent), S32_TEST_TOPOLOGY=str(observation),
                   NODE_OPTIONS=f"--require={preload}", S32_R7_BROWSER_TOKEN="LOCAL_ONLY_SENTINEL")
        child_report = Path(self.tmp.name) / "fake-child.json"
        if fake:
            fake_chrome = Path(self.tmp.name) / "fake-chrome"
            fake_chrome.write_text("#!/usr/bin/env python3\nimport os,json,sys\n"
                + f"open({str(child_report)!r}, 'w').write(json.dumps({{'tmpdir':os.environ['TMPDIR'], 'hasToken':'S32_R7_BROWSER_TOKEN' in os.environ}}))\n")
            fake_chrome.chmod(0o700)
            env['S32_R7_CHROMIUM'] = str(fake_chrome)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            env['S32_R7_FIXTURE_PORT'] = str(sock.getsockname()[1])
        r = subprocess.run(['node', str(PRODUCER), 'fixture', str(self.out), FP, PID, CTRL],
                           env=env, capture_output=True, text=True, timeout=100)
        self.assertTrue(observation.exists(), r.stdout + r.stderr)
        observed = json.loads(observation.read_text())
        if fake:
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('DEVTOOLS_ENDPOINT_TIMEOUT', r.stdout)
            self.assertTrue(child_report.exists(), 'fake Chrome did not start')
            report = json.loads(child_report.read_text())
            self.assertEqual(report['tmpdir'], observed['tmpdir'])
            self.assertFalse(report['hasToken'])
            self.assertFalse(self.out.exists())
        else:
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn('R7_BROWSER_RECEIPT=PASS', r.stdout)
            content = self.out.read_text()
            fields = dict(line.split('=', 1) for line in content.splitlines())
            body = ''.join(line + '\n' for line in content.splitlines() if not line.startswith('RECEIPT_SHA256='))
            self.assertEqual(fields['RECEIPT_SHA256'], hashlib.sha256(body.encode()).hexdigest())
            self.assertEqual(stat.S_IMODE(self.out.stat().st_mode), 0o600)
            self.assertNotRegex(content, r'TOKEN|PASSWORD|SECRET|DATABASE_URL|LOCAL_ONLY_SENTINEL')
        self.assertNotEqual(observed['tmpdir'], str(parent))
        profile = Path(observed['profile']); root = profile.parent
        self.assertEqual(root.parent, Path('/tmp'))
        self.assertTrue(root.name.startswith('s32-r7-'))
        self.assertEqual(Path(observed['tmpdir']).parent, root)
        self.assertLess(len(observed['profile']), 60)
        self.assertLess(len(observed['tmpdir']), 60)
        self.assertEqual([observed[k] for k in ('profileMode','tmpMode','rootMode')], [0o700]*3)
        self.assertFalse(root.exists(), 'producer-owned temp root leaked')
        self.assertFalse(profile.exists())
        self.assertEqual(list(parent.iterdir()), [], 'Chrome wrote in orchestrator TMPDIR')
        self.assertEqual(list(Path(self.tmp.name).glob('.r7-web-receipt.*.tmp')), [])
        self.assertTrue(self.wait_for_devtools_closed(observed['port']))
        for entry in Path('/proc').glob('[0-9]*/stat'):
            try:
                fields = entry.read_text().rsplit(')', 1)[1].split()
            except FileNotFoundError:
                continue
            self.assertFalse(int(fields[2]) == observed['pid'] and fields[0] not in ('Z','X'),
                             'live Chromium process group remains')

    def test_reachable_devtools_port_after_group_teardown_blocks_publication(self):
        # Keep a real TCP proxy listening on the producer's advertised port.
        # Chrome/CDP run on a second port; the proxy survives Chrome PGID exit.
        preload=Path(self.tmp.name)/'surviving-devtools-proxy.cjs'
        preload.write_text("""
const http=require('http'),cp=require('child_process');const spawn=cp.spawn;
cp.spawn=function(exe,args,opts) {
  const index=args.findIndex(a=>a.startsWith('--remote-debugging-port='));
  const advertised=Number(args[index].split('=')[1]);
  const actual=Number(process.env.S32_TEST_CHROME_PORT);
  const proxy=http.createServer((req,res)=>{
    const upstream=http.get(`http://127.0.0.1:${actual}${req.url}`,r=>r.pipe(res));
    upstream.on('error',()=>{res.writeHead(503);res.end('not ready');});
  });
  proxy.listen(advertised,'127.0.0.1');proxy.unref();
  args[index]=`--remote-debugging-port=${actual}`;
  return spawn.call(this,exe,args,opts);
};
""")
        with socket.socket() as free:
            free.bind(('127.0.0.1',0));actual=free.getsockname()[1]
        r=self.run_producer(f"NODE_OPTIONS={os.environ['NODE_OPTIONS']} --require={preload}",
                            f"S32_TEST_CHROME_PORT={actual}")
        self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('DEVTOOLS_ENDPOINT_NOT_CLOSED',r.stdout)
        self.assertFalse(self.out.exists())
        self.assertEqual(list(Path(self.tmp.name).glob('.r7-web-receipt.*.tmp')),[])
        self.assert_no_runtime_profile_leak()

    def test_pending_unlink_failure_withdraws_canonical_receipt(self):
        preload = Path(self.tmp.name) / 'fail-unlink.cjs'
        preload.write_text("""
const fs=require('fs'); const unlink=fs.unlinkSync; let rejected=false;
fs.unlinkSync=function(target, ...args) {
  if (!rejected && require('path').basename(String(target)).startsWith('.r7-web-receipt.')) {
    rejected=true;
    throw Object.assign(new Error('test sink failure'),{code:'EACCES'});
  }
  return unlink.call(this,target,...args);
};
""")
        r=self.run_producer(f"NODE_OPTIONS={os.environ['NODE_OPTIONS']} --require={preload}")
        self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('RECEIPT_TEMP_CLEANUP_FAILED',r.stdout+r.stderr)
        self.assertNotIn('R7_BROWSER_RECEIPT=PASS',r.stdout)
        self.assertFalse(self.out.exists())
        self.assertEqual(list(Path(self.tmp.name).glob('.r7-web-receipt.*.tmp')),[])
        self.assert_no_runtime_profile_leak()

    def test_owned_root_cleanup_failure_blocks_canonical_receipt(self):
        preload=Path(self.tmp.name)/'fail-root-remove.cjs'
        preload.write_text(r"""
const fs=require('fs'); const rm=fs.rmSync;
fs.rmSync=function(target,...args) {
  if (/^\/tmp\/s32-r7-[^/]+$/.test(String(target))) {
    throw Object.assign(new Error('test removal failure'),{code:'EACCES'});
  }
  return rm.call(this,target,...args);
};
""")
        r=self.run_producer(f"NODE_OPTIONS={os.environ['NODE_OPTIONS']} --require={preload}")
        self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('CHROME_ROOT_CLEANUP_FAILED',r.stdout)
        self.assertFalse(self.out.exists())
        self.assertEqual(list(Path(self.tmp.name).glob('.r7-web-receipt.*.tmp')),[])
        observed=json.loads(self.observation.read_text())
        root=Path(observed['profile']).parent
        self.assertTrue(root.exists(), 'test did not actually inhibit root cleanup')
        self.assertTrue(self.wait_for_devtools_closed(observed['port']))
        # This intentionally injected deletion failure is a producer FAIL.
        # Only the test-created directory is removed after asserting evidence.
        import shutil
        self.addCleanup(shutil.rmtree,root)

    def test_long_parent_tmpdir_fixture_and_owned_root_cleanup(self):
        self.run_temp_topology_case(long_parent=True)

    def test_short_parent_tmpdir_control_and_owned_root_cleanup(self):
        self.run_temp_topology_case(long_parent=False)

    def test_fake_chrome_receives_private_short_tmpdir_without_token(self):
        self.run_temp_topology_case(long_parent=True, fake=True)

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
        self.assertTrue(self.observation.exists(), "spawn was not observed")
        observed = json.loads(self.observation.read_text())
        profile = Path(observed['profile'])
        self.assertFalse(profile.exists(), f"leftover profile: {profile}")
        self.assertFalse(profile.parent.exists(), f"leftover Chrome root: {profile.parent}")
        self.assertTrue(self.wait_for_devtools_closed(observed['port']))
        for entry in Path('/proc').glob('[0-9]*/stat'):
            try:
                fields = entry.read_text().rsplit(')', 1)[1].split()
            except FileNotFoundError:
                continue
            self.assertFalse(int(fields[2]) == observed.get('pid') and fields[0] not in ('Z', 'X'),
                             f"live Chromium group: {observed.get('pid')}")
        ps = subprocess.run(['ps', '-eo', 'args='], capture_output=True, text=True, timeout=10)
        self.assertEqual(ps.returncode, 0, ps.stderr)
        self.assertNotIn(f"--user-data-dir={profile}", ps.stdout)

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

    def test_process_group_cleanup_when_chromium_leader_exits_first(self):
        fake = Path(self.tmp.name) / "fake-chromium.sh"
        pid_file = Path(self.tmp.name) / "leader-descendant.pid"
        sentinel = f"s32-r7-orphan-sentinel-{os.getpid()}"
        fake.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"bash -c 'exec -a {sentinel} sleep 120' &\n"
            "child=$!\n"
            "kill -0 \"$child\"\n"
            f"printf '%s\\n' \"$child\" > {str(pid_file)!r}\n"
            "exit 0\n"
        )
        fake.chmod(0o755)

        out2 = Path(self.tmp.name) / "leader-exit.web.env"
        env = dict(os.environ)
        env["TMPDIR"] = self.tmp.name
        env["S32_R7_CHROMIUM"] = str(fake)
        import random
        env["S32_R7_FIXTURE_PORT"] = str(random.randint(30000, 39000))

        r = subprocess.run(
            ["node", str(PRODUCER), "fixture", str(out2), FP, PID, CTRL],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("DEVTOOLS_ENDPOINT_TIMEOUT", r.stdout)
        self.assertFalse(out2.exists())
        self.assertTrue(pid_file.exists(), "fake Chromium descendant never started")

        descendant_pid = int(pid_file.read_text().strip())
        stat_path = Path(f"/proc/{descendant_pid}/stat")
        if stat_path.exists():
            raw = stat_path.read_text()
            close_paren = raw.rfind(")")
            self.assertGreaterEqual(close_paren, 0)
            fields = raw[close_paren + 2:].split()
            self.assertGreaterEqual(len(fields), 3)
            self.assertIn(fields[0], {"Z", "X"}, f"descendant still live: state={fields[0]}")

        ps = subprocess.run(
            ["ps", "-eo", "args="],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(ps.returncode, 0, ps.stderr)
        self.assertNotIn(sentinel, ps.stdout)
        self.assert_no_runtime_profile_leak()

    def test_chromium_spawn_failure_cleans_profile_and_reports_structured_failure(self):
        fake_dir = Path(self.tmp.name) / "executable-directory"
        fake_dir.mkdir()
        fake_dir.chmod(0o755)

        out2 = Path(self.tmp.name) / "spawn-fail.web.env"
        env = dict(os.environ)
        env["TMPDIR"] = self.tmp.name
        env["S32_R7_CHROMIUM"] = str(fake_dir)
        import random
        env["S32_R7_FIXTURE_PORT"] = str(random.randint(40000, 49000))

        r = subprocess.run(
            ["node", str(PRODUCER), "fixture", str(out2), FP, PID, CTRL],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("CHROMIUM_SPAWN_FAILED:", r.stdout)
        self.assertFalse(out2.exists())
        self.assert_no_runtime_profile_leak()

    def test_chromium_uses_isolated_nondefault_user_data_dir(self):
        text = PRODUCER.read_text()
        self.assertIn('fs.mkdtempSync("/tmp/s32-r7-")', text)
        self.assertIn('--user-data-dir=${chromeProfileDir}', text)
        self.assertIn('process.kill(-pgid, "SIGKILL")', text)
        self.assertIn('fs.readdirSync("/proc", { withFileTypes: true })', text)
        self.assertIn('state !== "Z" && state !== "X"', text)
        self.assertIn('await terminateChromeGroup()', text)
        self.assertNotIn('if (chrome.exitCode !== null || chrome.signalCode !== null) return;', text)
        self.assertIn('fs.rmSync(chromeProfileDir, { recursive: true, force: true })', text)
        self.assertIn('if (chromeProfileDir && fs.existsSync(chromeProfileDir))', text)
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
