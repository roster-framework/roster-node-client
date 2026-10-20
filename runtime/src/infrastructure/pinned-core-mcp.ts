import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {loadMcpTools} from "@langchain/mcp-adapters";
import type {AgentContext} from "../domain/agent.js";
import {ToolAccessRefusal} from "../domain/tool-access-refusal.js";
import {coreToolEndpoint,requireCoreToolResponse} from "./core-tool-access.js";

// Core credentials never follow transport redirects or SSE fallback endpoints.
// External author-configured MCP connections retain their independent adapter.
export async function pinnedCoreMcp(core: {url:string;token:string}, context: AgentContext) {
  const endpoint=coreToolEndpoint(core.url,"/mcp");
  const client=new Client({name:"roster-runtime-core",version:"1"});
  const transport=new StreamableHTTPClientTransport(endpoint,{
    requestInit:{headers:{Authorization:`Bearer ${core.token}`},redirect:"error"},
    reconnectionOptions:{maxRetries:0,maxReconnectionDelay:1000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1},
    fetch:async(url,init)=>{
      context.signal.throwIfAborted();
      await context.authorizeCoreConnection?.();
      try {
        const target=new URL(url instanceof Request?url.url:String(url));
        if(target.href!==endpoint.href) throw new ToolAccessRefusal("core_origin_untrusted");
        let response: Response;
        try {response=await fetch(target,{...init,redirect:"error",signal:AbortSignal.any([context.signal,...(init?.signal?[init.signal]:[])])});}
        catch {context.signal.throwIfAborted();throw new ToolAccessRefusal("core_authority_unavailable");}
        try {await context.authorizeCoreConnection?.();}
        catch(error){try{await response.body?.cancel();}catch{}throw error;}
        // A stateless MCP server may not offer the optional receive stream.
        if(init?.method==="GET"&&response.status===405){try{await response.body?.cancel();}catch{}return new Response(null,{status:405});}
        return await requireCoreToolResponse(async()=>response,context.signal);
      }catch(error){
        if(error instanceof ToolAccessRefusal) context.refuseCoreAccess?.(error.reason);
        throw error;
      }
    },
  });
  try {await client.connect(transport);}
  catch(error){await client.close().catch(()=>{});throw error;}
  return {
    getTools:async()=>{const tools=await loadMcpTools("roster-core",client);await context.authorizeCoreConnection?.();return tools;},
    close:()=>client.close(),
  };
}
