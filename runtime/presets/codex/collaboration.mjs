import {coreMcpConfiguration} from './core-mcp.mjs';

const validID = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const validIDs = (values,max) => Array.isArray(values) && values.length>0 && values.length<=max && values.every(validID) && new Set(values).size===values.length;

export function collaborationPrompt(context, input) {
  if (!context.coreMcp || typeof context.authorizeCoreConnection !== 'function' || typeof (context.suspendForCompletion??context.suspendForReply) !== 'function') throw Error('Collaboration requires current Core access and Runtime suspension support');
  coreMcpConfiguration(context.coreMcp, {agentCalls:true});
  if (!validID(input?.work_id) || !validID(input?.execution_id)) throw Error('Collaboration requires the current Runtime work and execution IDs');
  let prompt = '\n\nFor collaboration, return wait:null with success or needs_help. If another participant must answer before you can continue, first create the authorized shared thread and append your actual question using Core MCP. Mention the intended responders. Then return status:waiting and wait:{id,thread_id,question_id,responders,join,timeout_seconds}. Use stable IDs and join any or all deliberately; timeout_seconds must be 1..86400. Do not poll repeatedly. Runtime registers the wait with current Core authority only after the CLI exits cleanly, then saves a private checkpoint. A waiting report is not completion. Do not include credentials, hidden reasoning or resource bodies in summary. No PM role or particular workflow is required.';
  prompt += '\nFor a question that suspends this work, set roster_create_discussion parent_work_id to '+JSON.stringify(input.work_id)+'. This ID is an execution reference, not a permission grant. A standalone discussion without this work link cannot register a reply wait. Core supplies the author; never supply actor or scope fields.';
  prompt += '\nTo wait for delegated work instead, first call roster_call_agent and retain the actual receipt work_id. Return status:waiting with wait:{id,child_work_ids,join,timeout_seconds}; do not mix question fields with child_work_ids. Core checks the original acceptance and current call/read permissions. Acceptance is not completion. Use this durable wait instead of repeated polling. No PM or routing pattern is forced.';
  if (context.continuation) {
    const {reference:r,checkpoint:c} = context.continuation;
    if (!r || typeof r !== 'object') throw Error('Invalid Codex collaboration checkpoint');
    if (!c || c.wait_id!==r.wait_id || !validID(c.wait_id) || typeof c.summary!=='string' || c.summary.length>20000) throw Error('Invalid Codex collaboration checkpoint');
    if(c.version===2) {
      if (!exactKeys(c,['version','kind','wait_id','child_work_ids','join','summary']) || c.kind!=='codex-child-wait' || r.protocol!=='roster-execution-continuation/2' || !validIDs(c.child_work_ids,12) || !['any','all'].includes(c.join) || !Array.isArray(r.children) || r.children.length<1 || r.children.some(child=>!c.child_work_ids.includes(child.request_id)) || new Set(r.children.map(child=>child.request_id)).size!==r.children.length || (c.join==='all' && r.children.length!==c.child_work_ids.length) || typeof context.suspendForCompletion!=='function') throw Error('Invalid Codex collaboration checkpoint');
      prompt += '\n\nThis is a new authorized execution resuming suspended delegated work. Read the original child results through roster_get_delegated_result using each original work_id and current permissions before continuing. Do not repeat the original delegation. Completion metadata is not the result body; attention or cancelled does not mean success. For any, unfinished children may still be running. Checkpoint references and explicit work summary: '+JSON.stringify({child_work_ids:c.child_work_ids,join:c.join,summary:c.summary});
    } else {
      if (!exactKeys(c,['version','kind','wait_id','thread_id','question_id','summary']) || c.version!==1 || c.kind!=='codex-discussion-wait' || r.protocol==='roster-execution-continuation/2' || c.thread_id!==r.thread_id || c.question_id!==r.question_id || !validID(c.thread_id) || !validID(c.question_id)) throw Error('Invalid Codex collaboration checkpoint');
      prompt += '\n\nThis is a new authorized execution resuming a suspended question. Read the original thread and actual replies through roster_read_discussion with current permissions, then continue the original task. Do not repeat the original question or assume an answer from metadata. An answer from one responder is not agreement by all. Checkpoint references and explicit work summary: '+JSON.stringify({thread_id:c.thread_id,question_id:c.question_id,summary:c.summary});
    }
  }
  return prompt;
}

