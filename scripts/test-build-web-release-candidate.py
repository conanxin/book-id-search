#!/usr/bin/env python3
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / 'apps/web/Dockerfile'
BUILDER = ROOT / 'scripts/build-web-release-candidate.sh'
TSCONFIG = ROOT / 'apps/web/tsconfig.json'

class WebReleaseCandidateContractTests(unittest.TestCase):
    def setUp(self):
        self.dockerfile = DOCKERFILE.read_text()
        self.builder = BUILDER.read_text()
        self.tsconfig = json.loads(TSCONFIG.read_text())

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


    def test_builder_requires_source_reachable_from_reviewed_origin_main(self):
        self.assertIn('git merge-base --is-ancestor "$FULL_SHA" origin/main', self.builder)
        self.assertIn('source is not reachable from origin/main', self.builder)

    def test_production_typecheck_excludes_test_only_sources(self):
        excluded = set(self.tsconfig.get('exclude', []))
        self.assertTrue({
            'src/**/*.test.ts',
            'src/**/*.test.tsx',
            'src/**/*.spec.ts',
            'src/**/*.spec.tsx',
        }.issubset(excluded))

    def test_builder_records_capacity_evidence(self):
        for field in ('imageBytes', 'tarBytes', 'compressedBytes'):
            self.assertIn(field, self.builder)

    def test_builder_has_no_web_private_token_build_arg(self):
        self.assertNotIn('VITE_S32_PRIVATE_API_TOKEN', self.dockerfile)
        self.assertNotIn('--build-arg "VITE_S32_PRIVATE_API_TOKEN', self.builder)
        self.assertNotIn('ARG VITE_S32_PRIVATE_API_TOKEN', self.builder)

if __name__ == '__main__':
    unittest.main()
