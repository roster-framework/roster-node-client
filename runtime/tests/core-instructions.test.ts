import assert from "node:assert/strict";
import {test} from "node:test";
import {Invocation} from "@roster/contracts";
import {coreInstructionPrompt} from "../src/infrastructure/core-instructions.js";

test("subscription instructions stay separate from persistent and runtime configuration",()=>{
 const input=Invocation.parse({protocol:"roster/0.1",execution_id:"run",work_id:"work",agent_id:"agent",input:{instruction:"wrong"},context:{request:"Task",culture:"",history:[],knowledge:[],subscription_delivery:{owner_member_id:"owner",recipient_member_id:"developer",signal:"complete",instruction:"Use supplied design",resource_ids:["figma"]}}});
 assert.match(coreInstructionPrompt(input),/Use supplied design/);
 assert.doesNotMatch(coreInstructionPrompt(input),/wrong/);
 assert.equal(input.context.core_instructions,undefined);
});

test("core instructions survive protocol validation without modifying the task or runtime settings",()=>{
 const request={protocol:"roster/0.1",execution_id:"run",work_id:"work",agent_id:"agent",input:{},context:{request:"Task",culture:"Culture",history:[],knowledge:[],core_instructions:{text:"Cite evidence",version:2,updated:"now",updated_by:"owner"}}};
 const input=Invocation.parse(request);
 assert.match(coreInstructionPrompt(input),/version 2/);
 assert.match(coreInstructionPrompt(input),/Cite evidence/);
 assert.equal(input.context.request,"Task");
 assert.deepEqual(input,request);
 assert.equal(coreInstructionPrompt(Invocation.parse({...request,context:{...request.context,core_instructions:undefined}})),"");
 assert.equal(coreInstructionPrompt(Invocation.parse({...request,context:{...request.context,core_instructions:{...request.context.core_instructions,text:""}}})),"");
});