// Host-owned registration: a model's claimed wait ID/receipt is never accepted
// as proof. Core binds this command to the current execution and real question.
export async function finishCollaboration(receipt, input, context) {
  let report;
  try { report=JSON.parse(receipt.final); } catch { throw Error('Invalid collaboration report'); }
  if (!exactKeys(report,['status','summary','minutes','wait']) || !['success','needs_help','waiting'].includes(report.status) || typeof report.summary!=='string' || !report.summary.trim() || report.summary.length>20000 || typeof report.minutes!=='string' || report.minutes.length>100000) throw Error('Invalid collaboration report');
  if (report.status!=='waiting') {
    if (report.wait!==null) throw Error('Unexpected wait in terminal report');
    return;
  }
  if (receipt.code!==0 || receipt.failed || receipt.stopped || context.signal.aborted) throw Error('CLI did not stop cleanly for reply waiting');
  collaborationPrompt(context, input); // Validate host ports and any original checkpoint.
  const w=report.wait;
  const child=exactKeys(w,['id','child_work_ids','join','timeout_seconds']);
  const question=exactKeys(w,['id','thread_id','question_id','responders','join','timeout_seconds']);
  if ((!child && !question) || !validID(w.id) || !['any','all'].includes(w.join) || !Number.isInteger(w.timeout_seconds) || w.timeout_seconds<1 || w.timeout_seconds>86400 || (child ? !validIDs(w.child_work_ids,12) || typeof context.suspendForCompletion!=='function' : !validID(w.thread_id) || !validID(w.question_id) || !validIDs(w.responders,32))) throw Error('Invalid collaboration wait');
  const command={version:child?2:1,id:w.id,...(child?{child_work_ids:[...w.child_work_ids]}:{thread_id:w.thread_id,question_id:w.question_id,responders:[...w.responders]}),join:w.join,deadline:new Date(Date.now()+w.timeout_seconds*1000).toISOString()};
  const executionID=input.execution_id, workID=input.work_id, summary=report.summary;
  const {url:coreURL,token}=context.coreMcp;
  await context.authorizeCoreConnection();
  context.signal.throwIfAborted();
  const url=new URL(coreURL);url.pathname='/api/core/continuations/register';
  let response;
  try { response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.any([context.signal,AbortSignal.timeout(10000)]),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(command)}); }
  catch { throw Error('Core wait registration unavailable'); }
  if (!response.ok) { await response.body?.cancel().catch(()=>{}); throw Error('Core wait registration rejected'); }
  let raw='';
  try {
    if (!response.body) throw Error();
    const reader=response.body.getReader(), decoder=new TextDecoder('utf-8',{fatal:true});let size=0;
    for (;;) { const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw Error();}raw+=decoder.decode(value,{stream:true}); }
    raw+=decoder.decode();
  } catch { throw Error('Invalid Core wait registration receipt'); }
  let accepted;
  try { accepted=JSON.parse(raw); } catch { throw Error('Invalid Core wait registration receipt'); }
  if (!exactKeys(accepted,['version','id','work_id','execution_id',...(child?[]:['thread_id','question_id']),'created','replayed']) || accepted.version!==command.version || accepted.id!==command.id || accepted.work_id!==workID || accepted.execution_id!==executionID || accepted.thread_id!==command.thread_id || accepted.question_id!==command.question_id || typeof accepted.created!=='string' || !Number.isFinite(Date.parse(accepted.created)) || typeof accepted.replayed!=='boolean') throw Error('Invalid Core wait registration receipt');
  await context.authorizeCoreConnection();
  context.signal.throwIfAborted();
  const checkpoint=child?{version:2,kind:'codex-child-wait',wait_id:command.id,child_work_ids:[...command.child_work_ids],join:command.join,summary}:{version:1,kind:'codex-discussion-wait',wait_id:command.id,thread_id:command.thread_id,question_id:command.question_id,summary};
  (context.suspendForCompletion??context.suspendForReply)(command.id,checkpoint);
  throw Error('Runtime suspension port returned unexpectedly');
}
