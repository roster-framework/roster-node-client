import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCodex } from './codex/process.mjs';
import { resultFor } from './codex/agent.mjs';
import {runClaude} from './claude-code/process.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('real child JSONL works on host platform without shell or model calls', async () => {
  const controller = new AbortController(), logs = [], usages = [];
  const source = `process.stdin.resume(); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'success',summary:'Fixture done',minutes:''})}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));});`;
  const receipt = await runCodex(process.execPath, ['--input-type=module','-e',source], 'fixture input', {signal:controller.signal,log:text=>logs.push(text),recordModelUsage:usage=>usages.push(usage)}, 10);
  assert.equal(receipt.code, 0); assert.equal(logs.length, 1);
  assert.equal(resultFor(receipt, 1).status, 'success');
  assert.equal(receipt.usage.input_tokens, 2);
  assert.equal(usages.length,1); assert.equal(usages[0].input_tokens,2);
  assert.equal(usages[0].cached_input_tokens,null); assert.equal(usages[0].phase,'unknown');
});

test('cancellation terminates a live process and does not report success', {timeout:10000}, async () => {
  const controller = new AbortController();
  const source = `setInterval(()=>{},1000); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'started'}}));`;
  const receipt = await runCodex(process.execPath, ['--input-type=module','-e',source], '', {signal:controller.signal,log:()=>controller.abort()}, 8);
  assert.equal(receipt.stopped, true);
  assert.equal(resultFor(receipt, 1).status, 'needs_help');
});

test('actual child MCP events reach session records without secret payloads', async () => {
  const controller = new AbortController(), records = [];
  const event = {type:'item.completed',item:{id:'tool-1',type:'mcp_tool_call',server:'roster',tool:'roster_get_resource',status:'completed',arguments:{token:'PRIVATE_TOKEN'},result:{body:'PRIVATE_DOCUMENT'}}};
  const source = `process.stdin.resume();process.stdin.on('end',()=>{const event=${JSON.stringify(event)};console.log(JSON.stringify(event));console.log(JSON.stringify(event));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{}'}}));});`;
  const receipt = await runCodex(process.execPath, ['--input-type=module','-e',source], '', {signal:controller.signal,log:()=>{},recordSession:record=>records.push(record)}, 10);
  assert.equal(receipt.code, 0);
  assert.deepEqual(records, [{kind:'log',text:'Core MCP tool completed: roster_get_resource'}]);
  assert.ok(!JSON.stringify(records).includes('PRIVATE'));
});

test('POSIX cancellation kills a descendant holding the output pipe', {skip:process.platform==='win32',timeout:10000}, async () => {
  const controller = new AbortController();
  const source = `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]}); setInterval(()=>{},1000); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'started'}}));`;
  const receipt = await runCodex(process.execPath, ['--input-type=module','-e',source], '', {signal:controller.signal,log:()=>controller.abort()}, 8);
  assert.equal(receipt.stopped, true);
});

test('usage journal rejection terminates the child and rejects execution', {timeout:10000}, async () => {
  const controller = new AbortController();
  const source = `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));setInterval(()=>{},1000);`;
  await assert.rejects(runCodex(process.execPath,['--input-type=module','-e',source],'',
    {signal:controller.signal,log:()=>{},recordModelUsage:()=>{throw Error('journal unavailable');}},8),/journal unavailable/);
});

for(const provider of ['codex','claude'])for(const trigger of ['abort','timeout'])test(provider+' '+trigger+' retains escalation after the root exits while an ignored-output descendant resists SIGTERM',
 {skip:process.platform==='win32',timeout:10000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roster-cli-descendant-')),heartbeat=join(dir,'heartbeat');
  let descendant;
  t.after(async()=>{if(descendant){try{process.kill(descendant,'SIGKILL');}catch{}}await rm(dir,{recursive:true,force:true});});
  const pidFile=join(dir,'descendant.pid');
  const grandchild=`import {writeFileSync,appendFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(pidFile)},String(process.pid));appendFileSync(${JSON.stringify(heartbeat)},'started');process.send('ready');setInterval(()=>appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`;
  const root=`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>{process.stdout.write(${provider==='codex'?"JSON.stringify({type:'item.completed',item:{type:'agent_message',text:String(child.pid)}})+'\\n'":"String(child.pid)+'\\n'"});});setInterval(()=>{},1000);`;
  const controller=new AbortController();
  t.after(()=>controller.abort());
  const timeoutSeconds=trigger==='timeout'?0.5:8;
  let pending;
  if(provider==='codex')pending=runCodex(process.execPath,['--input-type=module','-e',root],'',
   {signal:controller.signal,log:text=>{descendant=Number(text);if(trigger==='abort')controller.abort();}},timeoutSeconds);
  else {
   pending=runClaude({command:process.execPath,prefix:[]},['--input-type=module','-e',root],'',dir,{signal:controller.signal},timeoutSeconds);
   // Claude output is a final JSON document, so observe the owned heartbeat.
   const deadline=Date.now()+3000;
   while(!descendant && Date.now()<deadline){try{await readFile(heartbeat);descendant=Number(await readFile(pidFile,'utf8'));if(trigger==='abort')controller.abort();break;}catch{await new Promise(r=>setTimeout(r,20));}}
   assert.ok(descendant,'Fixture descendant did not start');
  }
  const receipt=await pending;assert.equal(receipt.stopped,true);
  const before=await readFile(heartbeat,'utf8');await new Promise(r=>setTimeout(r,150));
  assert.equal(await readFile(heartbeat,'utf8'),before,'Descendant continued executing after cancellation completed');
 });
