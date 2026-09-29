import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendProjectItemNoteRevision, createProjectItemNote, getProjectItemNote, getProjectItemNoteRevision, removeProjectItem, ProjectApiError } from "./api";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
function seedSession(): void {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "csrf-test", error: null });
}
beforeEach(() => { seedSession(); });
afterEach(() => { __resetWebAuthStoreForTests(); });

const id = "11111111-1111-4111-8111-111111111111";
const revision = { revisionId: id, revisionNo: 1, contentFormat: "MARKDOWN", content: "R1", contentSha256: "a".repeat(64), createdAt: "2026-09-20T00:00:00Z" };
const note = { noteId: id, projectId: id, subjectBindingId: id, subjectId: id, createdAt: revision.createdAt, updatedAt: revision.createdAt, currentRevision: revision, revisions: [{ revisionId: id, revisionNo: 1, createdAt: revision.createdAt }] };
afterEach(() => vi.unstubAllGlobals());
describe("M1D same-origin Note client", () => {
  it("uses exact private URLs, minimal bodies, signals and no-store", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ note, revision })));
    vi.stubGlobal("fetch", fetchMock); const signal = new AbortController().signal;
    expect(await getProjectItemNote("p/a", "b/a", signal)).toEqual({note,revision});
    await createProjectItemNote("p/a","b/a","  R1\r\n",signal);
    await appendProjectItemNoteRevision("p/a","b/a",id,"R2",signal);
    await getProjectItemNoteRevision("p/a","b/a",id,signal);
    const base = "/api/private/s32/projects/p%2Fa/items/b%2Fa/note";
    expect(fetchMock.mock.calls.map(c=>c[0])).toEqual([base,base,`${base}/revisions`,`${base}/revisions/${id}`]);
    expect(fetchMock.mock.calls[1][1].body).toBe(JSON.stringify({content:"  R1\r\n"}));
    expect(fetchMock.mock.calls[2][1].body).toBe(JSON.stringify({baseRevisionId:id,content:"R2"}));
    for (const [,options] of fetchMock.mock.calls) expect(options).toMatchObject({cache:"no-store",signal,credentials:"same-origin"});
  });
  it("accepts nullable Note only on GET", async () => {
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('{"note":null}')));
    expect(await getProjectItemNote(id,id)).toEqual({note:null});
    await expect(createProjectItemNote(id,id,"new")).rejects.toMatchObject({status:502});
  });
  it.each([{}, {note:{}}, {note:{...note,currentRevision:{...revision,content:42}}}, {note:{...note,revisions:[{}]}}, {note:{...note,currentRevision:{...revision,contentSha256:"bad"}}}, {note:{...note,revisions:[{...note.revisions[0],revisionNo:0}]}}, {note:{...note,currentRevision:{...revision,contentFormat:"HTML"}}}])("rejects malformed Note %j",async body=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(body))));
    await expect(getProjectItemNote(id,id)).rejects.toMatchObject({status:502});
  });
  it.each([{}, {revision:{}}, {revision:{...revision,revisionNo:1.5}}, {revision:{...revision,createdAt:null}}, {revision:{...revision,revisionId:42}}])("rejects malformed historical revision %j",async body=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(body))));
    await expect(getProjectItemNoteRevision(id,id,id)).rejects.toMatchObject({status:502});
  });
  it.each([401,403,503,500])("never retries writes or reflects server details on %s",async status=>{
    const f=vi.fn(async()=>new Response(JSON.stringify({error:{message:"SQL PRIVATE NOTE SECRET",code:"UNKNOWN"}}),{status})); vi.stubGlobal("fetch",f);
    await expect(createProjectItemNote(id,id,"draft")).rejects.not.toThrow("SECRET");
    if (status === 401 || status === 403) {
      // the authoritative refresh runs once and (with this mock) lands unauthenticated,
      // so the second write is refused client-side without any further fetch.
      expect(f.mock.calls.filter(c => String(c[0]) === "/api/auth/session")).toHaveLength(1);
      await expect(appendProjectItemNoteRevision(id,id,id,"draft")).rejects.toBeInstanceOf(ProjectApiError);
      expect(f).toHaveBeenCalledTimes(2);
    } else {
      await expect(appendProjectItemNoteRevision(id,id,id,"draft")).rejects.toBeInstanceOf(ProjectApiError);
      expect(f).toHaveBeenCalledTimes(2);
    }
  });
  it("maps allowlisted conflict codes without reflecting arbitrary server messages",async()=>{
    const f=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:"STALE_NOTE_REVISION",message:"SECRET"}}),{status:409}))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:{code:"PROJECT_ITEM_HAS_NOTE",message:"SECRET"}}),{status:409}))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:{code:"UNKNOWN",message:"SECRET"}}),{status:409})); vi.stubGlobal("fetch",f);
    await expect(appendProjectItemNoteRevision(id,id,id,"draft")).rejects.toMatchObject({status:409,code:"STALE_NOTE_REVISION",message:"笔记已经发生变化。请重新加载最新版本后，再决定如何处理当前草稿。"});
    await expect(removeProjectItem("t",id,id)).rejects.toThrow("这项资料已有研究笔记，暂不能直接移出项目。");
    await expect(createProjectItemNote(id,id,"draft")).rejects.toThrow("项目或书目状态冲突");
  });
  it("still accepts only204 for a successful DELETE",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(null,{status:204})));
    await expect(removeProjectItem("t",id,id)).resolves.toBeUndefined();
  });
});
