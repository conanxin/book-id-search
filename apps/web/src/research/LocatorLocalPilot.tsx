import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { parseLocatorDraftV2, type LocatorDraftV2, type LocatorKindV2, type LocatorWitnessV2 } from "./locator-v2-draft";
import {
  createLocatorReviewSession, type LocatorAttestationContext,
  type LocatorReviewSession, type ReviewView,
} from "./locator-v2-attestation";

// DEMO identifiers are fabricated on purpose. They are NOT authorized S32
// project/source/edition identities and must never be used in a real citation.
const DEMO = {
  projectId: "11111111-1111-4111-8111-111111111111",
  editionId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333",
  sourceAssetId: "44444444-4444-4444-8444-444444444444",
  actorId: "55555555-5555-4555-8555-555555555555",
} as const;
const MAX_BYTES = 20 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const VALID_LOCAL_FILE = /\.(pdf|png|jpe?g|webp)$/i;

type Phase = "empty" | "reading" | "review" | "reported" | "revoked";
const EVENT_LABELS = {
  BYTES_MATCHED: "字节核对",
  HUMAN_MATCH_RECORDED: "报告匹配",
  HUMAN_MISMATCH_RECORDED: "报告不匹配",
  ATTESTATION_REVOKED: "撤销记录",
} as const;

