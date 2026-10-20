import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTemplates, resultFor } from './codex/agent.mjs';
import { childEnvironment, promptFor } from './codex/prompt.mjs';
test('normal exit does not override help, errors or cancellation', () => {
  for (const override of [{ final: JSON.stringify({status:'needs_help',summary:'Login required',minutes:''}) }, {code:1}, {failed:true}, {stopped:true}, {final:'invalid'}]) {
    const receipt = {code:0,final:JSON.stringify({status:'success',summary:'Done',minutes:''}),...override};
    assert.equal(resultFor(receipt, 1).events[0].type, 'fail');
  }
});
test('minutes are artifacts and events remain local', () => {
  const result = resultFor({code:0,final:JSON.stringify({status:'success',summary:'Discussed',minutes:'# Minutes'})}, 10);
  assert.equal(result.artifacts[0].name, 'minutes.md');
  assert.equal(result.events[0].type, 'complete');
});
test('desktop and runtime credentials are not inherited', () => {
  assert.deepEqual(childEnvironment({PATH:'bin',CODEX_HOME:'auth',CODEX_APP_TOOLS_PIPE_PATH:'private',ROSTER_TOKEN:'secret',OPENAI_API_KEY:'secret'}), {PATH:'bin',CODEX_HOME:'auth'});
});
test('queryable resources are excluded; prompt budget is enforced', () => {
  const prompt = promptFor({prompt:'Read docs',context:{knowledge:['SECRET_RESOURCE'],history:[],core_instructions:{text:'Persistent rule'}}}, {instructions:'Reviewer'});
  assert.ok(prompt.includes('Persistent rule')); assert.ok(!prompt.includes('SECRET_RESOURCE'));
  assert.throws(() => promptFor({context:{history:['x'.repeat(24001)]}}, {}), /24 KB/);
});
test('Core request is preserved in the actual invocation contract', () => {
  assert.ok(promptFor({context:{request:'Design the page',culture:'',history:[]}}, {}).includes('Design the page'));
});
test('factory only declares instances; no role or model is hardcoded', () => {
  const template = createAgentTemplates()[0];
  const agent = template.create({id:'reviewer',name:'Reviewer',parameters:{project:'D:/project',model:'custom-model'}});
  assert.equal(agent.parameters.model, 'custom-model');
  assert.deepEqual(agent.spec.events, ['complete','fail']);
  assert.ok(!('team' in agent.spec));
});
