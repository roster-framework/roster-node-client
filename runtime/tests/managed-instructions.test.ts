import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {ManagedAgent,PROTOCOL} from '@roster/contracts';
import {managedImplementation} from '../src/infrastructure/langchain-managed.js';

test('the agent loop and final structured response receive Runtime and Core instructions',async()=>{
  const requests:Record<string,any>[]=[];
  const usage:Record<string,any>[]=[];
  const expected={status:'success',summary:'Runtime rule; Core rule',output:'Rules retained',event:'complete'};
  const server=createServer(async(req,res)=>{
    const parts:Buffer[]=[];
    for await(const chunk of req)parts.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(parts).toString());requests.push(body);
    const structured=(body.tools ?? []).map((t:any)=>t.function).find((t:any)=>t.parameters?.properties?.status);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:body.model,
      choices:[{index:0,message:{role:'assistant',content:structured?null:JSON.stringify(expected),
        ...(structured?{tool_calls:[{id:'result',type:'function',function:{name:structured.name,arguments:JSON.stringify(expected)}}]}:{})},
        finish_reason:structured?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const config=ManagedAgent.parse({id:'reviewer',name:'Reviewer',kind:'llm',model:'fixture-model',credential_env:'',
      base_url:'http://127.0.0.1:'+(server.address() as any).port+'/v1',instructions:'Runtime rule',events:['complete'],
      model_parameters:{maxRetries:0}});
    const result=await managedImplementation(config,[]).execute({protocol:PROTOCOL,execution_id:'run',work_id:'work',agent_id:'reviewer',
      input:{},context:{request:'Check rules',culture:'Organization rule',history:[],knowledge:[],
        core_instructions:{text:'Core rule',version:1,updated:'now',updated_by:'person'}}},
      {workspace:'',signal:new AbortController().signal,log:()=>{},recordSession:note=>{if(note.text.startsWith('Model usage: '))usage.push(JSON.parse(note.text.slice('Model usage: '.length)))}});
    assert.equal(result.summary,expected.summary);
    assert.equal(requests.length,2);
    assert.deepEqual(usage.map(v=>[v.phase,v.input_tokens,v.output_tokens,v.cached_input_tokens]),[['loop',10,10,null],['final',10,10,null]]);
    assert.equal(new Set(usage.map(v=>v.invocation_id)).size,2);
    assert.ok(!JSON.stringify(usage).includes('Runtime rule'));
    assert.ok(requests[1].response_format?.type==='json_schema' || requests[1].tools?.some((t:any)=>t.function.parameters.properties.status));
    for(const body of requests){
      const system=body.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n');
      assert.ok(system.includes('Runtime rule'),'Runtime instructions must reach every model phase');
      assert.ok(system.includes('Core rule'),'Core instructions must reach every model phase');
      assert.ok(system.includes('Organization rule'),'Organization rules must reach every model phase');
    }
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
