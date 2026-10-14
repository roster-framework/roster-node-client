import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAgentOptions, parseProviderEnvNames, validateServiceAndProviderEnv } from '../scripts/launch.mjs';

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

test('agent options are JSON objects capped by serialized UTF-8 size', () => {
  assert.equal(parseAgentOptions(undefined), '{}');
  assert.equal(parseAgentOptions({ profile:'local', nested:{ count:2 } }), '{"profile":"local","nested":{"count":2}}');
  for (const invalid of [null, [], 'text', 4]) assert.throws(() => parseAgentOptions(invalid));
  assert.throws(() => parseAgentOptions({ value:'x'.repeat(16*1024) }), /agent_options_too_large/u);
});

test('Resource provider names are bounded, uppercase, unique and non-reserved', () => {
  assert.deepEqual(parseProviderEnvNames(undefined), []);
  assert.deepEqual(parseProviderEnvNames(['OPENAI_API_KEY','MCP_REMOTE_TOKEN']), ['OPENAI_API_KEY','MCP_REMOTE_TOKEN']);
  for (const invalid of [
    ['lowercase'], ['DUP','DUP'], ['ROSTER_TOKEN'], ['PORT'], ['ROSTER_AGENT_OPTIONS'], ['COMSPEC'], ['TMPDIR'],
    ['ROSTER_TLS_CERT'], ['ROSTER_TLS_KEY'], ['HTTP_PROXY'], ['HTTPS_PROXY'], ['ALL_PROXY'], ['NO_PROXY'],
    ['http_proxy'], ['https_proxy'], ['all_proxy'], ['no_proxy'], ['GODEBUG'], ['GOMAXPROCS'], ['GOMEMLIMIT'],
    ['LD_AUDIT'], ['LD_DEBUG'], ['LD_DEBUG_OUTPUT'],
    Array.from({length:17},(_,i)=>`PROVIDER_${i}`),
  ]) assert.throws(() => parseProviderEnvNames(invalid));
});

test('env file accepts exactly required service tokens and declared provider values', () => {
  const env={ROSTER_TOKEN:'r'.repeat(24),ROSTER_RESOURCE_TOKEN:'s'.repeat(32),ROSTER_RESOURCE_ADMIN_TOKEN:'a'.repeat(32),OPENAI_API_KEY:'provider-fixture'};
  const result=validateServiceAndProviderEnv({env},['OPENAI_API_KEY']);
  assert.deepEqual(Object.fromEntries(Object.entries(result.providerEnv)),{OPENAI_API_KEY:'provider-fixture'});
  assert.deepEqual(result.tokens,{runtime:env.ROSTER_TOKEN,resource:env.ROSTER_RESOURCE_TOKEN,admin:env.ROSTER_RESOURCE_ADMIN_TOKEN});
  for (const invalid of [
    { ...env, EXTRA:'not-declared' },
    { ...env, OPENAI_API_KEY:undefined },
    { ...env, OPENAI_API_KEY:'' },
    { ...env, OPENAI_API_KEY:'x'.repeat(16*1024+1) },
    { ...env, ROSTER_TOKEN:'short' },
    { ...env, ROSTER_RESOURCE_ADMIN_TOKEN:env.ROSTER_RESOURCE_TOKEN },
  ]) assert.throws(() => validateServiceAndProviderEnv({env:invalid},['OPENAI_API_KEY']));
});
