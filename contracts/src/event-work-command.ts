import { z } from 'zod';

const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Rough start supports text tasks; arbitrary input source remains a separate API concern.
export const EventWorkTextIntent=z.object({unit_id:id,workspace_id:id.optional(),title:z.string().min(1).max(200),request:z.string().min(1).max(20000)}).strict();
export const EventWorkTextCommand=z.object({version:z.literal(1),id,intent:EventWorkTextIntent}).strict();
export const EventWorkCreationReceipt=z.object({version:z.literal(1),command_id:id,work_id:id,unit_id:id,workspace_id:id.optional(),workspace_version:revision.optional(),work_revision:revision,accepted_at:z.iso.datetime({offset:true}),replayed:z.boolean()}).strict();
export type EventWorkTextIntentSpec=z.infer<typeof EventWorkTextIntent>;
export type EventWorkTextCommandSpec=z.infer<typeof EventWorkTextCommand>;
export function validateEventWorkTextCommand(value:unknown){
 const c=EventWorkTextCommand.parse(value),encode=(v:string)=>new TextEncoder().encode(v).length;
 if(c.intent.workspace_id==='self'||!c.intent.title.trim()||!c.intent.request.trim()||encode(c.intent.title)>200||encode(c.intent.request)>20000||encode(JSON.stringify(c))>56*1024)throw Error('Invalid event work command');
 return c;
}
export function validateEventWorkCreationReceipt(value:unknown,command:EventWorkTextCommandSpec){
 const c=validateEventWorkTextCommand(command),r=EventWorkCreationReceipt.parse(value);
 if(r.command_id!==c.id||r.unit_id!==c.intent.unit_id||(r.workspace_id??'')!==(c.intent.workspace_id??'')||r.work_revision<1||(r.workspace_id?(r.workspace_version??0)<1:(r.workspace_version??0)!==0))throw Error('Invalid event work receipt');
 return r;
}
