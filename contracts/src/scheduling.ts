import {z} from 'zod';

const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Limit=z.number().int().min(1).max(100);
export const SCHEDULER_COMMAND_AUDIENCE='roster-work-scheduler-change/1';
export const SCHEDULER_COMMAND_MAX_BYTES=65536;

export const Scheduler=z.object({
  global_limit:Limit,runtime_limit:Limit,agent_limit:Limit,
  runtime_limits:z.record(Id,Limit).optional(),
  agent_limits:z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),Limit).optional(),
}).strict();
export const SchedulerCommand=z.object({version:z.literal(1),id:Id,expected_revision:Revision.max(Number.MAX_SAFE_INTEGER-1),scheduler:Scheduler}).strict();
export const SchedulerView=z.object({revision:Revision,scheduler:Scheduler}).strict();
export const SchedulerActor=z.object({account_id:Id,member_id:Id}).strict();
export const SchedulerReceipt=z.object({
  version:z.literal(1),command_id:Id,command_digest:z.string().regex(/^[a-f0-9]{64}$/),actor:SchedulerActor,
  core_revision:Revision,work_revision:Revision.min(1),accepted_at:z.iso.datetime({offset:true}),replayed:z.boolean(),
}).strict();

function boundedScheduler(value:SchedulerConfig) {
  if(Object.keys(value.runtime_limits??{}).length>100 || Object.keys(value.agent_limits??{}).length>1000)throw Error('Invalid scheduler override count');
}
export function validateSchedulerCommand(value:unknown) {
  const c=SchedulerCommand.parse(value);
  boundedScheduler(c.scheduler);
  if(new TextEncoder().encode(JSON.stringify(c)).length>SCHEDULER_COMMAND_MAX_BYTES)throw Error('Scheduler command exceeds limit');
  return c;
}
export function validateSchedulerView(value:unknown) {
  const v=SchedulerView.parse(value);boundedScheduler(v.scheduler);return v;
}
// Canonical Go JSON uses struct field order and sorted map keys, and omits
// empty override maps. The allowed keys are ASCII; no provider data is hashed.
export async function schedulerCommandDigest(value:unknown) {
  const c=validateSchedulerCommand(value),s=c.scheduler;
  // JSON.stringify reorders integer-looking object keys numerically even after
  // sorting. Serialize maps explicitly so runtime IDs "10" and "2" match Go.
  const ordered=(map:Record<string,number>)=>'{'+Object.keys(map).sort().map(key=>JSON.stringify(key)+':'+map[key]).join(',')+'}';
  let scheduler='"global_limit":'+s.global_limit+',"runtime_limit":'+s.runtime_limit+',"agent_limit":'+s.agent_limit;
  if(s.runtime_limits && Object.keys(s.runtime_limits).length)scheduler+=',"runtime_limits":'+ordered(s.runtime_limits);
  if(s.agent_limits && Object.keys(s.agent_limits).length)scheduler+=',"agent_limits":'+ordered(s.agent_limits);
  const canonical='{"audience":'+JSON.stringify(SCHEDULER_COMMAND_AUDIENCE)+',"command":{"version":1,"id":'+JSON.stringify(c.id)+',"expected_revision":'+c.expected_revision+',"scheduler":{'+scheduler+'}}}';
  const hash=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function validateSchedulerReceipt(value:unknown,command:unknown,expectedActor?:SchedulerActorSpec) {
  const c=validateSchedulerCommand(command),r=SchedulerReceipt.parse(value);
  if(r.command_id!==c.id || r.command_digest!==await schedulerCommandDigest(c) || r.work_revision!==c.expected_revision+1)throw Error('Scheduler receipt does not match command');
  if(expectedActor) {
    const actor=SchedulerActor.parse(expectedActor);
    if(r.actor.account_id!==actor.account_id || r.actor.member_id!==actor.member_id)throw Error('Scheduler receipt does not match actor');
  }
  return r;
}

export type SchedulerConfig=z.infer<typeof Scheduler>;
export type SchedulerCommandSpec=z.infer<typeof SchedulerCommand>;
export type SchedulerViewSpec=z.infer<typeof SchedulerView>;
export type SchedulerActorSpec=z.infer<typeof SchedulerActor>;
export type SchedulerReceiptSpec=z.infer<typeof SchedulerReceipt>;
