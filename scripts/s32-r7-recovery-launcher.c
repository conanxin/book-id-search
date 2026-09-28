/* Build statically before loading any production credential. This executable
 * has no ELF interpreter, so LD_PRELOAD/LD_AUDIT cannot run before the guard. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "recovery-payload.h"
extern char **environ;

static int blocked(const char *reason) {
  fprintf(stdout, "R7_BROWSER_RECEIPT=FAIL\nREASON=%s\n", reason);
  return 1;
}

int main(int argc, char **argv) {
  for (char **entry = environ; *entry; ++entry) {
    if (strncmp(*entry, "LD_", 3) == 0 || strncmp(*entry, "DYLD_", 5) == 0) {
      const char *value = strchr(*entry, '=');
      if (value && value[1]) return blocked("RECOVERY_RUNTIME_INJECTION_REJECTED");
    }
  }
  const char *keys[] = {"NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_ICU_DATA", "NODE_REPL_EXTERNAL_MODULE",
    "NODE_USE_ENV_PROXY", "BASH_ENV", "ENV", "OPENSSL_CONF", "OPENSSL_MODULES", NULL};
  for (const char **key = keys; *key; ++key) {
    const char *value = getenv(*key);
    if (value && *value) return blocked("RECOVERY_RUNTIME_INJECTION_REJECTED");
  }
  if (argc != 6) return blocked("INVALID_ARGUMENTS");
  for (char **entry = environ; *entry; ++entry) {
    if (strncmp(*entry, "GIT_", 4) == 0) {
      const char *value = strchr(*entry, '=');
      if (value && value[1]) return blocked("RECOVERY_GIT_ENVIRONMENT_REJECTED");
    }
  }
  const char *tool = getenv("S32_R7_RECOVERY_TOOL_SHA");
  if (!tool || strcmp(tool, RECOVERY_TOOL_SHA) != 0) return blocked("RECOVERY_TOOL_SHA_MISMATCH");
  char *mode;
  if (strcmp(argv[1], "--recover-browser") == 0) {
    const char *url = getenv("S32_R7_BROWSER_URL");
    const char *production = "https://books.conanxin.com/research/projects";
    if (url && strcmp(url, production) != 0) return blocked("RECOVERY_PRODUCTION_URL_REQUIRED");
    if (setenv("S32_R7_BROWSER_URL", production, 1) != 0) return blocked("RECOVERY_LAUNCHER_ENV_FAILED");
    mode = "recovery-browser";
  } else if (strcmp(argv[1], "--local-browser-fixture") == 0) {
    mode = "recovery-browser-fixture";
  } else return blocked("INVALID_ARGUMENTS");
  // Only public reviewed source is on argv. The token stays in the environment.
  // No mutable checkout script or shell is executed, even before dirty checks.
  char *child[] = {RECOVERY_NODE, "-e", RECOVERY_BOOTSTRAP, mode, argv[2], argv[3], argv[4], argv[5], NULL};
  execv(child[0], child);
  return blocked("RECOVERY_LAUNCHER_EXEC_FAILED");
}
