#!/usr/bin/env python3
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / 'build-s32-api-release-candidate.sh'

class ApiCandidateBuilderTests(unittest.TestCase):
    def setUp(self):
        self.text = SCRIPT.read_text()

    def test_requires_exact_40_hex_source(self):
        self.assertIn("^[0-9a-f]{40}$", self.text)
        self.assertNotIn('SOURCE_SHA="$(git rev-parse HEAD)"', self.text)

    def test_builds_from_git_archive_not_worktree(self):
        self.assertIn('git archive "$SOURCE_SHA"', self.text)
        self.assertIn('--build-arg "SOURCE_COMMIT=$SOURCE_SHA"', self.text)

    def test_validates_oci_revision_and_records_sizes(self):
        self.assertIn('org.opencontainers.image.revision', self.text)
        for field in ('imageBytes', 'tarBytes', 'compressedBytes', 'baseDigest'):
            self.assertIn(field, self.text)

    def test_never_builds_from_dot_context(self):
        self.assertNotIn(' -t "$TAG" .', self.text)

if __name__ == '__main__':
    unittest.main()
