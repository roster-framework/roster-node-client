import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResult, validateManifest, Workflow, TaskStep, QueueSchedule, Scheduler, RecurringWork, ManagedAgent } from '../dist/index.js';
test('agent step time limits retain defaults and reject unbounded or fractional limits', () => {
  const step={kind:'member',member_id:'agent',accept:['ok']};
  assert.equal(TaskStep.parse(step).timeout_seconds,undefined);
  assert.equal(TaskStep.parse({...step,timeout_seconds:0}).timeout_seconds,0);
  assert.equal(TaskStep.parse({...step,timeout_seconds:600}).timeout_seconds,600);
  for(const timeout_seconds of [-1,601,0.5,'5']) assert.equal(TaskStep.safeParse({...step,timeout_seconds}).success,false);
});
test('managed agents choose a provider while old settings remain OpenAI compatible', () => {
  const legacy = ManagedAgent.parse({id:'agent',name:'Agent',kind:'llm'});
  assert.equal(legacy.provider,'openai-compatible');
  assert.equal(legacy.version,0);
  assert.equal(ManagedAgent.safeParse({...legacy,version:-1}).success,false);
  assert.equal(ManagedAgent.parse({...legacy,provider:'anthropic'}).provider,'anthropic');
  assert.equal(ManagedAgent.parse({...legacy,provider:'future-provider'}).provider,'future-provider');
  assert.equal(ManagedAgent.safeParse({...legacy,provider:'../unsafe'}).success,false);
});
test('recurring work requires a named cadence and timezone-aware next run', () => {
  const recurring = {id:'weekly',unit_id:'team',title:'Feedback',request:'Summarize feedback',input:{},steps:[{kind:'member',member_id:'writer'}],scheduling:{priority:0},every_seconds:604800,next_run_at:'2026-10-05T00:00:00Z',active:true,version:0};
  assert.equal(RecurringWork.safeParse(recurring).success,true);
  assert.equal(RecurringWork.safeParse({...recurring,every_seconds:60}).success,false);
  assert.equal(RecurringWork.safeParse({...recurring,next_run_at:'2026-10-05T00:00:00'}).success,false);
});
const agent = {id:'sample',name:'Sample',description:'test',statuses:['accepted','custom123'],events:['sample.ready'],skills:[],rules:[],capabilities:[]};
test('scheduling preserves legacy defaults and validates priorities, timezones and limits', () => {
  assert.equal(QueueSchedule.parse({}).priority, 0);
  assert.ok(QueueSchedule.safeParse({priority:2,not_before:'2026-10-01T10:00:00+09:00'}).success);
  assert.equal(QueueSchedule.safeParse({priority:3}).success,false);
  assert.equal(QueueSchedule.safeParse({not_before:'2026-10-01T10:00:00'}).success,false);
  assert.equal(Scheduler.safeParse({global_limit:4,runtime_limit:2,agent_limit:1,agent_limits:{'r/a':2}}).success,true);
  assert.equal(Scheduler.safeParse({global_limit:0,runtime_limit:2,agent_limit:1}).success,false);
  const rule={id:'r',on:'ready',target:{runtime_id:'r',agent_id:'a'},priority:2,delay_seconds:60};
  assert.equal(Workflow.parse({version:1,name:'priority',subscriptions:[rule]}).subscriptions[0].priority,2);
  assert.equal(Workflow.safeParse({version:1,name:'invalid',subscriptions:[{...rule,delay_seconds:-1}]}).success,false);
});
test('agent owns statuses and emitted events', () => {
  assert.equal(validateResult(agent,{status:'custom123',summary:'ok'}).status,'custom123');
  assert.throws(()=>validateResult(agent,{status:'success',summary:'bad'}));
  assert.throws(()=>validateResult(agent,{status:'accepted',summary:'bad',events:[{type:'undeclared'}]}));
});
test('manifest rejects duplicate agents and incompatible versions', () => {
  const manifest = {protocol:'roster/0.1',runtime_id:'local',name:'Local',engine:'langgraph',isolation:'trusted-local-process',agents:[agent,agent]};
  assert.throws(()=>validateManifest(manifest));
  assert.throws(()=>validateManifest({...manifest,agents:[{...agent,events:['complete','complete']}]}));
  assert.throws(()=>validateManifest({...manifest,agents:[agent],protocol:'roster/9.0'}));
});
test('workflow cannot define agents or ambiguous deliveries', () => {
  assert.equal(Workflow.safeParse({version:1,name:'x',agents:[],subscriptions:[]}).success,false);
  assert.equal(Workflow.safeParse({version:1,name:'x',subscriptions:[{id:'x',on:'a',target:{runtime_id:'r',agent_id:'a'},board:{team:'t',title:'x'}}]}).success,false);
});

test('artifact review step names a human member and preserves its instruction', () => {
  assert.deepEqual(TaskStep.parse({kind:'review', member_id:'reviewer', instruction:'Check the patch'}),
    {kind:'review',member_id:'reviewer',instruction:'Check the patch'});
});
