import {z} from 'zod';
import {RecurringWork} from './index.js';

const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Version=Revision.min(1);
const UTC=z.iso.datetime().regex(/Z$/);
const Title=z.string().refine(v=>v.trim().length>0&&new TextEncoder().encode(v).length<=200);
const Owner=z.object({account_id:Id,member_id:Id}).strict();
export const RecurringPageQuery=z.object({version:z.literal(1),unit_id:Id,limit:z.number().int().min(1).max(100).default(20),after:Id.optional()}).strict();
export const RecurringDefinitionQuery=z.object({version:z.literal(1),unit_id:Id,id:Id}).strict();
export const RecurringMetadata=z.object({id:Id,unit_id:Id,title:Title,owner_member_id:Id,every_seconds:z.number().int().min(3600).max(31536000),next_run_at:UTC,active:z.boolean(),version:Version,last_work_id:Id.optional(),last_slot_at:UTC.optional()}).strict().refine(v=>!!v.last_work_id===!!v.last_slot_at);
export const RecurringPage=z.object({version:z.literal(1),unit_id:Id,work_revision:Revision,items:z.array(RecurringMetadata).max(100),next_after:Id.optional()}).strict();
export const RecurringDefinitionView=z.object({version:z.literal(1),unit_id:Id,work_revision:Revision,owner_member_id:Id,definition:z.lazy(()=>RecurringWork)}).strict();
export const RecurringChangeReceipt=z.object({version:z.literal(1),command_id:Id,recurring_id:Id,unit_id:Id,definition_version:Version,work_revision:Version,actor:Owner,owner:Owner,accepted_at:UTC,replayed:z.boolean()}).strict();
export function validateRecurringPage(value:unknown,input:RecurringPageQueryInput) {
 const query=RecurringPageQuery.parse(input),page=RecurringPage.parse(value);let last=query.after||'';
 if(page.unit_id!==query.unit_id||page.items.length>query.limit)throw Error('Invalid recurring page');
 for(const item of page.items){if(item.unit_id!==query.unit_id||item.id<=last)throw Error('Invalid recurring order');last=item.id;}
 if(page.next_after!==undefined&&(page.items.length!==query.limit||page.next_after!==last))throw Error('Invalid recurring continuation');
 if(new TextEncoder().encode(JSON.stringify(page)).length>128*1024)throw Error('Invalid recurring page size');
 return page;
}
export function validateRecurringDefinition(value:unknown,input:RecurringDefinitionQuerySpec) {
 const q=RecurringDefinitionQuery.parse(input),view=RecurringDefinitionView.parse(value),d=view.definition;
 if(view.unit_id!==q.unit_id||d.unit_id!==q.unit_id||d.id!==q.id)throw Error('Invalid selected recurring definition');
 RecurringMetadata.parse({id:d.id,unit_id:d.unit_id,title:d.title,owner_member_id:view.owner_member_id,every_seconds:d.every_seconds,next_run_at:d.next_run_at,active:d.active,version:d.version,last_work_id:d.last_work_id,last_slot_at:d.last_slot_at});
 return view;
}
export function validateRecurringReceipt(value:unknown,command:RecurringChangeCommandSpec,actor:RecurringOwnerSpec,ownerMember:string) {
 const receipt=RecurringChangeReceipt.parse(value);
 if(receipt.command_id!==command.id||receipt.recurring_id!==command.definition.id||receipt.unit_id!==command.definition.unit_id||receipt.definition_version!==command.definition.version+1||receipt.work_revision!==command.expected_revision+1||receipt.actor.account_id!==actor.account_id||receipt.actor.member_id!==actor.member_id||receipt.owner.member_id!==ownerMember)throw Error('Invalid recurring change receipt');
 return receipt;
}
export type RecurringPageQueryInput=z.input<typeof RecurringPageQuery>;
export type RecurringDefinitionQuerySpec=z.infer<typeof RecurringDefinitionQuery>;
export type RecurringPageSpec=z.infer<typeof RecurringPage>;
export type RecurringDefinitionViewSpec=z.infer<typeof RecurringDefinitionView>;
export type RecurringOwnerSpec=z.infer<typeof Owner>;
export type RecurringChangeReceiptSpec=z.infer<typeof RecurringChangeReceipt>;
export type RecurringChangeCommandSpec={version:1;id:string;expected_revision:number;definition:z.infer<typeof RecurringWork>};
