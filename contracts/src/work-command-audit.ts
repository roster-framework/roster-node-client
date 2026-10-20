import {z} from 'zod';

const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Sequence=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Human=z.object({kind:z.literal('human'),account_id:Id,member_id:Id}).strict();
const Actor=z.discriminatedUnion('kind',[z.object({kind:z.literal('system')}).strict(),Human]);
const Base=z.object({sequence:Sequence,command_id:z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),work_id:Id,accepted_at:z.iso.datetime({offset:true})}).strict();
// Keep cross-field provenance in the schemas themselves, including JSON Schema.
export const WorkCommandAcceptance=z.discriminatedUnion('operation',[
 Base.extend({operation:z.literal('board.respond'),card_id:Id,actor:Actor}),
 Base.extend({operation:z.literal('board.claim'),card_id:Id,actor:Human}),
 Base.extend({operation:z.literal('work.create'),card_id:z.literal(''),actor:Human}),
 Base.extend({operation:z.literal('work.retry'),card_id:z.literal(''),actor:Human}),
 Base.extend({operation:z.literal('work.cancel'),card_id:z.literal(''),actor:Human}),
 Base.extend({operation:z.literal('agent.call'),card_id:z.literal(''),actor:z.object({kind:z.literal('execution'),execution_id:Id,member_id:Id}).strict()}),
]);
export const WorkCommandAuditQuery=z.object({limit:z.number().int().min(1).max(100).default(50),after:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)}).strict();
export const WorkCommandAuditPage=z.object({items:z.array(WorkCommandAcceptance).max(100),next_after:Sequence.optional()}).strict();
export function validateWorkCommandAuditPage(value:unknown,input:Partial<WorkCommandAuditQuerySpec>={}) {
 const query=WorkCommandAuditQuery.parse(input),page=WorkCommandAuditPage.parse(value);let last=query.after;
 if(page.items.length>query.limit)throw Error('Invalid command audit page');
 for(const item of page.items){if(item.sequence<=last)throw Error('Invalid command audit order');last=item.sequence;}
 if(page.next_after!==undefined&&(page.items.length!==query.limit||page.next_after!==last))throw Error('Invalid command audit continuation');
 return page;
}
export type WorkCommandAcceptanceSpec=z.infer<typeof WorkCommandAcceptance>;
export type WorkCommandAuditQuerySpec=z.infer<typeof WorkCommandAuditQuery>;
export type WorkCommandAuditPageSpec=z.infer<typeof WorkCommandAuditPage>;
