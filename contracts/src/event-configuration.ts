import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const target = z.object({runtime_id:id,agent_id:id}).strict();
const action = z.object({id,label:z.string(),event:id.optional()}).strict();
const board = z.object({team:id,title:z.string(),response_event:id.optional(),complete_on_response:z.boolean(),actions:z.array(action).max(5).optional()}).strict();
// This is the original stored value: do not run execution defaults while reading.
export const OriginalEventSubscription = z.object({
 id,on:id,from_member_id:id.optional(),target_member_id:id.optional(),owner_member_id:id.optional(),
 instruction:z.string().max(10000).optional(),resource_ids:z.array(id).max(100).optional(),
 priority:z.number().int().min(-1).max(2).optional(),delay_seconds:z.number().int().min(0).max(31536000).optional(),
 source_id:id.optional(),from:target.optional(),target:target.optional(),board:board.optional(),
 max_per_work:z.number().int().min(0).max(20),
}).strict();
export const OriginalEventDefinition = z.object({version:z.literal(1),name:z.string().min(1),subscriptions:z.array(OriginalEventSubscription).max(100).nullable()}).strict();
export const EventConfigurationQuery = z.object({version:z.literal(1),unit_id:id,workspace_id:id.optional()}).strict();
export const EventConfiguration = z.object({version:z.literal(1),unit_id:id,workspace_id:id.optional(),work_revision:revision,configured:z.boolean(),workspace_version:revision.optional(),definition:OriginalEventDefinition}).strict();
export const EventConfigurationChange = z.object({version:z.literal(1),id,expected_revision:revision.max(Number.MAX_SAFE_INTEGER-1),unit_id:id,workspace_id:id.optional(),expected_workspace_version:revision.max(Number.MAX_SAFE_INTEGER-1),definition:OriginalEventDefinition}).strict();
export const EventDefinitionPreview = z.object({version:z.literal(1),command_id:id,unit_id:id,workspace_id:id.optional(),work_revision:revision,workspace_version:revision,definition:OriginalEventDefinition}).strict();
export const EventConfigurationReceipt = z.object({version:z.literal(1),command_id:id,unit_id:id,workspace_id:id.optional(),work_revision:revision,workspace_version:revision.optional(),accepted_at:z.iso.datetime({offset:true}),replayed:z.boolean()}).strict();
export type OriginalEventDefinitionSpec = z.infer<typeof OriginalEventDefinition>;
export type EventConfigurationSpec = z.infer<typeof EventConfiguration>;
export type EventConfigurationChangeSpec = z.infer<typeof EventConfigurationChange>;

const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
const sameScope=(a:{unit_id:string;workspace_id?:string},b:{unit_id:string;workspace_id?:string})=>a.unit_id===b.unit_id&&(a.workspace_id??'')===(b.workspace_id??'');
export function validateEventConfiguration(value:unknown, selector:z.infer<typeof EventConfigurationQuery>){
 const q=EventConfigurationQuery.parse(selector),v=EventConfiguration.parse(value),version=v.workspace_version??0;
 if(!sameScope(v,q)||bytes(v)>2*1024*1024||!q.workspace_id&&version!==0||v.configured&&!!q.workspace_id&&version===0||!v.configured&&(version!==0||v.definition.name!=='Events'||!Array.isArray(v.definition.subscriptions)||v.definition.subscriptions.length))throw Error('Invalid selected event configuration');
 return v;
}
export function validateEventConfigurationCommand(value:unknown){
 const c=EventConfigurationChange.parse(value);
 if(!c.workspace_id&&c.expected_workspace_version!==0||bytes(c)>65536)throw Error('Invalid event configuration command');
 return c;
}
function canonicalDefinition(value:OriginalEventDefinitionSpec){
 const f=structuredClone(value);
 for(const s of f.subscriptions??[]){
  s.max_per_work ||= 3;
  for(const k of ['instruction','resource_ids','delay_seconds'] as const)if(s[k]===''||s[k]===0||Array.isArray(s[k])&&!s[k]!.length)delete s[k];
  if(s.board&&s.board.actions?.length===0)delete s.board.actions;
 }
 return f;
}
function ordered(value:unknown):unknown{
 if(Array.isArray(value))return value.map(ordered);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)]));
 return value;
}
export function validateEventDefinitionPreview(value:unknown,command:EventConfigurationChangeSpec){
 const c=validateEventConfigurationCommand(command),p=EventDefinitionPreview.parse(value);
 if(!sameScope(p,c)||p.command_id!==c.id||p.work_revision!==c.expected_revision||p.workspace_version!==c.expected_workspace_version||bytes(p)>2*65536+16384||JSON.stringify(ordered(p.definition))!==JSON.stringify(ordered(canonicalDefinition(c.definition))))throw Error('Invalid event definition preview');
 return p;
}
export function validateEventConfigurationReceipt(value:unknown,command:EventConfigurationChangeSpec){
 const c=validateEventConfigurationCommand(command),r=EventConfigurationReceipt.parse(value);
 if(!sameScope(r,c)||r.command_id!==c.id||r.work_revision!==c.expected_revision+1||(r.workspace_version??0)!==(c.workspace_id?c.expected_workspace_version+1:0)||bytes(r)>8192)throw Error('Invalid event configuration receipt');
 return r;
}
