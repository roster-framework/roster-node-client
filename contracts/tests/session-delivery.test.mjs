import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionDeliveryQuery, SessionDeliveryStatus, validateSessionDeliveryPage} from '../dist/index.js';

const item = (id, complete=false) => ({execution_id:id,work_id:'work',member_id:'member',unit_id:'original-team',confirmed_through:0,complete,state:complete?'complete':'pending'});
const attempt = {at:'2026-10-04T08:00:00.123456789Z',outcome:'error',stage:'archive',duration_ms:1,count:3,failures:2,consecutive_failures:1};
test('session delivery public schema preserves original scope and rejects private/misleading fields', () => {
  assert.deepEqual(SessionDeliveryQuery.parse({}),{state:'all',limit:50,after:''});
  const value={...item('run-a'),last_attempt:attempt};
  assert.deepEqual(SessionDeliveryStatus.parse(value),value);
  for(const change of [{runtime_url:'https://private.test'}, {consumer:'private'}, {body:'private'}, {confirmed_through:-1}, {confirmed_through:Number.MAX_SAFE_INTEGER+1}, {complete:true}, {last_attempt:{...attempt,failures:4}}, {last_attempt:{...attempt,consecutive_failures:0}}, {last_attempt:{...attempt,stage:'transfer'}}, {last_attempt:{...attempt,at:'yesterday'}}])
    assert.equal(SessionDeliveryStatus.safeParse({...value,...change}).success,false);
  assert.equal(SessionDeliveryStatus.safeParse({...value,last_attempt:{...attempt,outcome:'ok',stage:'transfer',consecutive_failures:0}}).success,true);
});
test('delivery pages reject non-progressing, oversized and filter-inconsistent responses', () => {
  assert.deepEqual(validateSessionDeliveryPage({items:[]}),{items:[]});
  assert.deepEqual(validateSessionDeliveryPage({items:[item('a')],next_after:'a'},{limit:1}),{items:[item('a')],next_after:'a'});
  for(const [page,query] of [
    [{items:[item('a'),item('a')]},{}], [{items:[item('b'),item('a')]},{}],
    [{items:[item('a')]},{after:'a'}], [{items:[],next_after:'a'},{}],
    [{items:[item('a')],next_after:'b'},{limit:1}], [{items:[item('a'),item('b')]},{limit:1}],
    [{items:[item('a',true)]},{state:'pending'}], [{items:[item('a')]},{state:'complete'}],
    [{items:[]},{limit:101}], [{items:[]},{after:'../private'}], [{items:[]},{state:'unknown'}],
  ]) assert.throws(()=>validateSessionDeliveryPage(page,query));
});
