// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectItemNotePanel } from "./ProjectItemNote";
import { appendProjectItemNoteRevision, createProjectItemNote, getProjectItemNote, getProjectItemNoteRevision, ProjectApiError, type ProjectItemNote, type ProjectResearchItem } from "./api";
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), getProjectItemNote: vi.fn(), createProjectItemNote: vi.fn(), appendProjectItemNoteRevision: vi.fn(), getProjectItemNoteRevision: vi.fn() }));
const item: ProjectResearchItem = { bindingId:"binding",projectId:"project",editionId:"edition",workId:"work",sourceId:null,catalogBookId:null,title:"真实资料",publisher:null,publicationDate:null,publicationDatePrecision:"YEAR",isbn:null,addedAt:"2026-09-20T00:00:00Z" };
function note(version=1): ProjectItemNote {
  const summary = (n:number)=>({revisionId:`r${n}`,revisionNo:n,createdAt:"2026-09-20T00:00:00Z"});
  return {noteId:"note",projectId:"project",subjectBindingId:"binding",subjectId:"edition",createdAt:summary(1).createdAt,updatedAt:summary(1).createdAt,currentRevision:{...summary(version),contentFormat:"MARKDOWN",content:`  R${version}\n原始正文  `,contentSha256:"a".repeat(64)},revisions:Array.from({length:version},(_,i)=>summary(version-i))};
}
const view = (token="token",projectId="project",bindingId="binding")=><ProjectItemNotePanel token={token} projectId={projectId} item={{...item,bindingId}}/>;
const click = (name:string)=>userEvent.click(screen.getByRole("button",{name}));
async function open() { await click("研究笔记"); }
const draft = ()=>screen.getByRole("textbox",{name:"笔记正文"}) as HTMLTextAreaElement;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(getProjectItemNote).mockResolvedValue({note:null});vi.mocked(createProjectItemNote).mockResolvedValue({note:note()});vi.mocked(appendProjectItemNoteRevision).mockResolvedValue({note:note(2)});vi.mocked(getProjectItemNoteRevision).mockResolvedValue({revision:note().currentRevision});});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("on-demand project item Note",()=>{
  it("starts closed with no fetch, then opens empty; blank creation disabled",async()=>{
    render(view());expect(getProjectItemNote).not.toHaveBeenCalled();await open();await screen.findByRole("textbox");
    expect(getProjectItemNote).toHaveBeenCalledWith("token","project","binding",expect.any(AbortSignal));
    fireEvent.change(draft(),{target:{value:" \n\r "}});expect((screen.getByRole("button",{name:"创建笔记"}) as HTMLButtonElement).disabled).toBe(true);
  });
  it("creates exactly once, preserves exact input and renders R1/history",async()=>{
    let resolve!: (v:{note:ProjectItemNote})=>void;vi.mocked(createProjectItemNote).mockReturnValue(new Promise(r=>{resolve=r;}));
    render(view());await open();await screen.findByRole("textbox");fireEvent.change(draft(),{target:{value:"  第一版\n原文  "}});
    await userEvent.dblClick(screen.getByRole("button",{name:"创建笔记"}));expect(createProjectItemNote).toHaveBeenCalledOnce();
    expect(createProjectItemNote).toHaveBeenCalledWith("token","project","binding","  第一版\n原文  ",expect.any(AbortSignal));
    await act(async()=>resolve({note:note()}));expect((await screen.findByRole("region",{name:"当前笔记"})).textContent).toContain(note().currentRevision.content);
    expect(screen.getByRole("button",{name:"v1 当前"})).toBeTruthy();expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("loads existing content as plain text; edit prefills exactly; cancel makes no write",async()=>{
    const n=note();n.currentRevision.content="<script>secret()</script>\n  原文  ";vi.mocked(getProjectItemNote).mockResolvedValue({note:n});
    const rendered=render(view());await open();await screen.findByRole("region",{name:"当前笔记"});expect(rendered.container.querySelector("script")).toBeNull();
    await click("编辑");expect(draft().value).toBe(n.currentRevision.content);fireEvent.change(draft(),{target:{value:"未保存"}});await click("取消");
    expect(screen.getByRole("region",{name:"当前笔记"}).textContent).toContain(n.currentRevision.content);expect(appendProjectItemNoteRevision).not.toHaveBeenCalled();
  });
  it("saves one new R2 using current base and updates current/history",async()=>{
    vi.mocked(getProjectItemNote).mockResolvedValue({note:note()});render(view());await open();await screen.findByRole("button",{name:"编辑"});await click("编辑");
    fireEvent.change(draft(),{target:{value:"第二版"}});await click("保存新版本");
    expect(appendProjectItemNoteRevision).toHaveBeenCalledWith("token","project","binding","r1","第二版",expect.any(AbortSignal));
    expect(await screen.findByRole("button",{name:"v2 当前"})).toBeTruthy();expect(screen.getByRole("button",{name:"v1"})).toBeTruthy();
  });
  it("stale409 retains draft; reload changes base, explicit re-edit alone replaces textarea",async()=>{
    vi.mocked(getProjectItemNote).mockResolvedValueOnce({note:note(2)}).mockResolvedValueOnce({note:note(3)});
    vi.mocked(appendProjectItemNoteRevision).mockRejectedValue(new ProjectApiError(409,"笔记已经发生变化。请重新加载最新版本后，再决定如何处理当前草稿。","STALE_NOTE_REVISION"));
    render(view());await open();await screen.findByRole("button",{name:"编辑"});await click("编辑");fireEvent.change(draft(),{target:{value:"我的过期草稿"}});await click("保存新版本");
    expect((await screen.findByRole("alert")).textContent).toContain("笔记已经发生变化");expect(draft().value).toBe("我的过期草稿");
    await click("重新加载最新版本");await screen.findByRole("button",{name:"v3 当前"});expect(draft().value).toBe("我的过期草稿");
    expect(screen.getByRole("region",{name:"保留的草稿"}).textContent).toContain("我的过期草稿");
    await click("用最新版本重新编辑");expect(draft().value).toBe(note(3).currentRevision.content);
    vi.mocked(appendProjectItemNoteRevision).mockResolvedValueOnce({note:note(4)});await click("保存新版本");
    expect(appendProjectItemNoteRevision).toHaveBeenLastCalledWith("token","project","binding","r3",note(3).currentRevision.content,expect.any(AbortSignal));
  });
  it("failed latest reload keeps original base and draft",async()=>{
    vi.mocked(getProjectItemNote).mockResolvedValueOnce({note:note(2)}).mockRejectedValueOnce(new ProjectApiError(503,"服务暂不可用"));
    vi.mocked(appendProjectItemNoteRevision).mockRejectedValue(new ProjectApiError(409,"已变化","STALE_NOTE_REVISION"));
    render(view());await open();await screen.findByRole("button",{name:"编辑"});await click("编辑");fireEvent.change(draft(),{target:{value:"保留"}});await click("保存新版本");await click("重新加载最新版本");
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用");expect(draft().value).toBe("保留");expect(screen.queryByRole("button",{name:"用最新版本重新编辑"})).toBeNull();
  });
  it.each(["create","append"])("failed %s preserves draft and never displays false success",async kind=>{
    if(kind==="append")vi.mocked(getProjectItemNote).mockResolvedValue({note:note()});
    vi.mocked(createProjectItemNote).mockRejectedValue(new ProjectApiError(503,"服务暂不可用"));vi.mocked(appendProjectItemNoteRevision).mockRejectedValue(new ProjectApiError(503,"服务暂不可用"));
    render(view());await open();if(kind==="append"){await screen.findByRole("button",{name:"编辑"});await click("编辑");}else await screen.findByRole("textbox");
    fireEvent.change(draft(),{target:{value:"不能丢失"}});await click(kind==="append"?"保存新版本":"创建笔记");
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用");expect(draft().value).toBe("不能丢失");expect(screen.queryByRole("button",{name:"v2 当前"})).toBeNull();
  });
  it("GET503 is a retryable error, never no-Note create UI",async()=>{
    vi.mocked(getProjectItemNote).mockRejectedValueOnce(new ProjectApiError(503,"服务暂不可用"));render(view());await open();
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用");expect(screen.queryByRole("textbox")).toBeNull();expect(screen.queryByRole("button",{name:"创建笔记"})).toBeNull();
    await click("重新读取笔记");expect(await screen.findByRole("textbox")).toBeTruthy();
  });
  it("history loads only the selected immutable revision and offers no editing controls",async()=>{
    vi.mocked(getProjectItemNote).mockResolvedValue({note:note(2)});render(view());await open();await screen.findByRole("button",{name:"v1"});
    expect(getProjectItemNoteRevision).not.toHaveBeenCalled();await click("v1");
    expect((await screen.findByRole("region",{name:"历史版本 v1"})).textContent).toContain(note().currentRevision.content);
    expect(getProjectItemNoteRevision).toHaveBeenCalledWith("token","project","binding","r1",expect.any(AbortSignal));
    expect(screen.queryByRole("textbox")).toBeNull();expect(screen.queryByRole("button",{name:"编辑"})).toBeNull();await click("返回当前版本");expect(screen.getByRole("button",{name:"编辑"})).toBeTruthy();
  });
  it.each(["token","project","binding"])("%s change clears loaded UI immediately and aborts pending history",async change=>{
    vi.mocked(getProjectItemNote).mockResolvedValue({note:note(2)});let resolve!:(v:{revision:ProjectItemNote["currentRevision"]})=>void;
    vi.mocked(getProjectItemNoteRevision).mockReturnValue(new Promise(r=>{resolve=r;}));const rendered=render(view());await open();await screen.findByRole("button",{name:"v1"});await click("v1");
    const signal=vi.mocked(getProjectItemNoteRevision).mock.calls[0][4]!;
    rendered.rerender(view(change==="token"?"other":"token",change==="project"?"other":"project",change==="binding"?"other":"binding"));
    expect(signal.aborted).toBe(true);expect(screen.queryByRole("region",{name:"当前笔记"})).toBeNull();expect(screen.queryByRole("button",{name:"v2 当前"})).toBeNull();
    await act(async()=>resolve({revision:note().currentRevision}));expect(screen.queryByRole("region",{name:"历史版本 v1"})).toBeNull();expect(getProjectItemNote).toHaveBeenCalledOnce();
  });
  it("unmount aborts pending write and late completion cannot repopulate another panel",async()=>{
    let resolve!:(v:{note:ProjectItemNote})=>void;vi.mocked(createProjectItemNote).mockReturnValue(new Promise(r=>{resolve=r;}));
    const rendered=render(view());await open();await screen.findByRole("textbox");fireEvent.change(draft(),{target:{value:"pending"}});await click("创建笔记");
    const signal=vi.mocked(createProjectItemNote).mock.calls[0][4]!;rendered.unmount();expect(signal.aborted).toBe(true);render(view("new"));
    await act(async()=>resolve({note:note()}));expect(screen.queryByRole("region",{name:"当前笔记"})).toBeNull();
  });
  it("closing and reopening aborts old GET; ignored late response does not overwrite the new load",async()=>{
    let resolve!:(v:{note:ProjectItemNote|null})=>void;vi.mocked(getProjectItemNote).mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce({note:null});
    render(view());await open();const signal=vi.mocked(getProjectItemNote).mock.calls[0][3]!;await click("收起笔记");expect(signal.aborted).toBe(true);await open();await screen.findByRole("textbox");
    await act(async()=>resolve({note:note()}));expect(screen.queryByRole("region",{name:"当前笔记"})).toBeNull();expect(draft().value).toBe("");
  });
});
