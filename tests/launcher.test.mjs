import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../scripts/launch.mjs', import.meta.url));

test('launcher rejects malformed entrypoint arguments with safe JSON only', () => {
  const result = spawnSync(process.execPath, [launcher, '--config', 'private.json', '--extra'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output, { schema:'roster-launch-result/1', phase:'failed', component:'preflight', code:2, children:{}, unresolved:[] });
});

test('launcher does not echo unexpected command arguments', () => {
  const marker = 'never-print-this-value';
  const result = spawnSync(process.execPath, [launcher, marker], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stderr, '');
});
