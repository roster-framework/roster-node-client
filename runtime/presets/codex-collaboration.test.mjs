import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createAgentTemplates} from './codex/collaborating.mjs';
import {createAgentTemplates as legacyTemplates} from './codex/agent.mjs';
import {collaborationPrompt,finishCollaboration} from './codex/collaboration.mjs';

const input=()=>({execution_id:'execution-1',work_id:'work-1',input:{},prompt:'Build a small calculator'});
const waiting=()=>({status:'waiting',summary:'Implementation awaits the interface decision',minutes:'',wait:{id:'wait-1',thread_id:'thread-1',question_id:'question-1',responders:['designer'],join:'all',timeout_seconds:60}});
const receipt=report=>({code:0,final:JSON.stringify(report),failed:false,stopped:false});
const accepted=()=>({version:1,id:'wait-1',work_id:'work-1',execution_id:'execution-1',thread_id:'thread-1',question_id:'question-1',created:new Date().toISOString(),replayed:false});
const childWaiting=()=>({...waiting(),wait:{id:'wait-1',child_work_ids:['child-one','child-two'],join:'all',timeout_seconds:60}});
const childAccepted=()=>({version:2,id:'wait-1',work_id:'work-1',execution_id:'execution-1',created:new Date().toISOString(),replayed:false});
const suspended=new Error('host-suspended');

async function serverFor(t,reply) {
  const requests=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    requests.push({url:req.url,method:req.method,authorization:req.headers.authorization,body:JSON.parse(raw)});
    reply(req,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  let checks=0,checkpoint;
  const context={signal:new AbortController().signal,log:()=>{},coreMcp:{url:`http://127.0.0.1:${server.address().port}/mcp`,token:'PRIVATE_CAPABILITY'.repeat(4)},authorizeCoreConnection:async()=>{checks++;},suspendForReply:(id,state)=>{checkpoint={id,state};throw suspended;}};
  context.suspendForCompletion=context.suspendForReply;
  return {requests,context,checks:()=>checks,checkpoint:()=>checkpoint};
}

test('actual CLI child exits before host registration; resumed child receives original question references',async t=>{
  const f=await serverFor(t,(_req,res)=>res.end(JSON.stringify(accepted())));
  const dir=await mkdtemp(join(tmpdir(),'roster-collaboration-'));
  t.after(async()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&basename(dir).startsWith('roster-collaboration-'));await rm(dir,{recursive:true,force:true});});
  const report=waiting();
  const source=`let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
    if(prompt.includes('PRIVATE_CAPABILITY')||prompt.includes('Do not claim durable waiting/resumption')||!prompt.includes('Use waiting only')||!prompt.includes('parent_work_id to "work-1"'))process.exit(2);
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(report)})}}));
  });`;
  const template=createAgentTemplates({resolveLaunch:async()=>({command:process.execPath,prefix:['--input-type=module','-e',source]})})[0];
  assert.equal(template.id,'codex-cli-collaborating');
  const agent=template.create({id:'developer',name:'Developer',parameters:{project:dir}});
  await assert.rejects(agent.execute(input(),f.context),e=>e===suspended);
  assert.equal(f.checks(),2);assert.equal(f.requests.length,1);
  const request=f.requests[0];assert.equal(request.method,'POST');assert.equal(request.url,'/api/core/continuations/register');
  assert.equal(request.authorization,'Bearer '+f.context.coreMcp.token);
  assert.deepEqual(Object.keys(request.body).sort(),['deadline','id','join','question_id','responders','thread_id','version']);
  assert.deepEqual(request.body.responders,['designer']);
  const checkpoint=f.checkpoint();assert.equal(checkpoint.id,'wait-1');
  const continuation={reference:{wait_id:'wait-1',thread_id:'thread-1',question_id:'question-1'},checkpoint:checkpoint.state};
  const guidance=collaborationPrompt({...f.context,continuation},input());
  assert.match(guidance,/Read the original thread and actual replies/);assert.match(guidance,/Do not repeat the original question/);
  assert.ok(!guidance.includes(f.context.coreMcp.token));
  const resumedSource=`let p='';process.stdin.on('data',x=>p+=x);process.stdin.on('end',()=>{const ok=p.includes('"question_id":"question-1"')&&p.includes('Read the original thread and actual replies');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:ok?'success':'needs_help',summary:'Fixture checked resume guidance only',minutes:'',wait:null})}}));});`;
  const resumed=createAgentTemplates({resolveLaunch:async()=>({command:process.execPath,prefix:['--input-type=module','-e',resumedSource]})})[0].create({id:'developer',name:'Developer',parameters:{project:dir}});
  assert.equal((await resumed.execute(input(),{...f.context,continuation})).status,'success');
  assert.equal(f.requests.length,1,'terminal report must not register another wait');
  await assert.rejects(legacyTemplates()[0].create({id:'legacy',name:'Legacy',parameters:{project:dir}}).execute(input(),{...f.context,continuation}),/does not support checkpoint/);
});

