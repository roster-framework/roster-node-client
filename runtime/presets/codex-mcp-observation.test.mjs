import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coreToolObservation} from './codex/mcp-observation.mjs';
test('records actual Core transport outcome once without arguments or results', () => {
  const seen = new Set();
  const event = {type: 'item.completed', item: {id: 'call-1', type: 'mcp_tool_call', server: 'roster', tool: 'roster_get_resource', status: 'completed', arguments: {credential: 'SECRET'}, result: {private: 'SECRET'}}};
  assert.equal(coreToolObservation(event, seen), 'Core MCP tool completed: roster_get_resource');
  assert.equal(coreToolObservation(event, seen), undefined);
  assert.equal(coreToolObservation({...event, item: {...event.item, id: 'call-2', error: {message: 'SECRET'}}}, seen), 'Core MCP tool failed: roster_get_resource');
  for (const patch of [{server: 'private-secret-server'}, {tool: 'SECRET'}, {type: 'reasoning'}, {status: 'in_progress'}, {id: ''}]) assert.equal(coreToolObservation({...event, item: {...event.item, id: 'call-3', ...patch}}, seen), undefined);
  assert.equal(coreToolObservation({...event, type: 'item.started'}, seen), undefined);
});

test('discussion and publication observations omit bodies, attachments and authorization details', () => {
  for (const tool of ['roster_create_discussion','roster_read_discussion','roster_append_discussion','roster_list_discussions','roster_publish_resource']) {
    const seen = new Set();
    const event = {type:'item.completed',item:{id:'discussion-call',type:'mcp_tool_call',server:'roster',tool,status:'completed',arguments:{text:'PRIVATE',actor_proof:'SECRET',attachments:[{resource_id:'hidden'}]},result:{thread:{messages:['PRIVATE']}}}};
    assert.equal(coreToolObservation(event,seen),`Core MCP tool completed: ${tool}`);
    assert.equal(coreToolObservation(event,seen),undefined);
    assert.equal(coreToolObservation({...event,item:{...event.item,id:'denied',error:{message:'SECRET'}}},seen),`Core MCP tool failed: ${tool}`);
  }
});
