#!/usr/bin/env python3
"""Render only; validate the fifth override with dummy credentials, never start services."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--compose", help="Standalone Compose executable; otherwise docker compose")
parser.add_argument("--baseline", type=Path, help="Optional sanitized effective production Compose JSON")
args = parser.parse_args()
compose = [args.compose] if args.compose else ["docker", "compose"]
# Never import real S32 credentials into rendered test output.
env = {k: v for k, v in os.environ.items() if not k.startswith(("S32_", "COMPOSE_"))}
env.update(S32_API_IMAGE="book-id-search-api:release-test", S32_POSTGRES_IMAGE="postgres:16-alpine",
           S32_POSTGRES_DB="s32_test", S32_POSTGRES_USER="s32_test", S32_POSTGRES_PASSWORD="test-only")

with tempfile.TemporaryDirectory(prefix="s32-compose-") as directory:
    tmp = Path(directory)
    (tmp / ".env").write_text("")
    files = []
    if args.baseline:
        files = [args.baseline.resolve()]
    else:
        # Four layers matching the observed production image/mount/port contract.
        layers = [(ROOT / "docker-compose.yml").read_text(),
                  (ROOT / "docker-compose.override.yml").read_text(),
                  json.dumps({"services": {"api": {
                      "image": "book-id-search-api:3add9a60a20364fbd32b64a7d54197b75983d26e",
                      "volumes": ["/data/book-id-search/private-data:/data/private:ro",
                                  "/opt/book-id-search/reports:/app/reports",
                                  "/opt/book-id-search/private-data/weread:/app/private-data/weread:ro"]}}}),
                  json.dumps({"services": {"web": {
                      "image": "book-id-search-web:99a3702c64e5ae389800348dc7310f23eaed4a66"}}})]
        for i, content in enumerate(layers):
            file = tmp / f"layer-{i}.yml"
            file.write_text(content)
            files.append(file)

    def render(extra=(), environment=None, check=True):
        command = compose + ["--project-directory", directory, "--env-file", str(tmp / ".env")]
        for file in [*files, *extra]:
            command += ["-f", str(file)]
        return subprocess.run(command + ["config", "--format", "json"], env=environment or env,
                              text=True, capture_output=True, check=check)

    override = ROOT / "deploy/s32-production.override.yml"
    before = json.loads(render().stdout)["services"]
    after = json.loads(render([override]).stdout)["services"]
    assert set(after) == set(before) | {"postgres"}
    for name in ("web", "meilisearch"):
        assert after[name] == before[name], f"{name} configuration changed"
    api = after["api"]
    assert "build" not in api
    assert api["image"] == env["S32_API_IMAGE"] and api["pull_policy"] == "never"
    for key in ("ports", "volumes", "networks", "logging"):
        assert api.get(key) == before["api"].get(key), key
    assert len(api["volumes"]) == 3
    mounts = {(v["source"], v["target"], v.get("read_only", False)) for v in api["volumes"]}
    assert mounts == {("/data/book-id-search/private-data", "/data/private", True),
                      ("/opt/book-id-search/reports", "/app/reports", False),
                      ("/opt/book-id-search/private-data/weread", "/app/private-data/weread", True)}
    assert len(api["ports"]) == 1
    assert api["ports"][0]["host_ip"] == "127.0.0.1"
    assert str(api["ports"][0]["published"]) == "3001" and api["ports"][0]["target"] == 3001
    assert api["environment"]["S32_FEATURES_ENABLED"] == "false"
    assert api["environment"]["S32_DATABASE_URL"] == ""
    assert api["environment"]["S32_PRIVATE_API_TOKEN"] == ""
    assert api["depends_on"]["postgres"]["condition"] == "service_healthy"
    assert api["depends_on"]["meilisearch"] == before["api"]["depends_on"]["meilisearch"]
    pg = after["postgres"]
    assert not pg.get("ports") and "build" not in pg
    assert pg["pull_policy"] == "never"
    assert set(pg["networks"]) & set(api["networks"])
    assert len(pg["volumes"]) == 1
    volume = pg["volumes"][0]
    assert volume["type"] == "bind" and volume["source"] == "/data/book-id-search/postgres_data"
    assert volume["target"] == "/var/lib/postgresql/data" and not volume.get("read_only", False)
    assert not volume.get("bind", {}).get("create_host_path", False)
    assert pg["healthcheck"]["test"][0] == "CMD-SHELL"
    assert pg["logging"]["options"] == {"max-size": "25m", "max-file": "3"}
    # A template without required image/credential input must fail closed.
    for missing in ("S32_API_IMAGE", "S32_POSTGRES_IMAGE", "S32_POSTGRES_PASSWORD"):
        invalid = {k: v for k, v in env.items() if k != missing}
        result = render([override], environment=invalid, check=False)
        assert result.returncode != 0 and missing in result.stderr, missing
print("S32_COMPOSE_CHECK=PASS (preservation, PG isolation, default-off, required inputs)")
