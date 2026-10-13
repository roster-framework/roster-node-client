import test from 'node:test';
import assert from 'node:assert/strict';
import {Workflow, Invocation} from '../dist/index.js';

test('structural subscriptions require a single publisher and recipient', () => {
  const rule={id:'design-ready',on:'complete',from_member_id:'designer',target_member_id:'developer',instruction:'Implement',resource_ids:['figma']};
  assert.equal(Workflow.parse({version:1,name:'Flow',subscriptions:[rule]}).subscriptions[0].from_member_id,'designer');
  assert.equal(Workflow.safeParse({version:1,name:'Flow',subscriptions:[{...rule,from:{runtime_id:'r',agent_id:'a'}}]}).success,false);
  assert.equal(Workflow.safeParse({version:1,name:'Flow',subscriptions:[{...rule,target:{runtime_id:'r',agent_id:'a'}}]}).success,false);
});
test('invocation preserves per-subscription context separately from untrusted input', () => {
  const delivery={owner_member_id:'owner',recipient_member_id:'developer',publisher_member_id:'designer',signal:'complete',instruction:'Implement',resource_ids:['figma']};
  const parsed=Invocation.parse({protocol:'roster/0.1',execution_id:'run',work_id:'work',agent_id:'agent',input:{subscription_delivery:'untrusted'},context:{request:'Task',culture:'',history:[],knowledge:[],subscription_delivery:delivery}});
  assert.deepEqual(parsed.context.subscription_delivery,delivery);
  assert.equal(parsed.input.subscription_delivery,'untrusted');
});
