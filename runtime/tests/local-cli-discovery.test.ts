import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostLocalCliDiscovery,cliCandidates,probeCli} from '../src/infrastructure/local-cli-discovery.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import type {RosterRuntime} from '../src/application/runtime.js';

test('npm CLI resolution uses Node without a shell and keeps status private',async()=>{
  const root=await mkdtemp(join(tmpdir(),'roster-cli-'));
  try {
    const codex=join(root,'node_modules','@openai','codex','bin','codex.js');
    const claude=join(root,'node_modules','@anthropic-ai','claude-code','cli.js');
    for(const file of [codex,claude]){await mkdir(join(file,'..'),{recursive:true});await writeFile(file,'');}
    let calls=0;
    const discovery=new HostLocalCliDiscovery({PATH:root},async(launch,args)=>{
      calls++;assert.ok(launch.prefix[0]);assert.equal(launch.command,process.execPath);
      return args[0]==='--version'?0:launch.prefix[0]===codex?0:1;
    });
    const rows=await discovery.inspect();
    assert.equal(rows[0].state,'ready');assert.equal(rows[1].state,'login_required');
    assert.deepEqual(discovery.launch('codex'),{command:process.execPath,prefix:[codex]});
    assert.equal(JSON.stringify(rows).includes(root),false);
    rows[0].state='unavailable';assert.equal((await discovery.inspect())[0].state,'ready');assert.equal(calls,4);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('explicit override never silently selects another installation; unknown auth stays unknown',async()=>{
  const candidates=await cliCandidates('codex',{ROSTER_CODEX_EXECUTABLE:'missing-cli'});
  assert.deepEqual(candidates,[{command:'missing-cli',prefix:[]}]);
  const missing=new HostLocalCliDiscovery({ROSTER_CODEX_EXECUTABLE:'missing-cli',ROSTER_CLAUDE_EXECUTABLE:'missing-cli'},async()=>null);
  assert.ok((await missing.inspect()).every(r=>r.state==='not_found'&&r.authenticated===null));
  assert.throws(()=>missing.launch('codex'));
  const unknown=new HostLocalCliDiscovery({ROSTER_CODEX_EXECUTABLE:process.execPath,ROSTER_CLAUDE_EXECUTABLE:process.execPath},async(_launch,args)=>args[0]==='--version'?0:null);
  assert.ok((await unknown.inspect()).every(r=>r.state==='unavailable'&&r.authenticated===null));
  const broken=new HostLocalCliDiscovery({ROSTER_CODEX_EXECUTABLE:process.execPath,ROSTER_CLAUDE_EXECUTABLE:process.execPath},async()=>null);
  assert.ok((await broken.inspect()).every(r=>r.state==='unavailable'&&r.installed&&r.authenticated===null));
});
test('status probes are bounded, noninteractive and return no stdout',async()=>{
  assert.equal(await probeCli({command:process.execPath,prefix:[]},['-e','console.log("private");process.exit(1)']),1);
  assert.equal(await probeCli({command:process.execPath,prefix:[]},['-e','setInterval(()=>{},1000)'],50),null);
});
test('local CLI inventory requires Runtime authentication',async()=>{
  const server=createRuntimeApi({id:'local'} as RosterRuntime,'test-token',undefined,{
    launch(){throw Error('not called');},async inspect(){return [{id:'codex',template_id:'codex-cli',state:'ready',installed:true,authenticated:true,checked_at:new Date().toISOString(),next_action:'select_template'}];}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  try{
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/local-clis`)).status,401);
    const response=await fetch(`http://127.0.0.1:${port}/admin/local-clis`,{headers:{Authorization:'Bearer test-token'}});
    assert.equal(response.status,200);assert.equal((await response.json()).clis[0].state,'ready');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
