import test from 'node:test';
import assert from 'node:assert/strict';
import {validateParallelDefinition,TaskStep} from '../dist/index.js';
import {formatWorkspaceDesk,parseWorkspaceDesk,planWorkspaceDesk} from '../desk/index.mjs';
const definition=()=>({mode:'all',members:[{member_id:'alpha',accept:['ok'],instruction:'Check A',timeout_seconds:5},{member_id:'beta',accept:['ok'],instruction:'Check B'}]});
test('parallel wire and Desk preserve branches and reject private/ambiguous definitions',()=>{
 const parallel=definition();assert.deepEqual(validateParallelDefinition(parallel),parallel);assert.ok(TaskStep.parse({kind:'parallel',parallel}));
 for (const value of [{kind:'parallel'},{kind:'member',parallel},{kind:'parallel',parallel,member_id:'alpha'},{kind:'parallel',parallel:{...parallel,members:[parallel.members[0],parallel.members[0]]}}])assert.throws(()=>TaskStep.parse(value));
 for(const value of [{...parallel,mode:'unknown'},{...parallel,members:parallel.members.slice(0,1)},{...parallel,members:[parallel.members[0],parallel.members[0]]},{...parallel,members:[{...parallel.members[0],runtime_id:'hidden'},parallel.members[1]]}])assert.throws(()=>validateParallelDefinition(value));
 const desk={schema:'roster/desk/v2',owner:{member_id:'alpha'},workspace:{name:'Alpha',team_id:'team',version:0},space:{enabled:true,member_ids:['$owner','beta'],version:0},flows:[{id:'all',name:'All',version:0,default:false,steps:[{kind:'parallel',parallel:{...parallel,members:[{...parallel.members[0],member_id:'$owner'},parallel.members[1]]}}]}],text:''};
 assert.deepEqual(parseWorkspaceDesk(formatWorkspaceDesk(desk)),desk);
 desk.flows[0].steps[0].member_id='alpha';assert.throws(()=>formatWorkspaceDesk(desk));delete desk.flows[0].steps[0].member_id;
 desk.flows[0].steps[0].parallel.members[1].accept=[];assert.throws(()=>formatWorkspaceDesk(desk));
});
test('bounded any preserves its mode through shared wire and Desk without routing secrets',()=>{
 const parallel={...definition(),mode:'any'};
 assert.deepEqual(validateParallelDefinition(parallel),parallel);assert.deepEqual(TaskStep.parse({kind:'parallel',parallel}),{kind:'parallel',parallel});
 const desk={schema:'roster/desk/v2',owner:{member_id:'alpha'},workspace:{name:'Alpha',team_id:'team',version:0},flows:[{id:'any',name:'First result',version:0,default:false,steps:[{kind:'parallel',parallel}]}],text:''};
 assert.deepEqual(parseWorkspaceDesk(formatWorkspaceDesk(desk)),desk);
 for(const change of [p=>p.mode='race',p=>p.members[0].runtime_url='private',p=>p.members[0].accept=[]]){
  const bad=structuredClone(desk);change(bad.flows[0].steps[0].parallel);assert.throws(()=>formatWorkspaceDesk(bad));
 }
});
test('Desk resolves branch owner and checks every placement before writing',async()=>{
 const requests=[];const desk={schema:'roster/desk/v2',owner:{member_id:'alpha'},workspace:{name:'Alpha',team_id:'team',version:0},flows:[{id:'all',name:'All',version:0,default:false,steps:[{kind:'parallel',parallel:{...definition(),members:[{member_id:'$owner',accept:['ok']},{member_id:'beta',accept:['ok']}]}}]}],text:''};
 const api=async(path,method,body)=>{requests.push([path,method]);if(path==='/core/work-creation-capabilities')return {version:1,mode:'local'};if(path==='/state')return {units:[{id:'team'}],members:[{id:'alpha',kind:'agent',state:'active',team:'team'},{id:'beta',kind:'agent',state:'active',team:'team'}]};if(path==='/workspaces/alpha')return {owner:{id:'alpha'},workspace:{id:'alpha',name:'Alpha',team_id:'team',version:0},placement_space:{workspace_id:'alpha',enabled:true,member_ids:['alpha'],version:1},flows:[],can_edit:true};throw Error('Unexpected fixture call');};
 await assert.rejects(planWorkspaceDesk(api,desk),/not placed/);assert.ok(requests.every(([,m])=>!m||m==='GET'));
});
