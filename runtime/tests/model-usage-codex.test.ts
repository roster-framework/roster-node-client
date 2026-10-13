import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PROTOCOL} from "@roster/contracts";
import {RosterRuntime} from "../src/application/runtime.js";
import {FileRuntimeStorage} from "../src/infrastructure/filesystem.js";
import {SqliteSessionJournal} from "../src/infrastructure/sqlite-session-journal.js";
import {JsonSchemaAgentParameters} from "../src/infrastructure/agent-parameters.js";
import type {AgentModule,AgentImplementation} from "../src/domain/agent.js";

test("Codex child aggregate reaches original Runtime journal once and survives reopen",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"roster-codex-usage-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const modulePath=new URL("../presets/codex/agent.mjs",import.meta.url).href;
  const module=await import(modulePath) as AgentModule;
  const source=`process.stdin.resume();process.stdin.on('end',()=>{
    const usage={type:'turn.completed',usage:{input_tokens:42,cached_input_tokens:30,output_tokens:3,prompt:'PRIVATE_USAGE'}};
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'success',summary:'Done',minutes:''})}}));
    console.log(JSON.stringify(usage));console.log(JSON.stringify(usage));});`;
  const templates=await module.createAgentTemplates!({executable:{command:process.execPath,prefix:['-e',source,'--']}});
  const agent=await templates[0].create({id:"agent",name:"Agent",parameters:{project:dir,model:"configured-model"}}) as AgentImplementation;
  const storage=new FileRuntimeStorage(dir,"runtime"),path=join(dir,"usage.db"),journal=new SqliteSessionJournal(path,"runtime");
  const runtime=new RosterRuntime("runtime",[agent],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},
    {create:()=>{throw Error("unused");}},{inspect:async()=>[]},undefined,undefined,journal,undefined,new JsonSchemaAgentParameters());
  await runtime.initialize();
  try {
    await runtime.run({protocol:PROTOCOL,execution_id:"native-run",work_id:"original-work",agent_id:"agent",input:{},
      context:{request:"fixture",culture:"",history:[],knowledge:[]}},()=>{},()=>{},undefined,true,"original-core");
    assert.equal((await storage.get("native-run"))?.state,"completed");
    const page=journal.page("native-run","original-core",0,100);
    const entries=page.entries.filter(value=>value.entry.id==="model-usage.codex-cli-turn");
    assert.equal(entries.length,1);assert.equal(page.work_id,"original-work");assert.equal(page.sealed,true);
    const report=JSON.parse(entries[0].entry.text!).usage;
    assert.equal(report.input_tokens,42);assert.equal(report.cached_input_tokens,30);assert.equal(report.model,"configured-model");
    assert.ok(!JSON.stringify(page).includes("PRIVATE_USAGE"));
    await runtime.close();
    const reopened=new SqliteSessionJournal(path,"runtime");
    try {assert.deepEqual(reopened.page("native-run","original-core",0,100),page);} finally {reopened.close();}
  } finally {await runtime.close();}
});
