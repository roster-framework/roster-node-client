import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROTOCOL,Result} from '@roster/contracts';
import {HttpCoreExecutionAuthority} from '../src/infrastructure/core-execution-authority.js';
import {RosterRuntime} from '../src/application/runtime.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {SqliteSessionJournal} from '../src/infrastructure/sqlite-session-journal.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import type {AgentContext} from '../src/domain/agent.js';

const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
test('strict body authority rejects missing, changed and malformed proof without audience-only fallback',async t=>{
 let raw:Buffer,status=200,calls=0;
 const original={protocol:'roster-invocation-authority/1',execution_id:'run',work_id:'work',runtime_id:'runtime',agent_id:'agent',request_sha256:sha('wire')};
 raw=Buffer.from(JSON.stringify(original));
 const server=createServer((req,res)=>{calls++;assert.equal(req.url,'/api/core/execution/authority');res.writeHead(status,{'Content-Type':'application/json',Location:'/api/core/execution'});res.end(raw);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const core={url:`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`,token:'private-token'};
 const expected={executionId:'run',workId:'work',runtimeId:'runtime',agentId:'agent',requestSha256:original.request_sha256},signal=new AbortController().signal,verifier=new HttpCoreExecutionAuthority();
 await verifier.verify(core,expected,signal);
 const before=calls;
 await assert.rejects(verifier.verify(core,{...expected,requestSha256:undefined},signal),/execution_authority_mismatch/);assert.equal(calls,before);
 for(const field of ['execution_id','work_id','runtime_id','agent_id','request_sha256'] as const){
  raw=Buffer.from(JSON.stringify({...original,[field]:field==='request_sha256'?sha('changed'):'other'}));
  await assert.rejects(verifier.verify(core,expected,signal),/^ToolAccessRefusal: execution_authority_mismatch$/);
 }
 for(const value of ['{}',JSON.stringify({...original,token:'private'}),JSON.stringify(original).replace('"request_sha256":','"request_sha256":"'+sha('other')+'","request_sha256":'),' '.repeat(4097)]){
  raw=Buffer.from(value);await assert.rejects(verifier.verify(core,expected,signal),/^ToolAccessRefusal: core_authority_unavailable$/);
 }
 raw=Buffer.from([0xff]);await assert.rejects(verifier.verify(core,expected,signal),/core_authority_unavailable/);
 raw=Buffer.from(JSON.stringify(original));status=302;await assert.rejects(verifier.verify(core,expected,signal),/core_authority_unavailable/);
});

test('actual Runtime HTTP hashes wire bytes before defaults and refuses changed content before workspace, with durable safe evidence',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-wire-')),storage=new FileRuntimeStorage(dir,'runtime'),path=join(dir,'journal.db'),journal=new SqliteSessionJournal(path,'runtime');
 let execution='run',digest='',mode='',authors=0,workspaces=0,status=200,trusted=true;
 const core=createServer((req,res)=>{
  assert.equal(req.url,'/api/core/execution/authority');assert.equal(req.headers.authorization,'Bearer '+ 'c'.repeat(32));
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({protocol:'roster-invocation-authority/1',execution_id:execution,work_id:'work',runtime_id:'runtime',agent_id:'agent',request_sha256:digest}));
 });
 await new Promise<void>(r=>core.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(core.address() as {port:number}).port}`;
 const runtime=new RosterRuntime('runtime',[{spec:{id:'agent',name:'Agent',description:'Fixture',statuses:['ok'],events:[],skills:[],rules:[],capabilities:[]},async execute(_input,ctx:AgentContext){
  authors++;
  if(mode==='author-change'){
   digest=sha('changed');try{await ctx.authorizeCoreConnection!();assert.fail('changed body accepted');}catch{assert.ok(ctx.signal.aborted);}
  }
  if(mode==='terminal-change'||mode==='suspension-change')digest=sha('changed');
  if(mode==='terminal-unavailable')status=503;
  if(mode==='terminal-trust')trusted=false;
  if(mode.startsWith('suspension-'))ctx.suspendForReply!('wait',{draft:'private-terminal-checkpoint'});
  return Result.parse({status:'ok',summary:'done'});
 }}],storage,storage,{create:async(a,e)=>{workspaces++;if(mode==='workspace-change')digest=sha('changed');return storage.create(a,e);}},
 {execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal,undefined,undefined,undefined,undefined,
 {current:async()=>({version:1,revision:'owner',grants:trusted?[{agentId:'agent',origin}]:[]})},new HttpCoreExecutionAuthority());
 await runtime.initialize();const api=createRuntimeApi(runtime,'service-token');await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
 t.after(async()=>{await runtime.close();for(const server of [api,core]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await rm(dir,{recursive:true,force:true});});
 const invoke=async(id:string,alter=false)=>{
  execution=id;
  // Intentionally not JSON.stringify(parsed): preserve whitespace, escapes and
  // an integer above the JavaScript safe range.
  const raw=`{ "protocol":"${PROTOCOL}","execution_id":"${id}","work_id":"work","agent_id":"agent","input":{"large":9007199254740993},"context":{"request":"private-request <&>","culture":"","history":[],"knowledge":[]} }`;
  digest=sha(raw);
  const response=await fetch(`http://127.0.0.1:${(api.address() as {port:number}).port}/executions`,{method:'POST',headers:{Authorization:'Bearer service-token','Content-Type':'application/json','X-Roster-Core-Mcp-Url':origin+'/mcp','X-Roster-Core-Mcp-Token':'c'.repeat(32),'X-Roster-Session-Stream':'2','X-Roster-Session-Consumer':'core'},body:alter?raw.replace('private-request','changed-request'):raw});
  const frames=await response.text();assert.equal(response.status,200,frames);
  for(const secret of ['private-request','changed-request','c'.repeat(32),digest])assert.ok(!frames.includes(secret));
  return storage.get(id);
 };
 assert.equal((await invoke('original'))?.state,'completed');assert.equal(authors,1);assert.equal(workspaces,1);
 assert.equal((await invoke('changed',true))?.observation,'execution_authority_mismatch');assert.equal(authors,1);assert.equal(workspaces,1);
 mode='workspace-change';assert.equal((await invoke('workspace'))?.observation,'execution_authority_mismatch');assert.equal(authors,1);assert.equal(workspaces,2);
 mode='author-change';assert.equal((await invoke('author'))?.state,'attention');assert.equal(authors,2);
 const terminalEvidence=new Map<string,ReturnType<SqliteSessionJournal['page']>>();
 for(const [selected,reason] of [['terminal-change','execution_authority_mismatch'],['terminal-unavailable','core_authority_unavailable'],['terminal-trust','core_origin_untrusted'],['suspension-change','execution_authority_mismatch']] as const){
  mode=selected;status=200;trusted=true;
  const receipt=await invoke(selected);assert.equal(receipt?.state,'attention');assert.equal(receipt?.observation,reason);
  assert.equal(receipt?.result,undefined);assert.equal(receipt?.suspension,undefined);
  const page=journal.page(selected,'core',0,100);
  terminalEvidence.set(selected,page);
  assert.equal(page.entries.filter(e=>e.entry.kind==='decision').length,1);
  assert.deepEqual(JSON.parse(page.entries.find(e=>e.entry.kind==='decision')!.entry.text),{protocol:'roster-core-tool-denial/1',reason});
  assert.ok(!JSON.stringify(page).includes('private-terminal-checkpoint'));
  if(selected==='suspension-change')await assert.rejects(storage.readSuspensionCheckpoint(selected));
 }
 assert.equal(authors,6,'Terminal refusal must not retry author work');
 mode='suspension-valid';status=200;trusted=true;
 assert.equal((await invoke('suspension-valid'))?.state,'suspended');assert.equal(authors,7);
 assert.equal((await storage.readSuspensionCheckpoint('suspension-valid')).state.draft,'private-terminal-checkpoint');
 const evidence=journal.page('changed','core',0,100);
 assert.deepEqual(JSON.parse(evidence.entries.find(e=>e.entry.kind==='decision')!.entry.text),{protocol:'roster-core-tool-denial/1',reason:'execution_authority_mismatch'});
 await runtime.close();const reopened=new SqliteSessionJournal(path,'runtime');
 try{
  assert.deepEqual(reopened.page('changed','core',0,100),evidence);
  for(const [id,page] of terminalEvidence)assert.deepEqual(reopened.page(id,'core',0,100),page);
 }finally{reopened.close();}
});
