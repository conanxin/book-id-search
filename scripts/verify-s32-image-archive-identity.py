#!/usr/bin/env python3
"""Verify a Docker image archive against a frozen config digest across image-store backends.

Classic Docker stores commonly expose the image config digest as .Id.
Docker's containerd image store may expose the OCI manifest digest instead.
This verifier accepts either only when the saved archive cryptographically
proves that the manifest points to the exact expected config digest.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys
import tarfile

DIGEST = re.compile(r"^sha256:([0-9a-f]{64})$")


def block(reason: str) -> int:
    print("STATUS=BLOCKED")
    print(f"BLOCK_REASON={reason}")
    return 1


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def normalize(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    return name


def labels_from_config(data: dict) -> dict:
    for key in ("config", "Config"):
        value = data.get(key)
        if isinstance(value, dict) and isinstance(value.get("Labels"), dict):
            return value["Labels"]
    return {}


def read_bytes(tf: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str) -> bytes:
    key = normalize(name)
    member = members.get(key)
    if member is None or not member.isfile():
        raise ValueError(f"ARCHIVE_MEMBER_MISSING:{key}")
    fp = tf.extractfile(member)
    if fp is None:
        raise ValueError(f"ARCHIVE_MEMBER_UNREADABLE:{key}")
    return fp.read()


def hash_member(tf: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str) -> str:
    key = normalize(name)
    member = members.get(key)
    if member is None or not member.isfile():
        raise ValueError(f"ARCHIVE_MEMBER_MISSING:{key}")
    fp = tf.extractfile(member)
    if fp is None:
        raise ValueError(f"ARCHIVE_MEMBER_UNREADABLE:{key}")
    h = hashlib.sha256()
    for chunk in iter(lambda: fp.read(1024 * 1024), b""):
        h.update(chunk)
    return "sha256:" + h.hexdigest()


def validate_revision(config: dict, expected_revision: str) -> None:
    labels = labels_from_config(config)
    if labels.get("org.opencontainers.image.revision") != expected_revision:
        raise ValueError("OCI_REVISION_MISMATCH")


def verify_oci(
    tf: tarfile.TarFile,
    members: dict[str, tarfile.TarInfo],
    expected_config: str,
    observed: str,
    expected_revision: str,
) -> tuple[str, str, str]:
    index = json.loads(read_bytes(tf, members, "index.json"))
    descriptors = index.get("manifests")
    if not isinstance(descriptors, list) or len(descriptors) != 1:
        raise ValueError("OCI_MANIFEST_DESCRIPTOR_AMBIGUOUS")
    desc = descriptors[0]
    manifest_digest = desc.get("digest") if isinstance(desc, dict) else None
    match = DIGEST.fullmatch(str(manifest_digest or ""))
    if not match:
        raise ValueError("OCI_MANIFEST_DIGEST_INVALID")
    manifest_path = f"blobs/sha256/{match.group(1)}"
    manifest_bytes = read_bytes(tf, members, manifest_path)
    if sha256_bytes(manifest_bytes) != manifest_digest:
        raise ValueError("OCI_MANIFEST_DIGEST_MISMATCH")
    manifest = json.loads(manifest_bytes)

    config_desc = manifest.get("config")
    config_digest = config_desc.get("digest") if isinstance(config_desc, dict) else None
    match = DIGEST.fullmatch(str(config_digest or ""))
    if not match:
        raise ValueError("OCI_CONFIG_DIGEST_INVALID")
    config_path = f"blobs/sha256/{match.group(1)}"
    config_bytes = read_bytes(tf, members, config_path)
    if sha256_bytes(config_bytes) != config_digest:
        raise ValueError("OCI_CONFIG_BLOB_DIGEST_MISMATCH")
    if config_digest != expected_config:
        raise ValueError("CONFIG_DIGEST_MISMATCH")
    config = json.loads(config_bytes)
    validate_revision(config, expected_revision)

    layers = manifest.get("layers")
    if not isinstance(layers, list):
        raise ValueError("OCI_LAYERS_INVALID")
    for layer in layers:
        digest = layer.get("digest") if isinstance(layer, dict) else None
        match = DIGEST.fullmatch(str(digest or ""))
        if not match:
            raise ValueError("OCI_LAYER_DIGEST_INVALID")
        if hash_member(tf, members, f"blobs/sha256/{match.group(1)}") != digest:
            raise ValueError("OCI_LAYER_BLOB_DIGEST_MISMATCH")

    if observed == expected_config:
        mode = "CONFIG_DIGEST"
    elif observed == manifest_digest:
        mode = "MANIFEST_DIGEST"
    else:
        raise ValueError("OBSERVED_IMAGE_ID_MISMATCH")
    return mode, config_digest, manifest_digest


def verify_docker(
    tf: tarfile.TarFile,
    members: dict[str, tarfile.TarInfo],
    expected_config: str,
    observed: str,
    expected_revision: str,
) -> tuple[str, str, str]:
    entries = json.loads(read_bytes(tf, members, "manifest.json"))
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
        raise ValueError("DOCKER_MANIFEST_AMBIGUOUS")
    entry = entries[0]
    config_name = entry.get("Config")
    if not isinstance(config_name, str) or not config_name:
        raise ValueError("DOCKER_CONFIG_MISSING")
    config_bytes = read_bytes(tf, members, config_name)
    config_digest = sha256_bytes(config_bytes)
    if config_digest != expected_config:
        raise ValueError("CONFIG_DIGEST_MISMATCH")
    config = json.loads(config_bytes)
    validate_revision(config, expected_revision)

    layers = entry.get("Layers")
    rootfs = config.get("rootfs") if isinstance(config.get("rootfs"), dict) else config.get("RootFS")
    diff_ids = rootfs.get("diff_ids") if isinstance(rootfs, dict) else None
    if isinstance(layers, list) and isinstance(diff_ids, list):
        if len(layers) != len(diff_ids):
            raise ValueError("DOCKER_LAYER_COUNT_MISMATCH")
        for name, expected in zip(layers, diff_ids):
            if DIGEST.fullmatch(str(expected or "")) and hash_member(tf, members, str(name)) != expected:
                raise ValueError("DOCKER_LAYER_DIFF_ID_MISMATCH")

    if observed != expected_config:
        raise ValueError("OBSERVED_IMAGE_ID_MISMATCH")
    return "CONFIG_DIGEST", config_digest, "N/A"


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        return block("INVALID_ARGUMENTS")
    archive = pathlib.Path(argv[1])
    expected_config = argv[2]
    observed = argv[3]
    expected_revision = argv[4]
    if not archive.is_file() or archive.is_symlink():
        return block("ARCHIVE_UNSAFE")
    if not DIGEST.fullmatch(expected_config):
        return block("EXPECTED_CONFIG_DIGEST_INVALID")
    if not DIGEST.fullmatch(observed):
        return block("OBSERVED_IMAGE_ID_INVALID")
    if not re.fullmatch(r"[0-9a-f]{40}", expected_revision):
        return block("EXPECTED_REVISION_INVALID")

    try:
        with tarfile.open(archive, "r:*") as tf:
            members = {normalize(m.name): m for m in tf.getmembers()}
            if "index.json" in members:
                mode, config_digest, manifest_digest = verify_oci(
                    tf, members, expected_config, observed, expected_revision
                )
                archive_format = "OCI"
            elif "manifest.json" in members:
                mode, config_digest, manifest_digest = verify_docker(
                    tf, members, expected_config, observed, expected_revision
                )
                archive_format = "DOCKER"
            else:
                raise ValueError("ARCHIVE_FORMAT_UNSUPPORTED")
    except (OSError, tarfile.TarError, json.JSONDecodeError, ValueError) as exc:
        return block(str(exc))

    print("STATUS=PASS")
    print(f"ARCHIVE_FORMAT={archive_format}")
    print(f"BACKEND_IDENTITY_MODE={mode}")
    print(f"OBSERVED_IMAGE_ID={observed}")
    print(f"CONFIG_DIGEST={config_digest}")
    print(f"MANIFEST_DIGEST={manifest_digest}")
    print(f"OCI_REVISION={expected_revision}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
