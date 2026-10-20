import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {PROTOCOL,Result} from "@roster/contracts";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {RosterRuntime} from "../src/application/runtime.js";
import {createRuntimeApi} from "../src/interfaces/http.js";
import {SESSION_DELIVERY,JournalNotFound} from "../src/domain/session-delivery.js";
import type {SessionJournal} from "../src/application/session-journal.js";

test("journal survives reopen, binds its consumer, rejects gaps and preserves monotone ACK",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-journal-"));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,"journal.db");
 let journal=new SqliteSessionJournal(path,"runtime");
 const binding={execution_id:"run",work_id:"work",agent_id:"agent.frontend",consumer_id:"core"};journal.begin(binding);
 const first={id:"record-1",kind:"decision" as const,text:"Original decision",at:"2026-10-03T00:00:00Z"};
 journal.append("run",first);journal.append("run",first);
 assert.throws(()=>journal.begin({...binding,consumer_id:"other"}));
 assert.throws(()=>journal.append("run",{...first,text:"Modified"}));
 assert.throws(()=>journal.page("run","other",0,100),JournalNotFound);
 assert.throws(()=>journal.acknowledge("run","core",2));
 assert.throws(()=>journal.acknowledge("run","core",0.5));
 assert.throws(()=>journal.page("run","core",2,100));
 journal.close();journal=new SqliteSessionJournal(path,"runtime");journal.recover();
 const recovered=journal.page("run","core",0,100);
 assert.equal(recovered.entries.length,2);
 assert.deepEqual(recovered.entries[0].entry,first);
 assert.equal(recovered.entries[1].entry.id,'journal.recovered');
 assert.deepEqual(JSON.parse(recovered.entries[1].entry.text),{protocol:'roster-session-journal-observation/1',phase:'recovery_sealed'});
 journal.recover();assert.deepEqual(journal.page("run","core",0,100),recovered);
 assert.equal(journal.page("run","core",0,100).sealed,true);
 assert.equal(journal.acknowledge("run","core",2),2);assert.equal(journal.acknowledge("run","core",0),2);
 assert.throws(()=>journal.append("run",{...first,id:"record-2"}));journal.close();
});

test("HTTP durable records persist before emission, replay after disconnect and never rerun the agent",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-journal-http-"));const storage=new FileRuntimeStorage(dir,"runtime");let calls=0;
 const journal=new SqliteSessionJournal(join(dir,"journal.db"),"runtime");
 const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"test",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(_,ctx){calls++;ctx.log("First");ctx.recordSession!({kind:"knowhow",text:"Keep evidence"});return Result.parse({status:"ok",summary:"Done"});}}],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal);
 await runtime.initialize();const server=createRuntimeApi(runtime,"private-runtime-token-for-tests");server.listen(0,"127.0.0.1");await once(server,"listening");
 t.after(async()=>{await runtime.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const headers={Authorization:"Bearer private-runtime-token-for-tests","Content-Type":"application/json","X-Roster-Session-Consumer":"core","X-Roster-Service-Protocol":SESSION_DELIVERY};
 const response=await fetch(origin+"/executions",{method:"POST",headers:{...headers,"X-Roster-Session-Stream":"2"},body:JSON.stringify({protocol:PROTOCOL,execution_id:"run",work_id:"work",agent_id:"agent",input:{},context:{request:"test",culture:"",history:[],knowledge:[]}})});
 assert.equal(response.status,200);assert.equal(response.headers.get("X-Roster-Session-Journal"),"1");await response.body!.cancel();
 for(let n=0;n<100 && (await storage.get("run"))?.state==="running";n++)await new Promise(r=>setTimeout(r,10));
 const page=await (await fetch(origin+"/executions/run/records?after=0",{headers})).json();
 assert.equal(page.entries.length,5);assert.equal(page.entries.at(-1).entry.kind,"result");assert.equal(page.sealed,true);assert.equal(calls,1);
 assert.equal((await fetch(origin+"/executions/run/records",{headers:{...headers,"X-Roster-Session-Consumer":"other"}})).status,404);
 assert.equal((await fetch(origin+"/executions/run/records/ack",{method:"POST",headers,body:JSON.stringify({through:6})})).status,400);
 assert.equal((await fetch(origin+"/executions/run/records/ack",{method:"POST",headers,body:JSON.stringify({through:5})})).status,200);
 assert.equal(calls,1);
});

