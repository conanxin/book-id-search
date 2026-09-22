import importlib.util, pathlib, unittest

MODULE = pathlib.Path(__file__).resolve().parent / "plan-s32-production-baseline.py"
spec = importlib.util.spec_from_file_location("plan_s32_production_baseline", MODULE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def snapshot():
    service = lambda name: {
        "cid": name + "-cid",
        "startedAt": "2026-09-22T00:00:00Z",
        "imageId": "sha256:" + "a"*64,
        "image": name,
        "revision": "1"*40,
    }
    return {
        "whoami": "ubuntu",
        "hostname": "VM-0-4-ubuntu",
        "checkoutSha": "1"*40,
        "services": {"web": service("web"), "api": service("api"), "meilisearch": service("meili")},
        "publicHttpStatus": 200,
        "search": {"ISBN": True, "SSID": True, "DXID": True, "title": True, "author": True, "publisher": True},
        "meili": {"numberOfDocuments": 5115734, "isIndexing": False},
        "postgresPresent": False,
        "s32EnvNames": [],
    }

class T(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(mod.evaluate_snapshot(snapshot(), 5115734)["R0_FINAL"], "PASS")

    def test_missing_author_blocks(self):
        data = snapshot()
        del data["search"]["author"]
        self.assertEqual(mod.evaluate_snapshot(data, 5115734)["R0_FINAL"], "BLOCKED")

    def test_duplicate_service_identity_blocks(self):
        data = snapshot()
        data["services"]["api"]["cid"] = data["services"]["web"]["cid"]
        self.assertEqual(mod.evaluate_snapshot(data, 5115734)["R0_FINAL"], "BLOCKED")

    def test_http_failure_blocks(self):
        data = snapshot()
        data["publicHttpStatus"] = 503
        self.assertEqual(mod.evaluate_snapshot(data, 5115734)["R0_FINAL"], "BLOCKED")

if __name__ == "__main__":
    unittest.main()
