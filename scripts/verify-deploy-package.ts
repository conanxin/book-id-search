import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface DeployPackageReport {
  generatedAt: string;
  status: "PASS" | "FAIL";
  checks: CheckResult[];
}

const projectRoot = process.cwd();
const ignoredDirs = new Set([".git", "node_modules", "dist", ".vite", "meili_data", "meilisearch", "dumps", "snapshots"]);
const privateNamePatterns = [/读秀/i, /下架书/i, /ss.*isbn/i, /isbn码/i];

function addCheck(checks: CheckResult[], name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function readText(relativePath: string) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function fileExists(relativePath: string) {
  return existsSync(path.join(projectRoot, relativePath));
}

function gitCheckIgnored(relativePath: string) {
  try {
    execFileSync("git", ["check-ignore", "-q", relativePath], { cwd: projectRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findPrivateDataFiles() {
  const findings: string[] = [];
  const stack = [projectRoot];

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(projectRoot, fullPath);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }

      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".log") || lower.endsWith(".pid")) continue;

      const normalizedRelative = relativePath.replaceAll("\\", "/");
      const isAllowedSample = normalizedRelative === "data/sample-books.txt";
      const isIgnoredRuntimeJson =
        normalizedRelative.startsWith("reports/") && (lower.endsWith(".json") || lower.endsWith(".ndjson"));
      const isPrivateDataExtension = [".txt", ".csv", ".tsv", ".db"].some((extension) => lower.endsWith(extension));
      const nameLooksPrivate = privateNamePatterns.some((pattern) => pattern.test(entry.name));
      const largeFile = statSync(fullPath).size > 50 * 1024 * 1024;

      if (
        !isAllowedSample &&
        !isIgnoredRuntimeJson &&
        (nameLooksPrivate || (normalizedRelative.startsWith("data/") && isPrivateDataExtension) || largeFile)
      ) {
        findings.push(relativePath);
      }
    }
  }

  return findings.sort();
}

function runBuild(command: string) {
  execFileSync(command, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: true,
    stdio: "pipe",
    timeout: 120000
  });
}

function writeReports(report: DeployPackageReport) {
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/deploy-package-check.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const rows = report.checks
    .map((check) => `| ${check.passed ? "PASS" : "FAIL"} | ${check.name} | ${check.detail.replaceAll("\n", " ")} |`)
    .join("\n");
  const markdown = `# Deploy Package Check

## Result

- Status: ${report.status}
- Generated at: ${report.generatedAt}

## Checks

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;

  writeFileSync("reports/DEPLOY_PACKAGE_CHECK.md", markdown, "utf8");
}

export function runDeployPackageCheck() {
  const checks: CheckResult[] = [];

  addCheck(checks, "docker-compose.yml exists", fileExists("docker-compose.yml"), "Docker Compose config must exist.");
  addCheck(checks, ".env.example exists", fileExists(".env.example"), "Environment template must exist.");
  addCheck(checks, "README.md exists", fileExists("README.md"), "Public README must exist.");
  addCheck(checks, "docs/DEPLOY_TENCENT_CLOUD.md exists", fileExists("docs/DEPLOY_TENCENT_CLOUD.md"), "Tencent Cloud deployment doc must exist.");
  addCheck(checks, "docs/OPERATIONS.md exists", fileExists("docs/OPERATIONS.md"), "Operations doc must exist.");
  addCheck(checks, "data/sample-books.txt exists", fileExists("data/sample-books.txt"), "Public sample data must exist.");

  for (const deployScript of [
    "scripts/deploy/prepare-server.sh",
    "scripts/deploy/upload-data.ps1",
    "scripts/deploy/deploy-app.sh",
    "scripts/deploy/import-500k.sh",
    "scripts/deploy/verify-remote.sh"
  ]) {
    addCheck(checks, `${deployScript} exists`, fileExists(deployScript), "Required S15 deployment script.");
  }

  addCheck(checks, ".deploy.env is ignored", gitCheckIgnored(".deploy.env"), ".deploy.env must not be committed.");

  if (fileExists("README.md")) {
    const readme = readText("README.md");
    addCheck(checks, "README references Tencent deployment", /腾讯云|Tencent/i.test(readme), "README should link or describe Tencent Cloud deployment.");
    addCheck(
      checks,
      "README states production import params",
      readme.includes("--batch-size 20000") && readme.includes("--search-raw-info false") && readme.includes("--wait-timeout-ms 900000"),
      "README should document recommended production import parameters."
    );
  }

  if (fileExists("docs/DEPLOY_TENCENT_CLOUD.md")) {
    const deployDoc = readText("docs/DEPLOY_TENCENT_CLOUD.md");
    addCheck(
      checks,
      "Tencent doc states production import params",
      deployDoc.includes("--batch-size 20000") && deployDoc.includes("--search-raw-info false") && deployDoc.includes("--wait-timeout-ms 900000"),
      "Deployment doc should document recommended production import parameters."
    );
  }

  if (fileExists("docker-compose.yml")) {
    const compose = readText("docker-compose.yml");
    addCheck(checks, "docker compose uses MEILI_DATA_DIR", compose.includes("MEILI_DATA_DIR"), "Meilisearch data dir must be configurable.");
    addCheck(checks, "docker compose uses BOOK_DATA_DIR", compose.includes("BOOK_DATA_DIR") && compose.includes("/data/private"), "Private data dir must be mounted read-only.");
    addCheck(checks, "docker compose limits Meilisearch bind", compose.includes("MEILI_PORT_BIND"), "Meilisearch port bind should be configurable and default to localhost.");
  }

  const privateFiles = findPrivateDataFiles();
  addCheck(
    checks,
    "private TXT is outside project",
    privateFiles.length === 0,
    privateFiles.length ? `Potential private or large data files: ${privateFiles.join(", ")}` : "No real TXT or large index data found in the project tree."
  );

  try {
    runBuild("pnpm --filter @book-id-search/api build");
    addCheck(checks, "API build", true, "apps/api build passed.");
  } catch (error) {
    addCheck(checks, "API build", false, error instanceof Error ? error.message : String(error));
  }

  try {
    runBuild("pnpm --filter @book-id-search/web build");
    addCheck(checks, "Web build", true, "apps/web build passed.");
  } catch (error) {
    addCheck(checks, "Web build", false, error instanceof Error ? error.message : String(error));
  }

  const report: DeployPackageReport = {
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? "PASS" : "FAIL",
    checks
  };

  writeReports(report);
  console.log(`[deploy-package] ${report.status}; checks=${checks.length}`);
  if (report.status !== "PASS") process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDeployPackageCheck();
}
