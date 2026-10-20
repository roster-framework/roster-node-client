import type {BaseMessage} from "@langchain/core/messages";
import type {LLMResult} from "@langchain/core/outputs";
import type {Serialized} from "@langchain/core/load/serializable";
import {reportedRequestID,reportedTokens,type ModelUsage} from "../domain/model-usage.js";

// SDK invocation callbacks do not observe provider retries inside the SDK. Keep
// those limits explicit; never retain messages, tools, credentials or errors.
export function modelUsageCallbacks(provider: string, model: string, publish: (usage: ModelUsage)=>void) {
  const phases=new Map<string,ModelUsage["phase"]>(),complete=new Set<string>();
  const snapshot=(id:string,state:ModelUsage["state"]):ModelUsage=>({version:1,invocation_id:id,provider,model,phase:phases.get(id)??"unknown",state,input_tokens:null,output_tokens:null,cached_input_tokens:null});
  return {
    name:"roster-model-usage",
    handleChatModelStart(_model:Serialized,_messages:BaseMessage[][],id:string,_parent?:string,_extra?:Record<string,unknown>,_tags?:string[],metadata?:Record<string,unknown>) {
      phases.set(id,metadata?.langgraph_node==="generate_structured_response" ? "final" : metadata?.langgraph_node==="agent" ? "loop" : "unknown");
    },
    handleLLMEnd(output:LLMResult,id:string) {
      if(complete.has(id))return;complete.add(id);
      const record=snapshot(id,"completed"),generation=output.generations[0]?.[0];
      const message=generation && "message" in generation ? generation.message as BaseMessage & {usage_metadata?:Record<string,any>} : undefined;
      const usage=message?.usage_metadata;
      record.input_tokens=reportedTokens(usage?.input_tokens);
      record.output_tokens=reportedTokens(usage?.output_tokens);
      record.cached_input_tokens=reportedTokens(usage?.input_token_details?.cache_read);
      const metadata=message?.response_metadata as Record<string,unknown> | undefined;
      record.provider_request_id=reportedRequestID(metadata?.request_id ?? metadata?.id);
      record.sdk_message_id=reportedRequestID(message?.id);
      publish(record);phases.delete(id);
    },
    handleLLMError(_error:unknown,id:string) {
      if(complete.has(id))return;complete.add(id);publish(snapshot(id,"failed"));phases.delete(id);
    },
  };
}
