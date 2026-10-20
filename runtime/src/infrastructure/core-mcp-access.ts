import {coreToolEndpoint, requireCoreToolResponse} from "./core-tool-access.js";
import {McpToolUse,McpToolSelection,type McpToolSelectionSpec} from '@roster/contracts';
import {ToolAccessRefusal} from '../domain/tool-access-refusal.js';
import {parseStrictJSON} from './strict-json.js';

// Core owns MCP access decisions. The runtime asks again immediately before
// each external tool call, so a grant revoked during approval cannot be used.
export async function authorizeCoreMcpTool(
  core: { url: string; token: string },
  runtimeId: string,
  connectionId: string,
  toolName: string,
  signal: AbortSignal,
  revision: string,
) {
  const use=McpToolUse.safeParse({runtime_id:runtimeId,connection_id:connectionId,revision,tool_name:toolName});
  if(!use.success)throw new ToolAccessRefusal('execution_scope_denied');
  const url = coreToolEndpoint(core.url, "/api/core/mcp-authorizations");
  const response = await requireCoreToolResponse(() => fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${core.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(use.data),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  }), signal);
  try { await response.body?.cancel(); } catch { /* No response payload is needed. */ }
}

export async function selectCoreMcpTools(core:{url:string;token:string},query:McpToolSelectionSpec,signal:AbortSignal):Promise<string[]> {
  const request=McpToolSelection.safeParse(query);
  if(!request.success)throw new ToolAccessRefusal('execution_scope_denied');
  const response=await requireCoreToolResponse(()=>fetch(coreToolEndpoint(core.url,'/api/core/mcp-tool-selection'),{
    method:'POST',headers:{Authorization:`Bearer ${core.token}`,'Content-Type':'application/json'},
    body:JSON.stringify(request.data),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),
  }),signal);
  try {
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw Error();
    const reader=response.body?.getReader();if(!reader)throw Error();
    const parts:Uint8Array[]=[];let size=0;
    try { for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>256*1024)throw Error();parts.push(item.value);} }
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
    const result=McpToolSelection.parse(parseStrictJSON(text,256*1024));
    if(result.runtime_id!==request.data.runtime_id||result.connection_id!==request.data.connection_id||result.revision!==request.data.revision||result.tools.some(name=>!request.data.tools.includes(name)))throw Error();
    return result.tools;
  }catch{signal.throwIfAborted();throw new ToolAccessRefusal('core_authority_unavailable');}
}
