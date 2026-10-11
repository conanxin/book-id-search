import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: spawn }));

const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  spawn.mockReset();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

function simulatePostgresStartup(failSchema = false) {
  let container = "";
  let finalServer = false;
  let tcpProbes = 0;
  let schemaAttempts = 0;
  let testRuns = 0;
  const probes: string[][] = [];
  const removed: string[] = [];
  const result = (status = 0, stdout = "", stderr = "") => ({ status, stdout, stderr });

  spawn.mockImplementation((command: string, args: string[]) => {
    if (command.endsWith("/node_modules/.bin/vitest")) {
      testRuns++;
      return result(finalServer && schemaAttempts === 1 && !failSchema ? 0 : 1);
    }
    if (command !== "docker") throw new Error(`Unexpected command: ${command}`);
    const operation = args[2]; // The runner always prefixes --host and its socket.
    if (operation === "run") {
      container = args[args.indexOf("--name") + 1];
      return result(0, container);
    }
    if (args.includes("pg_isready")) {
      probes.push(args);
      const tcp = args.includes("-h") && args[args.indexOf("-h") + 1] === "127.0.0.1";
      // The init server accepts socket probes, then shuts down. Only the
      // second TCP probe sees the final server that can safely run migrations.
      if (!tcp) return result();
      if (++tcpProbes === 1) return result(1, "", "no response");
      finalServer = true;
      return result();
    }
    if (args.includes("psql")) {
      schemaAttempts++;
      if (!finalServer) return result(2, "", "FATAL: terminating connection due to administrator command");
      if (failSchema) return result(2, "", "schema setup failed");
      return result();
    }
    if (operation === "port") return result(0, "127.0.0.1:54329");
    if (operation === "inspect") return result(0, container);
    if (operation === "rm") {
      removed.push(args.at(-1)!);
      return result();
    }
    throw new Error(`Unexpected Docker operation: ${operation}`);
  });
  return { probes, removed, schemaAttempts: () => schemaAttempts, testRuns: () => testRuns };
}

describe("M1B disposable PostgreSQL startup", () => {
  it("waits past the socket-only init server before schema setup and the real test command", async () => {
    const fixture = simulatePostgresStartup();
    await import("./s32-m1b-integration-check.js");

    expect(process.exitCode).toBeUndefined();
    expect(fixture.probes).toHaveLength(2);
    expect(fixture.schemaAttempts()).toBe(1);
    expect(fixture.testRuns()).toBe(1);
    expect(fixture.removed).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith("S32_M1B_REAL_PG=PASS");
    expect(console.log).toHaveBeenCalledWith("DISPOSABLE_TEST_CONTAINER_REMOVED=YES");
  });

  it("still fails closed and cleans up if setup fails after final TCP readiness", async () => {
    const fixture = simulatePostgresStartup(true);
    await import("./s32-m1b-integration-check.js");

    expect(process.exitCode).toBe(1);
    expect(fixture.probes).toHaveLength(2);
    expect(fixture.schemaAttempts()).toBe(1);
    expect(fixture.testRuns()).toBe(0);
    expect(fixture.removed).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("Docker exec failed: schema setup failed");
    expect(console.log).not.toHaveBeenCalledWith("S32_M1B_REAL_PG=PASS");
  });
});
