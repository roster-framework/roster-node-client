import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROTOCOL,type RunInput} from '@roster/contracts';
import {RosterRuntime} from '../src/application/runtime.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {HttpCoreExecutionAuthority} from '../src/infrastructure/core-execution-authority.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import {executeAgent} from '../src/infrastructure/langgraph-engine.js';
import {JsonSchemaAgentParameters} from '../src/infrastructure/agent-parameters.js';
import {createAgentTemplates} from '../presets/codex/collaborating.mjs';

for(const child of [false,true])test(`bundled Codex ${child?'child completion':'question'} wait persists through actual Runtime HTTP and storage reopen before a new CLI execution`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-codex-continuation-'));
 let expected={execution_id:'parent',work_id:'work',agent_id:'agent',request_sha256:''};
 let registrations=0,launches=0;
 const core=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+'c'.repeat(32));
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/core/execution/authority') {
   res.end(JSON.stringify({protocol:'roster-invocation-authority/1',runtime_id:'runtime',...expected}));return;
  }
  assert.equal(req.url,'/api/core/continuations/register');assert.equal(req.method,'POST');
  let raw='';for await(const part of req)raw+=part;const command=JSON.parse(raw);
  assert.equal(command.id,'wait');assert.equal(command.version,child?2:1);
  if(child)assert.deepEqual(command.child_work_ids,['child-work']);
  else {assert.equal(command.thread_id,'thread');assert.equal(command.question_id,'question');}
  registrations++;
  res.end(JSON.stringify({version:child?2:1,id:'wait',work_id:expected.work_id,execution_id:expected.execution_id,...(child?{}:{thread_id:'thread',question_id:'question'}),created:new Date().toISOString(),replayed:false}));
 });
 await new Promise<void>(r=>core.listen(0,'127.0.0.1',r));
 const coreOrigin=`http://127.0.0.1:${(core.address() as {port:number}).port}`;
 const make=()=>{
  const storage=new FileRuntimeStorage(dir,'test');
  // Real CLI process fixture: provider login and model inference are deliberately absent.
  const wait=child?{id:'wait',child_work_ids:['child-work'],join:'all',timeout_seconds:60}:{id:'wait',thread_id:'thread',question_id:'question',responders:['designer'],join:'any',timeout_seconds:60};
  const source=`let p='';process.stdin.on('data',x=>p+=x);process.stdin.on('end',()=>{
   const resumed=p.includes('This is a new authorized execution');
   const valid=!resumed||p.includes(${JSON.stringify(child?'Read the original child results':'Read the original thread')});
   const report=resumed?{status:valid?'success':'needs_help',summary:'Fixture checked original resume references only',minutes:'',wait:null}:{status:'waiting',summary:'Await completion',minutes:'',wait:${JSON.stringify(wait)}};
   console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report)}}));
  });`;
  const agent=createAgentTemplates({resolveLaunch:async()=>{launches++;return {command:process.execPath,prefix:['--input-type=module','-e',source]};}})[0]!.create({id:'agent',name:'Agent',parameters:{project:dir}});
  const runtime=new RosterRuntime('runtime',[agent],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,undefined,undefined,new JsonSchemaAgentParameters(),undefined,undefined,
   {current:async()=>({version:1,revision:'owner',grants:[{agentId:'agent',origin:coreOrigin}]})},new HttpCoreExecutionAuthority(true));
  return {storage,runtime,api:createRuntimeApi(runtime,'runtime-token')};
 };
 let current=make();
 t.after(async()=>{await current.runtime.close();for(const s of [current.api,core]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await rm(dir,{recursive:true,force:true});});
 await current.runtime.initialize();await new Promise<void>(r=>current.api.listen(0,'127.0.0.1',r));
 const invoke=async(input:RunInput)=>{
  const raw=JSON.stringify(input);expected={execution_id:input.execution_id,work_id:input.work_id,agent_id:input.agent_id,request_sha256:createHash('sha256').update(raw).digest('hex')};
  const res=await fetch(`http://127.0.0.1:${(current.api.address() as {port:number}).port}/executions`,{method:'POST',headers:{Authorization:'Bearer runtime-token','Content-Type':'application/json','X-Roster-Core-Mcp-Url':coreOrigin+'/mcp','X-Roster-Core-Mcp-Token':'c'.repeat(32)},body:raw});
  const wire=await res.text();assert.equal(res.status,200,wire);return {stored:await current.storage.get(input.execution_id),wire};
 };
 const original:RunInput={protocol:PROTOCOL,execution_id:'parent',work_id:'work',agent_id:'agent',input:{},context:{request:'build',culture:'',history:[],knowledge:[]}};
 const first=await invoke(original);assert.equal(first.stored?.state,'suspended');assert.equal(registrations,1);assert.equal(launches,1);
 const parent=first.stored!;assert.ok(parent.suspension);
 assert.ok(!first.wire.includes(child?'codex-child-wait':'codex-discussion-wait'),'private checkpoint envelope is not streamed; explicit work summary may be logged');
 await current.runtime.close();current.api.closeAllConnections();await new Promise<void>(r=>current.api.close(()=>r()));
 current=make();await current.runtime.initialize();await new Promise<void>(r=>current.api.listen(0,'127.0.0.1',r));
 const continuation:NonNullable<RunInput['context']['continuation']>=child?{protocol:'roster-execution-continuation/2',parent_execution_id:'parent',wait_id:'wait',checkpoint_digest:parent.suspension!.checkpoint_digest,children:[{request_id:'child-work',record_id:'child-execution',digest:'a'.repeat(64),state:'completed'}]}:{protocol:'roster-execution-continuation/1',parent_execution_id:'parent',wait_id:'wait',checkpoint_digest:parent.suspension!.checkpoint_digest,thread_id:'thread',question_id:'question',answers:[{member_id:'designer',message_id:'reply',sequence:2,digest:'a'.repeat(64)}]};
 const resumed:RunInput={...original,execution_id:'resumed',context:{...original.context,continuation}};
 assert.equal((await invoke(resumed)).stored?.state,'completed');assert.equal(registrations,1);assert.equal(launches,2);
 assert.deepEqual(await current.storage.get('parent'),parent);
});
