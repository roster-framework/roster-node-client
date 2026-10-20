import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import {SessionPublication} from "../src/application/session-publication.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {RosterRuntime} from "../src/application/runtime.js";
import {PROTOCOL,Result} from "@roster/contracts";
import type {SessionJournal} from "../src/application/session-journal.js";

const record=(id:string)=>({id,kind:"log" as const,text:"Original "+id,at:"2026-10-10T00:00:00Z"});

test("an entire batch rolls back on a conflict and preserves its original sequence after reopen",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-batch-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,"journal.db");let journal=new SqliteSessionJournal(path,"runtime");
 journal.begin({execution_id:"run",work_id:"work",agent_id:"agent",consumer_id:"core"});
 journal.append("run",record("one"));
 assert.throws(()=>journal.appendBatch("run",[record("two"),{...record("one"),text:"Changed"}]));
 assert.equal(journal.page("run","core",0,100).through,1);
 journal.appendBatch("run",[record("one"),record("two"),record("three")]);
 journal.close();journal=new SqliteSessionJournal(path,"runtime");
 assert.deepEqual(journal.page("run","core",0,100).entries.map(v=>[v.delivery_sequence,v.entry.id]),[[1,"one"],[2,"two"],[3,"three"]]);
 assert.equal(journal.acknowledge("run","core",3),3);assert.throws(()=>journal.acknowledge("run","core",4));journal.close();
});

test("publication emits only committed records, bounds each batch, and latches scheduled disk failure",async()=>{
 let committed=0,batches=0,delivered=0,failed:unknown;
 const journal:SessionJournal={begin(){},append(){throw Error("must batch")},appendBatch(_,records){assert.ok(records.length<=64);committed+=records.length;batches++},seal(){},recover(){},page(){throw Error("unused")},acknowledge(){return 0},close(){}};
 const publication=new SessionPublication(journal,"run",()=>{assert.ok(++delivered<=committed)},e=>failed=e);
 for(let n=0;n<1005;n++)publication.publish(record("r"+n),n);
 assert.equal(committed,960);publication.flush();assert.equal(delivered,1005);assert.equal(batches,16);
 await new Promise<void>(r=>setImmediate(r));assert.equal(batches,16);assert.equal(failed,undefined);
 journal.appendBatch=()=>{throw Error("disk failed")};
 publication.publish(record("failed"),1005);
 await new Promise<void>(r=>setImmediate(r));assert.ok(failed instanceof Error);assert.equal(delivered,1005);
 assert.throws(()=>publication.flush(),/disk failed/);assert.throws(()=>publication.publish(record("later"),1006),/disk failed/);
});

