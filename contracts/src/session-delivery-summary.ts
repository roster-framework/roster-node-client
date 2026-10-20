import {z} from 'zod';

const Count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Stamp=z.iso.datetime().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/);
const orderedStamp=(s:string)=>s.replace(/(?:\.(\d+))?Z$/,(_m,f='')=>'.'+f.padEnd(9,'0')+'Z');
export const SessionDeliverySummary=z.object({
 total:Count.max(100000),pending:Count,complete:Count,observed:Count,unobserved:Count,
 pending_unobserved:Count,pending_errors:Count,recorded_attempts:Count,recorded_failures:Count,
 latest_errors:z.object({read:Count,validate:Count,archive:Count,checkpoint:Count,ack:Count,complete:Count}).strict(),
 latest_duration:z.object({samples:Count,sum_ms:Count,min_ms:Count,max_ms:Count}).strict(),
 first_attempt_at:Stamp.optional(),last_attempt_at:Stamp.optional(),
}).strict().refine(s=>{
 const errors=Object.values(s.latest_errors).reduce((a,b)=>a+b,0),d=s.latest_duration;
 if(!Number.isSafeInteger(errors)||s.total!==s.pending+s.complete||s.total!==s.observed+s.unobserved||s.pending_unobserved>s.unobserved||s.pending_unobserved>s.pending||s.unobserved-s.pending_unobserved>s.complete||s.pending_errors>s.pending-s.pending_unobserved||s.pending_errors>errors||errors>s.observed||errors-s.pending_errors>s.complete-(s.unobserved-s.pending_unobserved)||s.recorded_attempts<s.observed||s.recorded_failures>s.recorded_attempts||s.recorded_failures<errors||s.recorded_attempts-s.recorded_failures<s.observed-errors||d.samples!==s.observed)return false;
 if(!s.observed)return d.sum_ms===0&&d.min_ms===0&&d.max_ms===0&&s.recorded_attempts===0&&s.recorded_failures===0&&s.first_attempt_at===undefined&&s.last_attempt_at===undefined;
 if(!s.first_attempt_at||!s.last_attempt_at||orderedStamp(s.last_attempt_at)<orderedStamp(s.first_attempt_at)||d.min_ms>d.max_ms||d.sum_ms<d.max_ms)return false;
 if(d.samples===1)return d.min_ms===d.sum_ms&&d.max_ms===d.sum_ms;
 const n=d.samples-1;
 // Quotients/remainders avoid an unsafe product of a duration and sample count.
 return Math.floor((d.sum_ms-d.max_ms)/n)>=d.min_ms&&(Math.floor((d.sum_ms-d.min_ms)/n)<d.max_ms||Math.floor((d.sum_ms-d.min_ms)/n)===d.max_ms&&(d.sum_ms-d.min_ms)%n===0);
});
export type SessionDeliverySummarySpec=z.infer<typeof SessionDeliverySummary>;
