// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {CandidateClaims} from './CandidateClaims';
import {
  createAssessment,
  createCandidateClaim,
  getAssessment,
  listAssessments,
  listCandidateClaims,
  ProjectApiError,
  type AssessmentDetailResponse,
  type AssessmentHistoryResponse,
} from './api';
import {clearPendingCandidateClaimReceipt,loadPendingCandidateClaimReceipt} from './candidate-claim-draft';
import {clearPendingAssessmentReceipt} from './assessment-draft';

vi.mock('./api',async load=>({
  ...await load<typeof import('./api')>(),
  createCandidateClaim:vi.fn(),
  listCandidateClaims:vi.fn(),
  createAssessment:vi.fn(),
  listAssessments:vi.fn(),
  getAssessment:vi.fn(),
}));

vi.mock('./EvidenceEditor',()=>({
  EvidenceEditor:(props:any)=><button
    type="button"
    onClick={()=>props.onPreviewChange?.({
      draftVersion:1,
      manifestSha256:'a'.repeat(64),
      items:[{
        role:'SUPPORTING',
        targetType:'SOURCE',
        targetId:'66666666-6666-4666-8666-666666666666',
        note:null,
      }],
    })}
  >模拟有效证据预览</button>,
}));
const project={id:'11111111-1111-4111-8111-111111111111',name:'Project',lifecycleState:'ACTIVE' as const,readOnly:false};
const issue={id:'22222222-2222-4222-8222-222222222222',projectId:project.id,title:'Question',question:'When?',lifecycleState:'OPEN' as const,createdAt:'2026-09-21T00:00:00Z',updatedAt:'2026-09-21T00:00:00Z'};
const claim={id:'33333333-3333-4333-8333-333333333333',statement:'Candidate A',lifecycleState:'ACTIVE' as const,createdAt:issue.createdAt,updatedAt:issue.updatedAt};
const assessmentId='44444444-4444-4444-8444-444444444444';
const manifestId='55555555-5555-4555-8555-555555555555';
const sourceId='66666666-6666-4666-8666-666666666666';
const assessmentSummary={
  id:assessmentId,
  stance:'SUPPORTS' as const,
  confidenceLevel:'HIGH' as const,
  actorId:null,
  numericScore:null,
  scoreKind:null,
  reasoningExcerpt:'当前证据支持。',
  createdAt:'2026-09-21T10:00:00.000Z',
  evidenceManifest:{
    id:manifestId,
    schemaVersion:1 as const,
    purpose:'CLAIM_ASSESSMENT' as const,
    manifestSha256:'a'.repeat(64),
    itemCount:1,
  },
};
const emptyHistory:AssessmentHistoryResponse={claim:{id:claim.id,statement:claim.statement,lifecycleState:'ACTIVE'},assessments:[],nextCursor:null};
const detail:AssessmentDetailResponse={
  claim:{id:claim.id,statement:claim.statement,lifecycleState:'ACTIVE'},
  assessment:{
    id:assessmentId,
    claimId:claim.id,
    stance:'SUPPORTS',
    confidenceLevel:'HIGH',
    actorId:null,
    numericScore:null,
    scoreKind:null,
    reasoning:'当前证据支持。',
    createdAt:'2026-09-21T10:00:00.000Z',
  },
  evidenceManifest:{
    id:manifestId,
    schemaVersion:1,
    purpose:'CLAIM_ASSESSMENT',
    manifestSha256:'a'.repeat(64),
    createdAt:'2026-09-21T10:00:00.000Z',
    items:[{
      ordinal:1,
      role:'SUPPORTING',
      targetType:'SOURCE',
      targetId:sourceId,
      locatorType:null,
      locator:null,
      excerpt:null,
      note:null,
    }],
  },
};
beforeEach(()=>{
  vi.resetAllMocks();
  clearPendingCandidateClaimReceipt();
  clearPendingAssessmentReceipt();
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[]});
  vi.mocked(createCandidateClaim).mockResolvedValue({claim});
  vi.mocked(listAssessments).mockResolvedValue(emptyHistory);
  vi.mocked(createAssessment).mockResolvedValue({
    status:'created',
    visible:true,
    assessment:detail.assessment,
    evidenceManifest:assessmentSummary.evidenceManifest,
  });
  vi.mocked(getAssessment).mockResolvedValue(detail);
});
afterEach(cleanup);
function show(p=project,i=issue){return render(<CandidateClaims token="t" project={p} issue={i}/>);}
async function submit(){await screen.findByText('还没有可能答案。');await userEvent.type(screen.getByRole('textbox',{name:'可能答案正文'}),'Candidate A');await userEvent.click(screen.getByRole('button',{name:'添加可能答案'}));}
it('shows confirmed empty and canonical competing claims as plain text',async()=>{vi.mocked(listCandidateClaims).mockResolvedValue({claims:[claim,{...claim,id:'44444444-4444-4444-8444-444444444444',statement:'<script>Candidate B</script>'}]});show();expect(await screen.findByText('Candidate A')).toBeTruthy();expect(screen.getByText('<script>Candidate B</script>')).toBeTruthy();expect(document.querySelector('script')).toBeNull();expect(document.body.textContent).not.toMatch(/置信|首选|真相/);});
it.each(['project','RESOLVED','ARCHIVED'])('hides writes for %s but reads claims',async state=>{show(state==='project'?{...project,readOnly:true}:project,{...issue,lifecycleState:state==='project'?'OPEN':state} as typeof issue);expect(await screen.findByText('还没有可能答案。')).toBeTruthy();expect(screen.queryByRole('textbox')).toBeNull();});
it('successful create refreshes canonical list and clears receipt/form',async()=>{vi.mocked(listCandidateClaims).mockResolvedValueOnce({claims:[]}).mockResolvedValueOnce({claims:[claim]});show();await submit();expect(await screen.findByText('Candidate A')).toBeTruthy();expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');expect(loadPendingCandidateClaimReceipt()).toBeNull();expect(createCandidateClaim).toHaveBeenCalledOnce();});
it.each([new TypeError('network'),new ProjectApiError(500,'SECRET'),new ProjectApiError(503,'SECRET'),new ProjectApiError(502,'SECRET')])('freezes unknown draft and retries exact key and payload %#',async error=>{vi.mocked(listCandidateClaims).mockResolvedValueOnce({claims:[]}).mockResolvedValueOnce({claims:[claim]});vi.mocked(createCandidateClaim).mockRejectedValueOnce(error).mockResolvedValueOnce({claim});show();await submit();const retry=await screen.findByRole('button',{name:'使用同一标识重试'});const box=screen.getByRole('textbox') as HTMLTextAreaElement;expect(box.disabled).toBe(true);await userEvent.type(box,'changed');expect(box.value).toBe('Candidate A');expect(loadPendingCandidateClaimReceipt()).not.toBeNull();await userEvent.click(retry);await screen.findByText('Candidate A');const calls=vi.mocked(createCandidateClaim).mock.calls;expect(calls[1].slice(0,5)).toEqual(calls[0].slice(0,5));expect(document.body.textContent).not.toContain('SECRET');});
it('requires explicit new intent after claim-specific conflict',async()=>{vi.mocked(listCandidateClaims).mockResolvedValueOnce({claims:[]}).mockResolvedValueOnce({claims:[claim]});vi.mocked(createCandidateClaim).mockRejectedValueOnce(new ProjectApiError(409,'研究问题内容不一致','IDEMPOTENCY_CONFLICT')).mockResolvedValueOnce({claim});show();await submit();expect(await screen.findByText('创建请求标识与当前可能答案内容不一致。')).toBeTruthy();expect(createCandidateClaim).toHaveBeenCalledOnce();await userEvent.click(screen.getByRole('button',{name:'作为新的可能答案重新提交'}));await screen.findByText('Candidate A');const calls=vi.mocked(createCandidateClaim).mock.calls;expect(calls[1][3]).not.toBe(calls[0][3]);});
it.each([[400,'CLAIM_INVALID_INPUT'],[409,'PROJECT_READ_ONLY'],[409,'RESEARCH_ISSUE_READ_ONLY']])('clears receipt on definite rejection %s %s',async(status,code)=>{vi.mocked(createCandidateClaim).mockRejectedValue(new ProjectApiError(Number(status),'拒绝',String(code)));show();await submit();await screen.findByText('拒绝');expect(loadPendingCandidateClaimReceipt()).toBeNull();});
it('retries unavailable claims without treating errors as empty',async()=>{vi.mocked(listCandidateClaims).mockRejectedValueOnce(Error('SECRET')).mockResolvedValueOnce({claims:[claim]});show();await screen.findByText('可能答案暂不可用。');expect(screen.queryByText('还没有可能答案。')).toBeNull();await userEvent.click(screen.getByRole('button',{name:'重试可能答案'}));expect(await screen.findByText('Candidate A')).toBeTruthy();});
it('ignores late response after unmount and retains pending receipt',async()=>{let resolve!:(v:{claim:typeof claim})=>void;vi.mocked(createCandidateClaim).mockImplementation(()=>new Promise(r=>{resolve=r;}));const view=show();await submit();await waitFor(()=>expect(createCandidateClaim).toHaveBeenCalledOnce());view.unmount();resolve({claim});await new Promise(r=>setTimeout(r,0));expect(loadPendingCandidateClaimReceipt()).not.toBeNull();});
it('remounted draft with changed statement requires explicit new intent before any POST',async()=>{
  const {getOrCreateCandidateClaimReceipt}=await import('./candidate-claim-draft');
  const receiptA=await getOrCreateCandidateClaimReceipt(project.id,issue.id,'Candidate A');
  expect(loadPendingCandidateClaimReceipt()).not.toBeNull();
  vi.mocked(listCandidateClaims).mockResolvedValueOnce({claims:[]}).mockResolvedValueOnce({claims:[{...claim,statement:'Different B'}]});
  show();
  await screen.findByText('还没有可能答案。');
  await userEvent.type(screen.getByRole('textbox',{name:'可能答案正文'}),'Different B');
  await userEvent.click(screen.getByRole('button',{name:'添加可能答案'}));
  expect(await screen.findByText('创建请求标识与当前可能答案内容不一致。')).toBeTruthy();
  expect(createCandidateClaim).not.toHaveBeenCalled();
  expect(loadPendingCandidateClaimReceipt()).toEqual(receiptA);
  await userEvent.click(screen.getByRole('button',{name:'作为新的可能答案重新提交'}));
  await screen.findByText('Different B');
  expect(createCandidateClaim).toHaveBeenCalledTimes(1);
  const call=vi.mocked(createCandidateClaim).mock.calls[0];
  expect(call[4]).toBe('Different B');
  expect(call[3]).not.toBe(receiptA.idempotencyKey);
});
it('create success refreshes canonical order from server GET instead of local append',async()=>{
  const oldArchived={...claim,id:'55555555-5555-4555-8555-555555555555',statement:'old archived',lifecycleState:'ARCHIVED' as const,createdAt:'2026-01-01T00:00:00Z'};
  const newActive={...claim,id:'66666666-6666-4666-8666-666666666666',statement:'new active',lifecycleState:'ACTIVE' as const,createdAt:'2026-09-21T00:00:00Z'};
  vi.mocked(listCandidateClaims).mockResolvedValueOnce({claims:[oldArchived]}).mockResolvedValueOnce({claims:[newActive,oldArchived]});
  vi.mocked(createCandidateClaim).mockResolvedValueOnce({claim:newActive});
  show();
  await screen.findByText('old archived');
  await userEvent.type(screen.getByRole('textbox',{name:'可能答案正文'}),'new active');
  await userEvent.click(screen.getByRole('button',{name:'添加可能答案'}));
  const list=await screen.findByText('new active');
  expect(list).toBeTruthy();
  expect(screen.getByText('old archived')).toBeTruthy();
  expect(vi.mocked(listCandidateClaims)).toHaveBeenCalledTimes(2);
  const cards=Array.from(document.querySelectorAll('.research-claim-list article'));
  const texts=cards.map(a=>a.querySelector('p')?.textContent);
  expect(texts).toEqual(['new active','old archived']);
});
it('replayed create keeps server canonical order for existing claims',async()=>{
  const activeA={...claim,id:'77777777-7777-4777-8777-777777777777',statement:'active A',createdAt:'2026-01-01T00:00:00Z'};
  const activeB={...claim,id:'88888888-8888-4888-8888-888888888888',statement:'active B',createdAt:'2026-02-01T00:00:00Z'};
  vi.mocked(listCandidateClaims).mockResolvedValueOnce({claims:[activeA,activeB]}).mockResolvedValueOnce({claims:[activeA,activeB]});
  vi.mocked(createCandidateClaim).mockResolvedValueOnce({claim:activeA});
  show();
  await screen.findByText('active A');
  await userEvent.type(screen.getByRole('textbox',{name:'可能答案正文'}),'active A');
  await userEvent.click(screen.getByRole('button',{name:'添加可能答案'}));
  await screen.findByText('active B');
  expect(vi.mocked(listCandidateClaims)).toHaveBeenCalledTimes(2);
  const cards=Array.from(document.querySelectorAll('.research-claim-list article'));
  const texts=cards.map(a=>a.querySelector('p')?.textContent);
  expect(texts).toEqual(['active A','active B']);
});


it('keeps the Claim and evidence entry usable when assessment history is temporarily unavailable',async()=>{
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[claim]});
  vi.mocked(listAssessments).mockRejectedValue(new ProjectApiError(503,'暂不可用','ASSESSMENT_STORE_UNAVAILABLE'));
  show();
  expect(await screen.findByText('Candidate A')).toBeTruthy();
  expect(await screen.findByText('评价历史暂时无法加载。')).toBeTruthy();
  expect(screen.getByRole('button',{name:'模拟有效证据预览'})).toBeTruthy();
  await userEvent.click(screen.getByRole('button',{name:'模拟有效证据预览'}));
  expect(await screen.findByRole('heading',{name:'评价这个 Claim'})).toBeTruthy();
});