function outcomeError(code: string): string {
  switch (code) {
    case "LABEL_MISMATCH": return "观察到的标签与拟定标签不同，请记录不匹配或重新开始";
    case "INVALID_REPORT": return "页序或人工报告不符合要求";
    case "INVALID_TIME": return "本机时间异常，未写入报告";
    case "UNAVAILABLE": return "核对会话已失效，请重新开始";
    case "BYTES_MISMATCH": return "文件字节摘要与本地基准不一致";
    default: return "操作未成功，原因：" + code;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}

/**
 * Development-only UI. Its entrypoint is /locator-pilot.html on Vite dev;
 * production App.tsx and main.tsx do NOT import this module.
 *
 * Privacy: File bytes stay in this browser tab. The witness is constructed
 * from the SAME selected file and is explicitly self-asserted, NOT a trusted
 * original SourceAsset. No API, localStorage or backend integration occurs.
 */
export function LocatorLocalPilot() {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<LocatorKindV2>("PRINTED_PAGE");
  const [label, setLabel] = useState("87");
  const [expectedHash, setExpectedHash] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [inspected, setInspected] = useState(false);
  const [seenLabel, setSeenLabel] = useState("87");
  const [scanPage, setScanPage] = useState("93");
  const [phase, setPhase] = useState<Phase>("empty");
  const [message, setMessage] = useState("");
  const [digest, setDigest] = useState("");
  const [view, setView] = useState<ReviewView | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const sessionRef = useRef<LocatorReviewSession | null>(null);

  const clearSession = useCallback(() => {
    epoch.current += 1;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setPhase("empty");
    setMessage("");
    setDigest("");
    setView(null);
    setInspected(false);
    setAcknowledged(false);
  }, []);

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  }, [file]);

  useEffect(() => () => {
    epoch.current += 1;
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, []);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    clearSession();
    setFile(event.target.files?.[0] ?? null);
  }

  function reset() {
    clearSession();
    setFile(null);
    setSeenLabel("87");
    setScanPage("93");
    setLabel("87");
    setKind("PRINTED_PAGE");
    setExpectedHash("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function beginReview() {
    if (!file || !acknowledged || phase === "reading") return;
    clearSession();
    // clearSession resets acknowledgment; this explicit click is the approval
    // for the operation now in progress. The next session requires a new tick.
    setPhase("reading");
    const ticket = epoch.current;
    if (file.size > MAX_BYTES) {
      setPhase("empty");
      setMessage("文件超过 20 MiB，请选择更小的 PDF 或图片");
      return;
    }
    if (!file.size || !VALID_LOCAL_FILE.test(file.name)) {
      setPhase("empty");
      setMessage("请选择非空 PDF、PNG、JPG 或 WEBP 文件");
      return;
    }
    const draftShape = {
      schemaVersion: 2, ...DEMO, assetSha256: "0".repeat(64), kind, label,
    };
    // Exact R8 proposal MUST omit actorId.
    const { actorId: _ignored, ...candidate } = draftShape;
    if (!parseLocatorDraftV2(candidate)) {
      setPhase("empty");
      setMessage("页码或图版号不符合定位契约");
      return;
    }
    if (expectedHash && !HASH_PATTERN.test(expectedHash)) {
      setPhase("empty");
      setMessage("预期 SHA-256 必须是 64 个小写十六进制字符");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (epoch.current !== ticket) return;
      const actualHash = await sha256Hex(bytes);
      if (epoch.current !== ticket) return;
      if (expectedHash && actualHash !== expectedHash) {
        setPhase("empty");
        setMessage("文件与预期 SHA-256 不一致");
        return;
      }

      // Explicitly fabricated in-memory local-demo witness: the same bytes
      // establish its hash and proposal. This is a demonstration only.
      const proposal: LocatorDraftV2 = {
        schemaVersion: 2,
        projectId: DEMO.projectId,
        editionId: DEMO.editionId,
        sourceId: DEMO.sourceId,
        sourceAssetId: DEMO.sourceAssetId,
        assetSha256: actualHash,
        kind, label,
      };
      const witness: LocatorWitnessV2 = {
        projectId: DEMO.projectId,
        editionId: DEMO.editionId,
        sourceId: DEMO.sourceId,
        sourceAssetId: DEMO.sourceAssetId,
        assetSha256: actualHash,
        sourceType: "PUBLICATION", assetRole: "ORIGINAL", access: "READABLE",
      };
      const context: LocatorAttestationContext = {
        witness,
        actor: { id: DEMO.actorId, type: "HUMAN" },
        authGeneration: 1, accessRevision: 1,
      };
      const session = createLocatorReviewSession(proposal, {
        currentContext: () => context,
        now: () => new Date().toISOString(),
      });
      sessionRef.current = session;
      const result = await session.observeOriginal(bytes);
      if (epoch.current !== ticket) {
        session.dispose();
        return;
      }
      if (!result.ok) {
        session.dispose();
        sessionRef.current = null;
        setPhase("empty");
        setMessage(outcomeError(result.code));
        return;
      }
      setDigest(actualHash);
      setView(session.view());
      setInspected(false);
      setSeenLabel(label);
      setPhase("review");
    } catch {
      if (epoch.current !== ticket) return;
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setPhase("empty");
      setMessage("无法读取或计算此本地文件，请检查浏览器和文件");
    }
  }

  function record(decision: "MATCHED" | "NOT_MATCHED") {
    if (!sessionRef.current || phase !== "review") return;
    setMessage("");
    if (!inspected) {
      setMessage("请先确认已人工查看相应页面");
      return;
    }
    const result = sessionRef.current.recordHumanCheck({
      inspectedOriginal: true,
      observedLabel: seenLabel,
      assetPageNumber: Number(scanPage),
      decision,
    });
    if (!result.ok) {
      setMessage(outcomeError(result.code));
      return;
    }
    setView(sessionRef.current.view());
    setPhase("reported");
  }

  function revokeReport() {
    if (!sessionRef.current || phase !== "reported") return;
    setMessage("");
    const result = sessionRef.current.revoke({ reason: "WITHDRAWN" });
    if (!result.ok) {
      setMessage(outcomeError(result.code));
      return;
    }
    setView(sessionRef.current.view());
    setPhase("revoked");
  }

  const frozen = phase !== "empty";
  const statusText = phase === "reading" ? "正在读取本地文件" :
    phase === "review" ? "文件摘要已计算，等待人工核对" :
    phase === "reported" ?
      view?.state === "HUMAN_MATCH_RECORDED" ? "人工报告已记录：匹配（非认证引文）" :
        "人工报告已记录：不匹配" :
    phase === "revoked" ? "报告已撤销，不可在本会话中恢复" :
    "选择文件后才能开始新会话";

  return (
    <main className="locator-pilot">
      <header className="locator-pilot__header">
        <div className="locator-pilot__eyebrow">BOOK-ID-SEARCH · R10 · LOCAL ONLY</div>
        <h1>本地文件页码核对实验室</h1>
        <p>仅供本地研究实验：不连接研究项目、不上传、不保存文件。</p>
        <p className="locator-pilot__notice">本页生成的记录不是经过认证的原书证据，也不提供经过核实的原文引用。</p>
      </header>

      <section className="locator-pilot__card" aria-label="准备核对文件">
        <h2>1 · 选择本地文件与拟定位置</h2>
        <label>本地文件（PDF 或图片）
          <input ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={selectFile} />
        </label>
        {file ? <p className="locator-pilot__meta">已选：{file.name} · {(file.size / 1024).toFixed(1)} KiB（最多 20 MiB）</p> : null}
        <div className="locator-pilot__fields">
          <label>定位类型
            <select disabled={frozen} value={kind} onChange={e => setKind(e.target.value as LocatorKindV2)}>
              <option value="PRINTED_PAGE">印刷页码</option>
              <option value="PLATE">图版</option>
            </select>
          </label>
          <label>书上印刷页码或图版号
            <input disabled={frozen} value={label} onChange={e => setLabel(e.target.value)} />
          </label>
        </div>
        <label>预期 SHA-256（可选）
          <input disabled={frozen} value={expectedHash} onChange={e => setExpectedHash(e.target.value)}
            placeholder="来自另一个可信渠道时可填写 64 位小写摘要" />
        </label>
        <p className="locator-pilot__meta">不提供摘要也能演示，但摘要将由同一文件自行生成，不能用于认证来源。</p>
        <label className="locator-pilot__check">
          <input type="checkbox" disabled={frozen} checked={acknowledged}
            onChange={e => setAcknowledged(e.target.checked)} />
          我理解这是未认证来源的本地演示，不会保存文件
        </label>
        <div className="locator-pilot__actions">
          <button type="button" onClick={beginReview} disabled={!file || !acknowledged || frozen}>开始本地核对</button>
          <button type="button" className="locator-pilot__secondary" onClick={reset}>清空并重新开始</button>
        </div>
        <p role="status">{statusText}</p>
        {message ? <p role="alert" className="locator-pilot__error">{message}</p> : null}
      </section>

      {previewUrl && file ? (
        <section className="locator-pilot__card" aria-label="本地文件预览">
          <h2>本地文件预览（仅浏览器内）</h2>
          {file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name)
            ? <img className="locator-pilot__preview" src={previewUrl} alt="本地选择的图片预览" />
            : <iframe className="locator-pilot__preview" src={previewUrl} title="本地 PDF 文件预览" />}
          <p className="locator-pilot__meta">预览来自浏览器临时 blob 地址，不是永久文件链接，也不验证 PDF 的实际页数。</p>
        </section>
      ) : null}

      {view && phase !== "empty" && phase !== "reading" ? (
        <section className="locator-pilot__card" aria-label="定位报告">
          <h2>2 · 对照印刷页码和扫描页序</h2>
          <p>文件 SHA-256</p>
          <code className="locator-pilot__hash">{digest}</code>
          <p className="locator-pilot__meta">文件摘要由所选文件计算，不能独立证明版本和来源。</p>
          <p className="locator-pilot__notice">原文核实状态：未独立核实</p>
          {phase === "review" ? (
            <>
              <div className="locator-pilot__fields">
                <label>实际看到的页码或图版号
                  <input value={seenLabel} onChange={e => setSeenLabel(e.target.value)} />
                </label>
                <label>扫描文件页序（从 1 开始）
                  <input type="number" min="1" step="1" value={scanPage}
                    onChange={e => setScanPage(e.target.value)} />
                </label>
              </div>
              <label className="locator-pilot__check">
                <input type="checkbox" checked={inspected} onChange={e => setInspected(e.target.checked)} />
                我已亲自查看本地文件相应页面
              </label>
              <div className="locator-pilot__actions">
                <button type="button" onClick={() => record("MATCHED")}>记录匹配</button>
                <button type="button" className="locator-pilot__secondary"
                  onClick={() => record("NOT_MATCHED")}>记录不匹配</button>
              </div>
            </>
          ) : null}
          {(phase === "reported" || phase === "revoked") ? (
            <>
              <p>书上页码：{label}</p>
              {view.events[1]?.observedLabel !== label ? <p>观察到的标签：{view.events[1]?.observedLabel}</p> : null}
              <p>扫描页序：{view.events[1]?.assetPageNumber}</p>
              {phase === "reported" ?
                <button type="button" onClick={revokeReport}>撤销报告</button> : null}
            </>
          ) : null}
          <h3>本会话事件（不持久化）</h3>
          <ol>{view.events.map(event =>
            <li key={event.sequence}>
              事件 {event.sequence}：{EVENT_LABELS[event.action]} · {event.recordedAt}
            </li>)}</ol>
          <p className="locator-pilot__meta">不会生成“已核实原文”链接、签名或正式研究结论；刷新页面即丢失本会话。</p>
        </section>
      ) : null}
    </main>
  );
}
