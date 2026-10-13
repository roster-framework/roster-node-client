import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDesk,formatDesk,planDesk,applyDesk,exportDesk} from '../desk/index.mjs';
function fixture(){
 const reviewer={id:'reviewer',name:'Reviewer',kind:'llm',version:1,provider:'openai',model:'original-model',instructions:'Reviewer',skills:[],rules:[],credential_env:'REVIEWER_API_KEY',mcp_ids:[],statuses:['success'],events:['complete']};
 const developer={...reviewer,id:'developer',model:'unchanged-model'};
 let instruction={text:'Core rule',version:1};const writes=[];
 const api=async(path,method='GET',body)=>{
  if(method!=='GET')writes.push({path,body});
  if(path==='/state')return {units:[{id:'team'}],members:[{id:'member-reviewer',kind:'agent',state:'active',team:'team',runtime_id:'runtime',agent_id:'reviewer'}]};
  if(path==='/agents/runtime/reviewer'){
   if(method==='PUT'){assert.equal(body.version,reviewer.version);Object.assign(reviewer,body,{version:reviewer.version+1});}
   return {managed_agents:[structuredClone(reviewer)],manifest:{agents:[{id:'reviewer'}]},mcp_connections:[]};
  }
  if(path.endsWith('/instructions')){if(method==='PUT'){assert.equal(body.version,instruction.version);instruction={...body,version:body.version+1};}return structuredClone(instruction);}
  if(path.endsWith('/manage/credentials'))return {saved:true};
  throw Error('Unexpected call');
 };return {api,reviewer,developer,writes};
}
test('one Desk changes only its runtime model/rules, preserves member and never exports keys',async()=>{
 const f=fixture(),desk=await exportDesk(f.api,'runtime','reviewer');
 desk.configuration={...desk.configuration,provider:'anthropic',model:'custom-model',instructions:'Senior reviewer',skills:['review']};
 desk.text='Core rule updated';desk.credentials={REVIEWER_API_KEY:'private-key'};
 assert.deepEqual(parseDesk(formatDesk(desk)),desk);
 const plan=await planDesk(f.api,desk);assert.ok(plan.writeAgent);assert.equal(f.writes.length,0);
 const saved=await applyDesk(f.api,desk);
 assert.equal(saved.member_id,'member-reviewer');assert.equal(f.developer.model,'unchanged-model');
 assert.equal(saved.configuration.model,'custom-model');assert.equal(saved.configuration.instructions,'Senior reviewer');
 assert.equal(formatDesk(saved).includes('private-key'),false);assert.equal(saved.credentials,undefined);
 const count=f.writes.length;await applyDesk(f.api,saved);assert.equal(f.writes.length,count);
 await assert.rejects(applyDesk(f.api,desk),/version conflict/);assert.equal(f.writes.length,count);
});
test('Desk rejects identity/protocol/key overrides and nested inference credential injection',()=>{
 const base={schema:'roster/desk/v1',runtime_id:'runtime',agent_id:'reviewer',team:'team',name:'Reviewer',version:0,mcp_ids:[],text:''};
 for(const configuration of [{id:'other'},{events:[]},{model_parameters:{apiKey:'key'}},{model_parameters:{nested:{headers:{}}}},{engine:'unknown'},{base_url:'https://user:secret@example.com'},{skills:[1]}])assert.throws(()=>parseDesk(formatDesk({...base,configuration})));
 for(const credentials of [{ROSTER_API_KEY:'secret'},{REVIEWER_API_KEY:'bad\nkey'}])assert.throws(()=>parseDesk(formatDesk({...base,credentials})));
});