it('blocks new Assessment submit after a history integrity failure without hiding the Claim',async()=>{
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[claim]});
  vi.mocked(listAssessments).mockRejectedValue(new ProjectApiError(500,'integrity'));
  show();
  expect(await screen.findByText('Candidate A')).toBeTruthy();
  expect(await screen.findByText('评价历史存在数据完整性问题。')).toBeTruthy();
  await userEvent.click(screen.getByRole('button',{name:'模拟有效证据预览'}));
  expect(await screen.findByText('评价历史存在数据完整性问题，暂时不能提交新的评价。')).toBeTruthy();
  const submitAssessment=screen.getByRole('button',{name:'提交评价'});
  expect((submitAssessment as HTMLButtonElement).disabled).toBe(true);
});

it.each([
  [{...project,readOnly:true},{...issue,lifecycleState:'OPEN' as const},'project archived'],
  [project,{...issue,lifecycleState:'ARCHIVED' as const},'issue archived'],
])('keeps history readable but hides Assessment composer when %s',async(p,i)=>{
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[claim]});
  show(p as typeof project,i as typeof issue);
  expect(await screen.findByText('当前没有可显示的评价记录。')).toBeTruthy();
  await userEvent.click(screen.getByRole('button',{name:'模拟有效证据预览'}));
  expect(screen.queryByRole('heading',{name:'评价这个 Claim'})).toBeNull();
});

