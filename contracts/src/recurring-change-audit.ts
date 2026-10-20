import {z} from 'zod';
const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Sequence=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const RecurringChangeAuditQuery=z.object({version:z.literal(1),unit_id:Id,limit:z.number().int().min(1).max(100).default(50),after:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)}).strict();
export const RecurringChangeAuditEntry=z.object({sequence:Sequence,command_id:Id,recurring_id:Id,unit_id:Id,definition_version:Sequence,work_revision:Sequence,actor_member_id:Id,owner_member_id:Id,accepted_at:z.iso.datetime({offset:true})}).strict();
export const RecurringChangeAuditPage=z.object({version:z.literal(1),unit_id:Id,items:z.array(RecurringChangeAuditEntry).max(100),next_after:Sequence.optional()}).strict();
export function validateRecurringChangeAuditPage(value:unknown,input:RecurringChangeAuditQueryInput){
 const q=RecurringChangeAuditQuery.parse(input),p=RecurringChangeAuditPage.parse(value);let last=q.after;
 if(p.unit_id!==q.unit_id||p.items.length>q.limit)throw Error('Invalid recurring audit page');
 for(const a of p.items){if(a.unit_id!==q.unit_id||a.sequence<=last)throw Error('Invalid recurring audit order');last=a.sequence;}
 if(p.next_after!==undefined&&(p.items.length!==q.limit||p.next_after!==last))throw Error('Invalid recurring audit cursor');
 if(new TextEncoder().encode(JSON.stringify(p)).length>256*1024)throw Error('Invalid recurring audit size');return p;
}
export type RecurringChangeAuditQueryInput=z.input<typeof RecurringChangeAuditQuery>;
export type RecurringChangeAuditPageSpec=z.infer<typeof RecurringChangeAuditPage>;
