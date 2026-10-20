import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {ManagedAgent,PROTOCOL,Result} from "@roster/contracts";
import {managedImplementation} from "../src/infrastructure/langchain-managed.js";
import {localMcpToolSelection,type LocalToolPolicy} from "../src/domain/local-tool-policy.js";
import {RosterRuntime} from "../src/application/runtime.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {fixtureMcpBinding} from './fixtures/mcp-binding.js';

test("real MCP discovery hides denied tool names/descriptions from both model phases",async t=>{
  const requests:Record<string,any>[]=[];let toolCalls=0;
  const expected={status:"success",summary:"Done",output:"Done",event:"complete"};
  const model=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
    const structured=(body.tools??[]).map((v:any)=>v.function).find((v:any)=>v.parameters?.properties?.status);
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({id:"fixture",object:"chat.completion",created:1,model:body.model,
      choices:[{index:0,message:{role:"assistant",content:structured?null:JSON.stringify(expected),
        ...(structured?{tool_calls:[{id:"result",type:"function",function:{name:structured.name,arguments:JSON.stringify(expected)}}]}:{})},finish_reason:structured?"tool_calls":"stop"}],
      usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}}));
  });
  const mcpHTTP=createServer(async(req,res)=>{
    const mcp=new McpServer({name:"fixture",version:"1"});
    for(const [name,description] of [["read","Read allowed code"],["password","private-password-tool-description"]]) {
      mcp.registerTool(name!,{description,inputSchema:{}},async()=>{toolCalls++;return {content:[{type:"text",text:"fixture"}]};});
    }
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    await mcp.connect(transport);res.on("close",()=>{void transport.close();void mcp.close();});
    try {const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const raw=Buffer.concat(chunks);await transport.handleRequest(req,res,raw.length?JSON.parse(raw.toString()):undefined);}
    catch {if(!res.headersSent)res.writeHead(500);res.end();}
  });
  for(const s of [model,mcpHTTP]) {s.listen(0,"127.0.0.1");await once(s,"listening");}
  t.after(async()=>{for(const s of [model,mcpHTTP]) {s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
  const policy:LocalToolPolicy={version:1,revision:"owner-1",grants:[{agentId:"reviewer",kind:"mcp",target:"private",operation:"read"}]};
  const config=ManagedAgent.parse({id:"reviewer",name:"Reviewer",kind:"llm",model:"fixture",credential_env:"",base_url:`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`,instructions:"Review",mcp_ids:["private"],events:["complete"],model_parameters:{maxRetries:0}});
  await managedImplementation(config,[{id:"private",name:"Private",url:`http://127.0.0.1:${(mcpHTTP.address() as {port:number}).port}/mcp`}]).execute(
    {protocol:PROTOCOL,execution_id:"run",work_id:"work",agent_id:"reviewer",input:{},context:{request:"Review",culture:"",history:[],knowledge:[]}},
    {workspace:"",signal:new AbortController().signal,log:()=>{},visibleMcpTools:async(id,names)=>localMcpToolSelection(policy,"reviewer",id,names)});
  assert.equal(requests.length,2);assert.equal(toolCalls,0);
  assert.ok(requests[0]!.tools.some((tool:any)=>tool.function.name.includes("read")));
  assert.ok(!JSON.stringify(requests).includes("password"));
});

test("Runtime exposes filtered resource context and live MCP discovery while preserving Core input",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-discovery-")),storage=new FileRuntimeStorage(dir,"runtime");
  const binding=await fixtureMcpBinding(dir,storage,'private',['read','password']);
  let selections=0;
  const core=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));
    const query=JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url,'/api/core/mcp-tool-selection');assert.equal(req.headers.authorization,'Bearer scoped-token');
    assert.deepEqual(query.tools,['read']);assert.equal(query.revision,binding.revision);selections++;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(query));
  });
  core.listen(0,'127.0.0.1');await once(core,'listening');
  const policy:LocalToolPolicy={version:1,revision:"owner-1",grants:[{agentId:"agent",kind:"resource",target:"code",operation:"read"},{agentId:"agent",kind:"mcp",target:"private",operation:"read"}]};
  const input={protocol:PROTOCOL,execution_id:"run",work_id:"work",agent_id:"agent",input:{},context:{request:"Review",culture:"",history:[],knowledge:[],resources:[
    {id:"code",name:"Code",server_id:"local",resource_id:"code",component:"files",route:"proxy" as const,version:1,operations:["read","publish"]},
    {id:"secret",name:"private-secret-location",server_id:"local",resource_id:"secret",component:"files",route:"proxy" as const,version:1,operations:["read"]}]}};
  const original=structuredClone(input);let executed=0;
  const runtime=new RosterRuntime("runtime",[{spec:{id:"agent",name:"Agent",description:"fixture",statuses:["ok"],events:[],skills:[],rules:[],capabilities:[]},async execute(received,ctx){
    executed++;assert.deepEqual(ctx.resources,[{...input.context.resources[0],operations:["read"]}]);
    assert.ok(!JSON.stringify(received).includes("private-secret-location"));
    assert.deepEqual(await ctx.visibleMcpTools!("private",["read","password"],binding.revision),["read"]);
    policy.grants=[];assert.deepEqual(await ctx.visibleMcpTools!("private",["read"],binding.revision),[]);
    return Result.parse({status:"ok",summary:"Done"});
  }}],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,undefined,undefined,undefined,undefined,{current:async()=>policy},undefined,undefined,binding.service);
  t.after(async()=>{await runtime.close();core.closeAllConnections();await new Promise<void>(r=>core.close(()=>r()));await rm(dir,{recursive:true,force:true});});await runtime.initialize();await runtime.run(input,()=>{},()=>{},{url:`http://127.0.0.1:${(core.address() as {port:number}).port}/mcp`,token:'scoped-token'});
  assert.equal(executed,1);assert.equal(selections,1);assert.equal((await storage.get("run"))?.state,"completed");assert.deepEqual(input,original);
});
