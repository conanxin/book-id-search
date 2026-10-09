#!/usr/bin/env python3
"""Hermetic Web release OAuth ID guard tests: real git, mocked Docker, never production."""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts/build-web-release-candidate.sh"
VALID = "1234567890-abc123def456.apps.googleusercontent.com"
VALID_LONG = "123456789012-abcdefghijklmnopqrstuvwxyzabcdef.apps.googleusercontent.com"

MOCK_DOCKER = r'''#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
with open(os.environ["MOCK_DOCKER_LOG"], "a", encoding="utf-8") as log:
    log.write(" ".join(args) + "\n")
if args[0] == "ps": sys.exit(0)
if args[0] == "build":
    sys.stdin.buffer.read()
    sys.exit(0)
if args[:2] == ["image", "inspect"]:
    tag = args[2]
    fmt = args[-1]
    if "org.opencontainers.image.revision" in fmt:
        print(tag.rsplit(":", 1)[-1])
    elif ".RepoDigests" in fmt:
        print(tag.split(":", 1)[0] + "@sha256:" + "a" * 64)
    elif ".Id" in fmt:
        print("sha256:" + "b" * 64)
    elif ".Size" in fmt:
        print("5000")
    else:
        sys.exit(17)
    sys.exit(0)
if args[0] == "create":
    print("mock-container-id")
    sys.exit(0)
if args[0] == "cp":
    dest = pathlib.Path(args[-1])
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "index.html").write_text("<html>controlled fixture</html>", encoding="utf-8")
    sys.exit(0)
if args[:2] == ["image", "save"]:
    pathlib.Path(args[args.index("-o") + 1]).write_bytes(b"image-contents")
    sys.exit(0)
if args[0] == "rm": sys.exit(0)
print("unexpected Docker command", file=sys.stderr)
sys.exit(17)
'''

class GoogleWebClientIdReleaseGuard(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="web-client-guard-")
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        self.repo = root / "project"
        self.repo.mkdir()
        self.bin = root / "bin"
        self.bin.mkdir()
        self.log = root / "docker.log"
        self.log.write_text("")
        docker = self.bin / "docker"
        docker.write_text(MOCK_DOCKER)
        docker.chmod(0o700)

        def git(*args):
            subprocess.run(["git", *args], cwd=self.repo, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        git("init", "-q")
        (self.repo / "package.json").write_text('{"packageManager":"pnpm@10.33.0"}\n')
        (self.repo / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
        (self.repo / "apps/web").mkdir(parents=True)
        (self.repo / "apps/web/Dockerfile").write_text("FROM scratch\n")
        git("add", ".")
        git("-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture")
        git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()

    def invoke(self, client_id=None):
        env = os.environ.copy()
        env.pop("VITE_GOOGLE_CLIENT_ID", None)
        if client_id is not None:
            env["VITE_GOOGLE_CLIENT_ID"] = client_id
        env.update({
            "BOOK_ID_SEARCH_REPO_ROOT": str(self.repo),
            "MOCK_DOCKER_LOG": str(self.log),
            "PATH": str(self.bin) + os.pathsep + env.get("PATH", ""),
            "BOOK_ID_SEARCH_SESSION_SECRET": "never-log-session-secret-8341",
            "S32_PRIVATE_API_TOKEN": "never-log-private-token-9341",
            "S32_DATABASE_URL": "postgres://never-log-db-8341",
            "BOOK_ID_SEARCH_OWNER_GOOGLE_SUB": "never-log-owner-8341",
        })
        return subprocess.run(["bash", str(BUILDER), "HEAD"], cwd=self.repo,
                              env=env, capture_output=True, text=True, timeout=45)

    def test_invalid_and_absent_values_block_before_docker(self):
        variants = {
            "unset": None, "empty": "", "spaces": " ",
            "leading": " " + VALID, "trailing": VALID + " ", "tab": "\t" + VALID,
            "newline": VALID + "\nINJECTED", "cr": VALID + "\r",
            "evil_host": "1234567890-abc123def456.apps.googleusercontent.com.evil.org",
            "wrong_host": "1234567890-abc123def456.googleusercontent.com",
            "uppercase": VALID.upper(), "bad_prefix": "abc-abc123def456.apps.googleusercontent.com",
            "missing_id": "-abc123def456.apps.googleusercontent.com",
            "shell_injection": VALID + "; touch /tmp/NO", "escaped_nul": VALID + "%00",
        }
        for name, candidate in variants.items():
            with self.subTest(name=name):
                self.log.write_text("")
                result = self.invoke(candidate)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("STATUS=BLOCKED", result.stderr)
                self.assertEqual(self.log.read_text(), "", "No Docker calls allowed")
                for sensitive in ("never-log-session-secret", "never-log-private-token",
                                  "never-log-db", "never-log-owner"):
                    self.assertNotIn(sensitive, result.stdout + result.stderr)
                # Whitespace by itself is ordinary formatting in the generic error;
                # do not mistake it for an echoed credential.
                if candidate and candidate.strip():
                    self.assertNotIn(candidate, result.stdout + result.stderr)
        # NUL itself cannot be supplied in POSIX environment variables.
        with self.assertRaises(ValueError):
            subprocess.run(["env"], env={"VITE_GOOGLE_CLIENT_ID": VALID + "\x00"})

    def test_valid_controlled_id_preserves_original_source_build_contract(self):
        for client_id in (VALID, VALID_LONG):
            with self.subTest(kind="controlled Google ID"):
                self.log.write_text("")
                result = self.invoke(client_id)
                self.assertEqual(result.returncode, 0, result.stderr[-2000:])
                calls = self.log.read_text()
                self.assertIn("build --no-cache", calls)
                self.assertIn("--build-arg SOURCE_COMMIT=" + self.sha, calls)
                self.assertIn("--build-arg VITE_S32_ENABLED=true", calls)
                self.assertIn("--build-arg VITE_GOOGLE_CLIENT_ID=" + client_id, calls)
                self.assertIn("image save -o", calls)
                folder = self.repo / "progress" / ("web-release-candidate-" + self.sha)
                self.assertTrue((folder / "candidate.json").is_file())
                self.assertTrue((folder / "static-manifest.tsv").is_file())
                self.assertTrue((folder / "image.tar.gz").is_file())
                for secret in ("never-log-session-secret", "never-log-private-token",
                               "never-log-db", "never-log-owner"):
                    self.assertNotIn(secret, result.stdout + result.stderr + calls)

    def test_validation_occurs_before_any_docker_invocation(self):
        builder = BUILDER.read_text()
        self.assertIn("STATUS=BLOCKED", builder)
        self.assertLess(builder.index("STATUS=BLOCKED"), builder.index("if docker ps"))
        self.assertNotIn(":-}", builder)
        self.assertNotIn("cat api.env", builder)
        self.assertNotIn("cat /opt/book-id-search-runtime", builder)

if __name__ == "__main__":
    unittest.main()
