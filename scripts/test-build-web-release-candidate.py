from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class T(unittest.TestCase):
    def test_dockerfile_binds_revision_and_s32_flag(self):
        s = (ROOT / "apps/web/Dockerfile").read_text()
        self.assertIn("ARG SOURCE_COMMIT", s)
        self.assertIn("ARG VITE_S32_ENABLED=false", s)
        self.assertIn("ENV VITE_S32_ENABLED=$VITE_S32_ENABLED", s)
        self.assertIn("LABEL org.opencontainers.image.revision=$SOURCE_COMMIT", s)

    def test_builder_passes_release_args_and_measures_sizes(self):
        s = (ROOT / "scripts/build-web-release-candidate.sh").read_text()
        self.assertIn('--build-arg "SOURCE_COMMIT=$FULL_SHA"', s)
        self.assertIn('--build-arg "VITE_S32_ENABLED=true"', s)
        self.assertIn('"webS32Enabled": true', s)
        self.assertIn('"imageBytes":', s)
        self.assertIn('"tarBytes":', s)
        self.assertIn('"compressedBytes":', s)
        self.assertIn('org.opencontainers.image.revision', s)
        self.assertIn('VITE_S32_PRIVATE_API_TOKEN is forbidden', s)

if __name__ == "__main__":
    unittest.main()
