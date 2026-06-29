import { existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const GIB = 1024 ** 3;
const MIN_FREE_FOR_500K = 80 * GIB;

interface StorageTarget {
  root: string;
  freeBytes: number;
  totalBytes: number;
  freeGiB: number;
  totalGiB: number;
  available: boolean;
  error?: string;
}

interface StorageReport {
  generatedAt: string;
  status: "READY_FOR_500K_TARGET" | "BLOCKED_FOR_500K_TARGET";
  minimumFreeGiBFor500k: number;
  targets: StorageTarget[];
  recommendedRoot: string | null;
  recommendedMeiliDataDir: string | null;
  notes: string[];
}

function formatGiB(bytes: number) {
  return `${(bytes / GIB).toFixed(2)} GiB`;
}

function possibleRoots() {
  if (process.platform === "win32") {
    const roots: string[] = [];
    for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (existsSync(root)) roots.push(root);
    }
    return roots;
  }

  return ["/"];
}

function inspectRoot(root: string): StorageTarget {
  try {
    const stats = statfsSync(root);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    return {
      root,
      freeBytes,
      totalBytes,
      freeGiB: Number((freeBytes / GIB).toFixed(2)),
      totalGiB: Number((totalBytes / GIB).toFixed(2)),
      available: true
    };
  } catch (error) {
    return {
      root,
      freeBytes: 0,
      totalBytes: 0,
      freeGiB: 0,
      totalGiB: 0,
      available: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function writeReports(report: StorageReport) {
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/storage-targets.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const rows = report.targets
    .map((target) => {
      const status = target.available ? "可用" : "不可用";
      return `| ${target.root} | ${status} | ${target.freeGiB.toFixed(2)} | ${target.totalGiB.toFixed(2)} | ${target.error ?? ""} |`;
    })
    .join("\n");

  const markdown = `# Windows 存储目标检查

## 结论

- 状态：${report.status}
- 500000 行压测建议最低剩余空间：${report.minimumFreeGiBFor500k} GiB
- 推荐盘符：${report.recommendedRoot ?? "无"}
- 推荐 Meilisearch 数据目录：${report.recommendedMeiliDataDir ?? "无"}

## 盘符空间

| 盘符 | 状态 | 剩余 GiB | 总 GiB | 备注 |
| --- | --- | ---: | ---: | --- |
${rows}

## 建议

${report.notes.map((note) => `- ${note}`).join("\n")}
`;

  writeFileSync("reports/STORAGE_TARGETS.md", markdown, "utf8");
}

export function runStorageCheck() {
  const targets = possibleRoots().map(inspectRoot);
  const usable = targets.filter((target) => target.available);
  const recommended = usable.reduce<StorageTarget | null>((best, target) => {
    if (!best || target.freeBytes > best.freeBytes) return target;
    return best;
  }, null);

  const recommendedRoot = recommended?.root ?? null;
  const recommendedMeiliDataDir = recommendedRoot
    ? path.join(recommendedRoot, "book-id-search", "meili_data")
    : null;
  const ready = Boolean(recommended && recommended.freeBytes >= MIN_FREE_FOR_500K);
  const notes = ready
    ? [
        `推荐把 MEILI_DATA_DIR 设置为 ${recommendedMeiliDataDir}。`,
        "只有确认当前运行中的 meilisearch.exe 已使用这个大盘目录后，才建议执行 500000 行压测。",
        "如果当前 Meilisearch 仍在 C: 临时目录，请先停止旧进程并用新 db-path 启动。"
      ]
    : [
        "没有发现剩余空间达到 80 GiB 的盘符，不建议在本机跑 500000 行以上导入。",
        "可以继续保留 100000 行演示索引，或迁移到腾讯云 4 核 8GB / 160GB SSD 以上机器。",
        "生产全量导入时请把 MEILI_DATA_DIR 放到容量充足的 SSD 数据盘。"
      ];

  const report: StorageReport = {
    generatedAt: new Date().toISOString(),
    status: ready ? "READY_FOR_500K_TARGET" : "BLOCKED_FOR_500K_TARGET",
    minimumFreeGiBFor500k: 80,
    targets,
    recommendedRoot,
    recommendedMeiliDataDir,
    notes
  };

  writeReports(report);
  console.log(
    `[storage] ${report.status}; recommended=${recommendedRoot ?? "none"}; free=${
      recommended ? formatGiB(recommended.freeBytes) : "0 GiB"
    }`
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runStorageCheck();
  } catch (error) {
    console.error(`[storage] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
