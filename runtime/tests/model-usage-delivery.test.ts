import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PROTOCOL,Result} from "@roster/contracts";
import {RosterRuntime} from "../src/application/runtime.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import {modelUsageRecord,type ModelUsage} from "../src/domain/model-usage.js";
import type {RuntimeFrame} from "../src/domain/session.js";

const usage:ModelUsage={version:1,invocation_id:"loop-1",provider:"fixture",model:"small",phase:"loop",state:"completed",input_tokens:10,output_tokens:0,cached_input_tokens:5,sdk_message_id:"sdk_1"};

test("typed usage contains only declared metadata and rejects invalid reports",()=>{
 const entry=modelUsageRecord({...usage,prompt:"private",credential:"secret"} as ModelUsage,"2026-10-10T00:00:00Z");
 assert.equal(entry.id,"model-usage.loop-1");assert.equal(entry.kind,"note");assert.ok(!entry.text.includes("private")&&!entry.text.includes("secret"));
 assert.equal(JSON.parse(entry.text).usage.sdk_message_id,"sdk_1");
 for(const bad of [{...usage,input_tokens:-1},{...usage,output_tokens:undefined},{...usage,cached_input_tokens:11},{...usage,invocation_id:"bad/id"}])
   assert.throws(()=>modelUsageRecord(bad as ModelUsage,"2026-10-10T00:00:00Z"));
});

test("Runtime usage is durable, deduplicated, bound to original work and preserved on reopen",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-usage-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const storage=new FileRuntimeStorage(dir,"runtime"),path=join(dir,"journal.db"),journal=new SqliteSessionJournal(path,"runtime");
 const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"test",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(_,ctx){ctx.recordModelUsage!(usage);ctx.recordModelUsage!({...usage});return Result.parse({status:"ok",summary:"Done"});}}],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal);
 await runtime.initialize();const frames:RuntimeFrame[]=[];const emittedAfterCommit:boolean[]=[];
 await runtime.run({protocol:PROTOCOL,execution_id:"run",work_id:"work",agent_id:"agent",input:{},context:{request:"test",culture:"",history:[],knowledge:[]}},f=>{
   if(f.type==="session") emittedAfterCommit.push(journal.page("run","core",0,100).entries.some(e=>e.entry.id===f.session.id));frames.push(f);
 },()=>{},undefined,true,"core");
 const page=journal.page("run","core",0,100);assert.equal(page.entries.length,4);assert.equal(page.work_id,"work");assert.equal(page.sealed,true);
 assert.deepEqual(emittedAfterCommit,[true,true,true]);
 assert.equal(page.entries.filter(e=>e.entry.id==="model-usage.loop-1").length,1);
 assert.equal(frames.filter(f=>f.type==="session").length,3);assert.equal((await storage.get("run"))?.state,"completed");
 await runtime.close();const reopened=new SqliteSessionJournal(path,"runtime");assert.deepEqual(reopened.page("run","core",0,100),page);reopened.close();
});

test("caught conflicting usage cannot become a successful execution",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"roster-usage-conflict-"));t.after(()=>rm(dir,{recursive:true,force:true}));const storage=new FileRuntimeStorage(dir,"runtime");
 const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"test",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(_,ctx){ctx.recordModelUsage!(usage);try{ctx.recordModelUsage!({...usage,input_tokens:20});}catch{}return Result.parse({status:"ok",summary:"Swallowed"});}}],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]});
 await runtime.initialize();await runtime.run({protocol:PROTOCOL,execution_id:"run",work_id:"work",agent_id:"agent",input:{},context:{request:"test",culture:"",history:[],knowledge:[]}},()=>{});
 assert.equal((await storage.get("run"))?.state,"attention");assert.match((await storage.get("run"))?.observation??"",/conflict/);await runtime.close();
});
