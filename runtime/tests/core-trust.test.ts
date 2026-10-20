import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {DynamicStructuredTool} from "@langchain/core/tools";
import {z} from "zod";
import {PROTOCOL,Result} from "@roster/contracts";
import {coreOriginTrusted,validCoreTrustPolicy,type CoreTrustPolicy} from "../src/domain/core-trust.js";
import {FileCoreTrust} from "../src/infrastructure/core-trust-file.js";
import {approvalTools} from "../src/infrastructure/approval-tools.js";
import {RosterRuntime} from "../src/application/runtime.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import type {AgentContext} from "../src/domain/agent.js";
import {fixtureMcpBinding} from './fixtures/mcp-binding.js';

test("host Core trust pins an exact origin and agent; remote Core has no implicit trust",()=>{
  const p:CoreTrustPolicy={version:1,revision:"owner-1",grants:[{agentId:"agent",origin:"https://company.example"}]};
  assert.ok(validCoreTrustPolicy(p));assert.ok(coreOriginTrusted(p,"agent","https://company.example/mcp"));
  for(const endpoint of ["https://company.example:8443/mcp","https://company.example.evil/mcp","http://company.example/mcp",
    "https://user:password@company.example/mcp","https://company.example/mcp?token=secret"])
    assert.equal(coreOriginTrusted(p,"agent",endpoint),false);
  assert.equal(coreOriginTrusted(p,"other","https://company.example/mcp"),false);
  assert.equal(coreOriginTrusted(undefined,"agent","https://company.example/mcp"),false);
  assert.ok(coreOriginTrusted(undefined,"agent","http://127.0.0.1:7330/mcp"));
  assert.equal(coreOriginTrusted({...p,grants:[]},"agent","http://127.0.0.1:7330/mcp"),false);
  for(const value of [{...p,extra:true},{...p,grants:[...p.grants,...p.grants]},
    {...p,grants:[{agentId:"*",origin:"https://company.example"}]},
    ...["https://company.example/","https://company.example:443","http://remote.example","https://user:password@company.example","https://company.example/path"].map(origin=>({...p,grants:[{agentId:"agent",origin}]}))])
    assert.equal(validCoreTrustPolicy(value),false);
});

test("owner trust file rereads replacements and reports safe failure for missing, malformed and oversized files",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-core-trust-file-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,"private-owner-path.json"),source=new FileCoreTrust(path);
  await assert.rejects(source.current(),/^Error: Core trust policy unavailable$/);
  const p:CoreTrustPolicy={version:1,revision:"owner-1",grants:[{agentId:"agent",origin:"https://company.example"}]};
  await writeFile(path,JSON.stringify(p));assert.deepEqual(await source.current(),p);
  await writeFile(path,JSON.stringify({...p,grants:[]}));assert.equal((await source.current()).grants.length,0);
  for(const body of ["{private-password", " ".repeat(65537),JSON.stringify({...p,unexpected:"private-key"})]){
    await writeFile(path,body);await assert.rejects(source.current(),/^Error: Core trust policy unavailable$/);
  }
});

test("Runtime rejects untrusted Core before workspace or agent code, then rechecks managed calls and approvals",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-core-trust-run-")),path=join(dir,"trust.json");
  const storage=new FileRuntimeStorage(dir,"runtime"),journalPath=join(dir,"journal.db"),journal=new SqliteSessionJournal(journalPath,"runtime");
  const binding=await fixtureMcpBinding(dir,storage);
  let requests=0,afterCore=async()=>{};
  const server=createServer(async(req,res)=>{for await(const _ of req){}requests++;await afterCore();res.writeHead(200,{"Content-Type":"application/json"});res.end("{}");});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const origin=`http://127.0.0.1:${address.port}`,policy:CoreTrustPolicy={version:1,revision:"owner-1",grants:[{agentId:"agent",origin}]};
  const save=(p:CoreTrustPolicy)=>writeFile(path,JSON.stringify(p));await save(policy);
  let executed=0,workspaces=0,mode="allowed",sideEffects=0;
  const action=new DynamicStructuredTool({name:"read",description:"Read",schema:z.object({}),func:async()=>{sideEffects++;return "done";}});
  const agents=["agent","other"].map(id=>({spec:{id,name:id,description:"fixture",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(input: any,ctx:AgentContext){
    executed++;
    assert.ok(Object.isFrozen(ctx.coreMcp));
    if(mode==="approval-revoked"){
      const wrapper={...ctx,approveTool:async()=>{await save({...policy,grants:[]});}};
      try{await approvalTools([action],{mode:"all"},wrapper,"roster-core")[0]!.invoke({});}catch{}
    }else{
      if(mode==="revoked")await save({...policy,grants:[]});
      if(mode==="unavailable")await writeFile(path,"{private-password");
      try{await ctx.authorizeMcpTool!("files","read",binding.revision);}catch{}
    }
    return Result.parse({status:"ok",summary:"done"});
  }}));
  const runtime=new RosterRuntime("runtime",agents,storage,storage,{create:async(a,e)=>{workspaces++;return storage.create(a,e);}},
    {execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal,undefined,undefined,undefined,undefined,new FileCoreTrust(path),undefined,binding.service);
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
  await runtime.initialize();
  const resource={id:"code",name:"Code",server_id:"local",resource_id:"code",component:"files",route:"proxy" as const,version:1,operations:["read"]};
  const run=async(id:string,agent="agent",url=origin+"/mcp")=>runtime.run({protocol:PROTOCOL,execution_id:id,work_id:"work",agent_id:agent,input:{},context:{request:"private-request",culture:"",history:[],knowledge:[],resources:[resource]}},()=>{},()=>{},{url,token:"private-token"},true,"core");
  await run("wrong-origin","agent","https://untrusted.example/mcp");
  await run("wrong-agent","other");
  await run("invalid-url","agent",`http://user:private-password@127.0.0.1:${address.port}/mcp`);
  assert.equal(executed,0);assert.equal(workspaces,0);assert.equal(requests,0);
  for(const id of ["wrong-origin","wrong-agent","invalid-url"]){
    assert.equal((await storage.get(id))?.observation,"core_origin_untrusted");
    assert.ok(journal.page(id,"core",0,100).entries.some(e=>e.entry.kind==="decision"&&e.entry.text.includes("core_origin_untrusted")));
  }
  await run("allowed");assert.equal((await storage.get("allowed"))?.state,"completed");assert.equal(requests,1);
  mode="revoked";await run("revoked");assert.equal(requests,1);
  assert.equal((await storage.get("revoked"))?.observation,"core_origin_untrusted");
  await save(policy);mode="unavailable";await run("unavailable");assert.equal(requests,1);
  assert.equal((await storage.get("unavailable"))?.observation,"core_trust_unavailable");
  await save(policy);mode="approval-revoked";await run("approval-revoked");assert.equal(sideEffects,0);
  assert.equal((await storage.get("approval-revoked"))?.state,"attention");
  await save(policy);mode="allowed";afterCore=()=>save({...policy,grants:[]});await run("revoked-during-core");
  assert.equal(requests,2);assert.equal((await storage.get("revoked-during-core"))?.observation,"core_origin_untrusted");
  const original=journal.page("wrong-origin","core",0,100);assert.ok(!JSON.stringify(original).includes("private-password"));
  await runtime.close();const reopened=new SqliteSessionJournal(journalPath,"runtime");
  try{assert.deepEqual(reopened.page("wrong-origin","core",0,100),original);}finally{reopened.close();}
});
