/* Build statically before loading any production credential. This executable
 * has no ELF interpreter, so LD_PRELOAD/LD_AUDIT cannot run before the guard. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef RECOVERY_SCRIPT
#error "RECOVERY_SCRIPT must name the reviewed internal shell script"
#endif
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
  if (setenv("S32_R7_RECOVERY_STATIC_LAUNCHER", "STATIC_V1", 1) != 0)
    return blocked("RECOVERY_LAUNCHER_ENV_FAILED");
  char *child[] = {"/bin/sh", RECOVERY_SCRIPT, argv[1], argv[2], argv[3], argv[4], argv[5], NULL};
  execv(child[0], child);
  return blocked("RECOVERY_LAUNCHER_EXEC_FAILED");
}
