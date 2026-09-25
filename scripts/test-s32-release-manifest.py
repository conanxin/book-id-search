#!/usr/bin/env python3
import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
MODULE_PATH = ROOT / 's32-release-manifest.py'


def load_module():
    spec = importlib.util.spec_from_file_location('s32_release_manifest', MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError('cannot load module')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def valid_manifest():
    return {
        'version': 1,
        'sourceSha': 'a' * 40,
        'pnpmLockSha256': '1' * 64,
        'apiImageTag': 'book-id-search-api:s32-' + 'a' * 40,
        'apiImageId': 'sha256:' + '2' * 64,
        'apiOciRevision': 'a' * 40,
        'apiBaseDigest': 'node@sha256:' + '3' * 64,
        'webImageTag': 'book-id-search-web:' + 'a' * 40,
        'webImageId': 'sha256:' + '4' * 64,
        'webOciRevision': 'a' * 40,
        'webStaticManifestSha256': '5' * 64,
        'webS32Enabled': True,
        'webNodeBaseDigest': 'node@sha256:' + '6' * 64,
        'webNginxBaseDigest': 'nginx@sha256:' + '7' * 64,
        'pgImageRef': 'postgres@sha256:' + '8' * 64,
        'pgImageId': 'sha256:' + '9' * 64,
        'migrationPath': 'db/migrations/001_s32_core_schema.sql',
        'migrationSha256': 'a1' * 32,
        'roleBootstrapPath': 'deploy/s32-production-roles.sql',
        'roleBootstrapSha256': 'b2' * 32,
        's32OverridePath': 'deploy/s32-production.override.yml',
        's32OverrideSha256': 'c3' * 32,
    }


class ReleaseManifestTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_fingerprint_is_deterministic_and_mutation_sensitive(self):
        base = valid_manifest()
        first = self.mod.fingerprint_manifest(base)
        second = self.mod.fingerprint_manifest(dict(reversed(list(base.items()))))
        self.assertEqual(first, second)
        changed = copy.deepcopy(base)
        changed['migrationSha256'] = 'd4' * 32
        self.assertNotEqual(first, self.mod.fingerprint_manifest(changed))

    def test_secret_keys_are_rejected_even_if_unknown(self):
        data = valid_manifest() | {'S32_PRIVATE_API_TOKEN': 'secret'}
        with self.assertRaisesRegex(ValueError, 'SECRET_FIELD_FORBIDDEN'):
            self.mod.fingerprint_manifest(data)

    def test_unknown_nonsecret_key_is_rejected(self):
        data = valid_manifest() | {'extra': 'x'}
        with self.assertRaisesRegex(ValueError, 'MANIFEST_KEYS_INVALID'):
            self.mod.fingerprint_manifest(data)

    def test_source_and_oci_revision_must_match(self):
        data = valid_manifest()
        data['apiOciRevision'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'API_SOURCE_MISMATCH'):
            self.mod.fingerprint_manifest(data)
        data = valid_manifest()
        data['webOciRevision'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'WEB_SOURCE_MISMATCH'):
            self.mod.fingerprint_manifest(data)

    def test_web_s32_must_be_explicitly_enabled(self):
        data = valid_manifest()
        data['webS32Enabled'] = False
        with self.assertRaisesRegex(ValueError, 'WEB_S32_DISABLED'):
            self.mod.fingerprint_manifest(data)

    def test_cli_emits_only_nonsecret_identity(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / 'manifest.json'
            path.write_text(json.dumps(valid_manifest()), encoding='utf-8')
            proc = subprocess.run([sys.executable, str(MODULE_PATH), str(path)], text=True, capture_output=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            lines = dict(line.split('=', 1) for line in proc.stdout.splitlines() if '=' in line)
            self.assertRegex(lines['S32_RELEASE_FINGERPRINT'], r'^[0-9a-f]{64}$')
            self.assertEqual(lines['SOURCE_SHA'], 'a' * 40)
            self.assertNotIn('TOKEN', proc.stdout.upper())
            self.assertNotIn('PASSWORD', proc.stdout.upper())


if __name__ == '__main__':
    unittest.main()
