import {useEffect,useRef,useState,type FormEvent} from 'react';
import {createCandidateClaim,listCandidateClaims,ProjectApiError,type CandidateClaim,type ResearchIssue,type ResearchIssueProjectContext} from './api';
import {EvidenceEditor} from './EvidenceEditor';
import {clearPendingCandidateClaimReceipt,getOrCreateCandidateClaimReceipt,normalizeCandidateClaimDraft,PendingCandidateClaimIntentConflictError} from './candidate-claim-draft';
type Props={token:string;project:ResearchIssueProjectContext;issue:ResearchIssue};
export function CandidateClaims(props:Props){return <CandidateClaimsSession key={`${props.token}:${props.project.id}:${props.issue.id}`} {...props}/>;}
function CandidateClaimsSession({token,project,issue}:Props){
 const [attempt,setAttempt]=useState(0);
 const [load,setLoad]=useState<'loading'|'ready'|'unavailable'>('loading');
 const [claims,setClaims]=useState<CandidateClaim[]>([]);
 const [statement,setStatement]=useState('');
 const [state,setState]=useState<'idle'|'submitting'|'unconfirmed'|'rejected'|'idempotency-conflict'>('idle');
 const [message,setMessage]=useState('');
 const active=useRef<AbortController|null>(null);
 useEffect(()=>()=>active.current?.abort(),[]);
 useEffect(()=>{const c=new AbortController();setLoad('loading');void listCandidateClaims(token,project.id,issue.id,c.signal).then(r=>{if(!c.signal.aborted){setClaims(r.claims);setLoad('ready');}}).catch(()=>{if(!c.signal.aborted)setLoad('unavailable');});return()=>c.abort();},[token,project.id,issue.id,attempt]);
 const canCreate=!project.readOnly&&issue.lifecycleState==='OPEN';
 async function submit(forceNew=false){
  if(active.current||!canCreate)return;
  let normalized:string;
  try{normalized=normalizeCandidateClaimDraft(statement);}catch(e){setState('rejected');setMessage(e instanceof Error?e.message:'可能答案输入不正确。');return;}
  const controller=new AbortController();active.current=controller;setState('submitting');setMessage('');
  try{
   const receipt=await getOrCreateCandidateClaimReceipt(project.id,issue.id,normalized,forceNew);
   if(controller.signal.aborted)return;
   const response=await createCandidateClaim(token,project.id,issue.id,receipt.idempotencyKey,normalized,controller.signal);
   if(controller.signal.aborted)return;
   clearPendingCandidateClaimReceipt();setStatement('');setState('idle');
   // Canonical order (ACTIVE before ARCHIVED, created_at ASC, id ASC) comes only
   // from the server GET; a local append could reorder against PostgreSQL's
   // microsecond-precision created_at.
   setAttempt(n=>n+1);
  }catch(e){
   if(controller.signal.aborted)return;
   if(e instanceof PendingCandidateClaimIntentConflictError){setState('idempotency-conflict');setMessage(e.message);}
   else if(e instanceof ProjectApiError&&e.code==='IDEMPOTENCY_CONFLICT'){setState('idempotency-conflict');setMessage('创建请求标识与当前可能答案内容不一致。');}
   else if(e instanceof ProjectApiError&&([400,404].includes(e.status)||['PROJECT_READ_ONLY','RESEARCH_ISSUE_READ_ONLY'].includes(e.code??''))){clearPendingCandidateClaimReceipt();setState('rejected');setMessage(e.message);}
   else{setState('unconfirmed');setMessage('创建结果尚未确认。请使用同一标识重试。');}
  }finally{if(!controller.signal.aborted)active.current=null;}
 }
 const onSubmit=(e:FormEvent)=>{e.preventDefault();void submit();};
 return <section className="research-candidate-claims" aria-labelledby="candidate-claims-heading">
  <h2 id="candidate-claims-heading">可能答案</h2>
  {load==='loading'?<p role="status">正在读取可能答案…</p>:null}
  {load==='unavailable'?<div className="research-error" role="alert">可能答案暂不可用。<button onClick={()=>setAttempt(n=>n+1)}>重试可能答案</button></div>:null}
  {load==='ready'?<>
   {claims.length?<div className="research-claim-list">{claims.map(claim=><article className="research-card" key={claim.id}><span className="research-issue-state">{claim.lifecycleState}</span><p>{claim.statement}</p><small>创建于 {new Date(claim.createdAt).toLocaleString('zh-CN')}</small><EvidenceEditor token={token} projectId={project.id} issueId={issue.id} claim={claim}/></article>)}</div>:<p>还没有可能答案。</p>}
   {canCreate?<form className="research-issue-form" onSubmit={onSubmit}>
    <label htmlFor="candidate-statement">可能答案正文</label>
    <textarea id="candidate-statement" rows={4} value={statement} disabled={state==='submitting'||state==='unconfirmed'} onChange={e=>setStatement(e.target.value)}/>
    {message?<p role="alert" className="research-issue-notice">{message}</p>:null}
    {state==='unconfirmed'?<button type="button" onClick={()=>void submit()}>使用同一标识重试</button>:state==='idempotency-conflict'?<button type="button" onClick={()=>void submit(true)}>作为新的可能答案重新提交</button>:<button type="submit" className="research-primary" disabled={state==='submitting'}>{state==='submitting'?'正在添加…':'添加可能答案'}</button>}
   </form>:null}
  </>:null}
 </section>;
}
