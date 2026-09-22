#!/usr/bin/env python3
import hashlib
import json
import re
import sys
from pathlib import Path

FIELDS = (
    "version", "sourceSha", "pnpmLockSha256",
    "apiImageTag", "apiImageId", "apiOciRevision", "apiBaseDigest",
    "webImageTag", "webImageId", "webOciRevision",
    "webStaticManifestSha256", "webS32Enabled",
    "webNodeBaseDigest", "webNginxBaseDigest",
    "pgImageRef", "pgImageId",
    "migrationPath", "migrationSha256",
    "roleBootstrapPath", "roleBootstrapSha256",
    "s32OverridePath", "s32OverrideSha256",
)

_SECRET_WORDS = ("PASSWORD", "TOKEN", "SECRET", "DATABASE_URL")
_HEX40 = re.compile(r"^[0-9a-f]{40}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")


def _validate(data: dict) -> None:
    extra = set(data) - set(FIELDS)
    if any(any(word in key.upper() for word in _SECRET_WORDS) for key in extra):
        raise ValueError("SECRET_FIELD_FORBIDDEN")
    if extra:
        raise ValueError("UNEXPECTED_FIELDS")

    missing = [key for key in FIELDS if key not in data]
    if missing:
        raise ValueError("MISSING_FIELDS")

    if data["version"] != 1:
        raise ValueError("INVALID_VERSION")
    if not _HEX40.fullmatch(str(data["sourceSha"])):
        raise ValueError("INVALID_SOURCE_SHA")

    for key in (
        "pnpmLockSha256",
        "webStaticManifestSha256",
        "migrationSha256",
        "roleBootstrapSha256",
        "s32OverrideSha256",
    ):
        if not _HEX64.fullmatch(str(data[key])):
            raise ValueError(f"INVALID_{key}")

    for key in (
        "apiImageId",
        "webImageId",
        "pgImageId",
        "apiBaseDigest",
        "webNodeBaseDigest",
        "webNginxBaseDigest",
    ):
        if not _IMAGE_ID.fullmatch(str(data[key])):
            raise ValueError(f"INVALID_{key}")

    if data["apiOciRevision"] != data["sourceSha"]:
        raise ValueError("API_REVISION_MISMATCH")
    if data["webOciRevision"] != data["sourceSha"]:
        raise ValueError("WEB_REVISION_MISMATCH")
    if data["webS32Enabled"] is not True:
        raise ValueError("WEB_S32_DISABLED")
    if not str(data["pgImageRef"]).startswith("postgres@sha256:"):
        raise ValueError("INVALID_PG_IMAGE_REF")


def canonicalize_manifest(data: dict) -> bytes:
    _validate(data)
    ordered = {key: data[key] for key in FIELDS}
    return (json.dumps(ordered, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def fingerprint_manifest(data: dict) -> str:
    return hashlib.sha256(canonicalize_manifest(data)).hexdigest()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: s32-release-manifest.py <manifest.json>", file=sys.stderr)
        return 2
    data = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    print(f"S32_RELEASE_FINGERPRINT={fingerprint_manifest(data)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
