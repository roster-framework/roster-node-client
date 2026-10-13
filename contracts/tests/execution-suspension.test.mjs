import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Frame, ExecutionSuspension, SuspendedExecutionReceipt, validateExecutionSuspension, validateSuspendedExecutionReceipt} from '../dist/index.js';

const origin = {execution_id:'run',work_id:'work',runtime_id:'runtime',agent_id:'agent'};
const suspension = {...origin,protocol:'roster-execution-suspension/1',wait_id:'wait',checkpoint_digest:'a'.repeat(64)};

test('suspension is separate terminal evidence bound to all four original IDs', () => {
  assert.deepEqual(validateExecutionSuspension(suspension, origin), suspension);
  assert.deepEqual(Frame.parse({type:'suspended',suspension}), {type:'suspended',suspension});
  const receipt = {id:origin.execution_id,state:'suspended',suspension};
  assert.deepEqual(validateSuspendedExecutionReceipt(receipt, origin), receipt);
  for (const key of Object.keys(origin)) {
    assert.throws(() => validateExecutionSuspension({...suspension,[key]:'foreign'}, origin));
    assert.throws(() => validateSuspendedExecutionReceipt({...receipt,suspension:{...suspension,[key]:'foreign'}}, origin));
  }
  assert.equal(SuspendedExecutionReceipt.safeParse({...receipt,id:'foreign'}).success, false);
});

test('suspension rejects business result, secrets, invalid protocol and malformed checkpoint reference', () => {
  for (const change of [{protocol:'roster/0.1'},{wait_id:''},{checkpoint_digest:'A'.repeat(64)},{checkpoint_digest:'a'.repeat(63)},{private_checkpoint:{secret:'hidden'}},{state:{secret:'hidden'}}]) {
    assert.equal(ExecutionSuspension.safeParse({...suspension,...change}).success, false);
  }
  for (const field of ['result','observation','private_checkpoint','checkpoint','token']) {
    assert.equal(SuspendedExecutionReceipt.safeParse({id:'run',state:'suspended',suspension,[field]:{secret:'hidden'}}).success, false);
    assert.equal(Frame.safeParse({type:'suspended',suspension,[field]:{secret:'hidden'}}).success, false);
  }
  assert.equal(Frame.safeParse({type:'result',suspension,result:{status:'ok',summary:'ok'}}).success, false);
  assert.equal(SuspendedExecutionReceipt.safeParse({id:'run',state:'completed',suspension}).success, false);
});

test('language-neutral public schemas contain no private checkpoint payload', () => {
  for (const name of ['executionSuspension','suspendedFrame','suspendedExecutionReceipt']) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`,import.meta.url),'utf8'));
    assert.equal(schema.additionalProperties, false);
    assert.ok(!JSON.stringify(schema).includes('private_checkpoint'));
  }
});
