import test from 'node:test';
import assert from 'node:assert/strict';
import {Scheduler,SchedulerCommand,SchedulerReceipt,validateSchedulerCommand,validateSchedulerView,schedulerCommandDigest,validateSchedulerReceipt} from '../dist/index.js';

const command={version:1,id:'settings',expected_revision:4,scheduler:{global_limit:2,runtime_limit:1,agent_limit:1}};
const actor={account_id:'account',member_id:'member'};
const digest='76fbe94b2264a63a265281c465a48fb0f7a2bc769696f78fd1effc5252ae8082';
const receipt={version:1,command_id:'settings',command_digest:digest,actor,core_revision:12,work_revision:5,accepted_at:'2026-10-11T00:00:00Z',replayed:false};

test('scheduler command matches Go digest including numeric IDs and omitted empty overrides',async()=>{
  assert.deepEqual(Scheduler.parse(command.scheduler),command.scheduler);
  assert.equal(await schedulerCommandDigest(command),digest);
  assert.equal(await schedulerCommandDigest({...command,scheduler:{...command.scheduler,runtime_limits:{},agent_limits:{}}}),digest);
  const maps={...command,scheduler:{...command.scheduler,runtime_limits:{2:1,10:2},agent_limits:{'2/a':1,'10/a':2}}};
  assert.equal(await schedulerCommandDigest(maps),'47868b63ddede4896a85a75df5fb8d7ff8695b9e0038fed98714a33203491d55');
  assert.notEqual(await schedulerCommandDigest({...command,id:'other'}),digest);
  assert.notEqual(await schedulerCommandDigest({...command,expected_revision:5}),digest);
});

test('scheduler contracts reject authority injection, invalid limits and unsafe revisions',()=>{
  for(const bad of [{...command,actor},{...command,decision:{}},{...command,version:2},{...command,expected_revision:-1},{...command,expected_revision:Number.MAX_SAFE_INTEGER},{...command,scheduler:{...command.scheduler,global_limit:101}},{...command,scheduler:{...command.scheduler,agent_limits:{invalid:1}}}])assert.throws(()=>SchedulerCommand.parse(bad));
  const runtime_limits=Object.fromEntries(Array.from({length:101},(_,i)=>['r'+i,1]));
  assert.throws(()=>validateSchedulerCommand({...command,scheduler:{...command.scheduler,runtime_limits}}));
  assert.throws(()=>validateSchedulerView({revision:1,scheduler:{...command.scheduler,runtime_limits}}));
  const agent_limits=Object.fromEntries(Array.from({length:1001},(_,i)=>['runtime/a'+i,1]));
  assert.throws(()=>validateSchedulerCommand({...command,scheduler:{...command.scheduler,agent_limits}}));
  assert.deepEqual(validateSchedulerView({revision:5,scheduler:command.scheduler}),{revision:5,scheduler:command.scheduler});
});

test('scheduler receipt binds original command and actor while replay retains historical Core revision',async()=>{
  assert.deepEqual(await validateSchedulerReceipt(receipt,command,actor),receipt);
  const replay={...receipt,replayed:true};
  assert.deepEqual(await validateSchedulerReceipt(replay,command,actor),replay);
  for(const changed of [{command_id:'other'},{command_digest:'a'.repeat(64)},{work_revision:6},{actor:{account_id:'other',member_id:'member'}}])await assert.rejects(validateSchedulerReceipt({...receipt,...changed},command,actor));
  for(const changed of [{accepted_at:'invalid'},{core_revision:-1},{work_revision:Number.MAX_SAFE_INTEGER+1},{actor:{...actor,role:'admin'}},{decision:{}},{replayed:undefined}])assert.throws(()=>SchedulerReceipt.parse({...receipt,...changed}));
});