test('delegated completion uses the same registration and suspension lifecycle and resumes through current result reads',async t=>{
  const f=await serverFor(t,(_req,res)=>res.end(JSON.stringify(childAccepted())));
  await assert.rejects(finishCollaboration(receipt(childWaiting()),input(),f.context),e=>e===suspended);
  assert.equal(f.checks(),2);assert.equal(f.requests.length,1);
  const command=f.requests[0].body;assert.equal(command.version,2);assert.deepEqual(command.child_work_ids,['child-one','child-two']);
  assert.equal(Object.hasOwn(command,'thread_id'),false);
  const checkpoint=f.checkpoint().state;
  const reference={protocol:'roster-execution-continuation/2',wait_id:'wait-1',children:[{request_id:'child-one',state:'completed'},{request_id:'child-two',state:'attention'}]};
  const guidance=collaborationPrompt({...f.context,continuation:{reference,checkpoint}},input());
  assert.match(guidance,/roster_get_delegated_result/);assert.match(guidance,/attention or cancelled does not mean success/);
  assert.match(guidance,/Do not repeat the original delegation/);assert.ok(!guidance.includes(f.context.coreMcp.token));
  for(const children of [[],reference.children.slice(0,1),[{request_id:'foreign'}],[reference.children[0],reference.children[0]]])assert.throws(()=>collaborationPrompt({...f.context,continuation:{reference:{...reference,children},checkpoint}},input()),/Invalid Codex collaboration checkpoint/);
  assert.match(collaborationPrompt({...f.context,continuation:{reference:{...reference,children:reference.children.slice(0,1)},checkpoint:{...checkpoint,join:'any'}}},input()),/unfinished children/);
});

test('invalid child selection, unsupported host, and mixed or wrong receipts cannot suspend',async t=>{
  const f=await serverFor(t,(_req,res)=>res.end(JSON.stringify(childAccepted())));
  for(const mutate of [w=>w.child_work_ids=[],w=>w.child_work_ids=['duplicate','duplicate'],w=>w.child_work_ids=Array.from({length:13},(_,i)=>'child-'+i),w=>w.thread_id='thread',w=>w.actor='forged']) {
    const report=childWaiting();mutate(report.wait);await assert.rejects(finishCollaboration(receipt(report),input(),f.context),/Invalid collaboration wait/);
  }
  await assert.rejects(finishCollaboration(receipt(childWaiting()),input(),{...f.context,suspendForCompletion:undefined}),/Invalid collaboration wait/);
  assert.equal(f.requests.length,0);assert.equal(f.checkpoint(),undefined);
  for(const reply of [accepted(),{...childAccepted(),execution_id:'other'},{...childAccepted(),thread_id:'unexpected'},{...childAccepted(),version:1}])await t.test(JSON.stringify(reply),async t=>{
    const bad=await serverFor(t,(_req,res)=>res.end(JSON.stringify(reply)));
    await assert.rejects(finishCollaboration(receipt(childWaiting()),input(),bad.context),/Invalid Core wait registration receipt/);
    assert.equal(bad.requests.length,1);assert.equal(bad.checkpoint(),undefined);
  });
});

test('rejected, redirected and malformed registration never suspend or retry',async t=>{
  for(const child of [false,true])for(const kind of ['denied','redirect','wrong-execution','extra-field','oversized','malformed']) await t.test((child?'child:':'question:')+kind,async t=>{
    const f=await serverFor(t,(_req,res)=>{
      if(kind==='denied'){res.writeHead(403);res.end('private diagnostic');return;}
      if(kind==='redirect'){res.writeHead(302,{Location:'/other'});res.end();return;}
      if(kind==='oversized'){res.end('x'.repeat(4097));return;}
      if(kind==='malformed'){res.end('{');return;}
      const a=child?childAccepted():accepted();if(kind==='wrong-execution')a.execution_id='other';if(kind==='extra-field')a.secret='private';res.end(JSON.stringify(a));
    });
    await assert.rejects(finishCollaboration(receipt(child?childWaiting():waiting()),input(),f.context),/Core wait registration/);
    assert.equal(f.requests.length,1);assert.equal(f.checkpoint(),undefined);
  });
});

test('current authority is checked before registration and again before suspension',async t=>{
  for(const child of [false,true])for(const denyAt of [1,2])await t.test((child?'child:':'question:')+denyAt,async t=>{
    const f=await serverFor(t,(_req,res)=>res.end(JSON.stringify(child?childAccepted():accepted())));let calls=0;
    f.context.authorizeCoreConnection=async()=>{if(++calls===denyAt)throw Error('authority revoked');};
    await assert.rejects(finishCollaboration(receipt(child?childWaiting():waiting()),input(),f.context),/authority revoked/);
    assert.equal(f.requests.length,denyAt-1);assert.equal(f.checkpoint(),undefined);
  });
});

test('unclean CLI, cancellation and invalid wait contracts cannot register',async t=>{
  const f=await serverFor(t,(_req,res)=>res.end(JSON.stringify(accepted())));
  for(const patch of [{code:1},{failed:true},{stopped:true}])await assert.rejects(finishCollaboration({...receipt(waiting()),...patch},input(),f.context),/did not stop cleanly/);
  for(const mutate of [w=>{w.responders=['designer','designer'];},w=>{w.actor='other';},w=>{w.timeout_seconds=0;},w=>{w.join='majority';}]) {
    const report=waiting();mutate(report.wait);await assert.rejects(finishCollaboration(receipt(report),input(),f.context),/Invalid collaboration wait/);
  }
  const controller=new AbortController();controller.abort();await assert.rejects(finishCollaboration(receipt(waiting()),input(),{...f.context,signal:controller.signal}),/did not stop cleanly/);
  assert.equal(f.requests.length,0);assert.equal(f.checkpoint(),undefined);
  assert.throws(()=>collaborationPrompt({...f.context,continuation:{checkpoint:{}}},input()),/Invalid Codex collaboration checkpoint/);
  assert.throws(()=>collaborationPrompt({...f.context,suspendForReply:undefined,suspendForCompletion:undefined},input()),/suspension support/);
  assert.throws(()=>collaborationPrompt(f.context,{work_id:'other?'}),/current Runtime work/);
});
