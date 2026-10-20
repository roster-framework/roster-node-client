import {z} from 'zod';

const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1);
const target=z.object({runtime_id:id,agent_id:id}).strict();
export const ProviderChangeCommand=z.object({version:z.literal(1),id,expected_revision:revision,member_id:id,previous:target,next:target,binding_version:revision,actor:z.object({account_id:id,member_id:id}).strict()}).strict();
export const ProviderChangeProgress=z.object({version:z.literal(1),command_id:id,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),stage:z.enum(['new','held','accepted-pending','aborted-pending','accepted','aborted']),binding_version:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),work_revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export type ProviderChangeCommandSpec=z.infer<typeof ProviderChangeCommand>;
export type ProviderChangeProgressSpec=z.infer<typeof ProviderChangeProgress>;
export function validateProviderChangeCommand(value:unknown){
 const c=ProviderChangeCommand.parse(value);
 if(c.previous.runtime_id===c.next.runtime_id&&c.previous.agent_id===c.next.agent_id||new TextEncoder().encode(JSON.stringify(c)).length>4096)throw Error('Invalid provider command');
 return c;
}
// Core hashes its Go struct's exact field order. All identifiers are ASCII and
// revisions are safe integers; caller property ordering must not change the hash.
export async function providerChangeFingerprint(value:unknown){
 const c=validateProviderChangeCommand(value);
 const canonical={version:c.version,id:c.id,expected_revision:c.expected_revision,member_id:c.member_id,previous:{runtime_id:c.previous.runtime_id,agent_id:c.previous.agent_id},next:{runtime_id:c.next.runtime_id,agent_id:c.next.agent_id},binding_version:c.binding_version,actor:{account_id:c.actor.account_id,member_id:c.actor.member_id}};
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical)));
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function validateProviderChangeProgress(value:unknown,command:ProviderChangeCommandSpec){
 const c=validateProviderChangeCommand(command),p=ProviderChangeProgress.parse(value),accepted=p.stage==='accepted'||p.stage==='accepted-pending';
 if(p.command_id!==c.id||p.fingerprint!==await providerChangeFingerprint(c)||p.binding_version!==c.binding_version+(accepted?1:0)||p.work_revision!==c.expected_revision+(p.stage==='accepted'?1:0))throw Error('Invalid provider progress');
 return p;
}
