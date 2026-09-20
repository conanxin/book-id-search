import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, cp, copyFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const apiRoot = fileURLToPath(new URL("./", import.meta.url));

// Observe the actual TCP listener, without replacing the API or choosing its address.
const probeSource = `
import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening', () => console.log('S32_LISTEN=' + JSON.stringify({
    platform: process.platform, node: process.version, ...this.address()
  })));
  return listen.apply(this, args);
};
`;

for (const scenario of [
  { name: "development defaults to loopback", mode: "dev", host: undefined, expected: "127.0.0.1" },
  { name: "development respects explicit API_HOST over dotenv", mode: "dev", host: "127.0.0.2", dotenvHost: "127.0.0.1", expected: "127.0.0.2" },
  { name: "development respects dotenv API_HOST", mode: "dev", host: undefined, dotenvHost: "127.0.0.2", expected: "127.0.0.2" },
  { name: "compiled production defaults to all interfaces", mode: "production", host: undefined, expected: "0.0.0.0" },
  { name: "compiled production respects explicit API_HOST", mode: "production", host: "127.0.0.2", expected: "127.0.0.2" },
]) {
  test(scenario.name, { timeout: 60_000 }, async (t) => {
    const scratch = await mkdtemp(path.join(tmpdir(), "s32-dev-entry-"));
    // Run the real sources/script with the same dependencies, but never read the user's .env.
    const fixtureApi = path.join(scratch, "apps", "api");
    await mkdir(fixtureApi, { recursive: true });
    await cp(path.join(apiRoot, "src"), path.join(fixtureApi, "src"), { recursive: true });
    await cp(path.join(apiRoot, "dist"), path.join(fixtureApi, "dist"), { recursive: true });
    await copyFile(path.join(apiRoot, "package.json"), path.join(fixtureApi, "package.json"));
    await symlink(path.join(apiRoot, "node_modules"), path.join(fixtureApi, "node_modules"), "junction");
    if (scenario.dotenvHost) await writeFile(path.join(scratch, ".env"), `API_HOST=${scenario.dotenvHost}\n`);
    const probe = path.join(scratch, "listen-probe.mjs");
    await writeFile(probe, probeSource);
    const env = {
      ...process.env, API_PORT: "0", S32_FEATURES_ENABLED: "false",
      NODE_OPTIONS: `--import=${pathToFileURL(probe).href}`,
    };
    delete env.API_HOST;
    delete env.S32_DATABASE_URL;
    delete env.S32_PRIVATE_API_TOKEN;
    if (scenario.host !== undefined) env.API_HOST = scenario.host;
    // Invoke the actual package dev script: pnpm uses cmd.exe on native Windows.
    assert.ok(process.env.npm_execpath, "Run through pnpm run test:dev-entry after building the API");
    const args = scenario.mode === "dev"
      ? [process.env.npm_execpath, "run", "dev"] : ["dist/index.js"];
    const child = spawn(process.execPath, args, {
      cwd: fixtureApi, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let output = "";
    let timer;
    try {
      const bound = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 40_000);
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`API exited ${code}: ${output}`)));
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/S32_LISTEN=(\{[^\n]+\})/);
          if (match) resolve(JSON.parse(match[1]));
        });
      });
      assert.equal(bound.address, scenario.expected);
      assert.equal(bound.platform, process.platform);
      const host = bound.address === "0.0.0.0" ? "127.0.0.1" : bound.address;
      const response = await fetch(`http://${host}:${bound.port}/api/private/s32/projects`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 404); // Real API, S32 disabled: no PG or Meili access.
      assert.ok((await response.json()).error);
      t.diagnostic(`${bound.platform} ${bound.node} bound=${bound.address} HTTP=404 (S32 disabled)`);
    } finally {
      clearTimeout(timer);
      if (child.pid) {
        try {
          if (process.platform === "win32") {
            execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          } else {
            process.kill(-child.pid, "SIGTERM");
          }
        } catch (error) { if (child.exitCode === null && error.code !== "ESRCH") throw error; }
      }
      await closed;
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
