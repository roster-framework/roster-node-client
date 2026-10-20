import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionContinuation,Invocation,Manifest,PROTOCOL} from '../dist/index.js';

const reference={protocol:'roster-execution-continuation/1',wait_id:'wait',parent_execution_id:'parent',checkpoint_digest:'a'.repeat(64),thread_id:'thread',question_id:'question',answers:[{member_id:'designer',message_id:'reply',sequence:2,digest:'b'.repeat(64)}]};
test('Continuation carries bounded references and never checkpoint or reply bodies',()=>{
 assert.deepEqual(ExecutionContinuation.parse(reference),reference);
 const input={protocol:PROTOCOL,execution_id:'resumed',work_id:'work',agent_id:'agent',input:{},context:{request:'build',culture:'',history:[],knowledge:[],continuation:reference}};
 assert.deepEqual(Invocation.parse(input).context.continuation,reference);
 const manifest={protocol:PROTOCOL,runtime_id:'runtime',name:'Runtime',engine:'node',isolation:'trusted-local-process',agents:[],execution_continuation:'roster-execution-continuation/1'};
 assert.equal(Manifest.parse(manifest).execution_continuation,reference.protocol);
 assert.equal(Manifest.safeParse({...manifest,execution_continuation:'unknown'}).success,false);
 for(const value of [{...reference,checkpoint:{}},{...reference,answers:[]},{...reference,answers:[...reference.answers,...reference.answers]},{...reference,answers:[{...reference.answers[0],body:'private'}]},{...reference,answers:[{...reference.answers[0],sequence:Number.MAX_SAFE_INTEGER+1}]}])assert.equal(ExecutionContinuation.safeParse(value).success,false);
});

test('Child continuation uses the same invocation boundary without question or result bodies',()=>{
 const child={request_id:'child-work',record_id:'child-run',digest:'c'.repeat(64),state:'attention'};
 const value={protocol:'roster-execution-continuation/2',wait_id:'wait',parent_execution_id:'parent',checkpoint_digest:'a'.repeat(64),children:[child]};
 assert.deepEqual(ExecutionContinuation.parse(value),value);
 assert.equal(Manifest.parse({protocol:PROTOCOL,runtime_id:'runtime',name:'Runtime',engine:'node',isolation:'trusted-local-process',agents:[],execution_continuation:value.protocol}).execution_continuation,value.protocol);
 for(const bad of [{...value,children:[]},{...value,children:Array(13).fill(child)},{...value,children:[child,child]},{...value,children:[child,{...child,request_id:'other'}]},{...value,children:[{...child,record_id:'parent'}]},{...value,children:[{...child,state:'running'}]},{...value,answers:reference.answers},{...value,thread_id:'thread'},{...value,children:[{...child,body:'private'}]}])assert.equal(ExecutionContinuation.safeParse(bad).success,false);
 assert.equal(ExecutionContinuation.safeParse({...reference,children:[child]}).success,false);
 const input={protocol:PROTOCOL,execution_id:'resumed',work_id:'work',agent_id:'agent',input:{},context:{request:'build',culture:'',history:[],knowledge:[],continuation:value}};
 assert.deepEqual(Invocation.parse(input).context.continuation,value);
});
