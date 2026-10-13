import type {CoreExecutionAuthority,CoreConnection,ExecutionAudience} from "../domain/core-execution-authority.js";
import {ToolAccessRefusal} from "../domain/tool-access-refusal.js";
import {coreToolEndpoint,requireCoreToolResponse} from "./core-tool-access.js";
import {InvocationAuthority} from "@roster/contracts";
import {parseStrictJSON} from "./strict-json.js";

// Online current-execution introspection. This is not an offline signed lease.
export class HttpCoreExecutionAuthority implements CoreExecutionAuthority {
  readonly bindsRequest: boolean;
  // false is an explicit audience-only compatibility adapter, never fallback.
  constructor(private readonly requestBinding=true) {this.bindsRequest=requestBinding;}
  async verify(core:CoreConnection,expected:ExecutionAudience,signal:AbortSignal):Promise<void> {
    if(this.requestBinding&&!/^[a-f0-9]{64}$/.test(expected.requestSha256??""))throw new ToolAccessRefusal("execution_authority_mismatch");
    const timeout=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
    const response=await requireCoreToolResponse(()=>fetch(coreToolEndpoint(core.url,this.requestBinding?"/api/core/execution/authority":"/api/core/execution"),{
      headers:{Authorization:`Bearer ${core.token}`,Accept:"application/json"},redirect:"error",signal:timeout,
    }),signal);
    let value:unknown;
    try {
      if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))throw Error();
      const reader=response.body?.getReader();if(!reader)throw Error();
      const parts:Uint8Array[]=[];let length=0;
      try {
        while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>4096)throw Error();parts.push(item.value);}
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      value=parseStrictJSON(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts)),4096);
    }catch{signal.throwIfAborted();throw new ToolAccessRefusal("core_authority_unavailable");}
    if(this.requestBinding) {
      const parsed=InvocationAuthority.safeParse(value);
      if(!parsed.success)throw new ToolAccessRefusal("core_authority_unavailable");
      const record=parsed.data;
      if(record.execution_id!==expected.executionId||record.work_id!==expected.workId||record.runtime_id!==expected.runtimeId||record.agent_id!==expected.agentId||record.request_sha256!==expected.requestSha256)
        throw new ToolAccessRefusal("execution_authority_mismatch");
      return;
    }
    const record=value as Record<string,any>|null;
    const execution=record?.execution;
    if(!record||Array.isArray(record)||Object.keys(record).sort().join(",")!=="execution,revision,version"||
      record.version!==1||!Number.isSafeInteger(record.revision)||record.revision<0||
      !execution||Array.isArray(execution)||Object.keys(execution).sort().join(",")!=="id,state,target,work_id"||
      !execution.target||Array.isArray(execution.target)||Object.keys(execution.target).sort().join(",")!=="agent_id,runtime_id")
      throw new ToolAccessRefusal("core_authority_unavailable");
    if(execution.state!=="running"||execution.id!==expected.executionId||execution.work_id!==expected.workId||
      execution.target.runtime_id!==expected.runtimeId||execution.target.agent_id!==expected.agentId)
      throw new ToolAccessRefusal("execution_authority_mismatch");
  }
}
