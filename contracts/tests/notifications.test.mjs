import test from 'node:test';
import assert from 'node:assert/strict';
import {NotificationConfigure} from '../dist/index.js';

test('notification configuration separates published events from actual subscription receipt', () => {
  const base={id:'notify',version:0,unit_id:'team',kind:'published',publisher_member_id:'designer',signal:'complete',resource_ids:['hook-a','hook-b'],template:'{"body":$body}',body_fields:['message'],enabled:true};
  assert.deepEqual(NotificationConfigure.parse(base),base);
  assert.ok(NotificationConfigure.safeParse({...base,kind:'received',subscription_id:'design-to-dev'}).success);
  assert.ok(NotificationConfigure.safeParse({...base,publisher_member_id:undefined,signal:undefined,event_type:'work.requested'}).success);
  for(const change of [{kind:'received'}, {event_type:'work.requested'}, {signal:undefined}, {subscription_id:'unexpected'}, {resource_ids:[]}, {resource_ids:['a','a']}, {body_fields:['a','a']}, {version:-1}, {destinations:[]}, {template:'x'.repeat(16001)}])
    assert.equal(NotificationConfigure.safeParse({...base,...change}).success,false);
});
