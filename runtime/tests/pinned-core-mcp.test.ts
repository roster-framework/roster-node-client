import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {pinnedCoreMcp} from "../src/infrastructure/pinned-core-mcp.js";
import {ToolAccessRefusal} from "../src/domain/tool-access-refusal.js";
import type {AgentContext} from "../src/domain/agent.js";

test("pinned Core MCP discovers/calls real tools and rechecks host trust before every HTTP request",async t=>{
  let calls=0,requests=0,checks=0,allow=true,revokeOnCall=false;
  const server=createServer(async(req,res)=>{
    requests++;
    if(req.method==="GET"){res.writeHead(405);res.end("private optional-stream body");return;}
    assert.equal(req.headers.authorization,"Bearer fixture-token");
    const mcp=new McpServer({name:"core-fixture",version:"1"});
    mcp.registerTool("read",{description:"Read",inputSchema:{}},async()=>{calls++;if(revokeOnCall)allow=false;return {content:[{type:"text",text:"allowed"}]};});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});await mcp.connect(transport);
    res.on("close",()=>{void transport.close();void mcp.close();});
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
    await transport.handleRequest(req,res,chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const port=(server.address() as {port:number}).port;
  const context:AgentContext={workspace:"",log:()=>{},signal:new AbortController().signal,
    authorizeCoreConnection:async()=>{checks++;if(!allow)throw new ToolAccessRefusal("core_origin_untrusted");}};
  const client=await pinnedCoreMcp({url:`http://127.0.0.1:${port}/mcp`,token:"fixture-token"},context);
  try{
    const tools=await client.getTools();assert.equal(tools.length,1);
    await tools[0]!.invoke({});assert.equal(calls,1);assert.ok(checks>=requests);
    allow=false;const before=requests;
    await assert.rejects(tools[0]!.invoke({}));assert.equal(calls,1);assert.equal(requests,before);
    allow=true;revokeOnCall=true;
    await assert.rejects(tools[0]!.invoke({}));assert.equal(calls,2);
  }finally{await client.close();}
});

test("pinned Core MCP never follows redirects or echoes denied server bodies",async t=>{
  let status=302,requests=0,targetCalls=0;const reasons:string[]=[];
  const server=createServer((req,res)=>{
    requests++;if(req.url==="/stolen")targetCalls++;
    res.writeHead(status,{Location:"/stolen","Content-Type":"text/plain"});res.end("private-core-body-token");
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const port=(server.address() as {port:number}).port;
  const ctx:AgentContext={workspace:"",log:()=>{},signal:new AbortController().signal,authorizeCoreConnection:async()=>{},
    refuseCoreAccess:reason=>{reasons.push(reason);throw new ToolAccessRefusal(reason);}};
  for(const [code,reason] of [[302,"core_authority_unavailable"],[401,"core_credential_rejected"],[403,"core_policy_denied"]] as const){
    status=code;const before=requests;
    await assert.rejects(pinnedCoreMcp({url:`http://127.0.0.1:${port}/mcp`,token:"private-scoped-token"},ctx),error=>{
      assert.ok(!String(error).includes("private-core-body-token"));assert.ok(!String(error).includes("private-scoped-token"));return true;
    });
    assert.equal(requests,before+1);assert.equal(targetCalls,0);assert.equal(reasons.at(-1),reason);
  }
});
