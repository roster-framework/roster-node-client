import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PROTOCOL, Result} from "@roster/contracts";
import {ToolAccessRefusal} from "../src/domain/tool-access-refusal.js";
import {coreToolEndpoint, requireCoreToolResponse} from "../src/infrastructure/core-tool-access.js";
import {RosterRuntime} from "../src/application/runtime.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import type {AgentContext} from "../src/domain/agent.js";
import type {RuntimeFrame} from "../src/domain/session.js";
import {fixtureMcpBinding} from './fixtures/mcp-binding.js';

test("Core access errors never echo URL credentials, transport diagnostics or denied response bodies",async()=>{
  for(const url of ["not a URL private-credential", "https://private-user:private-password@example.com/mcp",
    "http://private.example/mcp", "https://example.com/mcp?token=private-token", "https://example.com/other"])
    assert.throws(()=>coreToolEndpoint(url,"/api/core/mcp-authorizations"),
      error=>error instanceof ToolAccessRefusal && error.message==="core_authority_unavailable");
  assert.equal(coreToolEndpoint("https://company.example/mcp","/api/core/mcp-authorizations").origin,"https://company.example");
  await assert.rejects(requireCoreToolResponse(async()=>{throw Error("private-token private-url private-body");},new AbortController().signal),
    error=>error instanceof ToolAccessRefusal && error.message==="core_authority_unavailable");
  for(const [status,reason] of [[401,"core_credential_rejected"],[403,"core_policy_denied"],[429,"core_authority_unavailable"],[503,"core_authority_unavailable"]] as const)
    await assert.rejects(requireCoreToolResponse(async()=>new Response("private-body",{status}),new AbortController().signal),
      error=>error instanceof ToolAccessRefusal && error.reason===reason);
  const controller=new AbortController(),cancelled=Error("cancelled");controller.abort(cancelled);
  await assert.rejects(requireCoreToolResponse(async()=>{throw Error("private-transport");},controller.signal),error=>error===cancelled);
});

test("managed Core refusals commit a safe decision before the agent catches them and survive reopen",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-core-refusal-"));
  let status=403,requests=0;
  const server=createServer(async(req,res)=>{
    for await(const _ of req){}requests++;
    res.writeHead(status,{"Content-Type":"application/json",...(status===302?{Location:"/credential-target"}:{})});res.end('{"error":"private-body-secret"}');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const storage=new FileRuntimeStorage(dir,"runtime"),journalPath=join(dir,"journal.db");
  const binding=await fixtureMcpBinding(dir,storage);
  const journal=new SqliteSessionJournal(journalPath,"runtime");
  const resource={id:"code",name:"Code",server_id:"local",resource_id:"code",component:"files",route:"proxy" as const,version:1,operations:["read"]};
  let mode="",reason="",caught=0;
  const frames:RuntimeFrame[]=[];
  const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"test",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(input,ctx:AgentContext){
    try {
      if(mode.startsWith("resource")||mode==="scope-denied")await ctx.invokeResource!({id:mode==="scope-denied"?"unavailable":"code",name:"read",arguments:{password:"private-argument-secret"}});
      else await ctx.authorizeMcpTool!("files","read",binding.revision);
    }catch{
      caught++;
      assert.ok(ctx.signal.aborted);
      const decisions=journal.page(input.execution_id,"core",0,100).entries.filter(e=>e.entry.kind==="decision");
      assert.equal(decisions.length,1,"refusal must already be committed before returning to author code");
      assert.match(decisions[0]!.entry.id,/^tool-denial\.[a-f0-9-]{36}$/);
      assert.deepEqual(JSON.parse(decisions[0]!.entry.text),{protocol:"roster-core-tool-denial/1",reason});
    }
    return Result.parse({status:"ok",summary:"Caught the exception"});
  }}],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal,undefined,undefined,undefined,undefined,undefined,undefined,binding.service);
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
  await runtime.initialize();
  const cases=[
    ["mcp-forbidden",403,"core_policy_denied",true],
    ["resource-forbidden",403,"core_policy_denied",true],
    ["credential-rejected",401,"core_credential_rejected",true],
    ["resource-authority-down",503,"core_authority_unavailable",true],
    ["resource-redirect",302,"core_authority_unavailable",true],
    ["scope-denied",200,"execution_scope_denied",false],
    ["credential-missing",200,"core_credential_missing",false],
  ] as const;
  for(const item of cases){
    [mode,status,reason]=item;
    const before=requests;
    await runtime.run({protocol:PROTOCOL,execution_id:mode,work_id:"original-work",agent_id:"agent",input:{},context:{request:"private-request-secret",culture:"",history:[],knowledge:[],resources:[resource]}},frame=>frames.push(frame),()=>{},
      mode==="credential-missing"?undefined:{url:`http://127.0.0.1:${address.port}/mcp`,token:"private-credential-secret"},true,"core");
    assert.equal(requests,before+(item[3]?1:0));
    const receipt=await storage.get(mode);
    assert.equal(receipt?.state,"attention");assert.equal(receipt?.observation,reason);
  }
  assert.equal(caught,cases.length);
  const original=journal.page("resource-forbidden","core",0,100);
  for(const secret of ["private-body-secret","private-argument-secret","private-credential-secret","private-request-secret","private-password-secret"])
    assert.ok(!JSON.stringify(frames).includes(secret));
  await runtime.close();
  const reopened=new SqliteSessionJournal(journalPath,"runtime");
  try{assert.deepEqual(reopened.page("resource-forbidden","core",0,100),original);assert.equal(original.work_id,"original-work");}
  finally{reopened.close();}
});
