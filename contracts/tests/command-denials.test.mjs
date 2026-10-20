import assert from 'node:assert/strict';
import test from 'node:test';
import {validateCommandDenialPage,CommandDenialQuery} from '../dist/index.js';
const record={sequence:2,operation:'board.respond',command_id:'command',card_id:'card',actor:{kind:'human',account_id:'account',member_id:'person'},outcome:'forbidden',at:'2026-10-07T00:00:00Z'};
test('command denials require exact actor/coverage metadata and cannot contain private originals',()=>{
 assert.deepEqual(validateCommandDenialPage({items:[record]},{after:1}).items,[record]);
 const execution={...record,operation:'board.claim',actor:{kind:'execution',member_id:'agent',execution_id:'run'}};assert.deepEqual(validateCommandDenialPage({items:[execution]}).items,[execution]);
 for(const wrong of [{...record,response:'private'},{...record,outcome:'accepted'},{...record,operation:'work.create'},{...record,actor:{kind:'system'}},{...record,actor:{...record.actor,execution_id:'run'}},{...execution,actor:{...execution.actor,account_id:'account'}},{...record,work_id:'invented'},{...record,at:'bad'}])assert.throws(()=>validateCommandDenialPage({items:[wrong]}));
});
test('command denial pages enforce query bounds, original increasing order and actual continuation',()=>{
 assert.deepEqual(CommandDenialQuery.parse({}),{limit:50,after:0});
 for(const query of [{limit:0},{limit:101},{after:-1},{after:Number.MAX_SAFE_INTEGER+1},{limit:null},{token:'private'}])assert.throws(()=>CommandDenialQuery.parse(query));
 assert.equal(validateCommandDenialPage({items:[record],next_after:2},{limit:1,after:1}).next_after,2);
 for(const page of [{items:[record,record]},{items:[record],next_after:3},{items:[record],next_after:2},{items:[record],secret:'private'},{items:null}])assert.throws(()=>validateCommandDenialPage(page));
 assert.throws(()=>validateCommandDenialPage({items:[record]},{after:2}));
});
test('creation denial variants identify the request without inventing a task/card or exposing private payload',()=>{
 for(const operation of ['work.create.direct','work.create.planned']){
  const {card_id,...v}=record;v.operation=operation;
  assert.deepEqual(validateCommandDenialPage({items:[v]}).items,[v]);
  for(const field of [{card_id:'fake'},{work_id:'fake'},{request:'private'},{member_id:'recipient'},{unit_id:'team'},{fingerprint:'private'}])assert.throws(()=>validateCommandDenialPage({items:[{...v,...field}]}));
 }
 const {card_id,...missing}=record;assert.throws(()=>validateCommandDenialPage({items:[missing]}));
});

test('agent call denials preserve only the execution caller and request reference',()=>{
 const {card_id,...call}={...record,operation:'agent.call',actor:{kind:'execution',member_id:'caller',execution_id:'parent'}};
 assert.deepEqual(validateCommandDenialPage({items:[call]}).items,[call]);
 for(const extra of [{actor:record.actor},{card_id:'invented'},{work_id:'invented'},{target_member_id:'target'},{prompt:'private'},{token:'private'},{actor:{...call.actor,account_id:'invented'}}])assert.throws(()=>validateCommandDenialPage({items:[{...call,...extra}]}));
});

test('resource invocation denial contains a server attempt and caller without resource payloads',()=>{
 const {card_id,...attempt}={...record,operation:'resource.invoke',command_id:'server-attempt'};
 for(const actor of [record.actor,{kind:'execution',member_id:'caller',execution_id:'run'}]){
  const item={...attempt,actor};assert.deepEqual(validateCommandDenialPage({items:[item]}).items,[item]);
  for(const extra of [{card_id:'fake'},{resource_id:'private'},{tool:'private'},{arguments:{token:'secret'}},{response:'private'}])assert.throws(()=>validateCommandDenialPage({items:[{...item,...extra}]}));
 }
});

test('runtime invocation denial identifies only the authenticated service credential class',()=>{
 const {card_id,...item}={...record,operation:'runtime.invoke',command_id:'requested-reference',actor:{kind:'work-service'}};
 assert.deepEqual(validateCommandDenialPage({items:[item]}).items,[item]);
 for(const extra of [{card_id:'invented'},{actor:record.actor},{actor:{kind:'execution',member_id:'agent',execution_id:'run'}},{actor:{kind:'work-service',execution_id:'invented'}},{actor:{kind:'work-service',member_id:'invented'}},{actor:{kind:'work-service',account_id:'invented'}},{prompt:'private'},{target:'private'}])assert.throws(()=>validateCommandDenialPage({items:[{...item,...extra}]}));
 for(const operation of ['board.claim','work.create.direct','agent.call','resource.invoke'])assert.throws(()=>validateCommandDenialPage({items:[{...item,operation}]}));
});
