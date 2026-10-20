import test from "node:test";
import assert from "node:assert/strict";
import { managedOutput } from "../src/infrastructure/delegation.js";
const scope = {max_steps:12,candidates:[{member_id:"dev",name:"Dev",accept:["ok"]},{member_id:"reviewer",name:"Reviewer",accept:null}]};
test("delegation preserves explicit completion gates and human steps", () => {
 const plan={delegation:[{member_id:"dev",instruction:"Implement",accept:["ok"]},{member_id:"reviewer",instruction:"Review"}]};
 assert.deepEqual(managedOutput(JSON.stringify(plan),scope),plan);
 assert.deepEqual(managedOutput("plain result",undefined),{text:"plain result"});
});
test("delegation rejects invented members, statuses, recursive plans and empty plans", () => {
 for(const steps of [[],[{member_id:"outsider",accept:["ok"]}],[{member_id:"dev",accept:["failed"]}],[{member_id:"dev"}],[{member_id:"dev",kind:"auto",accept:["ok"]}],Array.from({length:13},()=>({member_id:"dev",accept:["ok"]}))]) assert.throws(()=>managedOutput(JSON.stringify({delegation:steps}),scope));
 assert.throws(()=>managedOutput("not json",scope));
});
