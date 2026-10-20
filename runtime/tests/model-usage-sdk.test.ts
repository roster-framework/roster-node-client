import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {ChatOpenAI} from "@langchain/openai";
import {modelUsageCallbacks} from "../src/infrastructure/langchain-model-usage.js";
import {modelUsageRecord} from "../src/domain/model-usage.js";
import type {SessionRecord} from "../src/domain/session-delivery.js";

test("actual Node SDK callbacks publish typed usage from a local provider without input content",async t=>{
 let requests=0;
 const server=createServer(async(request,response)=>{
   for await(const _ of request) { /* Request contents are never telemetry. */ }
   requests++;
   response.writeHead(200,{"Content-Type":"application/json"});
   response.end(JSON.stringify({id:"chatcmpl_fixture",object:"chat.completion",created:1,model:"fixture",choices:[{index:0,message:{role:"assistant",content:"private response"},finish_reason:"stop"}],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15,prompt_tokens_details:{cached_tokens:7}}}));
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const records:SessionRecord[]=[],observer=modelUsageCallbacks("fixture","fixture",usage=>records.push(modelUsageRecord(usage,"2026-10-10T00:00:00Z")));
 const model=new ChatOpenAI({apiKey:"fixture-only",model:"fixture",maxRetries:0,configuration:{baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`}});
 await model.invoke("private request",{callbacks:[observer],metadata:{langgraph_node:"agent"}});
 assert.equal(requests,1);assert.equal(records.length,1);assert.equal(records[0]!.kind,"note");
 const report=JSON.parse(records[0]!.text).usage;
 assert.equal(report.input_tokens,12);assert.equal(report.output_tokens,3);assert.equal(report.cached_input_tokens,7);assert.equal(report.phase,"loop");
 assert.ok(!JSON.stringify(records).includes("private"));assert.ok(!JSON.stringify(records).includes("fixture-only"));
});
