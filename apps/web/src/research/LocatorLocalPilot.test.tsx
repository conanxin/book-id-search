// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocatorLocalPilot } from "./LocatorLocalPilot";

function localFile(name = "sample.pdf", contents = "abc", type = "application/pdf"): File {
  const bytes = new TextEncoder().encode(contents);
  const file = new File([bytes], name, { type });
  // jsdom's File does not yet implement arrayBuffer; browsers do.
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true, value: () => Promise.resolve(bytes.buffer.slice(0)),
  });
  return file;
}
const ABC_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

async function selectAndPrepare(user: ReturnType<typeof userEvent.setup>, file = localFile()) {
  await user.upload(screen.getByLabelText("本地文件（PDF 或图片）"), file);
  await user.clear(screen.getByLabelText("书上印刷页码或图版号"));
  await user.type(screen.getByLabelText("书上印刷页码或图版号"), "87");
  await user.click(screen.getByLabelText("我理解这是未认证来源的本地演示，不会保存文件"));
  await user.click(screen.getByRole("button", { name: "开始本地核对" }));
  await screen.findByText("文件摘要已计算，等待人工核对");
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("R10 isolated local-file review user journey", () => {
  it("clearly marks local-only, unverified scope before a file is selected", () => {
    render(<LocatorLocalPilot />);
    expect(screen.getByText("本地文件页码核对实验室")).toBeTruthy();
    expect(screen.getByText(/不连接研究项目、不上传、不保存/)).toBeTruthy();
    expect(screen.getByText(/不是经过认证的原书证据/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "开始本地核对" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "记录匹配" })).toBeNull();
  });

  it("reads selected file bytes locally and keeps page label distinct from scan index", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<LocatorLocalPilot />);
    await selectAndPrepare(user);
    expect(screen.getByText(ABC_SHA)).toBeTruthy();
    expect(screen.getByText(/文件摘要由所选文件计算，不能独立证明版本和来源/)).toBeTruthy();
    expect(screen.getByText(/原文核实状态：未独立核实/)).toBeTruthy();
    await user.clear(screen.getByLabelText("扫描文件页序（从 1 开始）"));
    await user.type(screen.getByLabelText("扫描文件页序（从 1 开始）"), "93");
    await user.click(screen.getByLabelText("我已亲自查看本地文件相应页面"));
    await user.click(screen.getByRole("button", { name: "记录匹配" }));
    expect(screen.getByText("人工报告已记录：匹配（非认证引文）")).toBeTruthy();
    expect(screen.getByText(/书上页码：87/)).toBeTruthy();
    expect(screen.getByText(/扫描页序：93/)).toBeTruthy();
    expect(screen.getByText(/字节核对/)).toBeTruthy();
    expect(screen.getByText(/报告匹配/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "已核实原文" })).toBeNull();
  });

  it("allows a human NOT_MATCHED report with a different observed page", async () => {
    const user = userEvent.setup();
    render(<LocatorLocalPilot />);
    await selectAndPrepare(user);
    await user.clear(screen.getByLabelText("实际看到的页码或图版号"));
    await user.type(screen.getByLabelText("实际看到的页码或图版号"), "88");
    await user.clear(screen.getByLabelText("扫描文件页序（从 1 开始）"));
    await user.type(screen.getByLabelText("扫描文件页序（从 1 开始）"), "93");
    await user.click(screen.getByLabelText("我已亲自查看本地文件相应页面"));
    await user.click(screen.getByRole("button", { name: "记录不匹配" }));
    expect(screen.getByText("人工报告已记录：不匹配")).toBeTruthy();
    expect(screen.getByText(/观察到的标签：88/)).toBeTruthy();
    expect(screen.getByText(/扫描页序：93/)).toBeTruthy();
  });

  it("does not let a different observed label be called a match", async () => {
    const user = userEvent.setup();
    render(<LocatorLocalPilot />);
    await selectAndPrepare(user);
    await user.clear(screen.getByLabelText("实际看到的页码或图版号"));
    await user.type(screen.getByLabelText("实际看到的页码或图版号"), "88");
    await user.click(screen.getByLabelText("我已亲自查看本地文件相应页面"));
    await user.click(screen.getByRole("button", { name: "记录匹配" }));
    expect(screen.getByRole("alert").textContent).toContain("观察到的标签与拟定标签不同");
    expect(screen.getByText("文件摘要已计算，等待人工核对")).toBeTruthy();
  });

  it("withdraws a report, preserves its in-session history and never calls it verified", async () => {
    const user = userEvent.setup();
    render(<LocatorLocalPilot />);
    await selectAndPrepare(user);
    await user.click(screen.getByLabelText("我已亲自查看本地文件相应页面"));
    await user.click(screen.getByRole("button", { name: "记录匹配" }));
    await user.click(screen.getByRole("button", { name: "撤销报告" }));
    expect(screen.getByText("报告已撤销，不可在本会话中恢复")).toBeTruthy();
    expect(screen.getByText(/撤销记录/)).toBeTruthy();
    expect(screen.getByText(/报告匹配/)).toBeTruthy();
    expect(screen.getByText(/原文核实状态：未独立核实/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "记录匹配" })).toBeNull();
  });

  it("will not proceed if the independently supplied expected digest is wrong", async () => {
    const user = userEvent.setup();
    render(<LocatorLocalPilot />);
    await user.upload(screen.getByLabelText("本地文件（PDF 或图片）"), localFile());
    await user.type(screen.getByLabelText("预期 SHA-256（可选）"), "b".repeat(64));
    await user.click(screen.getByLabelText("我理解这是未认证来源的本地演示，不会保存文件"));
    await user.click(screen.getByRole("button", { name: "开始本地核对" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("文件与预期 SHA-256 不一致");
    expect(screen.queryByRole("button", { name: "记录匹配" })).toBeNull();
  });

  it("rejects unsafe labels and oversized files before reading", async () => {
    const user = userEvent.setup();
    render(<LocatorLocalPilot />);
    await user.upload(screen.getByLabelText("本地文件（PDF 或图片）"), localFile());
    await user.clear(screen.getByLabelText("书上印刷页码或图版号"));
    await user.type(screen.getByLabelText("书上印刷页码或图版号"), "https://example.test/page/87");
    await user.click(screen.getByLabelText("我理解这是未认证来源的本地演示，不会保存文件"));
    await user.click(screen.getByRole("button", { name: "开始本地核对" }));
    expect(screen.getByRole("alert").textContent).toContain("页码或图版号不符合定位契约");
    const large = localFile("big.pdf");
    Object.defineProperty(large, "size", { value: 25 * 1024 * 1024 });
    await user.upload(screen.getByLabelText("本地文件（PDF 或图片）"), large);
    await user.click(screen.getByLabelText("我理解这是未认证来源的本地演示，不会保存文件"));
    await user.click(screen.getByRole("button", { name: "开始本地核对" }));
    expect(screen.getByRole("alert").textContent).toContain("文件超过 20 MiB");
  });

  it("discards old reports when the user replaces the file or resets", async () => {
    const user = userEvent.setup();
    render(<LocatorLocalPilot />);
    await selectAndPrepare(user);
    await user.click(screen.getByLabelText("我已亲自查看本地文件相应页面"));
    await user.click(screen.getByRole("button", { name: "记录匹配" }));
    expect(screen.getByText(/报告匹配/)).toBeTruthy();
    await user.upload(screen.getByLabelText("本地文件（PDF 或图片）"), localFile("other.pdf", "abd"));
    expect(screen.queryByText(/报告匹配/)).toBeNull();
    expect(screen.getByText(/选择文件后才能开始新会话/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清空并重新开始" }));
    expect((screen.getByLabelText("本地文件（PDF 或图片）") as HTMLInputElement).files?.length).toBe(0);
    expect(screen.queryByText(ABC_SHA)).toBeNull();
  });

  it("does not resurrect an obsolete digest result after replacing a pending file", async () => {
    const user = userEvent.setup();
    let resolve!: (buffer: ArrayBuffer) => void;
    const old = localFile();
    Object.defineProperty(old, "arrayBuffer", { configurable: true, value: () => new Promise<ArrayBuffer>(r => { resolve = r; }) });
    render(<LocatorLocalPilot />);
    await user.upload(screen.getByLabelText("本地文件（PDF 或图片）"), old);
    await user.click(screen.getByLabelText("我理解这是未认证来源的本地演示，不会保存文件"));
    await user.click(screen.getByRole("button", { name: "开始本地核对" }));
    expect(screen.getByText("正在读取本地文件")).toBeTruthy();
    await user.upload(screen.getByLabelText("本地文件（PDF 或图片）"), localFile("new.pdf", "abd"));
    resolve(new TextEncoder().encode("abc").buffer);
    await waitFor(() => expect(screen.queryByText("正在读取本地文件")).toBeNull());
    expect(screen.queryByText(ABC_SHA)).toBeNull();
    expect(screen.queryByText("文件摘要已计算，等待人工核对")).toBeNull();
  });
});
