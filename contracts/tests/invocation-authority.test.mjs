import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InvocationAuthority} from '../dist/index.js';
test('invocation authority requires the exact private execution tuple and wire digest',()=>{
 const original={protocol:'roster-invocation-authority/1',execution_id:'run',work_id:'work',runtime_id:'runtime',agent_id:'agent',request_sha256:'a'.repeat(64)};
 assert.deepEqual(InvocationAuthority.parse(original),original);
 for(const changed of [{...original,protocol:'unknown'},{...original,request_sha256:undefined},{...original,request_sha256:'A'.repeat(64)},{...original,request_sha256:'a'.repeat(63)},{...original,runtime_id:'*'},{...original,input:{secret:'private'}},{...original,token:'private'}])assert.equal(InvocationAuthority.safeParse(changed).success,false);
});
