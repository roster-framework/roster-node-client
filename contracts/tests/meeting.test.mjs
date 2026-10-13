import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMeetingDefinition,validateMeetingCreateCommand,validateMeetingRecord} from '../dist/index.js';
const definition={version:1,participants:[{member_id:'designer',accept:['ok']},{member_id:'danny'}],rounds:1,recorder:{member_id:'designer',accept:['ok']},reviewer_member_id:'danny'};
const members=[{member_id:'designer',name:'Designer',team_id:'team',kind:'agent'},{member_id:'danny',name:'Danny',team_id:'team',kind:'human'}];
const record={version:1,thread_id:'thread',definition,participants:members,reviewer:members[1],cursor:1,blocked:false,turns:[{index:1,phase:'discussion',round:1,member_id:'designer',state:'completed',execution_id:'run',summary:'Proposal'},{index:2,phase:'discussion',round:1,member_id:'danny',state:'waiting',card_id:'card'},{index:3,phase:'minutes',member_id:'designer',state:'pending'},{index:4,phase:'review',member_id:'danny',state:'pending'}]};
const source={work:{id:'thread',kind:'task'},runs:[{id:'run',work_id:'thread',state:'completed',summary:'Proposal'}],cards:[{id:'card',work_id:'thread',state:'claimed',assignee_id:'danny'}]};
test('meeting command freezes bounded explicit members and excludes runtime/authority injection',()=>{
 const command={version:1,id:'meeting',title:'Planning',agenda:'Discuss',definition};assert.deepEqual(validateMeetingCreateCommand(command),command);
 for(const change of [d=>d.participants.push(d.participants[0]),d=>d.recorder.member_id='other',d=>d.recorder.accept=['complete'],d=>d.participants[0].accept=['ok','ok'],d=>d.participants[1].target='runtime',d=>{d.participants=Array.from({length:8},(_,i)=>({member_id:'agent'+i}));d.rounds=2;d.recorder=d.participants[0];delete d.reviewer_member_id;},d=>{d.recorder=d.participants[1];}]){const d=structuredClone(definition);change(d);assert.throws(()=>validateMeetingDefinition(d));}
 assert.throws(()=>validateMeetingCreateCommand({...command,role:'admin'}));assert.throws(()=>validateMeetingCreateCommand({...command,title:'한'.repeat(70)}));
});

test('cancelled meeting retains completed discussion and stops existing and unstarted turns',()=>{
 const stopped=structuredClone(record),s=structuredClone(source);
 s.work.state='cancelled';s.cards[0].state='cancelled';stopped.blocked=true;
 for(let i=1;i<stopped.turns.length;i++)stopped.turns[i].state='cancelled';
 assert.deepEqual(validateMeetingRecord(stopped,s),stopped);
 assert.equal(stopped.turns[0].summary,'Proposal');
 assert.throws(()=>validateMeetingRecord(stopped,{...s,work:{...s.work,state:'waiting'}}));
 assert.throws(()=>validateMeetingRecord({...stopped,blocked:false},s));
 assert.throws(()=>validateMeetingRecord(stopped,{...s,cards:source.cards}));
 const invented=structuredClone(stopped);invented.turns[2].summary='invented';assert.throws(()=>validateMeetingRecord(invented,s));
});
test('meeting metadata binds ordered positions, original runs/cards and excludes private data',()=>{
 assert.deepEqual(validateMeetingRecord(record,source),record);
 for(const change of [r=>r.thread_id='other',r=>r.participants[0].kind='human',r=>r.reviewer.kind='agent',r=>r.turns[0].round=2,r=>r.turns[1].execution_id='run',r=>r.turns[2].summary='made up',r=>r.turns[0].summary='other',r=>r.turns[0].artifact_name='minutes.md',r=>r.turns[0].logs=['private'],r=>r.definition.account_id='private']){const r=structuredClone(record);change(r);assert.throws(()=>validateMeetingRecord(r,source));}
 assert.throws(()=>validateMeetingRecord(record,{...source,runs:[{...source.runs[0],work_id:'other'}]}));assert.throws(()=>validateMeetingRecord(record,{...source,cards:[{...source.cards[0],assignee_id:'other'}]}));
 const done=structuredClone(record),original=structuredClone(source);done.cursor=4;done.turns[1].state='completed';done.turns[1].summary='Feedback';original.cards[0].state='done';original.cards[0].response='Feedback';done.turns[2]={...done.turns[2],state:'completed',execution_id:'minutes',summary:'Minutes',artifact_name:'minutes.md'};original.runs.push({id:'minutes',work_id:'thread',state:'completed',summary:'Minutes',artifacts:[{name:'minutes.md',mime:'text/markdown'}]});done.turns[3]={...done.turns[3],state:'completed',card_id:'review',review_action:'approve'};original.cards.push({id:'review',work_id:'thread',state:'done',assignee_id:'danny',action:'approve'});assert.deepEqual(validateMeetingRecord(done,original),done);
 const copy=validateMeetingRecord(record,source);copy.participants[0].name='Changed';assert.equal(record.participants[0].name,'Designer');
});
