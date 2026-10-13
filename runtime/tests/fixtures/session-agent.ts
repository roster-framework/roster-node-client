import type { AgentImplementation } from "../../src/agent.js";
import {appendFile} from "node:fs/promises";
import {join} from "node:path";

export function createAgents(): AgentImplementation[] {
  return [{
    spec: { id:"session-probe", name:"Session probe", description:"Session integration fixture", statuses:["ok"], events:[], skills:[], rules:[], capabilities:[] },
    async execute(input, context) {
      await appendFile(join(context.workspace,"execution-count.txt"),"executed\n");
      if(input.input.access_refusal) {
        try { await context.invokeResource!({id:"not-exposed",name:"read",arguments:{password:"private-refusal-argument"}}); }
        catch { /* Runtime must retain attention and its committed refusal. */ }
        return {status:"ok",summary:"Author attempted to swallow refusal",output:{},events:[],artifacts:[],metrics:{}};
      }
      const logs = Number(input.input.logs ?? 3);
      for (let i = 0; i < logs; i++) {
        context.log("Work record " + i);
        if(i===0 && input.input.pause_ms) await new Promise(r=>setTimeout(r,Number(input.input.pause_ms)));
      }
      context.recordSession!({kind:"decision",text:"Keep originals separate from compact memory"});
      context.recordSession!({kind:"knowhow",text:"Check execution receipts before retrying external changes"});
      if(input.input.usage_reports) {
        const usage={version:1 as const,invocation_id:"fixture-loop",provider:"fixture",model:"deterministic",phase:"loop" as const,state:"completed" as const,input_tokens:12,output_tokens:3,cached_input_tokens:7};
        context.recordModelUsage!(usage);context.recordModelUsage!({...usage});
        context.recordModelUsage!({...usage,invocation_id:"fixture-final",phase:"final",state:"failed",input_tokens:null,output_tokens:null,cached_input_tokens:null});
      }
      if(input.input.roster_intent === "meeting") {
        const meeting=input.input.meeting as Record<string,unknown>;
        const history=input.context.history;
        const observation={thread_id:meeting.thread_id,member_id:meeting.member_id,phase:meeting.phase,round:meeting.round,previousHuman:history.some(h=>h.actor.startsWith("human/")&&h.summary==="Human meeting feedback"),previousAgent:history.some(h=>h.summary==="Agent meeting contribution")};
        await appendFile(join(context.workspace,"meeting-context.json"),JSON.stringify(observation));
        context.recordSession!({kind:"decision",text:meeting.phase==="minutes"?"Record disagreement explicitly in meeting minutes":"Agent meeting contribution"});
        return {status:"ok",summary:meeting.phase==="minutes"?"Meeting minutes drafted":"Agent meeting contribution",output:observation,events:[],artifacts:meeting.phase==="minutes"?[{name:"minutes.md",mime:"text/markdown",content:"# Meeting minutes\n\n## Decisions\nPreserve original records.\n\n## Open questions\nHuman meeting feedback remains unresolved.\n\n## Action items\nReview before taking action."}]:[],metrics:{}};
      }
      return {status:"ok",summary:"Records delivered",output:{knowledge:input.context.knowledge},events:[],artifacts:[],metrics:{}};
    },
  }];
}
