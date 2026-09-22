import importlib.util, pathlib, unittest, copy
MODULE = pathlib.Path(__file__).with_name("s32-release-manifest.py")
spec=importlib.util.spec_from_file_location("s32_release_manifest", MODULE)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def valid_manifest():
    h="a"*64
    return {
      "version":1,
      "sourceSha":"1"*40,
      "pnpmLockSha256":h,
      "apiImageTag":"book-id-search-api:s32-"+"1"*40,
      "apiImageId":"sha256:"+h,
      "apiOciRevision":"1"*40,
      "apiBaseDigest":"sha256:"+h,
      "webImageTag":"book-id-search-web:"+"1"*40,
      "webImageId":"sha256:"+h,
      "webOciRevision":"1"*40,
      "webStaticManifestSha256":h,
      "webS32Enabled":True,
      "webNodeBaseDigest":"sha256:"+h,
      "webNginxBaseDigest":"sha256:"+h,
      "pgImageRef":"postgres@sha256:"+h,
      "pgImageId":"sha256:"+h,
      "migrationPath":"db/migrations/001_s32_core_schema.sql",
      "migrationSha256":h,
      "roleBootstrapPath":"deploy/s32-production-roles.sql",
      "roleBootstrapSha256":h,
      "s32OverridePath":"deploy/s32-production.override.yml",
      "s32OverrideSha256":h,
    }

class T(unittest.TestCase):
    def test_stable(self):
        m=valid_manifest()
        self.assertEqual(mod.fingerprint_manifest(m), mod.fingerprint_manifest(copy.deepcopy(m)))

    def test_mutation(self):
        m=valid_manifest()
        a=mod.fingerprint_manifest(m)
        m["migrationSha256"]="b"*64
        self.assertNotEqual(a, mod.fingerprint_manifest(m))

    def test_secret_rejected(self):
        m=valid_manifest(); m["S32_PRIVATE_API_TOKEN"]="secret"
        with self.assertRaisesRegex(ValueError,"SECRET_FIELD_FORBIDDEN"):
            mod.fingerprint_manifest(m)

    def test_extra_rejected(self):
        m=valid_manifest(); m["extra"]="x"
        with self.assertRaisesRegex(ValueError,"UNEXPECTED_FIELDS"):
            mod.fingerprint_manifest(m)

    def test_web_flag_must_true(self):
        m=valid_manifest(); m["webS32Enabled"]=False
        with self.assertRaisesRegex(ValueError,"WEB_S32_DISABLED"):
            mod.fingerprint_manifest(m)

if __name__=="__main__":
    unittest.main()
