#!/usr/bin/env bash
# S32 P0 backup policy — synthetic-only pg_dump -> age -> scratch restore proof.
# This is NOT a production backup, external transfer, or deployment tool.
set -euo pipefail
umask 077

if [[ "$(printenv GITHUB_ACTIONS || true)" != "true" || "$(printenv S32_BACKUP_SYNTHETIC_ONLY || true)" != "YES" ]]; then
  echo "STATUS=BLOCKED reason=SYNTHETIC_CI_ONLY" >&2
  exit 3
fi

for binary in docker age age-keygen sha256sum python3; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "STATUS=BLOCKED reason=MISSING_SYNTHETIC_TEST_TOOL" >&2
    exit 3
  fi
done

ROOT="$(mktemp -d)"
SOURCE_CONTAINER="s32-backup-syn-src-$$"
RESTORE_CONTAINER="s32-backup-syn-dst-$$"
LABEL="book-id-search.s32-backup-synthetic"
mkdir -m 700 -p "$ROOT/object-store-simulation"
CLEAN=YES
cleanup() {
  local initial="$?"
  trap - EXIT
  for name in "$SOURCE_CONTAINER" "$RESTORE_CONTAINER"; do
    if docker inspect "$name" >/dev/null 2>&1; then
      identity="$(docker inspect --format '{{ index .Config.Labels "book-id-search.s32-backup-synthetic" }}' "$name" 2>/dev/null || true)"
      if [[ "$identity" == "$name" ]]; then
        docker rm -f "$name" >/dev/null 2>&1 || CLEAN=NO
      else
        CLEAN=NO
        echo "SYNTHETIC_CONTAINER_OWNERSHIP_MISMATCH=YES" >&2
      fi
    fi
  done
  rm -rf -- "$ROOT"
  if [[ "$CLEAN" == "YES" ]]; then
    echo "SYNTHETIC_CONTAINERS_REMOVED=YES"
  else
    echo "SYNTHETIC_CONTAINERS_REMOVED=NO" >&2
    initial=1
  fi
  exit "$initial"
}
trap cleanup EXIT

docker run -d --rm --network none --name "$SOURCE_CONTAINER" \
  --label "$LABEL=$SOURCE_CONTAINER" --memory=512m \
  --tmpfs /var/lib/postgresql/data:rw,size=268435456 \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=synthetic_source \
  -e POSTGRES_PASSWORD=synthetic-test-only-password \
  postgres:16-alpine >/dev/null

docker run -d --rm --network none --name "$RESTORE_CONTAINER" \
  --label "$LABEL=$RESTORE_CONTAINER" --memory=512m \
  --tmpfs /var/lib/postgresql/data:rw,size=268435456 \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=synthetic_restore \
  -e POSTGRES_PASSWORD=synthetic-test-only-password \
  postgres:16-alpine >/dev/null

