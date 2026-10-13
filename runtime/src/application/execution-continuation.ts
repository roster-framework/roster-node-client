import {createHash} from 'node:crypto';
import {ExecutionContinuation,ExecutionSuspension,type RunInput} from '@roster/contracts';
import type {ExecutionRepository} from './ports.js';
import type {AgentContinuation} from '../domain/execution-continuation.js';

// Read only the exact local parent selected by the authenticated Core body.
// This performs no authority check itself; the caller must check before/after.
export async function loadExecutionContinuation(input:RunInput,runtimeId:string,storage:ExecutionRepository):Promise<AgentContinuation|undefined> {
 if(!input.context.continuation)return undefined;
 const unavailable=()=>new Error('Continuation checkpoint unavailable');
 try {
  const reference=ExecutionContinuation.parse(input.context.continuation);
  if(reference.parent_execution_id===input.execution_id||!storage.readSuspensionCheckpoint)throw unavailable();
  const receipt=await storage.get(reference.parent_execution_id);
  if(receipt?.state!=='suspended'||receipt.id!==reference.parent_execution_id||receipt.result!==undefined||receipt.observation!==undefined)throw unavailable();
  const terminal=ExecutionSuspension.parse(receipt.suspension);
  const checkpoint=await storage.readSuspensionCheckpoint(reference.parent_execution_id);
  const expected={execution_id:reference.parent_execution_id,work_id:input.work_id,runtime_id:runtimeId,agent_id:input.agent_id,wait_id:reference.wait_id};
  for(const key of Object.keys(expected) as (keyof typeof expected)[])if(terminal[key]!==expected[key]||checkpoint[key]!==expected[key])throw unavailable();
  if(checkpoint.version!==1||!checkpoint.state||typeof checkpoint.state!=='object'||Array.isArray(checkpoint.state)||Object.keys(checkpoint).some(k=>!['version','execution_id','work_id','runtime_id','agent_id','wait_id','state'].includes(k)))throw unavailable();
  if(Buffer.byteLength(JSON.stringify(checkpoint.state))>65536||terminal.checkpoint_digest!==reference.checkpoint_digest||createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex')!==reference.checkpoint_digest)throw unavailable();
  const result:AgentContinuation=structuredClone({reference,checkpoint:checkpoint.state});
  const pending:object[]=[result];
  while(pending.length) {
   const value=pending.pop()!;
   for(const child of Object.values(value))if(child&&typeof child==='object')pending.push(child);
   Object.freeze(value);
  }
  return result;
 }catch{throw unavailable();}
}
