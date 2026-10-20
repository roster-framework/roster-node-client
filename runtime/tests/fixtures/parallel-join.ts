import type {AgentImplementation} from '../../src/agent.js';
import {appendFile} from 'node:fs/promises';import {join} from 'node:path';
// Provider-free probe; these are only local statuses, never organization names.
export function createAgents():AgentImplementation[] {
 const attempts=new Map<string,number>();
 return ['alpha','beta','final'].map(id=>({
  spec:{id,name:id,description:'Parallel join probe',statuses:['ok','fail'],events:['complete'],skills:[],rules:[],capabilities:[]},
  async execute(input,context){
   const key=id+':'+input.work_id,attempt=(attempts.get(key)||0)+1;attempts.set(key,attempt);
   await appendFile(join(context.workspace,'execution-count.txt'),'executed\n');
   const started=Date.now();context.log('Started '+id);
   await new Promise(r=>setTimeout(r,id==='alpha'?1200:id==='beta'?250:10));
   const status=id==='beta'&&input.input.fail_beta===true&&attempt===1?'fail':'ok';
   return {status,summary:'Finished '+id,output:{id,attempt,started,ended:Date.now(),stage:input.input.stage,previous:input.input.previous??null},events:status==='ok'?[{type:'complete',data:{agent:id}}]:[],artifacts:[],metrics:{}};
  }
 }));
}
