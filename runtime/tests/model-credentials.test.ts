import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {FileModelCredentials} from '../src/infrastructure/model-credentials.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {RosterRuntime} from '../src/application/runtime.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import {ManagedAgent,Result,PROTOCOL} from '@roster/contracts';
import {managedImplementation} from '../src/infrastructure/langchain-managed.js';

test('credentials encrypt/reopen, redact HTTP and fail without modifying corrupt originals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-credentials-'));
 try {
  const store=new FileModelCredentials(dir,{OPENAI_API_KEY:'environment-value'});
  store.save({REVIEWER_API_KEY:'private-reviewer-key'});
  assert.equal(store.get('OPENAI_API_KEY'),'environment-value');
  const file=await readFile(join(dir,'model-credentials.enc'));
  assert.equal(file.includes(Buffer.from('private-reviewer-key')),false);
  assert.equal(new FileModelCredentials(dir,{}).get('REVIEWER_API_KEY'),'private-reviewer-key');
  for(const values of [{ROSTER_API_KEY:'value'},{NODE_API_KEY:'value'},{REVIEWER_API_KEY:'bad\nkey'},{REVIEWER_API_KEY:'next',INVALID:'key'}])assert.throws(()=>store.save(values));
  assert.deepEqual(await readFile(join(dir,'model-credentials.enc')),file);
  const storage=new FileRuntimeStorage(dir,'test');
  const runtime=new RosterRuntime('runtime',[],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)}, {create:managedImplementation},{inspect:async()=>[]},undefined,undefined,undefined,store);
  await runtime.initialize();const server=createRuntimeApi(runtime,'fixture-token-at-least-24-characters');server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
   const url='http://127.0.0.1:'+(server.address() as any).port;
   const headers={Authorization:'Bearer fixture-token-at-least-24-characters','Content-Type':'application/json'};
   assert.equal((await fetch(url+'/admin/credentials',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({REVIEWER_API_KEY:'must-not-save'})})).status,401);
   assert.deepEqual(await (await fetch(url+'/admin/credentials',{method:'PUT',headers,body:JSON.stringify({REVIEWER_API_KEY:'updated-private-key'})})).json(),{saved:true});
   const admin=await (await fetch(url+'/admin',{headers})).text();
   assert.equal(admin.includes('updated-private-key'),false);assert.ok(admin.includes('REVIEWER_API_KEY'));
   assert.equal((await fetch(url+'/admin/credentials',{headers})).status,404);
  } finally {await new Promise<void>(r=>server.close(()=>r()));await runtime.close();}
  const damaged=Buffer.from(file);damaged[28]^=1;await writeFile(join(dir,'model-credentials.enc'),damaged);
  assert.throws(()=>new FileModelCredentials(dir,{}),/unreadable/);
  assert.deepEqual(await readFile(join(dir,'model-credentials.enc')),damaged);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('multiple credential batches reopen and excessive aggregate size preserves the previous store',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-credentials-batches-'));
 try {
  const store=new FileModelCredentials(dir,{});
  const entries=(start:number,end:number,size:number)=>Object.fromEntries(Array.from({length:end-start},(_,index)=>['KEY_'+(start+index)+'_API_KEY','k'.repeat(size)]));
  store.save(entries(0,20,10));store.save(entries(20,21,10));
  assert.equal(new FileModelCredentials(dir,{}).references().length,21);
  store.save(entries(0,20,4000));
  const previous=await readFile(join(dir,'model-credentials.enc'));
  assert.throws(()=>store.save(entries(21,41,4000)),/byte limit/);
  assert.deepEqual(await readFile(join(dir,'model-credentials.enc')),previous);
  assert.equal(new FileModelCredentials(dir,{}).references().length,21);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('changing one agent preserves other configurations and in-flight creation parameters',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-agent-config-'));
 try {
  const storage=new FileRuntimeStorage(dir,'test');let unblock!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>unblock=r);
  const seen:any[]=[];
  const runtime=new RosterRuntime('runtime',[],storage,storage,storage,{execute:async(a,i,c)=>{seen.push({id:a.spec.id,parameters:c.parameters,request:i.context.request});if(i.execution_id==='first'){entered();await wait;}return Result.parse({status:'success',summary:'done'});}},
   {create:config=>({...managedImplementation(config,[]),parameters:{model:config.model,instructions:config.instructions}})}, {inspect:async()=>[]});
  const config=ManagedAgent.parse({id:'reviewer',name:'Reviewer',kind:'llm',model:'old-model',statuses:['success'],events:['complete']});
  await runtime.upsertAgent(config);await runtime.upsertAgent({...config,id:'developer'});
  const invocation=(id:string)=>({protocol:PROTOCOL,execution_id:id,work_id:'work',agent_id:'reviewer',input:{parameters:{model:'forged'}},context:{request:'Core request',culture:'',history:[],knowledge:[]}});
  const running=runtime.run(invocation('first'),()=>{});await started;
  await runtime.upsertAgent({...config,version:1,model:'new-model',instructions:'Senior reviewer'},true);
  assert.equal((await storage.read()).managed_agents.find(a=>a.id==='developer')?.model,'old-model');
  await assert.rejects(runtime.upsertAgent({...config,version:2,events:[]},true),/바뀌었습니다/);
  await assert.rejects(runtime.upsertAgent({...config,version:1,model:'stale'},true),/바뀌었습니다/);
  unblock();await running;await runtime.run(invocation('second'),()=>{});
  assert.equal(seen[0].parameters.model,'old-model');assert.equal(seen[1].parameters.model,'new-model');
  assert.equal(seen[1].parameters.instructions,'Senior reviewer');assert.equal(seen[0].request,'Core request');
  assert.equal((await new FileRuntimeStorage(dir,'test').read()).managed_agents.find(a=>a.id==='reviewer')?.model,'new-model');
  await runtime.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
