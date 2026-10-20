import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {JsonSchemaAgentParameters} from '../src/infrastructure/agent-parameters.js';
import {RuntimeAgentCreation} from '../src/application/agent-creation.js';
import {authorCreationSources} from '../src/infrastructure/agent-creation-sources.js';
import type {AgentTemplate} from '../src/agent.js';
import {once} from 'node:events';
import {RosterRuntime} from '../src/application/runtime.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import {managedImplementation} from '../src/infrastructure/langchain-managed.js';
import {managedCreationSources} from '../src/infrastructure/managed-creation-sources.js';
import {saveAgentPreset} from '../src/application/agent-presets.js';
import {ManagedAgent,PROTOCOL} from '@roster/contracts';

const template:AgentTemplate={id:'developer',version:'1',name:'Developer',description:'Author rules',
 parameter_schema:{type:'object',additionalProperties:false,properties:{project:{type:'string',minLength:1},depth:{type:'integer',default:2},credential_env:{type:'string'}},required:['project']},credential_parameters:['credential_env'],
 create:context=>({spec:{id:context.id,name:context.name,description:'Author rules',statuses:['ok'],events:['complete'],skills:[],rules:[],capabilities:[]},execute:async(input,execution)=>({status:'ok',summary:String(execution.parameters?.project),output:{depth:execution.parameters?.depth,request:input.context.request,credential:!!context.credentials.get('DEV_API_KEY')},events:[],artifacts:[],metrics:{}})})};
test('author templates create one durable instance, retain resolved defaults and separate scoped vault access',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-creation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const storage=new FileRuntimeStorage(dir,'test'),parameters=new JsonSchemaAgentParameters();let calls=0;
 const sources=authorCreationSources([{...template,create:c=>{calls++;assert.equal(c.credentials.get('OTHER_API_KEY'),undefined);return template.create(c);}}],ref=>ref==='DEV_API_KEY'?'private-key':undefined);
 const service=new RuntimeAgentCreation('runtime',storage,parameters,sources);
 const catalogue=await service.catalogue([]);assert.equal(catalogue.creatable[0].parameter_schema.required?.[0],'project');assert.equal((catalogue.creatable[0] as any).parameters,undefined);
 const source=catalogue.creatable[0], command={protocol:'roster-agent-creation/1' as const,id:'original',source:{kind:source.kind,id:source.id,revision:source.revision},name:'My developer',parameters:{project:'roster',credential_env:'DEV_API_KEY'}};
 const [a,b]=await Promise.all([service.create(command,[]),service.create(command,[])]);assert.equal(a.agent.id,b.agent.id);assert.equal(Boolean(a.replayed)!==Boolean(b.replayed),true);
 assert.equal(calls,1);
 assert.equal((await storage.read()).agent_creations?.instances.length,1);
 assert.equal((await service.create(command,[])).agent.id,a.agent.id);
 await assert.rejects(service.create({...command,name:'Changed'},[]),/conflict/);
 await assert.rejects(service.create({...command,id:'missing',parameters:{}},[]),/rejected/);
 await assert.rejects(service.create({...command,id:'wrong',source:{...command.source,revision:'b'.repeat(64)}},[]),/source/);
 const recovered=new RuntimeAgentCreation('runtime',new FileRuntimeStorage(dir,'test'),parameters,sources);
 const agents=await recovered.agents(await storage.read());assert.equal(agents[0].parameters?.depth,2);assert.equal(agents[0].parameters?.project,'roster');
 assert.equal(JSON.stringify(a).includes('private-key'),false);assert.equal(JSON.stringify(await storage.read()).includes('private-key'),false);
 const drift=new RuntimeAgentCreation('runtime',storage,parameters,authorCreationSources([{...template,version:'2'}],()=>undefined));await assert.rejects(drift.agents(await storage.read()),/source/);
 assert.ok(calls>=1);
 await assert.rejects(storage.transact(r=>{r.agent_creations!.instances[0].parameters.project='changed-on-disk';}),/binding/);
 assert.equal((await storage.read()).agent_creations!.instances[0].parameters.project,'roster');
});

