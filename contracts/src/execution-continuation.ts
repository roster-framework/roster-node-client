import {z} from 'zod';

const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
// Core-owned references only. Checkpoint and reply bodies are never wire input.
const QuestionContinuation=z.object({
  protocol:z.literal('roster-execution-continuation/1'),
  wait_id:id,parent_execution_id:id,checkpoint_digest:z.string().regex(/^[a-f0-9]{64}$/),
  thread_id:id,question_id:id,
  answers:z.array(z.object({member_id:id,message_id:id,sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(12),
}).strict().superRefine((r,ctx)=>{
  const members=new Set<string>(),messages=new Set<string>();let previous=0;
  for(const a of r.answers) {
    if(members.has(a.member_id)||messages.has(a.message_id)||a.message_id===r.question_id||a.sequence<=previous)ctx.addIssue({code:'custom',message:'Invalid continuation answer references'});
    members.add(a.member_id);messages.add(a.message_id);previous=a.sequence;
  }
});
const ChildContinuation=z.object({
  protocol:z.literal('roster-execution-continuation/2'),
  wait_id:id,parent_execution_id:id,checkpoint_digest:z.string().regex(/^[a-f0-9]{64}$/),
  children:z.array(z.object({request_id:id,record_id:id,digest:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['completed','attention','cancelled'])}).strict()).min(1).max(12),
}).strict().superRefine((r,ctx)=>{
  const requests=new Set<string>(),executions=new Set<string>();
  for(const child of r.children) {
    if(requests.has(child.request_id)||executions.has(child.record_id)||child.record_id===r.parent_execution_id)ctx.addIssue({code:'custom',message:'Invalid continuation child references'});
    requests.add(child.request_id);executions.add(child.record_id);
  }
});
export const ExecutionContinuation=z.discriminatedUnion('protocol',[QuestionContinuation,ChildContinuation]);
export type ExecutionContinuationSpec=z.infer<typeof ExecutionContinuation>;
