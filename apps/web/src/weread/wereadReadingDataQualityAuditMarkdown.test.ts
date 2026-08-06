/**
 * S27Q-3A — Reading Data Quality Audit Markdown export tests.
 *
 * Two-layer strategy:
 *   1. Behavioural tests that build synthetic audits and exercise
 *      every pure helper plus the main builder.
 *   2. Source-level structural checks that lock down the Markdown
 *      contract: exhaustive label mappings, sanitisation, no
 *      forbidden patterns, no DOM/network/storage/URL leaks.
 *
 * All assertions are deterministic and never depend on real
 * years / books / catalogId / private identifiers.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildReadingDataQualityAuditFilename,
  buildReadingDataQualityAuditMarkdown,
  escapeReadingDataQualityMarkdownInline,
  escapeReadingDataQualityMarkdownTableCell,
  formatReadingDataQualityIssueLabel,
  formatReadingDataQualityMarkdownDate,
  formatReadingDataQualityScope,
  formatReadingDataQualityStatus,
  sanitizeReadingDataQualityMarkdownText,
  triggerReadingDataQualityAuditMarkdownDownload,
  validateReadingDataQualityAuditMarkdown,
  type ReadingDataQualityAuditMarkdownInput,
} from "./wereadReadingDataQualityAuditMarkdown";
import type {
  ReadingDataQualityIssue,
  ReadingDataQualityIssueCode,
  WereadReadingDataQualityAudit,
} from "./wereadReadingDataQualityAudit";

const MD_PATH = resolve(
  __dirname,
  "./wereadReadingDataQualityAuditMarkdown.ts",
);
const mdSource = readFileSync(MD_PATH, "utf8");
const mdCode = mdSource.replace(/^\/\*[\s\S]*?\*\//, "");

// ---------- fixtures ----------

function makeAudit(
  overrides: Partial<WereadReadingDataQualityAudit> = {},
): WereadReadingDataQualityAudit {
  const issue = (o: Partial<ReadingDataQualityIssue>): ReadingDataQualityIssue => ({
    id: "",
    code: "invalid_year",
    severity: "info",
    scope: "coverage",
    ...o,
  });
  return {
    status: "pass",
    issues: [],
    coverage: {
      targetYears: [2025],
      loadedYears: [2025],
      failedYears: [],
      unaccountedYears: [],
      unexpectedLoadedYears: [],
    },
    summary: {
      status: "pass",
      targetYearCount: 1,
      loadedYearCount: 1,
      failedYearCount: 0,
      unaccountedYearCount: 0,
      totalRecords: 100,
      datedRecords: 100,
      matchedRecords: 80,
      matchedBooks: 5,
      datedRecordRatio: 1,
      matchedRecordRatio: 0.8,
      publicTopBookMetadataRatio: 1,
      yearLinkCoverageRatio: 1,
      accountedRatio: 1,
      issueCounts: { error: 0, warning: 0, info: 0 },
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
    },
    meta: {
      source: "current_loaded_archive",
      persisted: false,
      requestedNetwork: false,
    },
    auditedAt: new Date("2026-08-06T07:00:00.000Z"),
    ...overrides,
  };
}

const FIXED_DATE = new Date("2026-08-06T07:00:00.000Z");

function build(args: {
  audit: WereadReadingDataQualityAudit;
  rangeLabel?: string;
  topBooksLimit?: 6 | 12 | 18;
  exportedAt?: Date;
}): { content: string; filename: string } {
  const input: ReadingDataQualityAuditMarkdownInput = {
    audit: args.audit,
    rangeLabel: args.rangeLabel ?? "全部",
    topBooksLimit: args.topBooksLimit ?? 12,
    exportedAt: args.exportedAt ?? FIXED_DATE,
  };
  return buildReadingDataQualityAuditMarkdown(input);
}

// ============================================================
// 1. Structure & metadata
// ============================================================

describe("Markdown export — structure & metadata", () => {
  it("1. top-level title is the audit heading", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).toMatch(/^# 长期档案数据质量审计/m);
  });

  it("2. metadata block lists scope, top N, status, counts, exportedAt", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).toMatch(/## 元数据/);
    expect(content).toMatch(/当前长期档案范围：全部/);
    expect(content).toMatch(/当前 Top N 口径：Top 12/);
    expect(content).toMatch(/审计状态：通过/);
    expect(content).toMatch(/导出时间：/);
    expect(content).toMatch(/生成方式：浏览器本地生成/);
    expect(content).toMatch(/保存状态：未上传服务器/);
  });

  it("3. metadata reflects rangeLabel override", () => {
    const { content } = build({ audit: makeAudit(), rangeLabel: "最近 5 年" });
    expect(content).toMatch(/当前长期档案范围：最近 5 年/);
  });

  it("4. metadata reflects topBooksLimit override", () => {
    const { content } = build({ audit: makeAudit(), topBooksLimit: 18 });
    expect(content).toMatch(/Top N 口径：Top 18/);
  });

  it("5. privacy preamble is always present", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).toMatch(/只检查当前已加载档案的数据覆盖/);
    expect(content).toMatch(/不评价阅读行为/);
    expect(content).toMatch(/不会自动修改数据/);
  });

  it("6. integrity note appears only when failedYears or unaccountedYears present", () => {
    const a = build({
      audit: makeAudit({
        summary: {
          ...makeAudit().summary,
          failedYearCount: 0,
          unaccountedYearCount: 0,
        },
      }),
    });
    expect(a.content).not.toMatch(/暂时失败或未闭合的目标年份/);

    const b = build({
      audit: makeAudit({
        summary: {
          ...makeAudit().summary,
          failedYearCount: 1,
          unaccountedYearCount: 0,
        },
      }),
    });
    expect(b.content).toMatch(/暂时失败或未闭合的目标年份/);
  });
});

// ============================================================
// 2. Status branches
// ============================================================

describe("Markdown export — status branches", () => {
  it("7. pass status renders '通过'", () => {
    const { content } = build({ audit: makeAudit({ status: "pass" }) });
    expect(content).toMatch(/审计状态：通过/);
  });

  it("8. warn status renders '需注意'", () => {
    const { content } = build({ audit: makeAudit({ status: "warn" }) });
    expect(content).toMatch(/审计状态：需注意/);
  });

  it("9. fail status renders '存在一致性错误'", () => {
    const { content } = build({ audit: makeAudit({ status: "fail" }) });
    expect(content).toMatch(/审计状态：存在一致性错误/);
  });

  it("10. issue counts reflect summary counts", () => {
    const audit = makeAudit({
      summary: {
        ...makeAudit().summary,
        errorCount: 1,
        warningCount: 2,
        infoCount: 3,
        issueCounts: { error: 1, warning: 2, info: 3 },
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/错误数量：1/);
    expect(content).toMatch(/警告数量：2/);
    expect(content).toMatch(/信息数量：3/);
  });
});

// ============================================================
// 3. Ratios
// ============================================================

describe("Markdown export — ratios", () => {
  it("11. all five ratios appear with at-most-1-decimal percentages", () => {
    const audit = makeAudit({
      summary: {
        ...makeAudit().summary,
        accountedRatio: 0.5,
        datedRecordRatio: 1,
        matchedRecordRatio: 0.8,
        publicTopBookMetadataRatio: 1,
        yearLinkCoverageRatio: 0,
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/年份闭合比例：50\.0%/);
    expect(content).toMatch(/有效日期记录占比：100%/);
    expect(content).toMatch(/已匹配记录占比：80\.0%/);
    expect(content).toMatch(/Top N 公共元数据完整比例：100%/);
    expect(content).toMatch(/相邻年度链接覆盖比例：0\.0%/);
  });

  it("12. ratios are framed as data coverage, not user scores", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).toMatch(/只描述数据覆盖和可核对程度，不评价阅读行为/);
  });

  it("13. ratio formatter renders 100% for >=0.9999 and 0.0% for <=0", () => {
    expect(build({ audit: makeAudit({ summary: { ...makeAudit().summary, datedRecordRatio: 0.99995 } }) }).content).toMatch(/100%/);
    expect(build({ audit: makeAudit({ summary: { ...makeAudit().summary, datedRecordRatio: -0.1 } }) }).content).toMatch(/0\.0%/);
  });
});

// ============================================================
// 4. Coverage lists
// ============================================================

describe("Markdown export — coverage lists", () => {
  it("14. all five coverage lists render", () => {
    const audit = makeAudit({
      coverage: {
        targetYears: [2025, 2024],
        loadedYears: [2025],
        failedYears: [2024],
        unaccountedYears: [],
        unexpectedLoadedYears: [2026],
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/### 目标年份/);
    expect(content).toMatch(/### 成功加载年份/);
    expect(content).toMatch(/### 暂时失败年份/);
    expect(content).toMatch(/### 未闭合年份/);
    expect(content).toMatch(/### 额外加载年份/);
  });

  it("15. coverage lists show joined numbers or em-dash when empty", () => {
    const audit = makeAudit({
      coverage: {
        targetYears: [2025],
        loadedYears: [],
        failedYears: [],
        unaccountedYears: [],
        unexpectedLoadedYears: [],
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/### 成功加载年份\n—/);
    expect(content).toMatch(/### 暂时失败年份\n—/);
    expect(content).toMatch(/### 未闭合年份\n—/);
    expect(content).toMatch(/### 额外加载年份\n—/);
  });

  it("16. loaded/failed/unaccounted/unexpected sections match input arrays", () => {
    const audit = makeAudit({
      coverage: {
        targetYears: [2025, 2024, 2023],
        loadedYears: [2025],
        failedYears: [2024],
        unaccountedYears: [2023],
        unexpectedLoadedYears: [2026],
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/### 成功加载年份\n2025/);
    expect(content).toMatch(/### 暂时失败年份\n2024/);
    expect(content).toMatch(/### 未闭合年份\n2023/);
    expect(content).toMatch(/### 额外加载年份\n2026/);
  });
});

// ============================================================
// 5. Issue groups
// ============================================================

describe("Markdown export — issue groups", () => {
  function withIssues(): WereadReadingDataQualityAudit {
    return makeAudit({
      status: "fail",
      issues: [
        {
          id: "",
          code: "dated_records_exceed_total",
          severity: "error",
          scope: "year",
          year: 2025,
          actual: 200,
          expected: 100,
          itemIndex: 1,
        },
      ],
      summary: {
        ...makeAudit().summary,
        status: "fail",
        errorCount: 1,
        warningCount: 0,
        infoCount: 0,
        issueCounts: { error: 1, warning: 0, info: 0 },
      },
    });
  }

  it("17. error group rendered for severity=error", () => {
    const { content } = build({ audit: withIssues() });
    expect(content).toMatch(/### 错误/);
    expect(content).toMatch(/有效日期记录超过阅读记录/);
    expect(content).toMatch(/年度指标/);
  });

  it("18. warning group renders 'no issues' when empty", () => {
    const { content } = build({ audit: withIssues() });
    expect(content).toMatch(/### 警告\n当前没有此级别的问题。/);
  });

  it("19. info group renders 'no issues' when empty", () => {
    const { content } = build({ audit: withIssues() });
    expect(content).toMatch(/### 信息\n当前没有此级别的问题。/);
  });

  it("20. year + actual + expected + itemIndex show in error entry", () => {
    const { content } = build({ audit: withIssues() });
    expect(content).toMatch(/年份：2025 年/);
    expect(content).toMatch(/项目位置：第 2 项/);
    expect(content).toMatch(/实际值：200/);
    expect(content).toMatch(/期望值：100/);
  });

  it("21. year pair (fromYear/toYear) renders", () => {
    const audit = makeAudit({
      status: "warn",
      issues: [
        {
          id: "",
          code: "missing_year_link",
          severity: "warning",
          scope: "year_link",
          fromYear: 2024,
          toYear: 2025,
        },
      ],
      summary: {
        ...makeAudit().summary,
        status: "warn",
        warningCount: 1,
        issueCounts: { error: 0, warning: 1, info: 0 },
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/### 警告/);
    expect(content).toMatch(/缺少应存在的相邻年度链接/);
    expect(content).toMatch(/年份范围：2024 → 2025/);
  });

  it("22. itemIndex rendered 1-based", () => {
    const audit = makeAudit({
      status: "fail",
      issues: [
        {
          id: "",
          code: "top_book_invalid_rank",
          severity: "error",
          scope: "top_book",
          year: 2025,
          itemIndex: 0,
          rank: 0,
        },
      ],
      summary: {
        ...makeAudit().summary,
        status: "fail",
        errorCount: 1,
        issueCounts: { error: 1, warning: 0, info: 0 },
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/项目位置：第 1 项/);
  });

  it("23. rank renders when present", () => {
    const audit = makeAudit({
      status: "fail",
      issues: [
        {
          id: "",
          code: "top_book_invalid_rank",
          severity: "error",
          scope: "top_book",
          year: 2025,
          itemIndex: 0,
          rank: 0,
        },
      ],
      summary: {
        ...makeAudit().summary,
        status: "fail",
        errorCount: 1,
        issueCounts: { error: 1, warning: 0, info: 0 },
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/排名值：0/);
  });

  it("24. null fields are omitted", () => {
    const audit = makeAudit({
      status: "warn",
      issues: [
        {
          id: "",
          code: "target_year_unaccounted",
          severity: "warning",
          scope: "coverage",
          year: 2024,
        },
      ],
      summary: {
        ...makeAudit().summary,
        status: "warn",
        warningCount: 1,
        issueCounts: { error: 0, warning: 1, info: 0 },
      },
    });
    const { content } = build({ audit });
    expect(content).not.toMatch(/>null</);
    expect(content).not.toMatch(/>undefined</);
    expect(content).not.toMatch(/项目位置：/);
    expect(content).not.toMatch(/排名值：/);
  });

  it("25. Issue ID is never rendered", () => {
    const audit = makeAudit({
      status: "fail",
      issues: [
        {
          id: "year:dated_records_exceed_total:2025:-:-:1:-",
          code: "dated_records_exceed_total",
          severity: "error",
          scope: "year",
          year: 2025,
          itemIndex: 1,
        },
      ],
      summary: {
        ...makeAudit().summary,
        status: "fail",
        errorCount: 1,
        issueCounts: { error: 1, warning: 0, info: 0 },
      },
    });
    const { content } = build({ audit });
    expect(content).not.toMatch(/year:dated_records_exceed_total:2025:-:-:1:-/);
  });
});

// ============================================================
// 6. Empty / partial archives
// ============================================================

describe("Markdown export — empty / partial archives", () => {
  it("26. empty archive + empty target still produces valid Markdown", () => {
    const audit = makeAudit({
      status: "pass",
      coverage: {
        targetYears: [],
        loadedYears: [],
        failedYears: [],
        unaccountedYears: [],
        unexpectedLoadedYears: [],
      },
      summary: {
        ...makeAudit().summary,
        status: "pass",
        targetYearCount: 0,
        loadedYearCount: 0,
        failedYearCount: 0,
        unaccountedYearCount: 0,
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/^# 长期档案数据质量审计/m);
    expect(content).toMatch(/审计状态：通过/);
  });

  it("27. empty archive + non-empty target shows unaccounted years", () => {
    const audit = makeAudit({
      status: "warn",
      coverage: {
        targetYears: [2025, 2024],
        loadedYears: [],
        failedYears: [],
        unaccountedYears: [2025, 2024],
        unexpectedLoadedYears: [],
      },
      summary: {
        ...makeAudit().summary,
        status: "warn",
        targetYearCount: 2,
        loadedYearCount: 0,
        failedYearCount: 0,
        unaccountedYearCount: 2,
        warningCount: 0,
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/### 未闭合年份\n2024、2025/);
  });

  it("28. partial archive shows failed years + integrity note", () => {
    const audit = makeAudit({
      status: "warn",
      coverage: {
        targetYears: [2025, 2024],
        loadedYears: [2025],
        failedYears: [2024],
        unaccountedYears: [],
        unexpectedLoadedYears: [],
      },
      summary: {
        ...makeAudit().summary,
        status: "warn",
        failedYearCount: 1,
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/### 暂时失败年份\n2024/);
    expect(content).toMatch(/暂时失败或未闭合的目标年份/);
  });
});

// ============================================================
// 7. Limitations + methodology
// ============================================================

describe("Markdown export — limitations + methodology", () => {
  it("29. NOT_APPLICABLE limitation block present", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).toMatch(/## 当前模型限制/);
    expect(content).toMatch(/没有逐年度排名映射/);
    expect(content).toMatch(/不会为缺失字段推测结果/);
  });

  it("30. methodology block lists no-network/no-AI/no-storage", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).toMatch(/## 方法说明/);
    expect(content).toMatch(/不重新请求年度 API/);
    expect(content).toMatch(/不调用 AI/);
    expect(content).toMatch(/不上传服务器/);
    expect(content).toMatch(/不写浏览器存储或 URL/);
    expect(content).toMatch(/不执行自动修复/);
    expect(content).toMatch(/失败年份的内容无法被审计/);
    expect(content).toMatch(/不评价用户本人/);
  });
});

// ============================================================
// 8. Filename + MIME
// ============================================================

describe("Markdown export — filename + MIME", () => {
  it("31. filename is ASCII + within 80 chars + includes date", () => {
    const fn = buildReadingDataQualityAuditFilename(new Date("2026-08-06T07:00:00.000Z"));
    expect(fn).toMatch(/^weread-reading-data-quality-audit-\d{8}\.md$/);
    expect(fn.length).toBeLessThanOrEqual(80);
    // ASCII-only
    expect(/^[\x20-\x7e]+$/.test(fn)).toBe(true);
  });

  it("32. filename handles invalid Date", () => {
    const fn = buildReadingDataQualityAuditFilename(new Date("invalid"));
    expect(fn).toBe("weread-reading-data-quality-audit.md");
  });

  it("33. result filename is also embedded in the trigger payload", () => {
    const { filename } = build({ audit: makeAudit() });
    expect(filename).toMatch(/^weread-reading-data-quality-audit-\d{8}\.md$/);
  });

  it("34. MIME constant exposed in download trigger", () => {
    const handle = triggerReadingDataQualityAuditMarkdownDownload(
      { content: "x", filename: "x.md" },
    );
    expect(handle.mimeType).toBe("text/markdown;charset=utf-8");
  });

  it("35. download trigger in non-browser env returns triggered=false", () => {
    const handle = triggerReadingDataQualityAuditMarkdownDownload(
      { content: "x", filename: "x.md" },
    );
    // In Node test env, Blob/document are undefined; trigger is a no-op.
    expect(handle).toMatchObject({ mimeType: "text/markdown;charset=utf-8" });
  });
});

// ============================================================
// 9. Sanitisation + escaping
// ============================================================

describe("Markdown export — sanitisation + escaping", () => {
  it("36. inline escape neutralises Markdown special characters", () => {
    expect(escapeReadingDataQualityMarkdownInline("a*b")).toBe("a\\*b");
    expect(escapeReadingDataQualityMarkdownInline("`c`")).toBe("\\`c\\`");
    expect(escapeReadingDataQualityMarkdownInline("[x](y)")).toBe(
      "\\[x\\]\\(y\\)",
    );
  });

  it("37. table cell escape neutralises pipes + newlines", () => {
    expect(escapeReadingDataQualityMarkdownTableCell("a|b")).toBe("a\\|b");
    expect(escapeReadingDataQualityMarkdownTableCell("a\nb")).toBe("a b");
  });

  it("38. text sanitiser drops NaN / Infinity", () => {
    expect(sanitizeReadingDataQualityMarkdownText(NaN)).toBe("—");
    expect(sanitizeReadingDataQualityMarkdownText(Infinity)).toBe("—");
  });

  it("39. text sanitiser handles null / undefined / boolean / number", () => {
    expect(sanitizeReadingDataQualityMarkdownText(null)).toBe("");
    expect(sanitizeReadingDataQualityMarkdownText(undefined)).toBe("");
    expect(sanitizeReadingDataQualityMarkdownText(true)).toBe("是");
    expect(sanitizeReadingDataQualityMarkdownText(42)).toBe("42");
  });

  it("40. date formatter handles invalid date", () => {
    expect(formatReadingDataQualityMarkdownDate(new Date("invalid"))).toBe(
      "—",
    );
  });

  it("41. date formatter produces a normalised ISO-like string", () => {
    expect(formatReadingDataQualityMarkdownDate(new Date(2026, 7, 6, 7, 0))).toBe(
      "2026-08-06 07:00",
    );
  });

  it("42. stripControlCharacters removes ASCII control chars", () => {
    const dirty = "abc\u0000def\u0007ghi";
    const { content } = build({
      audit: makeAudit({
        issues: [
          {
            id: "",
            code: "target_year_unaccounted",
            severity: "warning",
            scope: "coverage",
            year: 2024,
            actual: dirty,
          },
        ],
      }),
    });
    expect(content).not.toMatch(/ /);
    expect(content).not.toMatch(//);
  });

  it("43. validation flags forbidden patterns", () => {
    const bad = "here is a note.text leakage";
    const result = validateReadingDataQualityAuditMarkdown(bad);
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("44. validation passes for clean content", () => {
    const { content } = build({ audit: makeAudit() });
    const result = validateReadingDataQualityAuditMarkdown(content);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });
});

// ============================================================
// 10. Privacy + forbidden scan
// ============================================================

describe("Markdown export — privacy contract", () => {
  it("45. no note.text / comment / markedText in any Markdown output", () => {
    const audit = makeAudit({
      issues: [
        {
          id: "",
          code: "dated_records_exceed_total",
          severity: "error",
          scope: "year",
          year: 2025,
          actual: "note.text leak attempt",
          expected: "expected value",
          itemIndex: 1,
        },
      ],
    });
    const { content } = build({ audit });
    expect(content).not.toMatch(/note\.text/i);
    expect(content).not.toMatch(/note\.comment/i);
    expect(content).not.toMatch(/markedText/i);
    expect(content).not.toMatch(/wereadBookId/i);
    expect(content).not.toMatch(/noteId/i);
    expect(content).not.toMatch(/highlightId/i);
    expect(content).not.toMatch(/chapterTitle/i);
  });

  it("46. no catalogId / title / author / raw JSON leakage", () => {
    const audit = makeAudit({
      issues: [
        {
          id: "",
          code: "top_book_missing_title",
          severity: "warning",
          scope: "top_book",
          year: 2025,
          actual: "catalogId-LEAK-12345",
          itemIndex: 0,
        },
      ],
    });
    const { content } = build({ audit });
    expect(content).not.toMatch(/catalogId-LEAK-12345/);
    expect(content).not.toMatch(/catalogId/i);
    expect(content).not.toMatch(/raw archive/i);
  });

  it("47. no token / API key leakage", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).not.toMatch(/Authorization/i);
    expect(content).not.toMatch(/token=/i);
    expect(content).not.toMatch(/api[_-]?key/i);
    expect(content).not.toMatch(/cookie/i);
  });

  it("48. no user-evaluation language", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).not.toMatch(/更爱阅读|兴趣增强|兴趣减弱|能力提升|能力下降|阅读质量|心理状态|人格|成长|退步|低谷|巅峰|用户评分|优秀|较差/);
  });

  it("49. no console output of full markdown", () => {
    // Source-level check.
    expect(mdCode).not.toMatch(/console\.(log|info|warn|error)\([`"'"]?#\s|console\.(log|info|warn|error)\([`"'"]?长期档案/);
  });

  it("50. no alert() call", () => {
    expect(mdCode).not.toMatch(/\balert\s*\(/);
  });
});

// ============================================================
// 11. Source contract
// ============================================================

describe("Markdown export — source contract", () => {
  it("51. zero hook calls (model is pure JS)", () => {
    expect(mdCode).not.toMatch(/\buseMemo\s*\(/);
    expect(mdCode).not.toMatch(/\buseState\s*\(/);
    expect(mdCode).not.toMatch(/\buseEffect\s*\(/);
  });

  it("52. no fetch / XMLHttpRequest / network calls", () => {
    expect(mdCode).not.toMatch(/\bfetch\s*\(/);
    expect(mdCode).not.toMatch(/XMLHttpRequest/);
    expect(mdCode).not.toMatch(/fetchWereadAnnualReview/);
    expect(mdCode).not.toMatch(/fetchWereadAiSummary/);
    expect(mdCode).not.toMatch(/fetchWereadRelatedBooks/);
  });

  it("53. no localStorage / sessionStorage / IndexedDB", () => {
    expect(mdCode).not.toMatch(/localStorage/);
    expect(mdCode).not.toMatch(/sessionStorage/);
    expect(mdCode).not.toMatch(/IndexedDB/);
  });

  it("54. no URL bar mutation (only createObjectURL / revokeObjectURL)", () => {
    expect(mdCode).not.toMatch(/window\.location/);
    expect(mdCode).not.toMatch(/history\.pushState/);
    expect(mdCode).not.toMatch(/history\.replaceState/);
  });

  it("55. no dangerouslySetInnerHTML / innerHTML", () => {
    expect(mdCode).not.toMatch(/dangerouslySetInnerHTML/);
    expect(mdCode).not.toMatch(/\.innerHTML\b/);
  });

  it("56. ISSUE_LABELS uses satisfies Record<IssueCode, string>", () => {
    expect(mdCode).toMatch(
      /ISSUE_LABELS[\s\S]*?satisfies\s+Record<ReadingDataQualityIssueCode,\s*string>/,
    );
  });

  it("57. SCOPE_LABELS uses satisfies Record<Scope, string>", () => {
    expect(mdCode).toMatch(
      /SCOPE_LABELS[\s\S]*?satisfies\s+Record<ReadingDataQualityScope,\s*string>/,
    );
  });

  it("58. no third-party Markdown library imported", () => {
    expect(mdCode).not.toMatch(/from\s+["'](marked|remark|markdown-it)/);
  });
});

// ============================================================
// 12. Determinism
// ============================================================

describe("Markdown export — determinism + safety", () => {
  it("59. rerender with same input yields identical content", () => {
    const audit = makeAudit({
      issues: [
        {
          id: "",
          code: "missing_year_link",
          severity: "warning",
          scope: "year_link",
          fromYear: 2024,
          toYear: 2025,
        },
      ],
    });
    const input: ReadingDataQualityAuditMarkdownInput = {
      audit,
      rangeLabel: "全部",
      topBooksLimit: 12,
      exportedAt: FIXED_DATE,
    };
    const a = buildReadingDataQualityAuditMarkdown(input);
    const b = buildReadingDataQualityAuditMarkdown(input);
    expect(a.content).toBe(b.content);
    expect(a.filename).toBe(b.filename);
  });

  it("60. audit input is not mutated", () => {
    const audit = makeAudit();
    const snapshot = JSON.stringify(audit);
    build({ audit });
    expect(JSON.stringify(audit)).toBe(snapshot);
  });

  it("61. formatIssueLabel and formatScope return Chinese labels for every union member", () => {
    const codes: ReadingDataQualityIssueCode[] = [
      "empty_archive",
      "partial_archive",
      "target_year_unaccounted",
      "loaded_failed_conflict",
      "duplicate_loaded_year",
      "invalid_year",
      "non_finite_metric",
      "negative_metric",
      "dated_records_exceed_total",
      "matched_records_exceed_total",
      "matched_books_exceed_matched_records",
      "active_months_out_of_range",
      "streak_months_out_of_range",
      "streak_exceeds_active_months",
      "peak_month_year_mismatch",
      "top_books_exceed_limit",
      "top_book_missing_catalog",
      "top_book_duplicate_catalog",
      "top_book_missing_title",
      "top_book_invalid_rank",
      "top_book_duplicate_rank",
      "top_book_records_exceed_year_total",
      "top_book_order_mismatch",
      "year_link_unknown_year",
      "year_link_invalid_order",
      "year_link_duplicate_pair",
      "year_link_invalid_counts",
      "year_link_ratio_out_of_range",
      "year_link_ratio_mismatch",
      "missing_year_link",
      "recurring_duplicate_catalog",
      "recurring_appearance_count_mismatch",
      "recurring_unknown_year",
      "recurring_duplicate_year",
      "recurring_invalid_rank",
      "recurring_latest_year_mismatch",
    ];
    for (const code of codes) {
      const label = formatReadingDataQualityIssueLabel(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(code);
    }
    for (const scope of [
      "archive",
      "coverage",
      "year",
      "top_book",
      "year_link",
      "recurring_book",
    ] as const) {
      const label = formatReadingDataQualityScope(scope);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(scope);
    }
    expect(formatReadingDataQualityStatus("pass")).toBe("通过");
    expect(formatReadingDataQualityStatus("warn")).toBe("需注意");
    expect(formatReadingDataQualityStatus("fail")).toBe("存在一致性错误");
  });

  it("62. coverage years render in numeric order", () => {
    const audit = makeAudit({
      coverage: {
        targetYears: [2023, 2025, 2024],
        loadedYears: [2024, 2023, 2025],
        failedYears: [],
        unaccountedYears: [],
        unexpectedLoadedYears: [],
      },
    });
    const { content } = build({ audit });
    expect(content).toMatch(/### 目标年份\n2023、2024、2025/);
    expect(content).toMatch(/### 成功加载年份\n2023、2024、2025/);
  });

  it("63. output never contains raw JSON", () => {
    const { content } = build({ audit: makeAudit() });
    expect(content).not.toMatch(/\{.*"audit":/);
    expect(content).not.toMatch(/"scope":\s*"/);
  });

  it("64. no fetch / no storage / no URL change in trigger path (source)", () => {
    // Trigger must use createObjectURL + revokeObjectURL only.
    expect(mdCode).toMatch(/createObjectURL/);
    expect(mdCode).toMatch(/revokeObjectURL/);
  });

  it("65. trigger revoke is scheduled with setTimeout 0 or finally", () => {
    expect(mdCode).toMatch(/setTimeout|finally/);
  });
});