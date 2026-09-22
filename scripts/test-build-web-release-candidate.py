#!/usr/bin/env python3
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / 'apps/web/Dockerfile'
BUILDER = ROOT / 'scripts/build-web-release-candidate.sh'

class WebReleaseCandidateContractTests(unittest.TestCase):
    def setUp(self):
        self.dockerfile = DOCKERFILE.read_text()
        self.builder = BUILDER.read_text()

    def test_dockerfile_binds_source_and_s32_enablement(self):
        self.assertIn('ARG SOURCE_COMMIT', self.dockerfile)
        self.assertIn('ARG VITE_S32_ENABLED=false', self.dockerfile)
        self.assertIn('ENV VITE_S32_ENABLED=$VITE_S32_ENABLED', self.dockerfile)
        self.assertIn('LABEL org.opencontainers.image.revision=$SOURCE_COMMIT', self.dockerfile)

    def test_builder_passes_exact_source_and_enables_s32(self):
        self.assertIn('--build-arg "SOURCE_COMMIT=$FULL_SHA"', self.builder)
        self.assertIn('--build-arg "VITE_S32_ENABLED=true"', self.builder)
        self.assertIn('org.opencontainers.image.revision', self.builder)
        self.assertIn('webS32Enabled', self.builder)

    def test_builder_records_capacity_evidence(self):
        for field in ('imageBytes', 'tarBytes', 'compressedBytes'):
            self.assertIn(field, self.builder)

    def test_builder_has_no_web_private_token_build_arg(self):
        self.assertNotIn('VITE_S32_PRIVATE_API_TOKEN', self.dockerfile)
        self.assertNotIn('--build-arg "VITE_S32_PRIVATE_API_TOKEN', self.builder)
        self.assertNotIn('ARG VITE_S32_PRIVATE_API_TOKEN', self.builder)

if __name__ == '__main__':
    unittest.main()
