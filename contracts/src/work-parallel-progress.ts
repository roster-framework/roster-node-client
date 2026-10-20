import {z} from 'zod';
const ID=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/);
const Branch=z.object({index:z.number().int().min(0).max(7),member_id:ID,name:z.string().max(1000),execution_id:ID.optional(),state:z.enum(['queued','running','attention','completed','cancelled']),selected:z.boolean().optional()}).strict();
export const WorkParallelStage=z.object({index:z.number().int().min(0).max(63),mode:z.enum(['all','any']),state:z.enum(['queued','running','attention','completed','cancelled']),branches:z.array(Branch).min(2).max(8)}).strict();
export type WorkParallelStageSpec=z.infer<typeof WorkParallelStage>;
// Read metadata only. Bind to this record, never recover a winner from run order.
export function validateWorkParallelProgress(value:unknown,record:{work:{id:string;state?:string};runs:{id:string;work_id:string;state:string}[]}):WorkParallelStageSpec[] {
 const parsed=z.array(WorkParallelStage).max(64).safeParse(value);
 if(!parsed.success)throw Error('Invalid parallel progress');
 const result=parsed.data,seen=new Set<string>();let last=-1;
 for(const s of result){
  if(s.index<=last||s.state==='cancelled'&&record.work.state!=='cancelled')throw Error('Invalid parallel progress');last=s.index;
  const members=new Set<string>();let selected=0,attention=false;
  s.branches.forEach((b,i)=>{
   if(b.index!==i||members.has(b.member_id))throw Error('Invalid parallel progress');members.add(b.member_id);
   attention||=b.state==='attention';
   if(b.execution_id){
    if(seen.has(b.execution_id)||!record.runs.some(r=>r.id===b.execution_id&&r.work_id===record.work.id&&r.state===b.state))throw Error('Invalid parallel progress');seen.add(b.execution_id);
   }else if(b.state!=='queued'&&!(s.state==='cancelled'&&b.state==='cancelled')||b.selected)throw Error('Invalid parallel progress');
   if(b.selected){if(s.mode!=='any'||s.state!=='completed'||b.state!=='completed')throw Error('Invalid parallel progress');selected++;}
   if(s.state==='completed'&&((s.mode==='all'&&b.state!=='completed')||(s.mode==='any'&&!b.selected&&b.state!=='cancelled')))throw Error('Invalid parallel progress');
   if(s.state==='queued'&&b.state!=='queued'||s.state!=='completed'&&s.state!=='cancelled'&&b.state==='cancelled'||s.state==='cancelled'&&b.state!=='completed'&&b.state!=='cancelled')throw Error('Invalid parallel progress');
  });
  if(s.mode==='any'&&s.state==='completed'&&selected!==1||s.state==='attention'&&!attention||s.state==='running'&&attention)throw Error('Invalid parallel progress');
 }
 return result;
}
