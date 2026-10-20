import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {PROTOCOL} from '@roster/contracts';
import {SqliteRuntimeOwnership} from '../src/infrastructure/sqlite-runtime-ownership.js';

test('real Runtime startup exposes bundled CLI templates and creates Claude and delegating Codex without model execution',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'roster-cli-main-'));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const token=randomUUID(),env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ROSTER_')));
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/main.ts',import.meta.url))],{
    env:{...env,ROSTER_DATA_DIR:dir,ROSTER_TOKEN:token,ROSTER_RUNTIME_ID:'local-test',PORT:String(port),ROSTER_CODEX_EXECUTABLE:process.execPath,ROSTER_CLAUDE_EXECUTABLE:process.execPath},stdio:'ignore',windowsHide:true
  });
  const base=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  try{
    let ready=false;
    for(let i=0;i<300;i++){try{ready=(await fetch(base+'/health')).ok;}catch{}if(ready)break;if(child.exitCode!==null)break;await delay(100);}
    assert.ok(ready,'Runtime did not start');
    const catalogue=await (await fetch(base+'/agent-catalogue',{headers})).json();
    for(const id of ['codex-cli','codex-cli-delegating','codex-cli-collaborating','claude-code-cli'])assert.ok(catalogue.creatable.some((s:any)=>s.id===id));
    for(const templateID of ['claude-code-cli','codex-cli-delegating','codex-cli-collaborating']) {
      const source=catalogue.creatable.find((s:any)=>s.id===templateID);
      const response=await fetch(base+'/admin/agent-creations',{method:'POST',headers,body:JSON.stringify({protocol:'roster-agent-creation/1',id:'create-'+templateID,source:{kind:source.kind,id:source.id,revision:source.revision},name:'Reviewer',parameters:{project:dir}})});
      assert.equal(response.status,200);const receipt=await response.json();assert.ok(receipt.agent.id);assert.deepEqual(receipt.agent.events,['complete','fail']);
    }
    const inventory=await (await fetch(base+'/admin/local-clis',{headers})).json();assert.equal(inventory.clis.length,2);
    assert.equal(JSON.stringify(inventory).includes(process.execPath),false);
  }finally{
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await rm(dir,{recursive:true,force:true});
  }
});


test('local ownership never steals a live transaction and explicit release allows the next owner',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-owner-lock-'));
 const first=new SqliteRuntimeOwnership(dir),second=new SqliteRuntimeOwnership(dir);
 t.after(async()=>{second.release();first.release();await rm(dir,{recursive:true,force:true});});
 first.acquire();first.acquire();
 assert.throws(()=>second.acquire(),/ownership unavailable/);
 first.release();first.release();second.acquire();
 assert.throws(()=>first.acquire(),/ownership unavailable/);
});

test('second real Runtime cannot load agents or recover live originals; a killed owner permits recovery without rerun',{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'roster-main-owner-'));
 const children:ReturnType<typeof spawn>[]=[];
 t.after(async()=>{
  for(const child of children)if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  await rm(dir,{recursive:true,force:true});
 });
 const token=randomUUID(),modulePath=join(dir,'agents.mjs'),loaded=join(dir,'module-loads.txt'),executed=join(dir,'agent-executions.txt');
 await writeFile(modulePath,`
  import {appendFile} from 'node:fs/promises';
  export async function createAgents(){
   await appendFile(${JSON.stringify(loaded)},'loaded\\n');
   return [{spec:{id:'ownership-probe',name:'Probe',description:'test',statuses:['ok'],events:[],skills:[],rules:[],capabilities:[]},
    async execute(_,ctx){await appendFile(${JSON.stringify(executed)},'executed\\n');ctx.log('Original owned output');
     await new Promise((resolve,reject)=>{ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true});});}}];
  }
 `);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ROSTER_')));
 async function launch(){
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/main.ts',import.meta.url))],{
   env:{...env,OPENAI_API_KEY:'',ROSTER_DATA_DIR:dir,ROSTER_TOKEN:token,ROSTER_AGENT_MODULE:modulePath,ROSTER_RUNTIME_ID:'owner-test',PORT:String(port)},
   stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);
  let diagnostic='';child.stderr!.on('data',chunk=>{diagnostic+=String(chunk);});
  return {child,base:`http://127.0.0.1:${port}`,diagnostic:()=>diagnostic};
 }
 async function ready(server:Awaited<ReturnType<typeof launch>>){
  for(let i=0;i<300;i++){
   if(server.child.exitCode!==null)break;
   try{if((await fetch(server.base+'/health',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
   await delay(100);
  }
  throw Error('Owned Runtime did not become ready');
 }
 const first=await launch();await ready(first);
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json','X-Roster-Session-Consumer':'core','X-Roster-Service-Protocol':'roster-session-delivery/1'};
 const response=await fetch(first.base+'/executions',{method:'POST',headers:{...headers,'X-Roster-Session-Stream':'2'},body:JSON.stringify({protocol:PROTOCOL,execution_id:'owned-run',work_id:'work',agent_id:'ownership-probe',input:{},context:{request:'test',culture:'',history:[],knowledge:[]}})});
 assert.equal(response.status,200);await response.body!.cancel();
 let original:any;
 for(let i=0;i<100;i++){
  original=await (await fetch(first.base+'/executions/owned-run/records',{headers})).json();
  if(original.entries?.some((e:any)=>e.entry.text==='Original owned output'))break;
  await delay(50);
 }
 assert.equal(original.sealed,false);assert.ok(original.entries.some((e:any)=>e.entry.text==='Original owned output'));
 const receipt=await readFile(join(dir,'executions','owned-run.json'),'utf8');assert.equal(JSON.parse(receipt).state,'running');
 const second=await launch();const [code]=await once(second.child,'exit');assert.notEqual(code,0);
 assert.match(second.diagnostic(),/Runtime data directory ownership unavailable/);
 assert.equal(await readFile(loaded,'utf8'),'loaded\n');
 assert.equal(await readFile(join(dir,'executions','owned-run.json'),'utf8'),receipt);
 assert.deepEqual(await (await fetch(first.base+'/executions/owned-run/records',{headers})).json(),original);
 const exited=once(first.child,'exit');first.child.kill('SIGKILL');await exited;
 const next=await launch();await ready(next);
 assert.equal(JSON.parse(await readFile(join(dir,'executions','owned-run.json'),'utf8')).state,'attention');
 const recovered=await (await fetch(next.base+'/executions/owned-run/records',{headers})).json();
 assert.deepEqual(recovered.entries.slice(0,original.entries.length),original.entries);
 assert.equal(recovered.entries.length,original.entries.length+1);assert.equal(recovered.entries.at(-1).entry.id,'journal.recovered');
 assert.equal(recovered.sealed,true);assert.equal(await readFile(loaded,'utf8'),'loaded\nloaded\n');
 assert.equal(await readFile(executed,'utf8'),'executed\n');
 assert.ok(!recovered.entries.some((e:any)=>e.entry.kind==='result'));
 if(process.platform!=='win32') {
  const stopped=once(next.child,'exit');next.child.kill('SIGTERM');const [code]=await stopped;assert.equal(code,0);
  const following=await launch();await ready(following);
  assert.deepEqual(await (await fetch(following.base+'/executions/owned-run/records',{headers})).json(),recovered);
  assert.equal(await readFile(executed,'utf8'),'executed\n');
 }
});
