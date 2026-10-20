import test from 'node:test';
import assert from 'node:assert/strict';
import {RecurringChangeAuditQuery,validateRecurringChangeAuditPage} from '../dist/index.js';
const q={version:1,unit_id:'team',limit:1};
const entry={sequence:1,command_id:'save',recurring_id:'weekly',unit_id:'team',definition_version:2,work_revision:7,actor_member_id:'editor',owner_member_id:'person',accepted_at:'2026-10-07T00:00:00Z'};
test('recurring change audit binds bounded selection/order/cursor and excludes private sources',()=>{
 const page={version:1,unit_id:'team',items:[entry],next_after:1};assert.deepEqual(validateRecurringChangeAuditPage(page,q),page);assert.equal(RecurringChangeAuditQuery.parse({version:1,unit_id:'team'}).limit,50);
 for(const bad of [{...page,unit_id:'other'},{...page,items:null},{...page,items:[entry,entry]},{...page,next_after:2},{...page,items:[{...entry,unit_id:'other'}]},{...page,items:[{...entry,sequence:0}]},{...page,items:[{...entry,work_revision:9007199254740992}]},{...page,items:[{...entry,definition_version:9007199254740992}]},{...page,items:[{...entry,owner_member_id:''}]},{...page,items:[{...entry,account_id:'private'}]},{...page,request:'private'}])assert.throws(()=>validateRecurringChangeAuditPage(bad,q));
 assert.throws(()=>validateRecurringChangeAuditPage(page,{...q,after:1}));
 for(const bad of [{version:1},{...q,limit:0},{...q,limit:101},{...q,after:-1},{...q,after:9007199254740992},{...q,workspace_id:'private'}])assert.throws(()=>RecurringChangeAuditQuery.parse(bad));
});
