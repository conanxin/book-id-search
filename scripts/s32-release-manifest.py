#!/usr/bin/env python3
"""Validate and fingerprint the non-secret S32 production release manifest."""
from __future__ import annotations
import hashlib
import json
import pathlib
import re
import sys
from typing import Any

FIELDS = (
    'version', 'sourceSha', 'pnpmLockSha256',
    'apiImageTag', 'apiImageId', 'apiOciRevision', 'apiBaseDigest',
    'webImageTag', 'webImageId', 'webOciRevision',
    'webStaticManifestSha256', 'webS32Enabled',
    'webNodeBaseDigest', 'webNginxBaseDigest',
    'pgImageRef', 'pgImageId',
    'migrationPath', 'migrationSha256',
    'roleBootstrapPath', 'roleBootstrapSha256',
    's32OverridePath', 's32OverrideSha256',
)
HEX40 = re.compile(r'^[0-9a-f]{40}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
IMAGE_ID = re.compile(r'^sha256:[0-9a-f]{64}$')
DIGEST_REF = re.compile(r'^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$')
TAG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_./:.-]*$')
SECRET_KEY = re.compile(r'(PASSWORD|TOKEN|SECRET|DATABASE_URL)', re.I)


def _require_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f'MANIFEST_FIELD_INVALID:{key}')
    return value


def validate_manifest(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError('MANIFEST_NOT_OBJECT')
    for key in data:
        if SECRET_KEY.search(str(key)):
            raise ValueError(f'SECRET_FIELD_FORBIDDEN:{key}')
    if set(data) != set(FIELDS):
        missing = sorted(set(FIELDS) - set(data))
        extra = sorted(set(data) - set(FIELDS))
        raise ValueError(f'MANIFEST_KEYS_INVALID:missing={missing}:extra={extra}')
    if data['version'] != 1:
        raise ValueError('MANIFEST_VERSION_INVALID')
    source = _require_str(data, 'sourceSha')
    if not HEX40.fullmatch(source):
        raise ValueError('SOURCE_SHA_INVALID')
    if _require_str(data, 'apiOciRevision') != source:
        raise ValueError('API_SOURCE_MISMATCH')
    if _require_str(data, 'webOciRevision') != source:
        raise ValueError('WEB_SOURCE_MISMATCH')
    if data['webS32Enabled'] is not True:
        raise ValueError('WEB_S32_DISABLED')

    for key in ('pnpmLockSha256', 'webStaticManifestSha256', 'migrationSha256',
                'roleBootstrapSha256', 's32OverrideSha256'):
        if not HEX64.fullmatch(_require_str(data, key)):
            raise ValueError(f'SHA256_INVALID:{key}')
    for key in ('apiImageId', 'webImageId', 'pgImageId'):
        if not IMAGE_ID.fullmatch(_require_str(data, key)):
            raise ValueError(f'IMAGE_ID_INVALID:{key}')
    for key in ('apiBaseDigest', 'webNodeBaseDigest', 'webNginxBaseDigest', 'pgImageRef'):
        if not DIGEST_REF.fullmatch(_require_str(data, key)):
            raise ValueError(f'DIGEST_REF_INVALID:{key}')
    for key in ('apiImageTag', 'webImageTag'):
        if not TAG.fullmatch(_require_str(data, key)):
            raise ValueError(f'IMAGE_TAG_INVALID:{key}')
    if not data['apiImageTag'].endswith(source):
        raise ValueError('API_TAG_SOURCE_MISMATCH')
    if not data['webImageTag'].endswith(source):
        raise ValueError('WEB_TAG_SOURCE_MISMATCH')
    expected_paths = {
        'migrationPath': 'db/migrations/001_s32_core_schema.sql',
        'roleBootstrapPath': 'deploy/s32-production-roles.sql',
        's32OverridePath': 'deploy/s32-production.override.yml',
    }
    for key, expected in expected_paths.items():
        if _require_str(data, key) != expected:
            raise ValueError(f'PATH_INVALID:{key}')
    return {key: data[key] for key in FIELDS}


def canonicalize_manifest(data: dict[str, Any]) -> bytes:
    valid = validate_manifest(data)
    ordered = {key: valid[key] for key in FIELDS}
    return (json.dumps(ordered, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def fingerprint_manifest(data: dict[str, Any]) -> str:
    return hashlib.sha256(canonicalize_manifest(data)).hexdigest()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print('usage: s32-release-manifest.py manifest.json', file=sys.stderr)
        return 2
    path = pathlib.Path(argv[1])
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        valid = validate_manifest(data)
        fp = fingerprint_manifest(valid)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f'STATUS=BLOCKED\nBLOCK_REASON={exc}', file=sys.stderr)
        return 1
    print('STATUS=PASS')
    print(f'SOURCE_SHA={valid["sourceSha"]}')
    print(f'S32_RELEASE_FINGERPRINT={fp}')
    print('MANIFEST_VALIDATED=true')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
