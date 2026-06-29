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
const privateNamePatterns = [/读秀/i, /下架书/i, /ss与isbn码/i, /isbn码/i];

function addCheck(checks: CheckResult[], name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function readText(relativePath: string) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function fileExists(relativePath: string) {
  return existsSync(path.join(projectRoot, relativePath));
}

function findPrivateDataFiles() {
  const findings: string[] = [];
  const stack = [projectRoot];

  while (stack.length) {
    const current = stack.pop()!;
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
      const isAllowedSample = relativePath.replaceAll("\\", "/") === "data/sample-books.txt";
      const isPrivateDataExtension = [".txt", ".csv", ".tsv", ".db"].some((extension) => lower.endsWith(extension));
      const nameLooksPrivate = privateNamePatterns.some((pattern) => pattern.test(entry.name));
      const largeFile = statSync(fullPath).size > 50 * 1024 * 1024;

      if (!isAllowedSample && (nameLooksPrivate || (relativePath.startsWith(`data${path.sep}`) && isPrivateDataExtension) || largeFile)) {
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
  const markdown = `# 腾讯云部署包检查

## 结论

- 状态：${report.status}
- 生成时间：${report.generatedAt}

## 检查项

| 状态 | 检查项 | 说明 |
| --- | --- | --- |
${rows}
`;

  writeFileSync("reports/DEPLOY_PACKAGE_CHECK.md", markdown, "utf8");
}

export function runDeployPackageCheck() {
  const checks: CheckResult[] = [];

  addCheck(checks, "docker-compose.yml exists", fileExists("docker-compose.yml"), "Docker Compose 配置文件必须存在。");
  addCheck(checks, ".env.example exists", fileExists(".env.example"), "环境变量模板必须存在。");
  addCheck(checks, "README.md exists", fileExists("README.md"), "开源仓库入口文档必须存在。");
  addCheck(checks, "docs/DEPLOY_TENCENT_CLOUD.md exists", fileExists("docs/DEPLOY_TENCENT_CLOUD.md"), "腾讯云部署文档必须存在。");
  addCheck(checks, "docs/OPERATIONS.md exists", fileExists("docs/OPERATIONS.md"), "运维文档必须存在。");
  addCheck(checks, "data/sample-books.txt exists", fileExists("data/sample-books.txt"), "公开样例数据必须存在。");

  if (fileExists("README.md")) {
    const readme = readText("README.md");
    addCheck(checks, "README has deploy section", /腾讯云|Docker Compose|docker compose/i.test(readme), "README 应包含部署入口说明。");
  }

  if (fileExists("docker-compose.yml")) {
    const compose = readText("docker-compose.yml");
    addCheck(checks, "docker compose uses MEILI_DATA_DIR", compose.includes("MEILI_DATA_DIR"), "Meilisearch 数据目录必须可配置。");
  }

  const privateFiles = findPrivateDataFiles();
  addCheck(
    checks,
    "private TXT is outside project",
    privateFiles.length === 0,
    privateFiles.length ? `疑似私有或大型数据文件：${privateFiles.join(", ")}` : "未发现真实 TXT 或大型索引数据进入项目目录。"
  );

  try {
    runBuild("pnpm --filter @book-id-search/api build");
    addCheck(checks, "API build", true, "apps/api 构建通过。");
  } catch (error) {
    addCheck(checks, "API build", false, error instanceof Error ? error.message : String(error));
  }

  try {
    runBuild("pnpm --filter @book-id-search/web build");
    addCheck(checks, "Web build", true, "apps/web 构建通过。");
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
