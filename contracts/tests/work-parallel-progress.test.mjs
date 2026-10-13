import test from 'node:test';import assert from 'node:assert/strict';
import {validateWorkParallelProgress} from '../dist/index.js';
const record={work:{id:'work'},runs:[{id:'winner',work_id:'work',state:'completed'},{id:'peer',work_id:'work',state:'cancelled'}]};
const good=()=>[{index:0,mode:'any',state:'completed',branches:[{index:0,member_id:'dev',name:'Dev',execution_id:'peer',state:'cancelled'},{index:1,member_id:'qa',name:'QA',execution_id:'winner',state:'completed',selected:true}]}];
test('Work parallel read projection is bounded and binds immutable winner/retired IDs without private fields',()=>{
 const v=good();assert.deepEqual(validateWorkParallelProgress(v,record),v);
 for(const corrupt of [v=>v[0].branches[1].selected=false,v=>v[0].branches[0].execution_id='foreign',v=>v[0].branches[0].state='running',v=>v[0].branches[0].instruction='private',v=>v[0].index=64,v=>v[0].branches[0].member_id='qa',v=>v.push(v[0]),v=>v[0].mode='all']){const v=good();corrupt(v);assert.throws(()=>validateWorkParallelProgress(v,record),/Invalid parallel progress/);}
 assert.throws(()=>validateWorkParallelProgress(good(),{...record,runs:[{...record.runs[0],work_id:'other'},record.runs[1]]}));
 assert.deepEqual(validateWorkParallelProgress([{index:1,mode:'all',state:'queued',branches:[{index:0,member_id:'dev',name:'Dev',state:'queued'},{index:1,member_id:'qa',name:'QA',state:'queued'}]}],record)[0].mode,'all');
});

test('cancelled progress is bound to cancelled Work and preserves completed branches without a winner',()=>{
 const source={work:{id:'work',state:'cancelled'},runs:[{id:'finished',work_id:'work',state:'completed'},{id:'stopped',work_id:'work',state:'cancelled'}]};
 const value=[{index:0,mode:'all',state:'cancelled',branches:[{index:0,member_id:'dev',name:'Dev',execution_id:'finished',state:'completed'},{index:1,member_id:'qa',name:'QA',execution_id:'stopped',state:'cancelled'}]},{index:1,mode:'any',state:'cancelled',branches:[{index:0,member_id:'dev',name:'Dev',state:'cancelled'},{index:1,member_id:'qa',name:'QA',state:'cancelled'}]}];
 assert.deepEqual(validateWorkParallelProgress(value,source),value);
 assert.throws(()=>validateWorkParallelProgress(value,{...source,work:{id:'work',state:'working'}}));
 for(const change of [v=>v[0].branches[0].selected=true,v=>v[1].branches[0].state='queued',v=>v[1].branches[0].execution_id='invented',v=>v[0].branches[1].execution_id='finished']){const v=structuredClone(value);change(v);assert.throws(()=>validateWorkParallelProgress(v,source));}
});