test("two native runtime bursts retain all records before emission and preserve terminal receipts across reopen",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-runtime-batch-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const storage=new FileRuntimeStorage(dir,"runtime"),path=join(dir,"journal.db");let journal=new SqliteSessionJournal(path,"runtime");
 const agent={spec:{id:"agent",name:"Agent",description:"burst",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(_:unknown,ctx:any){for(let n=0;n<1005;n++)ctx.log("Burst "+n);return Result.parse({status:"ok",summary:"Complete"});}};
 const runtime=new RosterRuntime("runtime",[agent],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused")}},{inspect:async()=>[]},{maxConcurrent:2,maxPerAgent:2},undefined,journal);
 await runtime.initialize();const counts=new Map<string,number>();
 await Promise.all(["first","second"].map(id=>runtime.run({protocol:PROTOCOL,execution_id:id,work_id:"work",agent_id:"agent",input:{},context:{request:"burst",culture:"",history:[],knowledge:[]}},frame=>{
  if(frame.type!=="session")return;
  const count=(counts.get(id)??0)+1;counts.set(id,count);
  assert.ok(journal.page(id,"core",Math.max(0,count-1),1).through>=count);
 },()=>{},undefined,true,"core")));
 assert.deepEqual([...counts.values()],[1007,1007]);
 for(const id of ["first","second"]){assert.equal((await storage.get(id))?.state,"completed");const page=journal.page(id,"core",1000,100);assert.equal(page.through,1008);assert.equal(page.entries.at(-1)?.entry.kind,"result");assert.equal(page.sealed,true);journal.acknowledge(id,"core",1008);}
 await runtime.close();journal=new SqliteSessionJournal(path,"runtime");journal.recover();
 for(const id of ["first","second"]){const page=journal.page(id,"core",1000,100);assert.equal(page.acknowledged,1008);assert.equal(page.through,1008);assert.equal((await storage.get(id))?.result?.summary,"Complete");}
 journal.close();
});


test("engine facts automatically share original durable binding, survive ACK and reopen, and contain no provider data",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-engine-facts-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const storage=new FileRuntimeStorage(dir,"runtime"),path=join(dir,"journal.db");let journal=new SqliteSessionJournal(path,"runtime");let calls=0;
 const agent={spec:{id:"agent",name:"Agent",description:"test",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(input:any){
  calls++;const page=journal.page(input.execution_id,"core",0,100);
  assert.equal(page.entries[0]?.entry.id,"engine.started");
  if(input.execution_id==='failed')throw new Error('private-provider-error');
  return Result.parse({status:'ok',summary:'private-result'});
 }};
 const runtime=new RosterRuntime("runtime",[agent],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused")}},{inspect:async()=>[]},undefined,undefined,journal);
 await runtime.initialize();const originals=new Map();
 for(const id of ['success','failed']) {
  await runtime.run({protocol:PROTOCOL,execution_id:id,work_id:'work',agent_id:'agent',input:{secret:'private-input'},context:{request:'private-request',culture:'',history:[],knowledge:[]}},()=>{},()=>{},undefined,true,'core');
  const page=journal.page(id,'core',0,100);originals.set(id,page.entries);
  assert.equal(page.work_id,'work');assert.equal(page.agent_id,'agent');assert.equal(page.sealed,true);
  const records=page.entries.filter(e=>e.entry.id.startsWith('engine.'));
  assert.equal(records.length,2);
  assert.deepEqual(records.map(e=>JSON.parse(e.entry.text).phase),['started',id==='success'?'returned':'interrupted']);
  for(const {entry} of records) {
   const fact=JSON.parse(entry.text);
   assert.deepEqual(Object.keys(fact).sort(),['duration_ms','phase','protocol']);
   assert.equal(fact.protocol,'roster-engine-observation/1');assert.ok(Number.isSafeInteger(fact.duration_ms)&&fact.duration_ms>=0);
   assert.equal(entry.kind,'note');assert.ok(!entry.text.includes('private-'));
  }
  assert.equal((await storage.get(id))?.state,id==='success'?'completed':'attention');
  journal.acknowledge(id,'core',page.through);
 }
 await runtime.close();journal=new SqliteSessionJournal(path,'runtime');journal.recover();
 for(const id of ['success','failed'])assert.deepEqual(journal.page(id,'core',0,100).entries,originals.get(id));
 assert.equal(calls,2);journal.close();
});

test("engine observation waits for invoked nodes after an early engine rejection",async()=>{
 const {executeTrackedAgent}=await import('../src/application/agent-execution.js');
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const phases:string[]=[];const failure=new Error('engine stopped');
 const agent={spec:{id:'agent',name:'Agent',description:'test',statuses:['ok'],events:[],skills:[],rules:[],capabilities:[]},async execute(){entered();await gate;return Result.parse({status:'ok'});}};
 const input={protocol:PROTOCOL,execution_id:'run',work_id:'work',agent_id:'agent',input:{},context:{request:'test',culture:'',history:[],knowledge:[]}};
 const run=executeTrackedAgent({async execute(a,i,c){void a.execute(i,c);await started;throw failure;}},agent,input,{workspace:'unused',signal:new AbortController().signal,log(){}},phase=>phases.push(phase));
 await started;await new Promise<void>(r=>setImmediate(r));assert.deepEqual(phases,['started']);
 release();await assert.rejects(run,e=>e===failure);assert.deepEqual(phases,['started','interrupted']);
});


test("engine journal failure blocks entry or prevents terminal success without repeating an invocation",async t=>{
 for(const failingPhase of ['started','returned']) {
  const dir=await mkdtemp(join(tmpdir(),'roster-engine-disk-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const storage=new FileRuntimeStorage(dir,'runtime');let calls=0;
  const journal:SessionJournal={begin(){},append(_,record){if(record.id==='engine.'+failingPhase)throw Error('disk unavailable');},seal(){},recover(){},page(){throw Error('unused');},acknowledge(){return 0;},close(){}};
  const agent={spec:{id:'agent',name:'Agent',description:'test',statuses:['ok'],events:[],skills:[],rules:[],capabilities:[]},async execute(){calls++;return Result.parse({status:'ok'});}};
  const runtime=new RosterRuntime('runtime',[agent],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal);
  await runtime.initialize();
  const request={protocol:PROTOCOL,execution_id:'run',work_id:'work',agent_id:'agent',input:{},context:{request:'test',culture:'',history:[],knowledge:[]}};
  await runtime.run(request,()=>{},()=>{},undefined,true,'core');
  assert.equal(calls,failingPhase==='started'?0:1);assert.equal((await storage.get('run'))?.state,'attention');
  await assert.rejects(runtime.run(request,()=>{},()=>{},undefined,true,'core'));
  assert.equal(calls,failingPhase==='started'?0:1);await runtime.close();
 }
});
