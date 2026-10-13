import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateProviderChangeCommand,validateProviderChangeProgress,providerChangeFingerprint} from '../dist/index.js';

const command={version:1,id:'change',expected_revision:0,member_id:'developer',previous:{runtime_id:'runtime',agent_id:'old'},next:{runtime_id:'runtime',agent_id:'new'},binding_version:0,actor:{account_id:'account',member_id:'person'}};
test('provider commands and progress bind all original fields to Core canonical fingerprints',async()=>{
 const fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex');
 assert.equal(await providerChangeFingerprint(command),fingerprint);
 assert.equal(await providerChangeFingerprint({actor:command.actor,...command,next:{agent_id:'new',runtime_id:'runtime'}}),fingerprint);
 for(const stage of ['new','held','accepted-pending','aborted-pending','accepted','aborted']){
  const progress={version:1,command_id:command.id,fingerprint,stage,binding_version:stage.startsWith('accepted')?1:0,work_revision:stage==='accepted'?1:0};
  assert.deepEqual(await validateProviderChangeProgress(progress,command),progress);
  for(const patch of [{command_id:'other'},{fingerprint:'b'.repeat(64)},{work_revision:3},{binding_version:3},{stage:'unknown'},{private:'data'}])await assert.rejects(validateProviderChangeProgress({...progress,...patch},command));
 }
 for(const patch of [{expected_revision:Number.MAX_SAFE_INTEGER},{binding_version:Number.MAX_SAFE_INTEGER},{actor:{...command.actor,account_id:'../other'}},{next:command.previous},{version:0},{extra:true}])assert.throws(()=>validateProviderChangeCommand({...command,...patch}));
 const huge={...command,expected_revision:Number.MAX_SAFE_INTEGER-1,binding_version:Number.MAX_SAFE_INTEGER-1};
 await validateProviderChangeProgress({version:1,command_id:huge.id,fingerprint:await providerChangeFingerprint(huge),stage:'accepted',binding_version:Number.MAX_SAFE_INTEGER,work_revision:Number.MAX_SAFE_INTEGER},huge);
});
