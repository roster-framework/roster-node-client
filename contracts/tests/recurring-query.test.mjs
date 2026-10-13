import test from 'node:test';
import assert from 'node:assert/strict';
import {RecurringPageQuery,validateRecurringPage,validateRecurringDefinition,validateRecurringReceipt} from '../dist/index.js';

const query={version:1,unit_id:'team',limit:1};
const definition={id:'weekly',unit_id:'team',title:' Original ',request:' Original private request\n',input:{original:true},steps:[{kind:'member',member_id:'person'}],scheduling:{priority:0},every_seconds:604800,next_run_at:'2026-10-13T00:00:00Z',active:true,version:1,last_work_id:'work',last_slot_at:'2026-10-06T00:00:00Z'};
const metadata={id:definition.id,unit_id:'team',title:definition.title,owner_member_id:'person',every_seconds:604800,next_run_at:definition.next_run_at,active:true,version:1,last_work_id:'work',last_slot_at:definition.last_slot_at};
test('owned recurring metadata requires explicit scope, order and bounded continuation without private body',()=>{
 assert.equal(RecurringPageQuery.parse({version:1,unit_id:'team'}).limit,20);
 assert.throws(()=>RecurringPageQuery.parse({version:1}));
 const page={version:1,unit_id:'team',work_revision:7,items:[metadata]};
 assert.deepEqual(validateRecurringPage(page,query),page);
 for(const bad of [{...page,unit_id:'private'},{...page,items:null},{...page,items:[metadata,metadata]},{...page,next_after:'other'},{...page,items:[{...metadata,request:'private'}]},{...page,items:[{...metadata,owner_member_id:''}]},{...page,work_revision:9007199254740992},{...page,items:[{...metadata,last_slot_at:undefined}]}])assert.throws(()=>validateRecurringPage(bad,query));
 assert.throws(()=>validateRecurringPage(page,{...query,after:'weekly'}));
 assert.throws(()=>validateRecurringPage({...page,items:[{...metadata,title:'가'.repeat(100)}]},query));
});
test('selected recurring original and receipt bind to exact query command actor and original owner',()=>{
 const q={version:1,unit_id:'team',id:'weekly'},view={version:1,unit_id:'team',work_revision:7,owner_member_id:'person',definition};
 assert.deepEqual(validateRecurringDefinition(view,q),view);
 for(const bad of [{...view,unit_id:'private'},{...view,definition:{...definition,id:'other'}},{...view,definition:{...definition,next_run_at:'2026-10-13T09:00:00+09:00'}},{...view,definition:{...definition,last_slot_at:undefined}},{...view,owner_account_id:'private'}])assert.throws(()=>validateRecurringDefinition(bad,q));
 const command={version:1,id:'save',expected_revision:7,definition:{...definition,version:1,last_work_id:undefined,last_slot_at:undefined}},actor={account_id:'account',member_id:'editor'},receipt={version:1,command_id:'save',recurring_id:'weekly',unit_id:'team',definition_version:2,work_revision:8,actor,owner:{account_id:'private-owner',member_id:'person'},accepted_at:'2026-10-06T00:00:00Z',replayed:false};
 assert.deepEqual(validateRecurringReceipt(receipt,command,actor,'person'),receipt);
 for(const bad of [{...receipt,command_id:'other'},{...receipt,recurring_id:'other'},{...receipt,unit_id:'private'},{...receipt,definition_version:3},{...receipt,work_revision:9},{...receipt,actor:{...actor,account_id:'other'}},{...receipt,owner:{...receipt.owner,member_id:'other'}}])assert.throws(()=>validateRecurringReceipt(bad,command,actor,'person'));
});
