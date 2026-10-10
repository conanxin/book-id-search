import { useState, type ChangeEvent } from "react";

/** R10 test-first scaffold. The panel has no working local-file actions yet. */
export function LocatorLocalPilot() {
  const [file, setFile] = useState<File | null>(null);
  const [ack, setAck] = useState(false);
  const [label, setLabel] = useState("87");
  const [expected, setExpected] = useState("");
  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }
  return (
    <main className="locator-pilot">
      <h1>本地文件页码核对实验室</h1>
      <p>仅供本地研究实验：不连接研究项目、不上传、不保存文件。</p>
      <p>本页生成的记录不是经过认证的原书证据，也不提供经过核实的原文引用。</p>
      <label>本地文件（PDF 或图片）
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={selectFile} />
      </label>
      <label>定位类型<select><option value="PRINTED_PAGE">印刷页码</option><option value="PLATE">图版</option></select></label>
      <label>书上印刷页码或图版号
        <input value={label} onChange={e => setLabel(e.target.value)} />
      </label>
      <label>预期 SHA-256（可选）
        <input value={expected} onChange={e => setExpected(e.target.value)} />
      </label>
      <label><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
        我理解这是未认证来源的本地演示，不会保存文件
      </label>
      <button disabled={!file || !ack} type="button">开始本地核对</button>
      <p>选择文件后才能开始新会话</p>
      <button type="button" onClick={() => { setFile(null); setAck(false); }}>清空并重新开始</button>
    </main>
  );
}
