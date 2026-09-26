#!/usr/bin/env python3
import hashlib
import io
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
ARCHIVE_VERIFY = ROOT / "verify-s32-image-archive-identity.py"
LOCAL_VERIFY = ROOT / "verify-s32-local-image.sh"
SRC = "b" * 40


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def add_bytes(tf: tarfile.TarFile, name: str, data: bytes):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tf.addfile(info, io.BytesIO(data))


def make_oci(path: pathlib.Path):
    layer = b"layer-bytes"
    config = json.dumps({
        "config": {"Labels": {"org.opencontainers.image.revision": SRC}},
        "rootfs": {"type": "layers", "diff_ids": [digest(layer)]},
    }, separators=(",", ":")).encode()
    config_digest = digest(config)
    manifest = json.dumps({
        "schemaVersion": 2,
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_digest, "size": len(config)},
        "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": digest(layer), "size": len(layer)}],
    }, separators=(",", ":")).encode()
    manifest_digest = digest(manifest)
    index = json.dumps({
        "schemaVersion": 2,
        "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": manifest_digest, "size": len(manifest)}],
    }, separators=(",", ":")).encode()
    with tarfile.open(path, "w") as tf:
        add_bytes(tf, "index.json", index)
        add_bytes(tf, "blobs/sha256/" + config_digest.split(":", 1)[1], config)
        add_bytes(tf, "blobs/sha256/" + manifest_digest.split(":", 1)[1], manifest)
        add_bytes(tf, "blobs/sha256/" + digest(layer).split(":", 1)[1], layer)
    return config_digest, manifest_digest


def make_docker(path: pathlib.Path):
    layer = b"docker-layer"
    config = json.dumps({
        "config": {"Labels": {"org.opencontainers.image.revision": SRC}},
        "rootfs": {"type": "layers", "diff_ids": [digest(layer)]},
    }, separators=(",", ":")).encode()
    config_digest = digest(config)
    config_name = config_digest.split(":", 1)[1] + ".json"
    manifest = json.dumps([{"Config": config_name, "RepoTags": ["example:test"], "Layers": ["layer/layer.tar"]}]).encode()
    with tarfile.open(path, "w") as tf:
        add_bytes(tf, "manifest.json", manifest)
        add_bytes(tf, config_name, config)
        add_bytes(tf, "layer/layer.tar", layer)
    return config_digest


class ImageIdentityTests(unittest.TestCase):
    def run_archive(self, path, expected, observed):
        return subprocess.run(
            ["python3", str(ARCHIVE_VERIFY), str(path), expected, observed, SRC],
            text=True, capture_output=True,
        )

    def test_oci_accepts_containerd_manifest_digest_when_config_is_exact(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "image.tar"
            config, manifest = make_oci(path)
            r = self.run_archive(path, config, manifest)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("BACKEND_IDENTITY_MODE=MANIFEST_DIGEST", r.stdout)
            self.assertIn(f"CONFIG_DIGEST={config}", r.stdout)
            self.assertIn(f"MANIFEST_DIGEST={manifest}", r.stdout)

    def test_oci_accepts_classic_config_digest(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "image.tar"
            config, _ = make_oci(path)
            r = self.run_archive(path, config, config)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("BACKEND_IDENTITY_MODE=CONFIG_DIGEST", r.stdout)

    def test_wrong_observed_or_wrong_config_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "image.tar"
            config, _ = make_oci(path)
            r = self.run_archive(path, config, "sha256:" + "f" * 64)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("OBSERVED_IMAGE_ID_MISMATCH", r.stdout + r.stderr)
            r = self.run_archive(path, "sha256:" + "e" * 64, config)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("CONFIG_DIGEST_MISMATCH", r.stdout + r.stderr)

    def test_docker_archive_requires_config_digest_identity(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "image.tar"
            config = make_docker(path)
            r = self.run_archive(path, config, config)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("ARCHIVE_FORMAT=DOCKER", r.stdout)
            r = self.run_archive(path, config, "sha256:" + "d" * 64)
            self.assertNotEqual(r.returncode, 0)

    def test_local_wrapper_dynamically_proves_containerd_identity(self):
        with tempfile.TemporaryDirectory() as td:
            td = pathlib.Path(td)
            archive = td / "image.tar"
            config, manifest = make_oci(archive)
            fake = td / "docker"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib,sys\n"
                f"archive=pathlib.Path({str(archive)!r})\n"
                f"config={config!r}; manifest={manifest!r}; rev={SRC!r}\n"
                "a=sys.argv[1:]\n"
                "if a[:2]==['image','inspect']:\n"
                "  fmt=a[-1]\n"
                "  print(rev if 'revision' in fmt else manifest)\n"
                "elif a[:2]==['image','save']:\n"
                "  sys.stdout.buffer.write(archive.read_bytes())\n"
                "else: raise SystemExit(2)\n"
            )
            fake.chmod(0o755)
            env = os.environ.copy()
            env["S32_IMAGE_DOCKER_CMD"] = str(fake)
            r = subprocess.run(
                ["bash", str(LOCAL_VERIFY), "example:test", config, SRC],
                text=True, capture_output=True, env=env,
            )
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn(f"OBSERVED_IMAGE_ID={manifest}", r.stdout)
            self.assertIn("BACKEND_IDENTITY_MODE=MANIFEST_DIGEST", r.stdout)


if __name__ == "__main__":
    unittest.main()
