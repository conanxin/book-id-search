import { randomUUID } from "node:crypto";

type AcceptanceOptions = {
  apiBaseUrl: string;
  publicUrl: string;
  token: string;
  releaseFingerprint: string;
  backendOnly?: boolean;
};

export type AcceptanceResult = {
  projectId: string;
  projectName: string;
  assessmentId: string;
  legacySearchRegression: "PASS";
  assessmentReplay: "PASS";
  backendAcceptance: "PASS";
};

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function expectFingerprint(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("INVALID_RELEASE_FINGERPRINT");
}

async function jsonRequest(
  url: string,
  options: RequestInit = {},
  expected: number[] = [200],
) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!expected.includes(response.status)) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP_${response.status} ${url} ${text.slice(0, 200)}`);
  }
  return response.status === 204 ? null : response.json();
}

function authHeaders(token: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function privateRequest(
  base: string,
  token: string,
  path: string,
  options: RequestInit = {},
  expected: number[] = [200],
) {
  const headers = {
    ...authHeaders(token),
    ...(options.headers as Record<string, string> | undefined),
  };
  return jsonRequest(`${base}/api/private/s32${path}`, { ...options, headers }, expected);
}

async function runLegacyChecks(apiBase: string, publicUrl: string) {
  const publicResponse = await fetch(publicUrl, { cache: "no-store" });
  if (!publicResponse.ok) throw new Error("PUBLIC_HTTP_FAILED");

  const health = await jsonRequest(`${apiBase}/api/health`);
  if (!health || health.ok !== true) throw new Error("HEALTH_CHECK_FAILED");

  const stats = await jsonRequest(`${apiBase}/api/stats`);
  if (!stats || stats.isIndexing !== false || !Number.isFinite(stats.numberOfDocuments)) {
    throw new Error("STATS_CHECK_FAILED");
  }

  const probes = [
    ["isbn", "9787538455250"],
    ["ssid", "13000000"],
    ["dxid", "000008232537"],
    ["title", "时尚秋冬披肩"],
    ["author", "鲁迅"],
    ["publisher", "人民文学出版社"],
  ] as const;

  let catalogBookId: string | null = null;
  for (const [kind, value] of probes) {
    const query = new URLSearchParams({ q: value });
    const result = await jsonRequest(`${apiBase}/api/search?${query}`);
    if (!result || !Array.isArray(result.items) || result.items.length < 1) {
      throw new Error(`LEGACY_SEARCH_FAILED_${kind.toUpperCase()}`);
    }
    if (kind === "isbn") {
      const id = result.items[0]?.id;
      if (typeof id !== "string" || !id.trim()) throw new Error("ACCEPTANCE_CATALOG_BOOK_ID_MISSING");
      catalogBookId = id.trim();
    }
  }
  if (!catalogBookId) throw new Error("ACCEPTANCE_CATALOG_BOOK_ID_MISSING");
  return catalogBookId;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

export async function runProductionAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const token = options.token.trim();
  if (!token) throw new Error("S32_PRIVATE_API_TOKEN_REQUIRED");
  expectFingerprint(options.releaseFingerprint);

  const apiBase = trimSlash(options.apiBaseUrl);
  const publicUrl = trimSlash(options.publicUrl);
  const short = options.releaseFingerprint.slice(0, 12);
  const projectName = `[S32 Production Acceptance] ${short}`;
  const issueTitle = `[Acceptance] ${short}`;
  const claimStatement = `Production acceptance claim ${short}.`;
  const reasoning = `Production acceptance assessment ${short}.`;

  const catalogBookId = !options.backendOnly
    ? await runLegacyChecks(apiBase, publicUrl)
    : await runLegacyChecks(
        apiBase,
        // Backend-only acceptance still proves the legacy API stays healthy, but skips
        // the public HTML fetch so it can run before the new Web is deployed.
        `${apiBase}/api/health`,
      );

  const projects = await privateRequest(apiBase, token, "/projects");
  let project = Array.isArray(projects?.projects)
    ? projects.projects.find((entry: any) => entry?.name === projectName)
    : null;
  if (!project) {
    const created = await privateRequest(
      apiBase,
      token,
      "/projects",
      jsonBody({ name: projectName, description: "S32 production acceptance audit fixture." }),
      [201],
    );
    project = created.project;
  }
  const projectId = String(project.id);

  const promoted = await privateRequest(
    apiBase,
    token,
    `/projects/${encodeURIComponent(projectId)}/catalog-books`,
    jsonBody({ bookId: catalogBookId }),
    [200, 201],
  );
  const bindingId = String(promoted.item.bindingId);

  const notePath = `/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(bindingId)}/note`;
  const existingNote = await privateRequest(apiBase, token, notePath);
  if (!existingNote.note) {
    await privateRequest(
      apiBase,
      token,
      notePath,
      jsonBody({ content: `Production acceptance note ${short}.` }),
      [201],
    );
  }

  const issuesPath = `/projects/${encodeURIComponent(projectId)}/issues`;
  const issueList = await privateRequest(apiBase, token, issuesPath);
  let issue = Array.isArray(issueList?.issues)
    ? issueList.issues.find((entry: any) => entry?.title === issueTitle)
    : null;
  if (!issue) {
    const created = await privateRequest(
      apiBase,
      token,
      issuesPath,
      {
        ...jsonBody({ title: issueTitle, question: "Does the production S32 vertical slice persist correctly?" }),
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
      },
      [201],
    );
    issue = created.issue;
  }
  const issueId = String(issue.id);

  const claimsPath = `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims`;
  const claimList = await privateRequest(apiBase, token, claimsPath);
  let claim = Array.isArray(claimList?.claims)
    ? claimList.claims.find((entry: any) => entry?.statement === claimStatement)
    : null;
  if (!claim) {
    const created = await privateRequest(
      apiBase,
      token,
      claimsPath,
      {
        ...jsonBody({ statement: claimStatement }),
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
      },
      [201],
    );
    claim = created.claim;
  }
  const claimId = String(claim.id);

  const claimBase = `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims/${encodeURIComponent(claimId)}`;
  const candidates = await privateRequest(apiBase, token, `${claimBase}/evidence-candidates`);
  const candidate = candidates?.candidates?.[0];
  if (!candidate?.targetType || !candidate?.targetId) throw new Error("EVIDENCE_CANDIDATE_MISSING");

  const items = [{
    role: "SUPPORTING",
    targetType: candidate.targetType,
    targetId: candidate.targetId,
    note: null,
  }];

  const preview = await privateRequest(
    apiBase,
    token,
    `${claimBase}/evidence-manifest-preview`,
    jsonBody({ items }),
  );
  const expectedManifestSha256 = preview?.draft?.manifestSha256;
  if (typeof expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedManifestSha256)) {
    throw new Error("PREVIEW_HASH_INVALID");
  }

  const assessmentsPath = `${claimBase}/assessments`;
  const history = await privateRequest(apiBase, token, assessmentsPath);
  let assessmentId: string;

  if (Array.isArray(history?.assessments) && history.assessments.length > 0) {
    assessmentId = String(history.assessments[0].id);
  } else {
    const idempotencyKey = randomUUID();
    const payload = {
      stance: "SUPPORTS",
      confidenceLevel: "HIGH",
      reasoning,
      expectedManifestSha256,
      items,
    };
    const headers = {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
    };

    let firstAssessmentId: string | null = null;
    try {
      const first = await privateRequest(
        apiBase,
        token,
        assessmentsPath,
        { method: "POST", headers, body: JSON.stringify(payload) },
        [201],
      );
      firstAssessmentId = String(first.assessment.id);
    } catch (error) {
      // A transport failure after the server committed is deliberately ambiguous.
      // Confirm it only by retrying the exact same command with the exact same key.
      if (!(error instanceof TypeError)) throw error;
    }

    const replay = await privateRequest(
      apiBase,
      token,
      assessmentsPath,
      { method: "POST", headers, body: JSON.stringify(payload) },
      [200],
    );
    assessmentId = String(replay.assessment?.id);
    if (!assessmentId) throw new Error("ASSESSMENT_REPLAY_ID_MISSING");
    if (firstAssessmentId && firstAssessmentId !== assessmentId) {
      throw new Error("ASSESSMENT_REPLAY_IDENTITY_MISMATCH");
    }
  }

  const detail = await privateRequest(
    apiBase,
    token,
    `${assessmentsPath}/${encodeURIComponent(assessmentId)}`,
  );
  if (String(detail?.assessment?.id) !== assessmentId) throw new Error("ASSESSMENT_DETAIL_MISMATCH");

  return {
    projectId,
    projectName,
    assessmentId,
    legacySearchRegression: "PASS",
    assessmentReplay: "PASS",
    backendAcceptance: "PASS",
  };
}

export function formatAcceptanceResult(result: AcceptanceResult) {
  return [
    "STATUS=PASS",
    `PROJECT_ID=${result.projectId}`,
    `PROJECT_NAME=${result.projectName}`,
    `ASSESSMENT_ID=${result.assessmentId}`,
    `LEGACY_SEARCH_REGRESSION=${result.legacySearchRegression}`,
    `ASSESSMENT_REPLAY=${result.assessmentReplay}`,
    `S32_BACKEND_ACCEPTANCE=${result.backendAcceptance}`,
    "ACCEPTANCE_PROJECT_RETAINED=YES",
  ].join("\n");
}

async function main() {
  const token = process.env.S32_PRIVATE_API_TOKEN?.trim() || "";
  const releaseFingerprint = process.env.S32_RELEASE_FINGERPRINT?.trim() || "";
  const apiBaseUrl = process.env.S32_API_BASE_URL?.trim() || "http://127.0.0.1:3001";
  const publicUrl = process.env.S32_PUBLIC_URL?.trim() || "https://books.conanxin.com";
  const backendOnly = process.env.S32_ACCEPTANCE_BACKEND_ONLY === "true";

  const result = await runProductionAcceptance({
    apiBaseUrl,
    publicUrl,
    token,
    releaseFingerprint,
    backendOnly,
  });
  process.stdout.write(formatAcceptanceResult(result) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    process.stderr.write(`STATUS=BLOCKED\nBLOCK_REASON=${message}\n`);
    process.exitCode = 1;
  });
}