wait_for_real_sql() {
  local name="$1"
  local db="$2"
  local ready="NO"
  # The official image has a temporary bootstrap daemon. Require multiple
  # SQL observations to avoid passing only against the initialization server.
  for attempt in $(seq 1 100); do
    if [[ "$(docker exec "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -Atc 'SELECT 1' 2>/dev/null || true)" == "1" ]]; then
      sleep 1
      if [[ "$(docker exec "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -Atc 'SELECT 1' 2>/dev/null || true)" == "1" ]]; then
        ready="YES"
        break
      fi
    fi
    sleep 0.25
  done
  if [[ "$ready" != "YES" ]]; then
    echo "STATUS=FAILED reason=DISPOSABLE_POSTGRES_NOT_READY" >&2
    exit 4
  fi
}
wait_for_real_sql "$SOURCE_CONTAINER" synthetic_source
wait_for_real_sql "$RESTORE_CONTAINER" synthetic_restore

docker exec -i "$SOURCE_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U postgres -d synthetic_source -f - >/dev/null <<'SQL'
CREATE SCHEMA core;
CREATE TABLE core.synthetic_evidence (
  id integer PRIMARY KEY,
  fact text NOT NULL
);
INSERT INTO core.synthetic_evidence (id, fact) VALUES
  (1, 'SYNTHETIC_PROOF_ALPHA'),
  (2, 'SYNTHETIC_PROOF_BETA');
SQL

# Private identity is generated only inside the disposable runner, never printed
# or committed. Source-side dump bytes go directly into authenticated encryption.
age-keygen -o "$ROOT/ephemeral-identity.txt" >/dev/null 2>&1
RECIPIENT="$(age-keygen -y "$ROOT/ephemeral-identity.txt")"
docker exec "$SOURCE_CONTAINER" pg_dump -U postgres -d synthetic_source -Fc \
  | age -r "$RECIPIENT" -o "$ROOT/object-store-simulation/synthetic.db.age"

# Hash only ciphertext. This folder is on the SAME disposable CI runner;
# it does NOT demonstrate any actual off-host copy or provider permission.
(
  cd "$ROOT/object-store-simulation"
  sha256sum synthetic.db.age > ciphertext.sha256
  sha256sum --check --status ciphertext.sha256
)

# A wrong identity and a deliberately tampered ciphertext must BOTH fail.
age-keygen -o "$ROOT/wrong-identity.txt" >/dev/null 2>&1
if age -d -i "$ROOT/wrong-identity.txt" -o "$ROOT/wrong.dump" \
  "$ROOT/object-store-simulation/synthetic.db.age" >/dev/null 2>&1; then
  echo "STATUS=FAILED reason=WRONG_KEY_ACCEPTED" >&2
  exit 5
fi
cp "$ROOT/object-store-simulation/synthetic.db.age" "$ROOT/tampered.age"
python3 - "$ROOT/tampered.age" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
buf = bytearray(p.read_bytes())
assert len(buf) > 64
buf[-1] ^= 0x01
p.write_bytes(buf)
PY
if age -d -i "$ROOT/ephemeral-identity.txt" -o "$ROOT/tampered.dump" \
  "$ROOT/tampered.age" >/dev/null 2>&1; then
  echo "STATUS=FAILED reason=TAMPER_ACCEPTED" >&2
  exit 5
fi
echo "SYNTHETIC_AUTHENTICATED_DECRYPTION=PASS"
echo "SYNTHETIC_WRONG_KEY_AND_TAMPER_REJECTED=PASS"

age -d -i "$ROOT/ephemeral-identity.txt" \
  -o "$ROOT/decrypted.dump" "$ROOT/object-store-simulation/synthetic.db.age"
docker cp "$ROOT/decrypted.dump" "$RESTORE_CONTAINER:/tmp/synthetic.dump"

if ! docker exec "$RESTORE_CONTAINER" pg_restore --list /tmp/synthetic.dump \
  | grep -q 'synthetic_evidence'; then
  echo "STATUS=FAILED reason=RESTORE_MANIFEST_MISSING" >&2
  exit 6
fi

docker exec "$RESTORE_CONTAINER" pg_restore --exit-on-error \
  --no-owner --no-privileges -U postgres -d synthetic_restore \
  /tmp/synthetic.dump >/dev/null

RESTORED="$(docker exec "$RESTORE_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U postgres -d synthetic_restore -Atc \
  'SELECT count(*)::text || chr(124) || sum(id)::text FROM core.synthetic_evidence')"

if [[ "$RESTORED" != "2|3" ]]; then
  echo "STATUS=FAILED reason=RESTORE_ASSERTION" >&2
  exit 6
fi

echo "SYNTHETIC_PG16_CUSTOM_DUMP_RESTORE=PASS"
echo "SYNTHETIC_CIPHERTEXT_SHA256=PASS"
echo "PRODUCTION_DATA_USED=NO"
echo "ACTUAL_OFFHOST_BACKUP=NO"
echo "STATUS=SYNTHETIC_POLICY_PROOF_PASS"
