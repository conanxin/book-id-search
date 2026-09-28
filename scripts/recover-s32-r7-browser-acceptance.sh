#!/bin/sh
# Internal second stage, reached only through the reviewed static ELF launcher.
# Do not invoke this dynamic shell directly with credentials in its environment.
set +x
set -eu
block() {
  printf 'R7_BROWSER_RECEIPT=FAIL\nREASON=%s\n' "$1"
  exit 1
}
[ "${S32_R7_RECOVERY_STATIC_LAUNCHER-}" = STATIC_V1 ] || block RECOVERY_STATIC_LAUNCHER_REQUIRED
# Reject rather than silently overriding injected runtimes/trust settings.
# Values (including credentials) must never enter output or command arguments.
[ -z "${NODE_OPTIONS-}${NODE_PATH-}${NODE_EXTRA_CA_CERTS-}${NODE_TLS_REJECT_UNAUTHORIZED-}${NODE_ICU_DATA-}${NODE_REPL_EXTERNAL_MODULE-}${NODE_USE_ENV_PROXY-}${LD_PRELOAD-}${LD_LIBRARY_PATH-}${LD_AUDIT-}${DYLD_INSERT_LIBRARIES-}${DYLD_LIBRARY_PATH-}${BASH_ENV-}${ENV-}${OPENSSL_CONF-}${OPENSSL_MODULES-}" ] \
  || block RECOVERY_RUNTIME_INJECTION_REJECTED
[ -z "${GIT_DIR-}${GIT_WORK_TREE-}${GIT_COMMON_DIR-}${GIT_INDEX_FILE-}${GIT_OBJECT_DIRECTORY-}${GIT_ALTERNATE_OBJECT_DIRECTORIES-}${GIT_CONFIG_COUNT-}${GIT_CONFIG_PARAMETERS-}${GIT_CONFIG_GLOBAL-}${GIT_CONFIG_SYSTEM-}${GIT_CONFIG_NOSYSTEM-}" ] \
  || block RECOVERY_GIT_ENVIRONMENT_REJECTED
[ "$#" -eq 5 ] || block INVALID_ARGUMENTS
case "$1" in
  --recover-browser)
    [ "${S32_R7_BROWSER_URL-https://books.conanxin.com/research/projects}" = https://books.conanxin.com/research/projects ] \
      || block RECOVERY_PRODUCTION_URL_REQUIRED
    S32_R7_BROWSER_URL=https://books.conanxin.com/research/projects
    export S32_R7_BROWSER_URL
    RUN_MODE=recovery-browser
    ;;
  --local-browser-fixture) RUN_MODE=recovery-browser-fixture ;;
  *) block INVALID_ARGUMENTS ;;
esac
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
exec "$NODE_BIN" "$SCRIPT_DIR/s32-r7-browser-receipt-producer.cjs" "$RUN_MODE" "$2" "$3" "$4" "$5"
