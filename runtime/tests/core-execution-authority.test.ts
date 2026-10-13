import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PROTOCOL,Result} from "@roster/contracts";
import {HttpCoreExecutionAuthority} from "../src/infrastructure/core-execution-authority.js";
import {RosterRuntime} from "../src/application/runtime.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import type {AgentContext} from "../src/domain/agent.js";

const expected={executionId:"run",workId:"work",runtimeId:"runtime",agentId:"agent"};
const original=()=>({version:1,revision:1,execution:{id:"run",work_id:"work",state:"running",target:{runtime_id:"runtime",agent_id:"agent"}}});

test("Core audience introspection pins transport and rejects malformed, excessive and wrong execution responses",async t=>{
  let value:unknown=original(),status=200,type="application/json",targetCalls=0;
  const server=createServer((req,res)=>{
    if(req.url==="/stolen")targetCalls++;
    assert.equal(req.url,"/api/core/execution");assert.equal(req.headers.authorization,"Bearer private-token");
    res.writeHead(status,{"Content-Type":type,Location:"/stolen"});res.end(typeof value==="string"?value:JSON.stringify(value));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const core={url:`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`,token:"private-token"};
  const verifier=new HttpCoreExecutionAuthority(false),signal=new AbortController().signal;
  await verifier.verify(core,expected,signal);
  for(const patch of [{id:"other"},{work_id:"other"},{state:"completed"},{target:{runtime_id:"other",agent_id:"agent"}},{target:{runtime_id:"runtime",agent_id:"other"}}]){
    value={...original(),execution:{...original().execution,...patch}};
    await assert.rejects(verifier.verify(core,expected,signal),/^ToolAccessRefusal: execution_authority_mismatch$/);
  }
  for(const malformed of [null,{}, {...original(),version:2},{...original(),revision:-1},{...original(),extra:"private-value"},
    {...original(),execution:{...original().execution,extra:true}},"{private-invalid"," ".repeat(4097)]){
    value=malformed;await assert.rejects(verifier.verify(core,expected,signal),/^ToolAccessRefusal: core_authority_unavailable$/);
  }
  value=original();type="text/html";await assert.rejects(verifier.verify(core,expected,signal),/^ToolAccessRefusal: core_authority_unavailable$/);
  type="application/json";value={private:"private-response"};
  for(const [code,reason] of [[401,"core_credential_rejected"],[403,"core_policy_denied"],[302,"core_authority_unavailable"],[503,"core_authority_unavailable"]]){
    status=Number(code);await assert.rejects(verifier.verify(core,expected,signal),new RegExp(`^ToolAccessRefusal: ${reason}$`));
  }
  assert.equal(targetCalls,0);
});

test("required authority blocks before author execution and durably latches revocation during managed access",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-audience-")),storage=new FileRuntimeStorage(dir,"runtime"),journalPath=join(dir,"journal.db"),journal=new SqliteSessionJournal(journalPath,"runtime");
  let state="running",workId="work",runtimeId="runtime",agentId="agent",id="run",requests=0,afterRequest=()=>{};
  const server=createServer((req,res)=>{
    requests++;assert.equal(req.url,"/api/core/execution");
    const record={version:1,revision:requests,execution:{id,work_id:workId,state,target:{runtime_id:runtimeId,agent_id:agentId}}};
    afterRequest();res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(record));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  let workspaces=0,authors=0,mode="",trust=true;
  const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"Fixture",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(input,ctx:AgentContext){
    authors++;
    if(mode==="revoke"){
      state="completed";
      try{await ctx.authorizeCoreConnection!();assert.fail("revocation accepted");}catch{
        assert.ok(ctx.signal.aborted);
        assert.equal(journal.page(input.execution_id,"core",0,100).entries.filter(e=>e.entry.kind==="decision").length,1);
      }
    }
    return Result.parse({status:"ok",summary:"done"});
  }}],storage,storage,{create:async(a,e)=>{workspaces++;if(mode==="workspace-revoke")state="completed";return storage.create(a,e);}},
    {execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal,undefined,undefined,undefined,undefined,
    {current:async()=>({version:1,revision:"owner",grants:trust?[{agentId:"agent",origin}]:[]})},new HttpCoreExecutionAuthority(false));
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  await runtime.initialize();
  const run=async(name:string,missing=false)=>{
    id=name;const frames:unknown[]=[];
    await runtime.run({protocol:PROTOCOL,execution_id:name,work_id:"work",agent_id:"agent",input:{secret:"private-input"},context:{request:"private-request",culture:"",history:[],knowledge:[]}},f=>frames.push(f),()=>{},missing?undefined:{url:origin+"/mcp",token:"private-token"},true,"core");
    for(const secret of ["private-token","private-input","private-request"])assert.ok(!JSON.stringify(frames).includes(secret));
    return storage.get(name);
  };
  assert.equal((await run("allowed"))?.state,"completed");assert.equal(authors,1);assert.equal(workspaces,1);
  const before=requests;assert.equal((await run("missing",true))?.observation,"core_credential_missing");assert.equal(requests,before);
  for(const mismatch of ["work","runtime","agent","state"]){
    workId=mismatch==="work"?"other":"work";runtimeId=mismatch==="runtime"?"other":"runtime";agentId=mismatch==="agent"?"other":"agent";state=mismatch==="state"?"completed":"running";
    assert.equal((await run(mismatch))?.observation,"execution_authority_mismatch");
  }
  assert.equal(authors,1);assert.equal(workspaces,1);
  workId="work";runtimeId="runtime";agentId="agent";state="running";mode="workspace-revoke";
  assert.equal((await run("workspace"))?.observation,"execution_authority_mismatch");assert.equal(authors,1);
  state="running";mode="revoke";assert.equal((await run("revoked"))?.state,"attention");assert.equal(authors,2);
  state="running";mode="";afterRequest=()=>{trust=false;};
  assert.equal((await run("trust-revoked"))?.observation,"core_origin_untrusted");assert.equal(authors,2);
  const page=journal.page("revoked","core",0,100);assert.equal(page.work_id,"work");
  assert.deepEqual(JSON.parse(page.entries.find(e=>e.entry.kind==="decision")!.entry.text),{protocol:"roster-core-tool-denial/1",reason:"execution_authority_mismatch"});
  await runtime.close();const reopened=new SqliteSessionJournal(journalPath,"runtime");
  try{assert.deepEqual(reopened.page("revoked","core",0,100),page);}finally{reopened.close();}
});
