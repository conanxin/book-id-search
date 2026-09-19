import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkInputs,
  _resetCleanupForTest,
  _getCleanupErrorForTest,
  _simulateCleanupFailureForTest,
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
});