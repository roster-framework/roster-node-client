import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {PROTOCOL,Result,validateSuspendedExecutionReceipt,type RunInput} from '@roster/contracts';
import {RosterRuntime} from '../src/application/runtime.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {executeAgent} from '../src/infrastructure/langgraph-engine.js';
import {SqliteSessionJournal} from '../src/infrastructure/sqlite-session-journal.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import type {RuntimeFrame} from '../src/domain/session.js';

const invocation:RunInput={protocol:PROTOCOL,execution_id:'run',work_id:'work',agent_id:'agent',input:{},context:{request:'Ask the designer',culture:'',history:[],knowledge:[]}};
const spec={id:'agent',name:'Agent',description:'test',statuses:['ok'],events:['complete'],skills:[],rules:[],capabilities:[]};

test('Real LangGraph suspension produces a private immutable checkpoint and durable terminal note over HTTP',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'roster-suspension-'));
 const storage=new FileRuntimeStorage(directory,'test');
 const journal=new SqliteSessionJournal(join(directory,'sessions.db'),'runtime');
 let calls=0;
 const runtime=new RosterRuntime('runtime',[{spec,async execute(_,ctx){calls++;ctx.log('Asking the designer.');ctx.suspendForReply!('wait',{draft:'private-checkpoint-content',next:'continue-development'});return Result.parse({status:'ok',summary:'unreachable'});}}],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal);
 await runtime.initialize();
 const server=createRuntimeApi(runtime,'private-runtime-token-for-tests');server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});});
 const address=server.address() as {port:number};const origin=`http://127.0.0.1:${address.port}`;
 const headers={Authorization:'Bearer private-runtime-token-for-tests','Content-Type':'application/json'};
 const response=await fetch(origin+'/executions',{method:'POST',headers:{...headers,'X-Roster-Session-Stream':'2','X-Roster-Session-Consumer':'core'},body:JSON.stringify(invocation)});
 const raw=await response.text();assert.equal(response.status,200,raw);assert.ok(!raw.includes('private-checkpoint-content'));
 const frames=raw.trim().split('\n').map(x=>JSON.parse(x)) as RuntimeFrame[];
 const terminal=frames.at(-1)!;assert.equal(terminal.type,'suspended');assert.ok(!frames.some(f=>f.type==='result'));
 if(terminal.type!=='suspended')throw Error('missing terminal');
 assert.equal(terminal.session?.kind,'note');assert.equal(terminal.suspension.runtime_id,'runtime');assert.equal(terminal.suspension.execution_id,'run');
 const receipt=await (await fetch(origin+'/executions/run',{headers})).text();assert.ok(!receipt.includes('private-checkpoint-content'));assert.equal(validateSuspendedExecutionReceipt(JSON.parse(receipt),{execution_id:'run',work_id:'work',runtime_id:'runtime',agent_id:'agent'}).state,'suspended');
 assert.equal((await storage.readSuspensionCheckpoint('run')).state.draft,'private-checkpoint-content');
 const page=journal.page('run','core',0,100);assert.equal(page.sealed,true);assert.equal(page.entries.at(-1)?.entry.kind,'note');
 await assert.rejects(()=>storage.save({id:'run',state:'completed',result:Result.parse({status:'ok',summary:'must refuse'})}));
 await runtime.close();
 const reopened=new FileRuntimeStorage(directory,'test');await reopened.recover();assert.equal((await reopened.get('run'))?.state,'suspended');assert.equal((await reopened.readSuspensionCheckpoint('run')).wait_id,'wait');assert.equal(await reopened.reserve('run'),false);assert.equal(calls,1);
 const file=join(directory,'executions','run.json');const damaged=JSON.parse(await readFile(file,'utf8'));damaged.private_checkpoint.state.draft='tampered';await writeFile(file,JSON.stringify(damaged));await assert.rejects(()=>reopened.get('run'));await assert.rejects(()=>reopened.recover());
});

test('Catching a wait cannot complete work or release admission before the agent stops',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-suspension-settle-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const storage=new FileRuntimeStorage(dir,'test');let release!:()=>void;const gate=new Promise<void>(r=>release=r);let requested!:()=>void;const ready=new Promise<void>(r=>requested=r);
 const runtime=new RosterRuntime('runtime',[{spec,async execute(_,ctx){try{ctx.suspendForReply!('wait',{step:1});}catch{}requested();await gate;return Result.parse({status:'ok',summary:'must not complete'});}}],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]});await runtime.initialize();t.after(()=>runtime.close());
 const frames:RuntimeFrame[]=[];const run=runtime.run(invocation,f=>frames.push(f));await ready;
 assert.equal((await storage.get('run'))?.state,'running');assert.equal(runtime.capacity().active,1);assert.ok(!frames.some(f=>f.type==='suspended'));
 release();await run;assert.equal((await storage.get('run'))?.state,'suspended');assert.equal(runtime.capacity().active,0);assert.equal(frames.at(-1)?.type,'suspended');assert.ok(!frames.some(f=>f.type==='result'));
});

test('Checkpoint storage failure or an abort cannot be reported as a successful suspension',async t=>{
 for(const mode of ['storage','abort'] as const){
 const dir=await mkdtemp(join(tmpdir(),'roster-suspension-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));const storage=new FileRuntimeStorage(dir,'test');
 if(mode==='storage')storage.saveSuspension=async()=>{throw Error('fixture storage failure');};
 let runtime:RosterRuntime;
 runtime=new RosterRuntime('runtime',[{spec,async execute(_,ctx){if(mode==='abort')runtime.cancel('run');ctx.suspendForReply!('wait',{step:1});return Result.parse({status:'ok'});}}],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]});await runtime.initialize();t.after(()=>runtime.close());const frames:RuntimeFrame[]=[];await runtime.run(invocation,f=>frames.push(f));assert.equal((await storage.get('run'))?.state,'attention');assert.equal(frames.at(-1)?.type,'observation');assert.ok(!frames.some(f=>f.type==='suspended'||f.type==='result'));
 }
});
