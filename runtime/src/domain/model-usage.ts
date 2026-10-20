export type ModelUsage = {
  version: 1;
  invocation_id: string;
  provider: string;
  model: string;
  phase: "loop" | "final" | "unknown";
  state: "completed" | "failed";
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  provider_request_id?: string;
  sdk_message_id?: string;
};

// Missing usage is unknown, never zero. Character estimates are not usage.
export function reportedTokens(value: unknown): number | null {
  return typeof value==="number" && Number.isSafeInteger(value) && value>=0 ? value : null;
}
export function reportedRequestID(value: unknown): string | undefined {
  return typeof value==="string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value) ? value : undefined;
}

// Project only declared telemetry fields. Arbitrary agent objects must not copy
// prompts, credentials or provider response payloads into the session archive.
export function modelUsageRecord(value: ModelUsage, at: string): import("./session-delivery.js").SessionRecord & {kind:"note"} {
  if(value.version!==1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.invocation_id) ||
     !value.provider?.trim() || value.provider.length>100 || !value.model?.trim() || value.model.length>200 ||
     !["loop","final","unknown"].includes(value.phase) || !["completed","failed"].includes(value.state) ||
     !Number.isFinite(Date.parse(at))) throw new Error("Invalid model usage report");
  for(const n of [value.input_tokens,value.output_tokens,value.cached_input_tokens])
    if(n!==null && reportedTokens(n)!==n) throw new Error("Invalid model usage token count");
  if(value.input_tokens!==null && value.cached_input_tokens!==null && value.cached_input_tokens>value.input_tokens)
    throw new Error("Cached input exceeds input tokens");
  for(const id of [value.provider_request_id,value.sdk_message_id])
    if(id!==undefined && reportedRequestID(id)!==id) throw new Error("Invalid model usage request ID");
  const usage={version:1,invocation_id:value.invocation_id,provider:value.provider,model:value.model,
    phase:value.phase,state:value.state,input_tokens:value.input_tokens,output_tokens:value.output_tokens,
    cached_input_tokens:value.cached_input_tokens,
    ...(value.provider_request_id ? {provider_request_id:value.provider_request_id}:{}),
    ...(value.sdk_message_id ? {sdk_message_id:value.sdk_message_id}:{}),at};
  return {id:"model-usage."+value.invocation_id,kind:"note",text:JSON.stringify({protocol:"roster-model-usage/1",usage}),at};
}
