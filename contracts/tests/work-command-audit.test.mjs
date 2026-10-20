import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkCommandAcceptance,WorkCommandAuditQuery,validateWorkCommandAuditPage} from '../dist/index.js';
const entry=n=>({sequence:n,operation:'board.respond',command_id:'command.1',card_id:'card',work_id:'work',actor:{kind:'human',account_id:'account',member_id:'member'},accepted_at:'2026-10-04T00:00:00.123456789Z'});

test('execution acceptance has its own exact actor without account or card',()=>{
 const value={...entry(1),operation:'agent.call',card_id:'',actor:{kind:'execution',execution_id:'parent',member_id:'caller'}};
 assert.deepEqual(WorkCommandAcceptance.parse(value),value);
 for(const change of [{card_id:'invented'},{actor:{...value.actor,account_id:'invented'}},{actor:{kind:'execution',member_id:'caller'}},{actor:{kind:'human',account_id:'account',member_id:'caller'}},{operation:'board.respond',card_id:'card'},{operation:'work.create'}])assert.throws(()=>WorkCommandAcceptance.parse({...value,...change}));
});

test('human operations enforce exact actor and real card provenance',()=>{
 for(const operation of ['board.respond','board.claim','work.create','work.retry','work.cancel']){
  const value={...entry(1),operation,card_id:operation.startsWith('board.')?'card':''};
  assert.deepEqual(WorkCommandAcceptance.parse(value),value);
  assert.throws(()=>WorkCommandAcceptance.parse({...value,card_id:value.card_id?'':'invented'}));
  const system={...value,actor:{kind:'system'}};
  if(operation==='board.respond')assert.deepEqual(WorkCommandAcceptance.parse(system),system);
  else assert.throws(()=>WorkCommandAcceptance.parse(system));
  assert.throws(()=>WorkCommandAcceptance.parse({...value,actor:{kind:'execution',execution_id:'run',member_id:'member'}}));
 }
});
test('strict accepted metadata, actor provenance and numeric live pagination reject private fields and unsafe cursors',()=>{
 assert.deepEqual(WorkCommandAcceptance.parse(entry(1)),entry(1));assert.deepEqual(WorkCommandAuditQuery.parse({}),{limit:50,after:0});
 const page={items:[entry(2),entry(3)],next_after:3};assert.deepEqual(validateWorkCommandAuditPage(page,{limit:2,after:1}),page);
 for(const change of [{response:'private'},{actor:{kind:'agent'}},{actor:{kind:'system',account_id:'invented'}},{sequence:Number.MAX_SAFE_INTEGER+1},{accepted_at:'invalid'},{operation:'unknown'}])assert.throws(()=>WorkCommandAcceptance.parse({...entry(1),...change}));
 for(const q of [{limit:0},{limit:101},{after:-1},{after:Number.MAX_SAFE_INTEGER+1},{private:'secret'}])assert.throws(()=>WorkCommandAuditQuery.parse(q));
 for(const bad of [{items:[entry(1)]},{items:[entry(3),entry(2)]},{items:[entry(2)],next_after:2},{...page,next_after:4},{...page,secret:'private'}])assert.throws(()=>validateWorkCommandAuditPage(bad,{limit:2,after:1}));
});
