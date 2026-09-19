import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkInputs,
  _resetCleanupForTest,
  _getCleanupErrorForTest,
  _simulateCleanupFailureForTest,
  _setDockerRunnerForTest,
  _resetDockerRunnerForTest,
  _setContainerForTest,
  _resetContainerForTest,
  cleanup,
  postCleanupDecision,
} from "./s32-schema-check";

function makeTmpWithFiles(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "s32-harness-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    const parent = full.substring(0, full.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("S32 harness: checkInputs() pre-flight", () => {
  it("passes when migration + both assertions exist and non-empty", () => {
    const dir = makeTmpWithFiles({
      "mig.sql": "BEGIN; COMMIT;",
      "001.sql": "-- assertions\n",
      "002.sql": "-- negatives\n",
    });
    expect(() => checkInputs(join(dir, "mig.sql"), [join(dir, "001.sql"), join(dir, "002.sql")])).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws REQUIRED_FILE_MISSING when migration file is absent (temp dir copy)", () => {
    const dir = makeTmpWithFiles({
      "001.sql": "-- assertions\n",
      "002.sql": "-- negatives\n",
    });
    expect(() => checkInputs(join(dir, "mig.sql"), [join(dir, "001.sql"), join(dir, "002.sql")]))
      .toThrow(/REQUIRED_FILE_MISSING/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws REQUIRED_FILE_MISSING when 001 assertion file is absent (temp dir copy)", () => {
    const dir = makeTmpWithFiles({
      "mig.sql": "BEGIN; COMMIT;",
      "002.sql": "-- negatives\n",
    });
    expect(() => checkInputs(join(dir, "mig.sql"), [join(dir, "001.sql"), join(dir, "002.sql")]))
      .toThrow(/REQUIRED_FILE_MISSING/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws REQUIRED_FILE_MISSING when 002 negative file is absent (temp dir copy)", () => {
    const dir = makeTmpWithFiles({
      "mig.sql": "BEGIN; COMMIT;",
      "001.sql": "-- assertions\n",
    });
    expect(() => checkInputs(join(dir, "mig.sql"), [join(dir, "001.sql"), join(dir, "002.sql")]))
      .toThrow(/REQUIRED_FILE_MISSING/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws REQUIRED_FILE_EMPTY when a file is whitespace-only", () => {
    const dir = makeTmpWithFiles({
      "mig.sql": "   \n\n  \t  \n",
      "001.sql": "-- assertions\n",
      "002.sql": "-- negatives\n",
    });
    expect(() => checkInputs(join(dir, "mig.sql"), [join(dir, "001.sql"), join(dir, "002.sql")]))
      .toThrow(/REQUIRED_FILE_EMPTY/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Restore all mock-injected state between tests so no residue leaks.
afterEach(() => {
  _resetDockerRunnerForTest();
  _resetCleanupForTest();
  _resetContainerForTest();
});

describe("S32 harness: cleanup failure tracking (SIMULATED)", () => {
  it("initially no cleanup error", () => {
    _resetCleanupForTest();
    expect(_getCleanupErrorForTest()).toBeNull();
  });

  it("SIMULATED cleanup failure sets lastCleanupError with [SIMULATED] prefix", () => {
    _resetCleanupForTest();
    _simulateCleanupFailureForTest("docker rm returned exit 1");
    const err = _getCleanupErrorForTest();
    expect(err).not.toBeNull();
    expect(err).toMatch(/^\[SIMULATED\]/);
    expect(err).toMatch(/docker rm returned exit 1/);
    _resetCleanupForTest();
  });

  it("SIMULATED cleanup failure must cause non-zero exit (verified by harness exit code)", () => {
    // This test verifies the contract: if lastCleanupError is set, main() must exit non-zero.
    // We cannot easily invoke main() in a unit test without spawning subprocess,
    // but we can verify the exported tracking variable reflects the simulation.
    _resetCleanupForTest();
    expect(_getCleanupErrorForTest()).toBeNull();
    _simulateCleanupFailureForTest("test cleanup failure");
    expect(_getCleanupErrorForTest()).toMatch(/^\[SIMULATED\]/);
    _resetCleanupForTest();
  });

  it("reset clears the error", () => {
    _simulateCleanupFailureForTest("something");
    expect(_getCleanupErrorForTest()).not.toBeNull();
    _resetCleanupForTest();
    expect(_getCleanupErrorForTest()).toBeNull();
  });

  // The real exit logic test: simulate the underlying docker rm failure
  // (not just set lastCleanupError), let the real cleanup() function detect it,
  // then call the real postCleanupDecision() to verify main() would take the
  // exit-2 / no-SCHEMA_OK path. Marked SIMULATED — no real Docker call.
  it("SIMULATED: injected docker rm unexpected failure -> real cleanup() sets lastCleanupError AND real postCleanupDecision() returns error (not 'OK'), proving main() would exit 2 and NOT print SCHEMA_OK", () => {
    _resetCleanupForTest();
    _resetDockerRunnerForTest();
    expect(_getCleanupErrorForTest()).toBeNull();

    // Inject a fake docker runner that simulates an unexpected rm failure
    // (NOT "No such container" — that would be treated as OK).
    _setDockerRunnerForTest(() => ({
      stdout: "",
      stderr: "Error: cannot remove container: container is running",
      status: 1,
    }));
    _setContainerForTest("test-container-simulated");

    // Invoke the REAL cleanup() function (not just _simulate...)
    cleanup();

    // The real cleanup() must have detected the injected failure
    const err = _getCleanupErrorForTest();
    expect(err).not.toBeNull();
    expect(err).toMatch(/cannot remove container/);

    // Invoke the REAL postCleanupDecision() function.
    // If it returns "OK", main() would print SCHEMA_OK and exit 0 (WRONG).
    // If it returns { error }, main() would exit 2 and NOT print SCHEMA_OK (CORRECT).
    const decision = postCleanupDecision();
    expect(decision).not.toBe("OK");
    expect(typeof decision).toBe("object");
    if (typeof decision === "object") {
      expect(decision.error).toMatch(/cannot remove container/);
    }

    _resetDockerRunnerForTest();
    _resetCleanupForTest();
  });

  it("SIMULATED: injected docker rm 'No such container' is treated as OK (clean exit, would print SCHEMA_OK)", () => {
    _resetCleanupForTest();
    _resetDockerRunnerForTest();

    // Inject a fake docker runner that simulates "already removed"
    _setDockerRunnerForTest(() => ({
      stdout: "",
      stderr: "Error: No such container: test-container-already-removed",
      status: 1,
    }));
    _setContainerForTest("test-container-already-removed");

    cleanup();

    // "No such container" must NOT be treated as a failure
    expect(_getCleanupErrorForTest()).toBeNull();

    // postCleanupDecision() must return "OK" — main() would print SCHEMA_OK
    const decision = postCleanupDecision();
    expect(decision).toBe("OK");

    _resetDockerRunnerForTest();
    _resetCleanupForTest();
  });
});
describe("S32 harness: import-only isolation (subprocess)", () => {
  // This test verifies that merely importing the runner (e.g. via vitest or
  // another module) does NOT start Docker, run SQL, or print SCHEMA_OK.
  // A recording fake `docker` is prepended to PATH so that ANY docker call
  // (including via sudo) is logged. The import script is then run in a
  // child process via tsx. We assert:
  //   - exit code 0
  //   - stdout contains IMPORT_DONE marker
  //   - stdout does NOT contain SCHEMA_OK
  //   - the recording fake docker log shows 0 docker invocations
  //     (proves no command ran, even transiently — "create then delete"
  //      would still leave a recorded call)
  it("importing the runner in a subprocess triggers 0 docker commands, no SCHEMA_OK, exits 0", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "s32-import-only-"));
    const mockBin = join(tmpDir, "bin");
    mkdirSync(mockBin, { recursive: true });

    const dockerLog = join(tmpDir, "docker.log");
    const dockerScript = join(mockBin, "docker");
    writeFileSync(dockerScript,
      "#!/bin/bash\necho \"DOCKER_CALLED:$@\" >> \"" + dockerLog + "\"\nexit 1\n");
    chmodSync(dockerScript, 0o755);

    const importScript = join(tmpDir, "import-only.mjs");
    const runnerTs = resolve(process.cwd(), "scripts/s32-schema-check.ts");
    writeFileSync(importScript,
      "const runnerPath = " + JSON.stringify(runnerTs) + ";\n" +
      "await import(runnerPath);\n" +
      "await new Promise(function(r){ setTimeout(r, 200); });\n" +
      "console.log(\"IMPORT_DONE\");\n");

    const env = Object.assign({}, process.env, {
      PATH: mockBin + ":" + (process.env.PATH || ""),
    });
    const tsx = resolve(process.cwd(), "node_modules/.bin/tsx");

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      stdout = execFileSync(tsx, [importScript], {
        encoding: "utf8",
        env: env,
        cwd: process.cwd(),
        timeout: 30000,
      });
    } catch (e: any) {
      stdout = (e.stdout ?? "") + (e.stderr ?? "");
      stderr = e.stderr ?? "";
      exitCode = e.status ?? -1;
    }

    // Assert exit code 0
    if (exitCode !== 0) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`import-only subprocess exited ${exitCode}; stdout=${stdout}; stderr=${stderr}`);
    }
    // Assert import succeeded
    expect(stdout).toContain("IMPORT_DONE");
    // Assert no SCHEMA_OK
    if (stdout.includes("SCHEMA_OK") || stderr.includes("SCHEMA_OK")) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`import-only subprocess printed SCHEMA_OK; stdout=${stdout}; stderr=${stderr}`);
    }
    // Assert 0 docker calls (the recording mock would have logged any)
    let dockerCalls: string[] = [];
    if (existsSync(dockerLog)) {
      const logContent = readFileSync(dockerLog, "utf8").trim();
      dockerCalls = logContent.length > 0 ? logContent.split("\n") : [];
    }
    if (dockerCalls.length > 0) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`import-only subprocess invoked docker ${dockerCalls.length} time(s): ${dockerCalls.join(" | ")}`);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
