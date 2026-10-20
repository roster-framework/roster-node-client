import {z} from 'zod';

const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Sequence=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Actor=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('human'),account_id:Id,member_id:Id}).strict(),
 z.object({kind:z.literal('execution'),member_id:Id,execution_id:Id}).strict(),
]);
// These references identify the refused request, not an accessible Work object.
const DenialBase=z.object({
 sequence:Sequence,
 command_id:z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
 actor:Actor,outcome:z.literal('forbidden'),at:z.iso.datetime({offset:true}),
}).strict();
// Work credential class only; command_id is a requested execution reference.
export const CommandDenialRecord=z.discriminatedUnion('operation',[
 DenialBase.extend({operation:z.literal('runtime.invoke'),actor:z.object({kind:z.literal('work-service')}).strict()}),
 DenialBase.extend({operation:z.enum(['board.respond','board.claim']),card_id:Id}),
 DenialBase.extend({operation:z.enum(['work.create.direct','work.create.planned','resource.invoke'])}),
 DenialBase.extend({operation:z.literal('agent.call'),actor:z.object({kind:z.literal('execution'),member_id:Id,execution_id:Id}).strict()}),
]);
export const CommandDenialQuery=z.object({limit:z.number().int().min(1).max(100).default(50),after:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)}).strict();
export const CommandDenialPage=z.object({items:z.array(CommandDenialRecord).max(100),next_after:Sequence.optional()}).strict();
export function validateCommandDenialPage(value:unknown,input:Partial<CommandDenialQuerySpec>={}) {
 const query=CommandDenialQuery.parse(input),page=CommandDenialPage.parse(value);let last=query.after;
 if(page.items.length>query.limit)throw Error('Invalid command denial page');
 for(const item of page.items){if(item.sequence<=last)throw Error('Invalid command denial order');last=item.sequence;}
 if(page.next_after!==undefined&&(page.items.length!==query.limit||page.next_after!==last))throw Error('Invalid command denial continuation');
 return page;
}
export type CommandDenialRecordSpec=z.infer<typeof CommandDenialRecord>;
export type CommandDenialQuerySpec=z.infer<typeof CommandDenialQuery>;
export type CommandDenialPageSpec=z.infer<typeof CommandDenialPage>;
