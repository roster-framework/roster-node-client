import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannedWorkCancelCommand, validatePlannedWorkCancelReceipt} from '../dist/index.js';

test('planned cancellation uses exact original Work/command and never accepts authority or cleanup promises', () => {
  const command = {version: 1, id: 'cancel:original', work_id: 'work'};
  const receipt = {version: 1, kind: 'planned-cancellation', command_id: command.id, work_id: command.work_id, accepted_at: '2026-10-08T00:00:00.123456789Z'};
  assert.deepEqual(PlannedWorkCancelCommand.parse(command), command);
  assert.deepEqual(validatePlannedWorkCancelReceipt(receipt, command), receipt);
  assert.equal(validatePlannedWorkCancelReceipt({...receipt, replayed: true}, command).replayed, true);
  for (const change of [{version: 2}, {id: ''}, {work_id: 'bad/path'}, {actor: {role: 'admin'}}, {execution_id: 'branch'}]) assert.throws(() => PlannedWorkCancelCommand.parse({...command, ...change}));
  for (const change of [{kind: 'direct-cancellation'}, {command_id: 'other'}, {work_id: 'other'}, {accepted_at: 'now'}, {replayed: 'yes'}, {runtime_stopped: true}, {token: 'private'}]) assert.throws(() => validatePlannedWorkCancelReceipt({...receipt, ...change}, command));
});
