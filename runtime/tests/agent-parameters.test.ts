import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {PROTOCOL, ManagedAgent} from '@roster/contracts';
import {RosterRuntime} from '../src/application/runtime.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {JsonSchemaAgentParameters} from '../src/infrastructure/agent-parameters.js';
import {snapshotAgentParameters} from '../src/domain/agent-parameters.js';
import {managedImplementation} from '../src/infrastructure/langchain-managed.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import {createAgents} from '../examples/parameter-agent.js';

const validator = new JsonSchemaAgentParameters();
const schema = {type:'object',additionalProperties:false,properties:{
  project:{type:'string',minLength:1}, depth:{type:'integer',minimum:1,default:2},
  preferences:{type:'object',additionalProperties:false,properties:{language:{type:'string',default:'en'}},default:{}},
},required:['project']};

test('author declaration owns required values and defaults without coercion or mutation',()=>{
  const supplied={project:'roster'};
  const resolved=validator.resolve(schema,supplied);
  assert.deepEqual(resolved,{project:'roster',depth:2,preferences:{language:'en'}});
  assert.deepEqual(supplied,{project:'roster'});
  assert.throws(()=>validator.resolve(schema,{}),/rejected/);
  assert.throws(()=>validator.resolve(schema,{project:'roster',depth:'2'}),/rejected/);
  assert.throws(()=>validator.resolve(schema,{project:'roster',unknown:true}),/rejected/);
  assert.throws(()=>validator.resolve({...schema,additionalProperties:true},supplied),/closed object/);
  assert.throws(()=>validator.resolve({...schema,properties:{project:{type:'string',default:42}}},{}),/rejected/);
  assert.throws(()=>validator.resolve({...schema,properties:{project:{type:'string',mispelledKeyword:true}}},supplied),/rejected/);
  assert.throws(()=>snapshotAgentParameters({value:NaN}),/JSON/);
  assert.throws(()=>snapshotAgentParameters({value:undefined}),/JSON/);
  assert.throws(()=>validator.resolve({type:'object',additionalProperties:false,properties:{url:{type:'string',format:'uri'}}},{url:'invalid'}),/rejected/);
  assert.throws(()=>((resolved.preferences as any).language='ko'),TypeError);
});

test('HTTP execution separates author parameters, business payload and Core context; discovery has declarations only',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'roster-parameter-contract-'));
  const storage=new FileRuntimeStorage(directory,'test');
  const agents=createAgents({reviewer:{project:'roster'}});
  const runtime=new RosterRuntime('test',agents,storage,storage,storage,
    {execute:(agent,input,context)=>agent.execute(input,context)},
    {create:managedImplementation},{inspect:async()=>[]},undefined,undefined,undefined,undefined,validator);
  const token='parameter-contract-token-at-least-24';
  await runtime.initialize();
  const server=createRuntimeApi(runtime,token);server.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+(server.address() as any).port;
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  try {
    assert.equal((await fetch(url+'/agent-parameters')).status,401);
    const declaration:any=await (await fetch(url+'/agent-parameters',{headers})).json();
    assert.equal(declaration.protocol,'roster-agent-parameters/1');
    assert.deepEqual(declaration.agents[0].parameter_schema.required,['project']);
    assert.equal(declaration.agents[0].parameters,undefined);
    assert.equal(JSON.stringify(declaration).includes('private-creation-value'),false);
    for(const id of ['first','second']) {
      const response=await fetch(url+'/executions',{method:'POST',headers,body:JSON.stringify({
        protocol:PROTOCOL,execution_id:id,work_id:'work-1',agent_id:'reviewer',
        input:{parameters:{project:'forged',reviewDepth:'forged'},execution_id:'fake'},
        context:{request:'Actual task',culture:'',history:[],knowledge:[],
          core_instructions:{text:'Core rule',version:1,updated:'now',updated_by:'person'}},
      })});
      assert.equal(response.status,200);
      const frames=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
      const result=frames.find(frame=>frame.type==='result').result;
      assert.deepEqual(result.output,{project:'roster',reviewDepth:'standard',request:'Actual task',coreRule:'Core rule',execution:'first'===id?'first':'second'});
    }
    assert.deepEqual(agents[0].parameters,{project:'roster'});
    assert.equal((await storage.get('first'))?.state,'completed');
  } finally {await runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('invalid declared parameters fail startup before execution; built-in author schema exposes individual settings',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'roster-invalid-parameters-'));
  try {
    const storage=new FileRuntimeStorage(directory,'test');
    const runtime=new RosterRuntime('test',createAgents({reviewer:{project:''}}),storage,storage,storage,
      {execute:(agent,input,context)=>agent.execute(input,context)},
      {create:managedImplementation},{inspect:async()=>[]},undefined,undefined,undefined,undefined,validator);
    await assert.rejects(runtime.initialize(),/rejected/);
    assert.equal(await storage.get('run'),undefined);
    const agent=managedImplementation(ManagedAgent.parse({id:'reviewer',name:'Reviewer',kind:'echo',model:'selected'}),[]);
    const properties=agent.parameter_schema!.properties as Record<string,any>;
    assert.equal(properties.engine.default,'langgraph-node');
    assert.equal(properties.credential_env.default,'OPENAI_API_KEY');
    assert.equal(properties.execution_id,undefined);
    assert.equal(properties.core_instructions,undefined);
    assert.equal(agent.parameters!.model,'selected');
    assert.equal(agent.parameters!.engine,'langgraph-node');
    assert.equal(validator.resolve(agent.parameter_schema!,agent.parameters!).model,'selected');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('Core invocation snapshots retain receipt identity and rules across caller and agent mutation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'roster-invocation-snapshot-'));
  const storage=new FileRuntimeStorage(directory,'test');
  const agents=createAgents({reviewer:{project:'roster'}});
  agents[0].execute=async(input,context)=>{
    assert.equal(input.execution_id,'original');
    assert.equal(input.context.request,'Original request');
    assert.equal(input.context.core_instructions?.text,'Original rule');
    assert.throws(()=>{input.execution_id='forged';},TypeError);
    assert.throws(()=>{input.context.core_instructions!.text='forged';},TypeError);
    assert.throws(()=>{(input.input.preferences as any).language='forged';},TypeError);
    assert.equal(context.parameters!.project,'roster');
    return {status:'success',summary:'Retained invocation',output:{},events:[],artifacts:[],metrics:{}};
  };
  const runtime=new RosterRuntime('test',agents,storage,storage,storage,
    {execute:(agent,input,context)=>agent.execute(input,context)},
    {create:managedImplementation},{inspect:async()=>[]},undefined,undefined,undefined,undefined,validator);
  try {
    await runtime.initialize();
    const input={protocol:PROTOCOL,execution_id:'original',work_id:'work',agent_id:'reviewer',
      input:{preferences:{language:'en'}},context:{request:'Original request',culture:'',history:[],knowledge:[],
        core_instructions:{text:'Original rule',version:1,updated:'now',updated_by:'person'}}};
    const pending=runtime.run(input,()=>{});
    input.execution_id='caller-forged';
    input.context.request='Caller changed request';
    input.context.core_instructions.text='Caller changed rule';
    await pending;
    assert.equal((await storage.get('original'))?.state,'completed');
    assert.equal(await storage.get('forged'),undefined);
    assert.equal(await storage.get('caller-forged'),undefined);
    assert.equal(runtime.capacity().active,0);
  } finally {await runtime.close();await rm(directory,{recursive:true,force:true});}
});
