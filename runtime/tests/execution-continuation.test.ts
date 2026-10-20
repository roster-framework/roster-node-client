import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROTOCOL,Result,type RunInput} from '@roster/contracts';
import {RosterRuntime} from '../src/application/runtime.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {HttpCoreExecutionAuthority} from '../src/infrastructure/core-execution-authority.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import {executeAgent} from '../src/infrastructure/langgraph-engine.js';

test('New HTTP execution restores only its authenticated local checkpoint after Runtime reopen',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-continuation-'));
 let expected={execution_id:'parent',work_id:'work',agent_id:'agent',request_sha256:''};
 const core=createServer((req,res)=>{assert.equal(req.url,'/api/core/execution/authority');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({protocol:'roster-invocation-authority/1',runtime_id:'runtime',...expected}));});
 await new Promise<void>(r=>core.listen(0,'127.0.0.1',r));
 const coreOrigin=`http://127.0.0.1:${(core.address() as {port:number}).port}`;
 let authors=0,workspaces=0;
 const spec={id:'agent',name:'Agent',description:'test',statuses:['ok'],events:['complete'],skills:[],rules:[],capabilities:[]};
 const make=(strong=true)=>{
  const storage=new FileRuntimeStorage(dir,'test');
  const runtime=new RosterRuntime('runtime',[{spec,async execute(input,ctx){
   authors++;
   if(!ctx.continuation){assert.equal(ctx.suspendForCompletion,ctx.suspendForReply);ctx.suspendForCompletion!('wait',{draft:'private-checkpoint-body',nested:{step:2}});}
   assert.equal(ctx.continuation!.checkpoint.draft,'private-checkpoint-body');
   const reference=ctx.continuation!.reference;
   if(reference.protocol==='roster-execution-continuation/1')assert.equal(reference.answers[0]!.message_id,'reply');
   else assert.equal(reference.children[0]!.request_id,'child-work');
   assert.ok(Object.isFrozen(ctx.continuation!.checkpoint.nested));
   assert.ok(!JSON.stringify(input).includes('private-checkpoint-body'));
   assert.throws(()=>{(ctx.continuation!.checkpoint.nested as Record<string,unknown>).step=3;});
   return Result.parse({status:'ok',summary:'Resumed',events:[{type:'complete',data:{}}]});
  }}],storage,storage,{create:async(a,e)=>{workspaces++;return storage.create(a,e);}},{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,undefined,undefined,undefined,undefined,undefined,
  {current:async()=>({version:1,revision:'owner',grants:[{agentId:'agent',origin:coreOrigin}]})},new HttpCoreExecutionAuthority(strong));
  return {storage,runtime,api:createRuntimeApi(runtime,'runtime-token')};
 };
 let current=make();await current.runtime.initialize();await new Promise<void>(r=>current.api.listen(0,'127.0.0.1',r));
 assert.equal((await current.runtime.manifest()).execution_continuation,'roster-execution-continuation/2');
 t.after(async()=>{await current.runtime.close();for(const s of [current.api,core]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await rm(dir,{recursive:true,force:true});});
 const invoke=async(input:RunInput)=>{
  const raw=JSON.stringify(input);expected={execution_id:input.execution_id,work_id:input.work_id,agent_id:input.agent_id,request_sha256:createHash('sha256').update(raw).digest('hex')};
  const res=await fetch(`http://127.0.0.1:${(current.api.address() as {port:number}).port}/executions`,{method:'POST',headers:{Authorization:'Bearer runtime-token','Content-Type':'application/json','X-Roster-Core-Mcp-Url':coreOrigin+'/mcp','X-Roster-Core-Mcp-Token':'c'.repeat(32)},body:raw});
  const wire=await res.text();assert.equal(res.status,200,wire);assert.ok(!wire.includes('private-checkpoint-body'));return current.storage.get(input.execution_id);
 };
 const original:RunInput={protocol:PROTOCOL,execution_id:'parent',work_id:'work',agent_id:'agent',input:{},context:{request:'build',culture:'',history:[],knowledge:[]}};
 assert.equal((await invoke(original))?.state,'suspended');
 const parent=await current.storage.get('parent');assert.ok(parent?.suspension);
 await current.runtime.close();current.api.closeAllConnections();await new Promise<void>(r=>current.api.close(()=>r()));
 current=make();await current.runtime.initialize();await new Promise<void>(r=>current.api.listen(0,'127.0.0.1',r));
 const resumed:RunInput={...original,execution_id:'resumed',context:{...original.context,continuation:{protocol:'roster-execution-continuation/1',parent_execution_id:'parent',wait_id:'wait',checkpoint_digest:parent.suspension.checkpoint_digest,thread_id:'thread',question_id:'question',answers:[{member_id:'designer',message_id:'reply',sequence:2,digest:'a'.repeat(64)}]}}};
 assert.equal((await invoke(resumed))?.state,'completed');assert.equal(authors,2);assert.equal(workspaces,2);assert.deepEqual(await current.storage.get('parent'),parent);
 const childResume:RunInput={...original,execution_id:'child-resumed',context:{...original.context,continuation:{protocol:'roster-execution-continuation/2',parent_execution_id:'parent',wait_id:'wait',checkpoint_digest:parent.suspension.checkpoint_digest,children:[{request_id:'child-work',record_id:'child-run',digest:'a'.repeat(64),state:'attention'}]}}};
 assert.equal((await invoke(childResume))?.state,'completed');assert.equal(authors,3);assert.equal(workspaces,3);assert.deepEqual(await current.storage.get('parent'),parent);
 for(const mode of ['wait','digest','missing','work'] as const){
  const bad=structuredClone(resumed);bad.execution_id='bad-'+mode;
  if(mode==='wait')bad.context.continuation!.wait_id='other';
  if(mode==='digest')bad.context.continuation!.checkpoint_digest='f'.repeat(64);
  if(mode==='missing')bad.context.continuation!.parent_execution_id='absent';
  if(mode==='work')bad.work_id='other';
  assert.equal((await invoke(bad))?.state,'attention');assert.equal(authors,3);assert.equal(workspaces,3);
 }
 const readCheckpoint=current.storage.readSuspensionCheckpoint.bind(current.storage);
 current.storage.readSuspensionCheckpoint=async id=>{const checkpoint=await readCheckpoint(id);expected.request_sha256='f'.repeat(64);return checkpoint;};
 assert.equal((await invoke({...resumed,execution_id:'changed-during-load'}))?.state,'attention');assert.equal(authors,3);assert.equal(workspaces,3);
 current.storage.readSuspensionCheckpoint=readCheckpoint;
 await current.runtime.close();current.api.closeAllConnections();await new Promise<void>(r=>current.api.close(()=>r()));
 current=make(false);await current.runtime.initialize();await new Promise<void>(r=>current.api.listen(0,'127.0.0.1',r));
 assert.equal((await current.runtime.manifest()).execution_continuation,undefined);
 // Audience-only compatibility must not restore private state.
 const weak={...resumed,execution_id:'weak'};
 // The weak adapter is rejected before its audience-only HTTP request or private read.
 assert.equal((await invoke(weak))?.state,'attention');assert.equal(authors,3);assert.equal(workspaces,3);
});
