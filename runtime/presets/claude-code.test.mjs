import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentTemplates,resultFor} from './claude-code/agent.mjs';
import {runClaude} from './claude-code/process.mjs';

test('Claude preset uses resolved npm launch, project cwd and scoped MCP; no secret arguments',async()=>{
  const root=await mkdtemp(join(tmpdir(),'roster-claude-'));
  try{
    const fixture=join(root,'fixture.mjs');
    await writeFile(fixture,`import fs from 'node:fs';fs.writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',is_error:false,session_id:'session-1',usage:{input_tokens:10},structured_output:{status:'success',summary:'Done '+process.env.ROSTER_CLAUDE_EXECUTION_MCP_TOKEN,minutes:'notes'}})));`);
    const template=createAgentTemplates({resolveLaunch:async()=>({command:process.execPath,prefix:[fixture]})})[0];
    const agent=template.create({id:'developer',name:'Developer',parameters:{project:root,model:'custom-model'}});
    const token='invocation-secret-'.repeat(3),logs=[];
    const result=await agent.execute({input:{},prompt:'Implement task'},{signal:new AbortController().signal,log:x=>logs.push(x),coreMcp:{url:'http://127.0.0.1:7330/mcp',token}});
    assert.equal(result.status,'success');assert.equal(result.output.session_id,'session-1');assert.equal(result.events[0].type,'complete');
    assert.equal(JSON.stringify(result).includes(token),false);assert.equal(JSON.stringify(logs).includes(token),false);
    const args=JSON.parse(await readFile(join(root,'args.json'),'utf8'));
    assert.equal(JSON.stringify(args).includes(token),false);assert.ok(args.includes('--strict-mcp-config'));assert.ok(args.includes('Read,Grep,Glob'));assert.ok(args.includes('custom-model'));
    assert.equal(args.includes('--dangerously-skip-permissions'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('Claude success requires structured success plus a successful final CLI result',()=>{
  const receipt={code:0,stopped:false,result:{type:'result',is_error:false,structured_output:{status:'success',summary:'done',minutes:''}}};
  assert.equal(resultFor(receipt,1).status,'success');
  for(const changed of [{code:1},{stopped:true},{result:{...receipt.result,is_error:true}},{result:{type:'result',is_error:false}}])
    assert.equal(resultFor({...receipt,...changed},1).events[0].type,'fail');
});
test('Claude cancellation stops a live CLI and cannot return successful work',async()=>{
  const root=await mkdtemp(join(tmpdir(),'roster-claude-stop-'));
  try{
    const script=join(root,'wait.mjs');await writeFile(script,'process.stdin.resume();setInterval(()=>{},1000);');
    const controller=new AbortController();
    const pending=runClaude({command:process.execPath,prefix:[script]},[],'request',root,{signal:controller.signal},30);
    setTimeout(()=>controller.abort(),100);
    const receipt=await pending;
    assert.equal(receipt.stopped,true);assert.equal(resultFor(receipt,1).status,'needs_help');
  }finally{await rm(root,{recursive:true,force:true});}
});
