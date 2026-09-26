#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile

MAX_JSON_BLOB_BYTES = 8 * 1024 * 1024

def die(reason: str) -> int:
    print("STATUS=BLOCKED")
    print(f"BLOCK_REASON={reason}")
    return 1

def normalize_digest(value: str) -> str:
    value = value.strip()
    if not value.startswith("sha256:") or len(value) != 71:
        raise ValueError("INVALID_SHA256_DIGEST")
    int(value[7:], 16)
    return value

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expected-manifest-digest", required=True)
    ap.add_argument("--expected-config-digest", required=True)
    ap.add_argument("--expected-revision", required=True)
    args = ap.parse_args()

    try:
        expected_manifest = normalize_digest(args.expected_manifest_digest)
        expected_config = normalize_digest(args.expected_config_digest)
        revision = args.expected_revision.strip()
        if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
            raise ValueError("INVALID_REVISION")

        verified_blobs: set[str] = set()
        small_blobs: dict[str, bytes] = {}
        index_raw: bytes | None = None

        with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as tf:
            for member in tf:
                if not member.isfile():
                    continue
                f = tf.extractfile(member)
                if f is None:
                    raise ValueError("ARCHIVE_MEMBER_READ_FAILED")
                h = hashlib.sha256()
                captured = bytearray()
                capture = member.size <= MAX_JSON_BLOB_BYTES
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    h.update(chunk)
                    if capture:
                        captured.extend(chunk)

                name = member.name.lstrip("./")
                if name == "index.json":
                    index_raw = bytes(captured)
                    continue
                prefix = "blobs/sha256/"
                if name.startswith(prefix):
                    hex_name = name[len(prefix):]
                    if len(hex_name) != 64 or any(c not in "0123456789abcdef" for c in hex_name):
                        raise ValueError("INVALID_BLOB_PATH")
                    actual = "sha256:" + h.hexdigest()
                    expected_from_path = "sha256:" + hex_name
                    if actual != expected_from_path:
                        raise ValueError("BLOB_DIGEST_MISMATCH")
                    verified_blobs.add(actual)
                    if capture:
                        small_blobs[actual] = bytes(captured)

        if index_raw is None:
            raise ValueError("OCI_INDEX_MISSING")
        index = json.loads(index_raw)
        manifests = index.get("manifests")
        if not isinstance(manifests, list) or not manifests:
            raise ValueError("OCI_INDEX_MANIFESTS_INVALID")
        if not any(isinstance(d, dict) and d.get("digest") == expected_manifest for d in manifests):
            raise ValueError("EXPECTED_MANIFEST_DIGEST_NOT_FOUND")
        if expected_manifest not in verified_blobs:
            raise ValueError("MANIFEST_BLOB_NOT_VERIFIED")
        manifest_raw = small_blobs.get(expected_manifest)
        if manifest_raw is None:
            raise ValueError("MANIFEST_BLOB_TOO_LARGE_OR_MISSING")
        manifest = json.loads(manifest_raw)

        config = manifest.get("config")
        if not isinstance(config, dict) or config.get("digest") != expected_config:
            raise ValueError("CONFIG_DIGEST_MISMATCH")
        if expected_config not in verified_blobs:
            raise ValueError("CONFIG_BLOB_NOT_VERIFIED")
        config_raw = small_blobs.get(expected_config)
        if config_raw is None:
            raise ValueError("CONFIG_BLOB_TOO_LARGE_OR_MISSING")
        config_json = json.loads(config_raw)
        labels = ((config_json.get("config") or {}).get("Labels") or {})
        if labels.get("org.opencontainers.image.revision") != revision:
            raise ValueError("OCI_REVISION_MISMATCH")

        layers = manifest.get("layers")
        if not isinstance(layers, list) or not layers:
            raise ValueError("LAYER_SET_INVALID")
        layer_count = 0
        for layer in layers:
            if not isinstance(layer, dict):
                raise ValueError("LAYER_DESCRIPTOR_INVALID")
            digest = normalize_digest(str(layer.get("digest", "")))
            if digest not in verified_blobs:
                raise ValueError("LAYER_BLOB_NOT_VERIFIED")
            layer_count += 1

        print("STATUS=PASS")
        print("IMAGE_ARCHIVE_IDENTITY=PASS")
        print(f"MANIFEST_DIGEST={expected_manifest}")
        print(f"CONFIG_DIGEST={expected_config}")
        print(f"OCI_REVISION={revision}")
        print(f"LAYER_COUNT={layer_count}")
        return 0
    except (ValueError, json.JSONDecodeError, tarfile.TarError, OSError) as exc:
        return die(str(exc))

if __name__ == "__main__":
    raise SystemExit(main())
