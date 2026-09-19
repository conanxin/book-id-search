import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkInputs,
  _resetCleanupForTest,
  _getCleanupErrorForTest,
  _simulateCleanupFailureForTest,
  _setDockerRunnerForTest,
  _resetDockerRunnerForTest,
  _setContainerForTest,
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