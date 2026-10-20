import {z} from 'zod';
const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const bytes=(s:string)=>new TextEncoder().encode(s).length;
export const MeetingParticipant=z.object({member_id:Id,accept:z.array(Id).max(100).optional()}).strict();
export const MeetingDefinition=z.object({version:z.literal(1),participants:z.array(MeetingParticipant).min(2).max(12),rounds:z.number().int().min(1).max(3),recorder:MeetingParticipant,reviewer_member_id:Id.optional()}).strict();
export const MeetingCreateCommand=z.object({version:z.literal(1),id:Id,title:z.string().min(1).max(200),agenda:z.string().min(1).max(20000),unit_id:Id.optional(),definition:MeetingDefinition}).strict();
export const MeetingMemberSnapshot=z.object({member_id:Id,name:z.string().min(1).max(200),team_id:Id,kind:z.enum(['human','agent'])}).strict();
export const MeetingTurn=z.object({index:z.number().int().min(1).max(16),phase:z.enum(['discussion','minutes','review']),round:z.number().int().min(1).max(3).optional(),member_id:Id,state:z.enum(['pending','queued','running','attention','completed','waiting','cancelled']),execution_id:Id.optional(),card_id:Id.optional(),summary:z.string().max(20000).optional(),artifact_name:z.literal('minutes.md').optional(),review_action:z.enum(['approve','request_changes']).optional()}).strict();
export const MeetingRecord=z.object({version:z.literal(1),thread_id:Id,definition:MeetingDefinition,participants:z.array(MeetingMemberSnapshot).min(2).max(12),reviewer:MeetingMemberSnapshot.optional(),cursor:z.number().int().min(0).max(16),blocked:z.boolean(),turns:z.array(MeetingTurn).min(3).max(16)}).strict();
export type MeetingDefinitionSpec=z.infer<typeof MeetingDefinition>;
export type MeetingRecordSpec=z.infer<typeof MeetingRecord>;
export type MeetingCreateCommandSpec=z.infer<typeof MeetingCreateCommand>;

// JSON schemas describe shapes; consumers also enforce ordered/frozen bindings.
export function validateMeetingDefinition(value:unknown){
 const d=MeetingDefinition.parse(value),seen=new Set<string>();
 if(d.participants.length*d.rounds>14)throw Error('Meeting discussion limit');
 for(const p of d.participants){if(seen.has(p.member_id)||new Set(p.accept??[]).size!==(p.accept??[]).length)throw Error('Invalid meeting participant');seen.add(p.member_id);}
 const recorder=d.participants.find(p=>p.member_id===d.recorder.member_id);
 if(!recorder||JSON.stringify(recorder.accept??[])!==JSON.stringify(d.recorder.accept??[])||d.reviewer_member_id&&!(d.recorder.accept?.length))throw Error('Invalid meeting recorder');
 return d;
}
export function validateMeetingCreateCommand(value:unknown){
 const c=MeetingCreateCommand.parse(value);validateMeetingDefinition(c.definition);
 if(!c.title.trim()||!c.agenda.trim()||bytes(c.title)>200||bytes(c.agenda)>20000||bytes(JSON.stringify(c))>32768)throw Error('Invalid meeting command size');
 return c;
}
type SourceRecord={work:{id:string;kind:string;state?:string};runs:{id:string;work_id:string;state:string;summary?:string;artifacts?:{name:string;mime:string}[]}[];cards:{id:string;work_id:string;assignee_id?:string;state:string;response?:string;action?:string}[]};
export function validateMeetingRecord(value:unknown,source:SourceRecord){
 const m=MeetingRecord.parse(value),d=validateMeetingDefinition(m.definition),n=d.participants.length*d.rounds,total=n+1+(d.reviewer_member_id?1:0);
 if(source.work.kind!=='task'||m.thread_id!==source.work.id||m.participants.length!==d.participants.length||m.turns.length!==total||m.cursor>total)throw Error('Foreign meeting thread');
 for(let i=0;i<m.participants.length;i++){
  const p=m.participants[i],definition=d.participants[i];
  if(p.member_id!==definition.member_id||!p.name.trim()||bytes(p.name)>200||p.kind!==((definition.accept?.length)?'agent':'human'))throw Error('Invalid meeting member');
 }
 if(d.reviewer_member_id?(!m.reviewer||m.reviewer.member_id!==d.reviewer_member_id||m.reviewer.kind!=='human'||!m.reviewer.name.trim()||bytes(m.reviewer.name)>200):m.reviewer!==undefined)throw Error('Invalid meeting reviewer');
 for(let i=0;i<m.turns.length;i++){
  const t=m.turns[i],phase=i<n?'discussion':i===n?'minutes':'review',member=i<n?d.participants[i%d.participants.length].member_id:i===n?d.recorder.member_id:d.reviewer_member_id;
  const person=phase==='review'?m.reviewer:m.participants.find(p=>p.member_id===member);
  if(t.index!==i+1||t.phase!==phase||t.member_id!==member||t.round!==(phase==='discussion'?Math.floor(i/d.participants.length)+1:undefined)||bytes(t.summary??'')>20000||t.execution_id&&t.card_id)throw Error('Invalid meeting position');
  if(t.state==='pending'){
   if(t.execution_id||t.card_id||t.summary)throw Error('Pending meeting has a result');
  }else if(t.state==='cancelled'){
   if(source.work.state!=='cancelled'||!m.blocked||person?.kind==='human'&&t.execution_id||person?.kind==='agent'&&t.card_id||!t.execution_id&&!t.card_id&&t.summary)throw Error('Invalid cancelled meeting source');
  }else{
   if(!t.execution_id&&!t.card_id||person?.kind==='agent'&&(!t.execution_id||t.state==='waiting')||person?.kind==='human'&&(!t.card_id||!['waiting','completed'].includes(t.state)))throw Error('Invalid meeting source');
  }
  if(t.artifact_name&&(phase!=='minutes'||t.state!=='completed'||!t.execution_id)||t.review_action&&(phase!=='review'||t.state!=='completed'||!t.card_id))throw Error('Invalid meeting outcome');
  if(t.execution_id){
   const run=source.runs.find(r=>r.id===t.execution_id);
   if(!run||run.work_id!==m.thread_id||run.state!==t.state||(run.summary??'')!==(t.summary??'')||t.artifact_name&&!run.artifacts?.some(a=>a.name===t.artifact_name&&a.mime==='text/markdown'))throw Error('Foreign meeting execution');
  }
  if(t.card_id){
   const card=source.cards.find(c=>c.id===t.card_id);
   if(!card||card.work_id!==m.thread_id||card.assignee_id!==t.member_id||(card.response??'')!==(t.summary??'')||(card.state==='done')!==(t.state==='completed')||(card.state==='cancelled')!==(t.state==='cancelled')||(card.action??'')!==(t.review_action??''))throw Error('Foreign meeting response');
  }
 }
 if(bytes(JSON.stringify(m))>=65536)throw Error('Meeting response limit');return m;
}