it.each(['OPEN','RESOLVED'] as const)('allows a new Assessment for an archived Claim while Issue is %s',async lifecycle=>{
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[{...claim,lifecycleState:'ARCHIVED'}]});
  show(project,{...issue,lifecycleState:lifecycle});
  await screen.findByText('Candidate A');
  await userEvent.click(screen.getByRole('button',{name:'模拟有效证据预览'}));
  expect(await screen.findByRole('heading',{name:'评价这个 Claim'})).toBeTruthy();
});

it('successful Assessment submit refreshes canonical history instead of locally appending',async()=>{
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[claim]});
  vi.mocked(listAssessments)
    .mockResolvedValueOnce(emptyHistory)
    .mockResolvedValueOnce({...emptyHistory,assessments:[assessmentSummary]});
  show();
  await screen.findByText('当前没有可显示的评价记录。');
  await userEvent.click(screen.getByRole('button',{name:'模拟有效证据预览'}));
  await userEvent.click(screen.getByLabelText('支持'));
  await userEvent.type(screen.getByLabelText('判断理由'),'当前证据支持。');
  await userEvent.click(screen.getByRole('button',{name:'提交评价'}));
  expect(await screen.findByText('评价已成功提交。')).toBeTruthy();
  expect(await screen.findByText('最近一次评价')).toBeTruthy();
  expect(listAssessments).toHaveBeenCalledTimes(2);
});

