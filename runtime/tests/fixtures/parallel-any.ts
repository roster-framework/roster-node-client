import type {AgentImplementation} from '../../src/agent.js';
import {appendFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';

// Provider-free execution fixture: no role names or Core join decisions.
export function createAgents():AgentImplementation[] {
 return ['alpha','beta','final'].map(id=>({
  spec:{id,name:id,description:'Bounded first-result probe',statuses:['ok','fail'],events:['complete'],skills:[],rules:[],capabilities:[]},
  async execute(input,context) {
   await appendFile(join(context.workspace,'execution-count.txt'),'executed\n');
   const started=Date.now();context.log('Started '+id);
   const fail=id==='alpha'&&input.input.fail_alpha===true;
   const delay=id==='final'?10:fail?200:id==='alpha'?5000:1800;
   try { await setTimeout(delay,undefined,{signal:context.signal}); }
   catch(error) {await appendFile(join(context.workspace,'cancel-observed.txt'),'cancelled\n');throw error;}
   const status=fail?'fail':'ok';
   await writeFile(join(context.workspace,'result-returned.txt'),status+'\n');
   return {status,summary:'Finished '+id,output:{id,started,ended:Date.now(),stage:input.input.stage,previous:input.input.previous??null},events:status==='ok'?[{type:'complete',data:{agent:id}}]:[],artifacts:[],metrics:{}};
  }
 }));
}
