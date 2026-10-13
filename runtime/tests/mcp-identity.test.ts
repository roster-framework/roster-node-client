import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpConnections,McpChangeConflict,McpIdentityUnavailable,McpClientBindingDenied} from '../src/application/mcp-connections.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {FileMcpIdentityFingerprint} from '../src/infrastructure/mcp-identity-fingerprint.js';
import {createRuntimeApi} from '../src/interfaces/http.js';
import type {RosterRuntime} from '../src/application/runtime.js';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';

function setup(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'roster-mcp-identity-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const storage=new FileRuntimeStorage(directory,'local');
  const env={PRIVATE_MCP_TOKEN:'not-a-public-credential'};
  let inspected=0;
  let inspect:()=>Promise<string[]>=async()=>['read','write'];
  const service=()=>new McpConnections('runtime-one',storage,{inspect:async()=>{inspected++;return inspect();}},new FileMcpIdentityFingerprint(directory,env));
  return {directory,storage,env,service,inspected:()=>inspected,inspect:(fn:()=>Promise<string[]>)=>{inspect=fn;}};
}
const configuration={id:'documents',name:'Private documents',url:'https://private.example/mcp?secret=private-value',token_env:'PRIVATE_MCP_TOKEN'};
function command(request_id:string,expected_revision:string|null=null,config=configuration){return {protocol:'roster-mcp-change/1',request_id,connection_id:'documents',expected_revision,action:'upsert',configuration:config};}

test('live client binding freezes resolved credentials and cannot borrow replacement or rotated revisions',async t=>{
  const f=setup(t),service=f.service();await service.initialize();
  const first=await service.change(command('create'));
  const input={...configuration},bound=await service.bindClient(input);
  assert.equal(bound.revision,first.revision);
  assert.equal(bound.credential,f.env.PRIVATE_MCP_TOKEN);
  input.url='https://caller-mutated.example/mcp';
  assert.equal(bound.configuration.url,configuration.url);
  await service.assertClient(configuration.id,bound.revision,'read');
  await assert.rejects(service.assertClient(configuration.id,bound.revision,'password'),McpClientBindingDenied);
  f.env.PRIVATE_MCP_TOKEN='new-private-credential';
  await assert.rejects(service.assertClient(configuration.id,bound.revision,'read'),McpClientBindingDenied);
  assert.equal(bound.credential,'not-a-public-credential');
  const rotated=await service.bindClient(configuration);
  assert.notEqual(rotated.revision,bound.revision);
  assert.equal(rotated.credential,'new-private-credential');
  const changed={...configuration,url:'https://changed.example/mcp'};
  await service.change(command('replace',rotated.revision,changed));
  await assert.rejects(service.bindClient(configuration),McpClientBindingDenied);
  await assert.rejects(service.assertClient(configuration.id,rotated.revision,'read'),McpClientBindingDenied);
  const replacement=await service.bindClient(changed);
  await f.service().assertClient(configuration.id,replacement.revision,'read');
  await service.change({protocol:'roster-mcp-change/1',request_id:'remove',connection_id:'documents',expected_revision:replacement.revision,action:'remove'});
  await assert.rejects(service.assertClient(configuration.id,replacement.revision,'read'),McpClientBindingDenied);
  await assert.rejects(service.bindClient(changed),McpClientBindingDenied);
});

test('missing credential refuses client binding without including private configuration in errors',async t=>{
  const f=setup(t),service=f.service();await service.initialize();
  await service.change(command('create'));
  delete (f.env as Record<string,string|undefined>).PRIVATE_MCP_TOKEN;
  await assert.rejects(service.bindClient(configuration),error=>{
    assert.ok(error instanceof McpClientBindingDenied);
    assert.ok(!String(error).includes('private'));
    return true;
  });
});

test('connection identity survives reopen; replacement, credential rotation and delete/recreate never reuse revisions',async t=>{
  const f=setup(t),service=f.service();await service.initialize();
  const first=await service.change(command('create'));
  assert.equal((await f.service().catalogue()).connections[0].revision,first.revision);
  const publicValue=JSON.stringify(await service.catalogue());
  for(const secret of ['private.example','PRIVATE_MCP_TOKEN','not-a-public-credential','private-value','fingerprint'])assert.ok(!publicValue.includes(secret));
  const next=await service.change(command('replace',first.revision,{...configuration,url:'https://changed.example/mcp'}));
  assert.notEqual(next.revision,first.revision);
  f.env.PRIVATE_MCP_TOKEN='rotated-private-credential';
  const rotated=(await f.service().catalogue()).connections[0];assert.notEqual(rotated.revision,next.revision);
  await assert.rejects(service.change(command('stale',next.revision)),McpChangeConflict);
  assert.equal(f.inspected(),2);
  const replay=await service.change(command('create'));assert.equal(replay.replayed,true);assert.equal(replay.revision,first.revision);assert.equal(f.inspected(),2);
  await assert.rejects(service.change(command('create',null,{...configuration,name:'changed command'})),McpChangeConflict);
  const removed=await service.change({protocol:'roster-mcp-change/1',request_id:'remove',connection_id:'documents',expected_revision:rotated.revision,action:'remove'});
  const tombstone=(await f.service().catalogue()).connections[0];assert.equal(tombstone.state,'removed');assert.deepEqual(tombstone.tools,[]);
  await assert.rejects(service.change(command('recreate-wrong')),McpChangeConflict);
  const recreated=await service.change(command('recreate',removed.revision));assert.notEqual(recreated.revision,removed.revision);
  assert.equal((await f.service().change(command('create'))).revision,first.revision);
});

