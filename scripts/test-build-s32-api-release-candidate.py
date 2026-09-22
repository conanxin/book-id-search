from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class T(unittest.TestCase):
    def test_builder_uses_git_archive_and_binds_source(self):
        s = (ROOT / "scripts/build-s32-api-release-candidate.sh").read_text()
        self.assertIn('git archive "$SOURCE_SHA"', s)
        self.assertIn('--build-arg "SOURCE_COMMIT=$SOURCE_SHA"', s)
        self.assertIn('book-id-search-api:s32-${SOURCE_SHA}', s)
        self.assertIn('org.opencontainers.image.revision', s)
        self.assertIn('"imageBytes":', s)
        self.assertIn('"tarBytes":', s)
        self.assertIn('"compressedBytes":', s)

if __name__ == "__main__":
    unittest.main()