test("journal commit failure cannot become success even when an agent catches the logging error",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-journal-failed-"));t.after(()=>rm(dir,{recursive:true,force:true}));const storage=new FileRuntimeStorage(dir,"runtime");
 let agentCalls=0;
 const journal:SessionJournal={begin(){},append(_,record){if(record.id!=="engine.started")throw Error("disk unavailable");},seal(){},recover(){},page(){throw Error("unused");},acknowledge(){return 0;},close(){}};
 const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"test",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(_,ctx){agentCalls++;try{ctx.log("Must persist");}catch{}return Result.parse({status:"ok",summary:"Swallowed"});}}],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal);
 await runtime.initialize();await runtime.run({protocol:PROTOCOL,execution_id:"run",work_id:"work",agent_id:"agent",input:{},context:{request:"test",culture:"",history:[],knowledge:[]}},()=>{},()=>{},undefined,true,"core");
 assert.equal((await storage.get("run"))?.state,"attention");assert.match((await storage.get("run"))?.observation ?? "",/disk unavailable/);assert.equal(agentCalls,1);await runtime.close();await runtime.close();
});


test('Runtime process loss preserves original journal, records recovery once and never reexecutes', {timeout:30000}, async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-runtime-crash-'));
 let recoveredRuntime:RosterRuntime|undefined,recoveredJournal:SqliteSessionJournal|undefined;
 let recoveredServer:ReturnType<typeof createRuntimeApi>|undefined;
 t.after(async()=>{if(recoveredServer)await new Promise<void>(r=>recoveredServer!.close(()=>r()));if(recoveredRuntime)await recoveredRuntime.close();else recoveredJournal?.close();await rm(dir,{recursive:true,force:true});});
 const modules={storage:new URL('../src/infrastructure/filesystem.ts',import.meta.url).href,
  journal:new URL('../src/infrastructure/sqlite-session-journal.ts',import.meta.url).href,
  runtime:new URL('../src/application/runtime.ts',import.meta.url).href};
 const script=`
  import {FileRuntimeStorage} from ${JSON.stringify(modules.storage)};
  import {SqliteSessionJournal} from ${JSON.stringify(modules.journal)};
  import {RosterRuntime} from ${JSON.stringify(modules.runtime)};
  import {join} from 'node:path';
  const storage=new FileRuntimeStorage(process.argv[1],'runtime');
  const journal=new SqliteSessionJournal(join(process.argv[1],'journal.db'),'runtime');
  const agent={spec:{id:'agent',name:'Agent',description:'test',statuses:['ok'],events:[],skills:[],rules:[],capabilities:[]},
   async execute(_,ctx){ctx.log('Before process loss');await new Promise(()=>{});}};
  const runtime=new RosterRuntime('runtime',[agent],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},
   {create(){throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal);
  await runtime.initialize();
  setInterval(()=>{},1000);
  await runtime.run({protocol:${JSON.stringify(PROTOCOL)},execution_id:'crashed',work_id:'work',agent_id:'agent',input:{},
   context:{request:'test',culture:'',history:[],knowledge:[]}},frame=>{if(frame.type==='session' && frame.session.text==='Before process loss')process.stdout.write('READY');},()=>{},undefined,true,'core');
 `;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,dir],
  {stdio:['ignore','pipe','pipe'],env:{...process.env,OPENAI_API_KEY:''}});
 t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
 const exited=once(child,'exit');
 await new Promise<void>((resolve,reject)=>{
  child.once('error',reject);
  child.once('exit',()=>reject(Error('Fixture exited before its durable record')));
  child.stdout.on('data',chunk=>{if(String(chunk).includes('READY'))resolve();});
 });
 child.kill('SIGKILL');await exited;
 const storage=new FileRuntimeStorage(dir,'runtime');
 assert.equal((await storage.get('crashed'))?.state,'running');
 const journal=recoveredJournal=new SqliteSessionJournal(join(dir,'journal.db'),'runtime');
 const before=journal.page('crashed','core',0,100);
 assert.equal(before.sealed,false);assert.equal(before.entries.length,2);
 let calls=0;
 const agent={spec:{id:'agent',name:'Agent',description:'test',statuses:['ok'],events:[],skills:[],rules:[],capabilities:[]},
  async execute(){calls++;return Result.parse({status:'ok',summary:'Must not run'});}};
 const runtime=new RosterRuntime('runtime',[agent],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},
  {create(){throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal);
 recoveredRuntime=runtime;await runtime.initialize();
 assert.equal((await storage.get('crashed'))?.state,'attention');
 const after=journal.page('crashed','core',0,100);
 assert.deepEqual(after.entries.slice(0,2),before.entries);
 assert.equal(after.entries.length,3);assert.equal(after.sealed,true);
 assert.equal(after.entries[2].entry.id,'journal.recovered');
 assert.equal(after.entries.some(e=>e.entry.kind==='result' || e.entry.id==='engine.interrupted'),false);
 assert.equal(await storage.reserve('crashed'),false);
 await runtime.initialize();assert.deepEqual(journal.page('crashed','core',0,100),after);
 recoveredServer=createRuntimeApi(runtime,'private-recovery-test-token');
 recoveredServer.listen(0,'127.0.0.1');await once(recoveredServer,'listening');
 const origin=`http://127.0.0.1:${(recoveredServer.address() as {port:number}).port}`;
 const headers={Authorization:'Bearer private-recovery-test-token','Content-Type':'application/json',
  'X-Roster-Session-Consumer':'core','X-Roster-Service-Protocol':SESSION_DELIVERY};
 const response=await fetch(origin+'/executions/crashed/records',{headers});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),after);
 const foreign=await fetch(origin+'/executions/crashed/records',{headers:{...headers,'X-Roster-Session-Consumer':'other'}});
 assert.equal(foreign.status,404);await foreign.body?.cancel();
 for(let attempt=0;attempt<2;attempt++) {
  const ack=await fetch(origin+'/executions/crashed/records/ack',{method:'POST',headers,body:JSON.stringify({through:3})});
  assert.equal(ack.status,200);await ack.body?.cancel();
 }
 assert.equal(journal.page('crashed','core',0,100).acknowledged,3);assert.equal(calls,0);
});

test('Recovery observation and sealing roll back together on storage failure',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-journal-recovery-failure-'));
 const path=join(dir,'journal.db');
 const journal=new SqliteSessionJournal(path,'runtime');
 let db:DatabaseSync|undefined;
 t.after(async()=>{db?.close();journal.close();await rm(dir,{recursive:true,force:true});});
 journal.begin({execution_id:'run',work_id:'work',agent_id:'agent',consumer_id:'core'});
 const original={id:'original',kind:'log' as const,text:'Before restart',at:'2026-10-11T00:00:00Z'};
 journal.append('run',original);const before=journal.page('run','core',0,100);
 db=new DatabaseSync(path);
 db.exec("CREATE TRIGGER refuse_recovery BEFORE UPDATE OF sealed ON streams BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 assert.throws(()=>journal.recover());assert.deepEqual(journal.page('run','core',0,100),before);
 db.exec('DROP TRIGGER refuse_recovery');journal.recover();
 const recovered=journal.page('run','core',0,100);assert.equal(recovered.entries.length,2);
 assert.deepEqual(recovered.entries[0].entry,original);assert.equal(recovered.sealed,true);
 journal.recover();assert.deepEqual(journal.page('run','core',0,100),recovered);
});
