import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from './resource.mjs';

test('subscription CLI preserves opaque numbers and repeats the original request without retrying failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'resource-cli-'));
 try {
  const file=join(dir,'command.json');
  const raw='{"resource_id":"slack-custom","configuration":{"cursor":9007199254740993},"id":"original"}';
  await writeFile(file,raw);
  const calls=[];
  const env={ROSTER_RESOURCE_TOKEN:'service-test-token-'.repeat(3)};
  const request=async(url,options)=>{calls.push({path:url.pathname,...options});return {ok:true,json:async()=>({replayed:calls.length>1})};};
  await run(['configure-subscription',file],env,request);
  const receipt=await run(['configure-subscription',file],env,request);
  assert.equal(receipt.replayed,true);
  for(const call of calls){assert.equal(call.body,raw);assert.equal(call.path,'/v1/resources/slack-custom/subscription-configurations');assert.equal(call.redirect,'error');assert.equal(call.headers.Authorization,'Bearer '+env.ROSTER_RESOURCE_TOKEN);}
  let failures=0;
  await assert.rejects(run(['configure-subscription',file],env,async()=>{failures++;return {ok:false,status:409};}),/409/);
  assert.equal(failures,1);
  await writeFile(file,'{"resource_id":"../private"}');
  await assert.rejects(run(['configure-subscription',file],env,request),/Invalid resource ID/);
  assert.equal(calls.length,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
