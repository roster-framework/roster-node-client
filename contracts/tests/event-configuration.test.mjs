import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEventConfiguration,validateEventConfigurationCommand,validateEventDefinitionPreview,validateEventConfigurationReceipt,validateEventWorkTextCommand,validateEventWorkCreationReceipt} from '../dist/index.js';

const definition={version:1,name:'Original',subscriptions:[{id:'start',on:'work.requested',owner_member_id:'person',target_member_id:'developer',max_per_work:0}]};
const command={version:1,id:'save',expected_revision:7,unit_id:'team',workspace_id:'person',expected_workspace_version:4,definition};
const selected={version:1,unit_id:'team',workspace_id:'person',work_revision:7,configured:true,workspace_version:4,definition};
const query={version:1,unit_id:'team',workspace_id:'person'};
test('selected original defaults and author are preserved without current permission inference',()=>{
 const v=validateEventConfiguration(selected,query);assert.equal(v.definition.subscriptions[0].max_per_work,0);assert.equal(v.definition.subscriptions[0].owner_member_id,'person');v.definition.subscriptions[0].max_per_work=2;assert.equal(definition.subscriptions[0].max_per_work,0);
 for(const bad of [{...selected,unit_id:'other'},{...selected,workspace_id:'other'},{...selected,owner_account_id:'private'},{...selected,configured:false},{...selected,work_revision:9007199254740992},{...selected,workspace_version:0},{...selected,definition:{...definition,token:'private'}}])assert.throws(()=>validateEventConfiguration(bad,query));
 const empty={...selected,configured:false,workspace_version:0,definition:{version:1,name:'Events',subscriptions:[]}};assert.equal(validateEventConfiguration(empty,query).configured,false);assert.equal(validateEventConfiguration({...selected,definition:{...definition,subscriptions:null}},query).definition.subscriptions,null);
});
test('preview binds scope/revisions and canonical default only without altering original draft',()=>{
 const p={version:1,command_id:'save',unit_id:'team',workspace_id:'person',work_revision:7,workspace_version:4,definition:{...definition,subscriptions:[{...definition.subscriptions[0],max_per_work:3}]}};
 assert.equal(validateEventDefinitionPreview(p,command).definition.subscriptions[0].max_per_work,3);assert.equal(command.definition.subscriptions[0].max_per_work,0);
 for(const bad of [{...p,command_id:'other'},{...p,workspace_id:'other'},{...p,work_revision:8},{...p,workspace_version:5},{...p,actor_proof:'private'},{...p,definition}])assert.throws(()=>validateEventDefinitionPreview(bad,command));
 const optional={...command,definition:{...definition,subscriptions:[{...definition.subscriptions[0],instruction:'',resource_ids:[],delay_seconds:0}]}};assert.ok(validateEventDefinitionPreview(p,optional));
 const changed={...command,definition:{...definition,subscriptions:[{...definition.subscriptions[0],owner_member_id:'other'}]}};assert.throws(()=>validateEventDefinitionPreview(p,changed));
});
test('save receipt is exact selected original command, no private payload or permission',()=>{
 const r={version:1,command_id:'save',unit_id:'team',workspace_id:'person',work_revision:8,workspace_version:5,accepted_at:'2026-10-06T00:00:00Z',replayed:true};assert.ok(validateEventConfigurationReceipt(r,command));
 for(const bad of [{...r,unit_id:'other'},{...r,command_id:'other'},{...r,work_revision:9},{...r,workspace_version:4},{...r,definition},{...r,accepted_at:'invalid'},{...r,replayed:'true'}])assert.throws(()=>validateEventConfigurationReceipt(bad,command));
 const noOwner={...command,definition:{...definition,subscriptions:[{id:'start',on:'work.requested',target_member_id:'developer',max_per_work:0}]}};assert.equal(validateEventConfigurationCommand(noOwner).definition.subscriptions[0].owner_member_id,undefined);
 assert.throws(()=>validateEventConfigurationCommand({...command,workspace_id:undefined}));assert.throws(()=>validateEventConfigurationCommand({...command,expected_revision:Number.MAX_SAFE_INTEGER}));assert.throws(()=>validateEventConfigurationCommand({...command,definition:{...definition,name:'x'.repeat(65536)}}));
});
test('text event work receipt stays bound to original actual workspace and rejects private/foreign response',()=>{
 const c=validateEventWorkTextCommand({version:1,id:'start',intent:{unit_id:'team',workspace_id:'person',title:' Original ',request:' Original request\n'}});assert.equal(c.intent.request,' Original request\n');
 const r={version:1,command_id:'start',work_id:'work',unit_id:'team',workspace_id:'person',workspace_version:4,work_revision:9,accepted_at:'2026-10-06T00:00:00Z',replayed:true};assert.ok(validateEventWorkCreationReceipt(r,c));
 for(const bad of [{...r,command_id:'foreign'},{...r,workspace_id:'other'},{...r,unit_id:'other'},{...r,workspace_version:0},{...r,work_revision:0},{...r,owner_account_id:'private'},{...r,definition}])assert.throws(()=>validateEventWorkCreationReceipt(bad,c));
 assert.throws(()=>validateEventWorkTextCommand({...c,intent:{...c.intent,workspace_id:'self'}}));assert.throws(()=>validateEventWorkTextCommand({...c,intent:{...c.intent,title:'한'.repeat(100)}}));assert.throws(()=>validateEventWorkTextCommand({...c,intent:{...c.intent,request:'  '}}));
});
