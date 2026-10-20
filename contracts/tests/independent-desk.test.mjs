import test from 'node:test';
import assert from 'node:assert/strict';
import {exportWorkspaceDesk,planWorkspaceDesk,applyWorkspaceDesk,parseWorkspaceDesk,formatWorkspaceDesk,DeskApplyError} from '../desk/index.mjs';
import {parseDeskJSON} from '../desk/json.mjs';
function fixture(count=21) {
 let revision=8,mode='independent',fail='',wrong=false,race=false;
 const person={id:'danny',kind:'human',state:'active',team:'development'};
 const workspace={id:'danny',name:'Danny',team_id:'development',version:1},space={workspace_id:'danny',enabled:true,member_ids:['danny'],version:1};
 const flows=Array.from({length:count},(_,i)=>({id:'flow-'+String(i).padStart(2,'0'),name:'Flow '+i,unit_id:'development',workspace_id:'danny',version:1,default:i===0,steps:[{kind:'member',member_id:'danny',instruction:'Original '+i}]}));
 let events={version:0,workspace_id:'danny',owner_account_id:'private-owner',owner_member_id:'danny',definition:{version:1,name:'Events',subscriptions:[]}};
 const calls=[],writes=[];
 const api=async(path,method='GET',body)=>{
  calls.push({path,method});if(method!=='GET')writes.push({path,method,body:structuredClone(body)});
  if(path===fail)throw Error('Unavailable');
  if(path==='/core/work-creation-capabilities')return {version:1,mode};
  if(path==='/state')return {members:[person]};
  if(path.startsWith('/workspaces/danny?')||path==='/workspaces/danny') {
   if(method==='PUT'){assert.equal(body.version,workspace.version);workspace.version++;workspace.name=body.name;}
   const offset=path.includes('cursor=')?20:0,all=flows.map(({steps,unit_id,workspace_id,...f})=>f);
   return {workspace:structuredClone(workspace),owner:person,placement_space:structuredClone(space),can_edit:true,flows:all.slice(offset,offset+20),works:offset||all.length<20?[{id:'original-task'}]:[],work_revision:revision,...(!offset&&all.length>20?{next_cursor:'wqc1.opaque'}:{})};
  }
  if(path.startsWith('/core/workflows/')) {
   const flow=structuredClone(flows.find(f=>f.id===path.split('/').at(-1))),result={version:1,work_revision:revision,flow};if(race)revision++;return result;
  }
  if(path==='/workspaces/danny/events')return structuredClone(events);
  if(path==='/core/workflow-change'||path==='/core/event-flow-change') {
   assert.equal(method,'POST');assert.equal(body.expected_revision,revision);revision++;
   let receipt={version:1,command_id:body.id,unit_id:'development',workspace_id:'danny',work_revision:revision,accepted_at:'2026-10-06T00:00:00Z',replayed:false};
   if(path==='/core/workflow-change') {
    const f=structuredClone(body.flow);if(f.default)for(const old of flows)if(old.default&&old.id!==f.id){old.default=false;old.version++;}
    const at=flows.findIndex(v=>v.id===f.id);assert.equal(f.version,at<0?0:flows[at].version);f.version++;if(at<0)flows.push(f);else flows[at]=f;
    Object.assign(receipt,{flow_id:f.id,flow_version:f.version});
   }else {assert.equal(body.expected_workspace_version,events.version);events={...events,version:events.version+1,definition:structuredClone(body.definition)};receipt.workspace_version=events.version;}
   if(wrong)receipt.command_id='foreign';return receipt;
  }
  throw Error('Unexpected Desk operation');
 };
 return {api,calls,writes,flows,space,workspace,fail:p=>fail=p,wrong:()=>wrong=true,race:()=>race=true,rev:v=>revision=v,mode:v=>mode=v};
}
test('complete private alias export pins original Work and reads later flow page without task originals',async()=>{
 const f=fixture(),desk=await exportWorkspaceDesk(f.api,'danny',{events:true});assert.equal(desk.work_revision,8);assert.equal(desk.flows.length,21);assert.equal(desk.flows[20].steps[0].instruction,'Original 20');assert.equal(desk.flows[0].steps[0].member_id,'$owner');
 assert.ok(f.calls.some(c=>c.path.includes('?limit=20&cursor=wqc1.opaque')));assert.ok(!JSON.stringify(desk).includes('private-owner'));assert.deepEqual(f.writes,[]);
 assert.deepEqual(parseWorkspaceDesk(formatWorkspaceDesk(desk)),desk);assert.equal((await planWorkspaceDesk(f.api,desk)).flows.some(f=>f.write),false);
 await applyWorkspaceDesk(f.api,desk);assert.deepEqual(f.writes,[]);
});
test('ordered aliases and events use exact selected command receipts and advance original revision',async()=>{
 const f=fixture(2),desk=await exportWorkspaceDesk(f.api,'danny',{events:true});
 desk.flows[1].default=true;desk.flows[0].default=false;desk.flows[0].steps[0].instruction='Change original';desk.events.definition.name='Changed events';
 const saved=await applyWorkspaceDesk(f.api,desk);assert.equal(saved.work_revision,11);assert.equal(saved.events.version,1);
 assert.deepEqual(f.writes.map(w=>w.path),['/core/workflow-change','/core/workflow-change','/core/event-flow-change']);
 assert.deepEqual(f.writes.map(w=>w.body.expected_revision),[8,9,10]);assert.equal(new Set(f.writes.map(w=>w.body.id)).size,3);
 assert.equal(f.writes[0].body.flow.workspace_id,'danny');assert.ok(!JSON.stringify(f.writes).includes('private-owner'));assert.equal(saved.flows[0].steps[0].instruction,'Change original');
});
test('stale or missing original pin, foreign scope, unavailable mode and oversized commands fail before any effects',async()=>{
 for(const change of [d=>delete d.work_revision,d=>d.work_revision--,d=>d.work_revision=Number.MAX_SAFE_INTEGER,d=>d.flows[0].version++,d=>d.flows[0].steps=Array.from({length:7},()=>({kind:'member',member_id:'$owner',instruction:'x'.repeat(10000)}))]) {
  const f=fixture(1),desk=await exportWorkspaceDesk(f.api,'danny');desk.workspace.name='Must not save';change(desk);await assert.rejects(applyWorkspaceDesk(f.api,desk));assert.deepEqual(f.writes,[]);
 }
 const f=fixture(1),desk=await exportWorkspaceDesk(f.api,'danny');f.fail('/core/work-creation-capabilities');await assert.rejects(applyWorkspaceDesk(f.api,desk));assert.deepEqual(f.writes,[]);
 const wrong=fixture(1);const api=async(path,...rest)=>{const value=await wrong.api(path,...rest);if(path.startsWith('/core/workflows/'))value.flow.workspace_id='other';return value;};await assert.rejects(exportWorkspaceDesk(api,'danny'));assert.deepEqual(wrong.writes,[]);
});
test('uncertain or malformed first save stops following aliases/events and requires current recovery export',async()=>{
 for(const kind of ['outage','receipt']) {
  const f=fixture(2),desk=await exportWorkspaceDesk(f.api,'danny',{events:true});desk.flows.forEach(v=>v.name+=' edited');desk.events.definition.name='Must not follow';
  if(kind==='outage')f.fail('/core/workflow-change');else f.wrong();
  await assert.rejects(applyWorkspaceDesk(f.api,desk),e=>e instanceof DeskApplyError&&e.phase.startsWith('flow ')&&e.completed.length===0);assert.equal(f.writes.length,1);assert.equal(f.writes[0].method,'POST');
  if(kind==='receipt'){await assert.rejects(applyWorkspaceDesk(f.api,desk));assert.equal(f.writes.length,1);const fresh=await exportWorkspaceDesk(f.api,'danny',{events:true});assert.equal(fresh.work_revision,9);assert.equal(fresh.events.definition.name,'Events');}
 }
});
test('changing source during export and cyclic continuation never return a partial file',async()=>{
 const f=fixture(2);f.race();await assert.rejects(exportWorkspaceDesk(f.api,'danny'));assert.deepEqual(f.writes,[]);
 const cycle=fixture(),api=async(path,...rest)=>{const value=await cycle.api(path,...rest);if(path.includes('?'))value.next_cursor='wqc1.opaque';return value;};await assert.rejects(exportWorkspaceDesk(api,'danny'));assert.deepEqual(cycle.writes,[]);
});
test('duplicate decoded keys, malformed input, unsafe revision and depth cannot silently replace file intent',()=>{
 for(const source of ['{"work_revision":1,"work_revision":2}','{"a":1,"\\u0061":2}','{"n":01}','{"a":true} false','{"x":"bad\n"}', '['.repeat(66)+'0'+']'.repeat(66)])assert.throws(()=>parseDeskJSON(source));
 const valid={schema:'roster/desk/v2',work_revision:8,owner:{member_id:'danny'},workspace:{name:'Danny',team_id:'development',version:1},text:''};
 assert.throws(()=>parseWorkspaceDesk(formatWorkspaceDesk(valid).replace('"work_revision": 8','"work_revision": 7,"work_revision":8')));
 assert.deepEqual(parseDeskJSON('{"unicode":"회사","number":1.2,"array":[true,null]}'),{unicode:'회사',number:1.2,array:[true,null]});
});
