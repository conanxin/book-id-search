#!/bin/sh
# The supported recovery execution entrypoint. Non-interactive /bin/sh does
# not evaluate NODE_OPTIONS before this guard. Never launch recovery through
# `node --require`, `node --import`, or a shell with startup hooks instead.
set +x
set -eu
block() {
  printf 'R7_BROWSER_RECEIPT=FAIL\nREASON=%s\n' "$1"
  exit 1
}
# Reject rather than silently overriding injected runtimes/trust settings.
# Values (including credentials) must never enter output or command arguments.
[ -z "${NODE_OPTIONS-}${NODE_PATH-}${NODE_EXTRA_CA_CERTS-}${NODE_TLS_REJECT_UNAUTHORIZED-}${NODE_ICU_DATA-}${NODE_REPL_EXTERNAL_MODULE-}${NODE_USE_ENV_PROXY-}${LD_PRELOAD-}${LD_LIBRARY_PATH-}${LD_AUDIT-}${DYLD_INSERT_LIBRARIES-}${DYLD_LIBRARY_PATH-}${BASH_ENV-}${ENV-}${OPENSSL_CONF-}${OPENSSL_MODULES-}" ] \
  || block RECOVERY_RUNTIME_INJECTION_REJECTED
[ "$#" -eq 5 ] && [ "$1" = --recover-browser ] || block INVALID_ARGUMENTS
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE_BIN="$(command -v node)" || block NODE_UNAVAILABLE
case "$NODE_BIN" in /*) ;; *) block NODE_PATH_NOT_ABSOLUTE ;; esac
# A defense against accidentally bypassing this entrypoint, not an attestation
# against a malicious local operator who controls binaries or the filesystem.
S32_R7_RECOVERY_LAUNCHER=SHELL_V1
NO_PROXY=127.0.0.1,localhost
no_proxy=127.0.0.1,localhost
export S32_R7_RECOVERY_LAUNCHER NO_PROXY no_proxy
# The token remains in the inherited environment, never an env(1) assignment
# on argv. Node receives no caller-controlled runtime flags.
exec "$NODE_BIN" "$SCRIPT_DIR/s32-r7-browser-receipt-producer.cjs" recovery-browser "$2" "$3" "$4" "$5"