test('actual HTTP creates author templates and per-instance presets, validates intent and reopens without re-execution',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-creation-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const factory={create:managedImplementation},parameters=new JsonSchemaAgentParameters(),token='runtime-creation-service-at-least-24';
 const open=async()=>{
  const storage=new FileRuntimeStorage(dir,'test'),builtin=managedCreationSources(factory),author=authorCreationSources([template],()=>undefined);
  const creations=new RuntimeAgentCreation('runtime',storage,parameters,r=>[...builtin(r),...author(r)]);
  const runtime=new RosterRuntime('runtime',[],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},factory,{inspect:async()=>[]},undefined,undefined,undefined,undefined,parameters,creations);
  await runtime.initialize();const server=createRuntimeApi(runtime,token);server.listen(0,'127.0.0.1');await once(server,'listening');
  return {runtime,storage,server,url:'http://127.0.0.1:'+(server.address() as any).port,close:async()=>{await runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
 };
 let app=await open();const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 try {
  assert.equal((await fetch(app.url+'/agent-catalogue')).status,401);
  let catalogue:any=await (await fetch(app.url+'/agent-catalogue',{headers})).json();
  assert.equal(catalogue.existing.length,0);
  const source=catalogue.creatable.find((s:any)=>s.id==='developer');
  const command={protocol:'roster-agent-creation/1',id:'actual',source:{kind:source.kind,id:source.id,revision:source.revision},name:'Developer',parameters:{project:'original'}};
  const request=async(body:string,status:number)=>{const r=await fetch(app.url+'/admin/agent-creations',{method:'POST',headers,body});assert.equal(r.status,status);return r.json() as Promise<any>;};
  for(const invalid of [JSON.stringify({...command,team:'organization'}),JSON.stringify({...command,parameters:{}}),JSON.stringify(command).replace('"id":"actual"','"id":"actual","i\\u0064":"replacement"'),JSON.stringify(command)+' {}',JSON.stringify({...command,parameters:{project:'x'.repeat(160000)}})]){
    const response=await request(invalid,400);assert.equal(JSON.stringify(response).includes('replacement'),false);
  }
  assert.equal((await app.storage.read()).agent_creations,undefined);
  const receipt=await request(JSON.stringify(command),200);assert.equal(receipt.agent.name,'Developer');assert.equal(receipt.parameters,undefined);
  await request(JSON.stringify({...command,parameters:{project:'changed'}}),409);
  const exec=await fetch(app.url+'/executions',{method:'POST',headers,body:JSON.stringify({protocol:PROTOCOL,execution_id:'original-run',work_id:'work',agent_id:receipt.agent.id,input:{parameters:{project:'forged'}},context:{request:'Actual work',culture:'',history:[],knowledge:[]}})});
  assert.equal(exec.status,200);const result=(await exec.text()).trim().split('\n').map(l=>JSON.parse(l)).find(f=>f.type==='result').result;
  assert.equal(result.summary,'original');assert.equal(result.output.depth,2);assert.equal(result.output.request,'Actual work');
  await saveAgentPreset(app.storage,{id:'reviewer',name:'Reviewer',agent:ManagedAgent.parse({id:'preset',name:'Reviewer',kind:'echo',model:'model-first',instructions:'Company rule',credential_env:''})});
  catalogue=await app.runtime.creationCatalogue();const preset=catalogue.creatable.find((s:any)=>s.kind==='preset');
  const created=await request(JSON.stringify({protocol:'roster-agent-creation/1',id:'preset-original',source:{kind:preset.kind,id:preset.id,revision:preset.revision},name:'My reviewer',parameters:{model:'model-second'}}),200);
  const managed=(await app.storage.read()).managed_agents[0];assert.equal(managed.id,created.agent.id);assert.equal(managed.model,'model-second');assert.equal(managed.instructions,'Company rule');
  await saveAgentPreset(app.storage,{id:'reviewer',name:'Reviewer',agent:ManagedAgent.parse({id:'preset',name:'Reviewer',kind:'echo',model:'changed-template',instructions:'Changed rule',credential_env:''})});
  const admin:any=await (await fetch(app.url+'/admin',{headers})).json();assert.equal(admin.agent_creations,undefined);
  await app.close();app=await open();
  const replay=await request(JSON.stringify(command),200);assert.equal(replay.replayed,true);assert.equal(replay.agent.id,receipt.agent.id);assert.equal(replay.accepted_at,receipt.accepted_at);
  assert.equal((await app.storage.read()).managed_agents[0].model,'model-second');assert.equal((await app.storage.get('original-run'))?.state,'completed');
  assert.equal((await app.runtime.creationCatalogue()).existing.length,2);
  const publish=app.storage.publish.bind(app.storage);app.storage.publish=async()=>{throw Error('publish failed');};
  const uncertain={...command,id:'publish-lost',name:'Another developer'};
  await request(JSON.stringify(uncertain),503);app.storage.publish=publish;
  const recovered=await request(JSON.stringify(uncertain),200);assert.equal(recovered.replayed,true);
  assert.equal((await app.runtime.creationCatalogue()).existing.length,3);
 } finally {await app.close();}
});
