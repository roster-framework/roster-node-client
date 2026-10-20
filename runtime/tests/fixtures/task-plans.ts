import type {AgentImplementation} from '../../src/agent.js';
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';

// Provider-free regression probe for frozen aliases, review and delegation.
export function createAgents():AgentImplementation[] {
 const attempts=new Map<string,number>();
 return ['strategy','developer','coordinator'].map(id=>({
  spec:{id,name:id,description:'Task plan probe',statuses:['ok','needs_help'],events:['complete'],skills:[],rules:[],capabilities:[]},
  async execute(input,context){
   const key=id+':'+input.work_id,attempt=(attempts.get(key)||0)+1;attempts.set(key,attempt);
   await appendFile(join(context.workspace,'execution-count.txt'),'executed\n');
   context.log('Plan probe '+id);
   const status=input.input.fail_once===true&&attempt===1?'needs_help':'ok';
   let output:Record<string,unknown>={id,attempt,stage:input.input.stage,previous:input.input.previous??null,review_feedback:input.input.review_feedback??null};
   if(id==='coordinator'){
    const candidates=(input.input.delegation as {candidates:{member_id:string;accept?:string[]}[]}).candidates;
    output={delegation:[{member_id:input.input.bad_delegate?'outside-allowlist':candidates[0].member_id,instruction:'Verify output',accept:candidates[0].accept??[]}]};
   }
   return {status,summary:'Finished '+id,output,events:status==='ok'?[{type:'complete',data:{}}]:[],artifacts:input.input.review_artifact?[{name:'patch.md',mime:'text/markdown',content:'# Patch '+input.execution_id}]:[],metrics:{}};
  }
 }));
}