test('concurrent inspect, changed credentials and in-use removal cannot partially commit',async t=>{
  const f=setup(t),service=f.service();await service.initialize();
  let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});
  f.inspect(async()=>{await pending;return ['read'];});
  const a=service.change(command('a')),b=service.change(command('b'));
  // Both initial checks finish before inspection is released.
  await new Promise(r=>setImmediate(r));release();
  const results=await Promise.allSettled([a,b]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const current=(await service.catalogue()).connections[0];
  const before=JSON.stringify((await f.storage.read()).mcp_connections);
  f.inspect(async()=>{f.env.PRIVATE_MCP_TOKEN='changed-during-inspection';return ['read'];});
  await assert.rejects(service.change(command('credential-race',current.revision)),McpChangeConflict);
  assert.equal(JSON.stringify((await f.storage.read()).mcp_connections),before);
  const rotated=(await service.catalogue()).connections[0];
  await f.storage.transact(r=>r.managed_agents.push({id:'consumer',mcp_ids:['documents']} as never));
  await assert.rejects(service.change({protocol:'roster-mcp-change/1',request_id:'remove',connection_id:'documents',expected_revision:rotated.revision,action:'remove'}),McpChangeConflict);
  assert.equal((await service.catalogue()).connections[0].state,'active');
});

test('legacy migration is durable; corrupted ledger or missing host key fails closed',async t=>{
  const f=setup(t);
  await f.storage.transact(r=>r.mcp_connections.push({config:configuration,tools:['read'],checked:new Date().toISOString()}));
  const service=f.service();await service.initialize();
  const first=(await service.catalogue()).connections[0].revision;
  assert.equal((await f.service().catalogue()).connections[0].revision,first);
  unlinkSync(join(f.directory,'mcp-identity.key'));
  assert.throws(()=>f.service(),McpIdentityUnavailable);
  const path=join(f.directory,'registry.json'),registry=JSON.parse(readFileSync(path,'utf8'));
  registry.mcp_identity.connections.push(registry.mcp_identity.connections[0]);
  writeFileSync(path,JSON.stringify(registry));
  await assert.rejects(f.storage.read(),McpIdentityUnavailable);
  await assert.rejects(service.catalogue(),McpIdentityUnavailable);
});

test('failed inspection is atomic and concurrent identical requests replay their original receipt',async t=>{
  const f=setup(t),service=f.service();await service.initialize();
  f.inspect(async()=>{throw Error('private provider detail');});
  await assert.rejects(service.change(command('inspect-failure')));
  assert.deepEqual((await service.catalogue()).connections,[]);
  assert.equal((await f.storage.read()).mcp_identity?.commands.length,0);
  f.inspect(async()=>['read']);
  const receipts=await Promise.all([service.change(command('same')),service.change(command('same'))]);
  assert.equal(receipts[0].revision,receipts[1].revision);
  assert.equal(receipts.filter(r=>r.replayed).length,1);
  assert.equal((await f.storage.read()).mcp_identity?.commands.length,1);
});

test('HTTP metadata requires service auth; strict commands, conflicts and private ledger projection',async t=>{
  const f=setup(t),service=f.service();await service.initialize();
  const runtime={id:'runtime-one',registry:f.storage,mcpConnections:service,
    manifest:async()=>({}),capacity:()=>({}),parameterDeclarations:async()=>({agents:[]})} as unknown as RosterRuntime;
  const token='test-service-token',server=createRuntimeApi(runtime,token);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(url+'/mcp-catalogue')).status,401);
  assert.equal((await fetch(url+'/admin/mcp-changes',{method:'POST',headers,body:'{"request_id":"one","request_id":"two"}'})).status,400);
  const create=await fetch(url+'/admin/mcp-changes',{method:'POST',headers,body:JSON.stringify(command('http-create'))});
  assert.equal(create.status,200);const receipt=await create.json();
  const descriptor=await (await fetch(url+'/mcp-connections/documents',{headers})).json();assert.equal(descriptor.revision,receipt.revision);
  assert.equal((await fetch(url+'/mcp-connections/missing',{headers})).status,404);
  const conflict=await fetch(url+'/admin/mcp-changes',{method:'POST',headers,body:JSON.stringify(command('stale'))});assert.equal(conflict.status,409);
  const admin=await (await fetch(url+'/admin',{headers})).json();assert.ok(!('mcp_identity' in admin));
  const path=join(f.directory,'registry.json'),registry=JSON.parse(readFileSync(path,'utf8'));registry.mcp_identity.version=999;writeFileSync(path,JSON.stringify(registry));
  const unavailable=await fetch(url+'/mcp-catalogue',{headers});assert.equal(unavailable.status,503);
  assert.ok(!(await unavailable.text()).includes('private-value'));
});
