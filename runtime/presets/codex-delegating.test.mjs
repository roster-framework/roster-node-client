import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTemplates} from './codex/delegating.mjs';
import {createAgentTemplates as baseTemplates} from './codex/agent.mjs';
import {coreMcpConfiguration} from './codex/core-mcp.mjs';

test('delegation is a separate template and does not alter existing read-only tool exposure', () => {
  const capability={url:'http://localhost:7330/mcp',token:'invocation-capability-example-'.repeat(2)};
  const base=coreMcpConfiguration(capability);
  assert.ok(!base.args.some(arg=>arg.includes('roster_call_agent')));
  assert.ok(!base.args.some(arg=>arg.includes('roster_get_delegated_result')));
  const delegated=coreMcpConfiguration(capability,{agentCalls:true});
  assert.ok(delegated.args.some(arg=>arg.includes('roster_call_agent')));
  assert.ok(delegated.args.some(arg=>arg.includes('roster_get_delegated_result')));
  assert.ok(delegated.args.some(arg=>arg.includes('roster_agent_events')));
  for (const tool of ['roster_create_discussion','roster_read_discussion','roster_append_discussion']) {
    assert.ok(!base.args.some(arg=>arg.includes(tool)));
    assert.ok(delegated.args.some(arg=>arg.includes(tool)));
  }
  assert.ok(!delegated.args.some(arg=>arg.includes(capability.token)));
  assert.deepEqual(delegated.env,base.env);
  const template=createAgentTemplates()[0], original=baseTemplates()[0];
  assert.equal(original.id,'codex-cli'); assert.equal(original.version,'2');
  assert.equal(template.id,'codex-cli-delegating'); assert.equal(template.version,'1');
  assert.deepEqual(template.parameter_schema,original.parameter_schema);
  const instance=template.create({id:'dispatcher',name:'Dispatcher',parameters:{project:'D:/project',model:'selected-model',instructions:'Delegate only selected tasks.'}});
  assert.equal(instance.parameters.model,'selected-model');
  assert.equal(instance.parameters.instructions,'Delegate only selected tasks.');
  assert.ok(!('team' in instance.spec));
  assert.deepEqual(instance.spec.events,['complete','fail']);
  assert.deepEqual(coreMcpConfiguration(undefined,{agentCalls:true}),{args:[],env:{}});
});
