#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

SEARCH_KEYS = ("ISBN", "SSID", "DXID", "title", "author", "publisher")
SERVICES = ("web", "api", "meilisearch")


def evaluate_snapshot(snapshot: dict, expected_docs: int) -> dict[str, str]:
    reasons: list[str] = []

    if snapshot.get("whoami") != "ubuntu" or snapshot.get("hostname") != "VM-0-4-ubuntu":
        reasons.append("IDENTITY_GATE_FAILED")

    services = snapshot.get("services") or {}
    if set(services) != set(SERVICES):
        reasons.append("SERVICE_SET_INVALID")

    cids: list[str] = []
    for name in SERVICES:
        service = services.get(name) or {}
        for key in ("cid", "startedAt", "imageId", "image", "revision"):
            if not service.get(key):
                reasons.append(f"{name.upper()}_{key.upper()}_MISSING")
        if service.get("cid"):
            cids.append(service["cid"])

    if len(cids) != len(set(cids)):
        reasons.append("DUPLICATE_SERVICE_IDENTITY")

    if snapshot.get("publicHttpStatus") != 200:
        reasons.append("PUBLIC_HTTP_FAILED")

    search = snapshot.get("search") or {}
    for key in SEARCH_KEYS:
        if search.get(key) is not True:
            reasons.append(f"SEARCH_{key.upper()}_FAILED_OR_MISSING")

    meili = snapshot.get("meili") or {}
    if meili.get("numberOfDocuments") != expected_docs:
        reasons.append("MEILI_DOC_COUNT_MISMATCH")
    if meili.get("isIndexing") is not False:
        reasons.append("MEILI_INDEXING_NOT_IDLE")

    if snapshot.get("postgresPresent") not in (False, True):
        reasons.append("POSTGRES_PRESENCE_UNKNOWN")
    if not isinstance(snapshot.get("s32EnvNames"), list):
        reasons.append("S32_ENV_NAMES_INVALID")

    runtime_block = any(
        reason.startswith(("IDENTITY_", "SERVICE_", "WEB_", "API_", "MEILISEARCH_", "DUPLICATE_"))
        for reason in reasons
    )
    search_block = any(reason.startswith("SEARCH_") for reason in reasons)

    return {
        "R0_RUNTIME_IDENTITY": "BLOCKED" if runtime_block else "PASS",
        "R0_LEGACY_SEARCH_SMOKE": "BLOCKED" if search_block else "PASS",
        "R0_FINAL": "PASS" if not reasons else "BLOCKED",
        "BLOCK_REASONS": ",".join(reasons),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--expected-docs", type=int, default=5115734)
    args = parser.parse_args(argv)

    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    result = evaluate_snapshot(snapshot, args.expected_docs)
    for key, value in result.items():
        print(f"{key}={value}")
    return 0 if result["R0_FINAL"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
