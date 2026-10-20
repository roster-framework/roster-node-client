import {test} from "node:test";
import assert from "node:assert/strict";
import {AIMessage} from "@langchain/core/messages";
import {modelUsageCallbacks} from "../src/infrastructure/langchain-model-usage.js";
import {reportedTokens,type ModelUsage} from "../src/domain/model-usage.js";
import {modelInputSizes} from "../src/domain/model-input-size.js";

test("usage is reported once per invocation, with unknown distinct from zero and no private payload",()=>{
 const records:ModelUsage[]=[],observer=modelUsageCallbacks("fixture","test-model",v=>records.push(v));
 observer.handleChatModelStart({lc:1,type:"not_implemented",id:[]},[],"run",undefined,undefined,undefined,{langgraph_node:"agent"});
 const output={generations:[[{text:"private text",message:new AIMessage({content:"private text",id:"request_123",usage_metadata:{input_tokens:15,output_tokens:0,total_tokens:15,input_token_details:{cache_read:10}},response_metadata:{secret:"Bearer private-key"}})}]]};
 observer.handleLLMEnd(output,"run");observer.handleLLMEnd(output,"run");observer.handleLLMError(Error("secret error"),"run");
 observer.handleLLMEnd({generations:[[{text:"unknown"}]],llmOutput:{estimatedTokenUsage:{promptTokens:99}}},"unknown");
 observer.handleLLMError(Error("Bearer secret"),"failed");
 assert.equal(records.length,3);assert.deepEqual([records[0].phase,records[0].input_tokens,records[0].output_tokens,records[0].cached_input_tokens,records[0].sdk_message_id],["loop",15,0,10,"request_123"]);
 assert.equal(records[0].provider_request_id,undefined,"SDK message IDs are not provider request IDs");
 assert.equal(records[1].input_tokens,null);assert.equal(records[2].state,"failed");assert.equal(records[2].output_tokens,null);
 assert.ok(!JSON.stringify(records).includes("private"));assert.ok(!JSON.stringify(records).includes("secret"));
 for(const value of [undefined,null,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,"10"])assert.equal(reportedTokens(value),null);
});

test("input diagnostics count UTF-8 bytes without copying content or presenting billed tokens",()=>{
 const parts={instructions:"private instruction",request:"한글",history:[],resources:[{id:"one"}]};
 const before=structuredClone(parts),sizes=modelInputSizes(parts);
 assert.equal(sizes.request,6);assert.equal(sizes.history,2);
 assert.equal(sizes.resources,Buffer.byteLength(JSON.stringify(parts.resources)));
 assert.deepEqual(parts,before);assert.ok(!JSON.stringify(sizes).includes("private instruction"));
});
