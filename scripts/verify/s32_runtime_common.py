#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path

SECRET_WORDS = ("PASSWORD", "TOKEN", "SECRET", "DATABASE_URL")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_unique_kv(text: str, required: set[str] | None = None) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("INVALID_KV_LINE")
        key, value = line.split("=", 1)
        if key in out:
            raise ValueError("DUPLICATE_KEY")
        out[key] = value
    if required is not None and required - set(out):
        raise ValueError("MISSING_KEY")
    return out


def _reject_secret_keys(fields: dict[str, str]) -> None:
    for key in fields:
        if any(word in key.upper() for word in SECRET_WORDS):
            raise ValueError("SECRET_FIELD_FORBIDDEN")


def _canonical(fields: dict[str, str]) -> str:
    _reject_secret_keys(fields)
    return "".join(f"{key}={fields[key]}\n" for key in sorted(fields))


def write_receipt_atomic(path: Path, fields: dict[str, str]) -> str:
    if path.exists() or path.is_symlink():
        raise ValueError("RECEIPT_ALREADY_EXISTS")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    if tmp.exists() or tmp.is_symlink():
        raise ValueError("UNSAFE_TEMP_FILE")
    tmp.write_text(_canonical(fields), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return sha256_file(path)


def read_receipt(path: Path) -> dict[str, str]:
    if path.is_symlink() or not path.is_file():
        raise ValueError("UNSAFE_RECEIPT_FILE")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("UNSAFE_RECEIPT_PERMISSIONS")
    return parse_unique_kv(path.read_text(encoding="utf-8"))


def classify_attempt(start_path: Path, result_path: Path) -> str:
    start_exists = start_path.exists() or start_path.is_symlink()
    result_exists = result_path.exists() or result_path.is_symlink()
    if result_exists:
        return "TERMINAL"
    if start_exists:
        return "INCOMPLETE"
    return "NOT_STARTED"