it('keeps Assessment success authoritative when the following history refresh fails',async()=>{
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[claim]});
  vi.mocked(listAssessments)
    .mockResolvedValueOnce(emptyHistory)
    .mockRejectedValueOnce(new ProjectApiError(503,'暂不可用','ASSESSMENT_STORE_UNAVAILABLE'));
  show();
  await screen.findByText('当前没有可显示的评价记录。');
  await userEvent.click(screen.getByRole('button',{name:'模拟有效证据预览'}));
  await userEvent.click(screen.getByLabelText('支持'));
  await userEvent.type(screen.getByLabelText('判断理由'),'当前证据支持。');
  await userEvent.click(screen.getByRole('button',{name:'提交评价'}));
  expect(await screen.findByText('评价已成功提交。')).toBeTruthy();
  expect(await screen.findByText('评价历史暂时无法加载。')).toBeTruthy();
  expect(document.body.textContent).not.toContain('提交失败');
});

it('opens Assessment detail from the canonical history selection',async()=>{
  vi.mocked(listCandidateClaims).mockResolvedValue({claims:[claim]});
  vi.mocked(listAssessments).mockResolvedValue({...emptyHistory,assessments:[assessmentSummary]});
  show();
  await screen.findByText('最近一次评价');
  await userEvent.click(screen.getByRole('button',{name:'查看完整评价'}));
  expect(await screen.findByRole('heading',{name:'完整评价'})).toBeTruthy();
  expect(getAssessment).toHaveBeenCalledWith('t',project.id,issue.id,claim.id,assessmentId,expect.anything());
});
