import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {PROTOCOL, Result} from "@roster/contracts";
import {localToolAllowed, localResourceSelection, localMcpToolSelection, validLocalToolPolicy, type LocalToolPolicy} from "../src/domain/local-tool-policy.js";
import {FileLocalToolPolicy} from "../src/infrastructure/local-tool-policy-file.js";
import {RosterRuntime} from "../src/application/runtime.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import type {AgentContext} from "../src/domain/agent.js";
import {fixtureMcpBinding} from './fixtures/mcp-binding.js';

const grant = {agentId:"agent",kind:"mcp" as const,target:"private",operation:"read"};
const policy: LocalToolPolicy = {version:1,revision:"owner-1",grants:[grant]};

test("host policy grants one exact agent/target/operation without wildcards or escalation",()=>{
  assert.ok(validLocalToolPolicy(policy)); assert.ok(localToolAllowed(policy,grant));
  for(const change of [{agentId:"other"},{kind:"resource" as const},{target:"other"},{operation:"password"}])
    assert.equal(localToolAllowed(policy,{...grant,...change}),false);
  for(const value of [{...policy,grants:[grant,grant]},{...policy,extra:true},{...policy,grants:[{...grant,operation:"*"}]},{...policy,version:2}])
    assert.equal(validLocalToolPolicy(value),false);
});

test("discovery excludes denied metadata and operations without modifying original Core descriptors",()=>{
  const selection: LocalToolPolicy={...policy,grants:[grant,{...grant,kind:"resource",target:"allowed"}]};
  const resources=[{id:"allowed",name:"Code",server_id:"local",resource_id:"code",component:"files",route:"proxy" as const,version:1,operations:["read","publish"]},
    {id:"private",name:"private-secret-location",server_id:"local",resource_id:"secret",component:"files",route:"proxy" as const,version:1,operations:["read"]}];
  const original=structuredClone(resources),out=localResourceSelection(selection,"agent",resources);
  assert.deepEqual(out,[{...resources[0],operations:["read"]}]);assert.deepEqual(resources,original);
  assert.ok(!JSON.stringify(out).includes("private-secret-location"));
  assert.deepEqual(localMcpToolSelection(selection,"agent","private",["read","password"]),["read"]);
  assert.deepEqual(localMcpToolSelection(selection,"other","private",["read"]),[]);
});

test("host file is reread for revocation and unreadable/malformed/oversized configuration fails closed",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-local-policy-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,"policy.json"),source=new FileLocalToolPolicy(path);
  await assert.rejects(source.current());
  await writeFile(path,JSON.stringify(policy));assert.ok(localToolAllowed(await source.current(),grant));
  await writeFile(path,JSON.stringify({...policy,revision:"owner-2",grants:[]}));assert.equal(localToolAllowed(await source.current(),grant),false);
  for(const body of ["{",JSON.stringify({...policy,unknown:"secret"})," ".repeat(65537)]) {
    await writeFile(path,body);await assert.rejects(source.current());
  }
});

test("denied resource and MCP calls are sticky, archived without arguments, and cannot override Core",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-local-policy-run-"));
  const path=join(dir,"policy.json");await writeFile(path,JSON.stringify({...policy,grants:[]}));
  let coreCalls=0,coreStatus=200,afterCheck=async()=>{};
  const server=createServer(async(req,res)=>{for await(const _ of req){} coreCalls++;await afterCheck();res.writeHead(coreStatus);res.end("{}");});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const storage=new FileRuntimeStorage(dir,"runtime"),journal=new SqliteSessionJournal(join(dir,"journal.db"),"runtime");
  const binding=await fixtureMcpBinding(dir,storage,'private');
  let call=(ctx:AgentContext)=>ctx.invokeResource!({id:"private",name:"password",arguments:{password:"never-logged"}});
  const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"test",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(_,ctx){try{await call(ctx);}catch{}return Result.parse({status:"ok",summary:"Swallowed"});}}],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal,undefined,undefined,undefined,new FileLocalToolPolicy(path),undefined,undefined,binding.service);
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});await runtime.initialize();
  const run=async(id:string)=>runtime.run({protocol:PROTOCOL,execution_id:id,work_id:"work",agent_id:"agent",input:{},context:{request:"test",culture:"",history:[],knowledge:[]}},()=>{},()=>{},{url:`http://127.0.0.1:${address.port}/mcp`,token:"fixture-token"},true,"core");
  await run("resource-denied");assert.equal(coreCalls,0);
  call=ctx=>ctx.authorizeMcpTool!("private","read",binding.revision);await run("mcp-denied");assert.equal(coreCalls,0);
  for(const id of ["resource-denied","mcp-denied"]) {
    assert.equal((await storage.get(id))?.state,"attention");
    const entries=journal.page(id,"core",0,100).entries;
    assert.ok(entries.some(e=>e.entry.kind==="decision"&&e.entry.text.includes("local_policy_denied")));
    assert.ok(!JSON.stringify(entries).includes("never-logged"));
  }
  await writeFile(path,JSON.stringify(policy));coreStatus=403;await run("core-denied");
  assert.equal(coreCalls,1);assert.equal((await storage.get("core-denied"))?.state,"attention");
  coreStatus=200;afterCheck=()=>writeFile(path,JSON.stringify({...policy,revision:"owner-2",grants:[]}));
  await run("revoked-during-core");assert.equal(coreCalls,2);
  assert.equal((await storage.get("revoked-during-core"))?.state,"attention");
  assert.match((await storage.get("revoked-during-core"))?.observation??"",/local_policy_denied/);
  afterCheck=async()=>{};await writeFile(path,JSON.stringify(policy));await run("allowed");
  assert.equal(coreCalls,3);assert.equal((await storage.get("allowed"))?.state,"completed");
  await writeFile(path,"{private malformed policy");await run("policy-unavailable");
  assert.equal(coreCalls,3);assert.equal((await storage.get("policy-unavailable"))?.state,"attention");
  assert.equal((await storage.get("policy-unavailable"))?.observation,"local_policy_unavailable");
  const original=journal.page("resource-denied","core",0,100);
  await runtime.close();
  const reopened=new SqliteSessionJournal(join(dir,"journal.db"),"runtime");
  try { assert.deepEqual(reopened.page("resource-denied","core",0,100),original); }
  finally { reopened.close(); }
});
