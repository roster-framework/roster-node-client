import {z} from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const ExecutionSuspensionOrigin = z.object({
  execution_id: id, work_id: id, runtime_id: id, agent_id: id,
}).strict();

// Runtime terminal evidence only. The private checkpoint stays in its Runtime;
// neither a digest nor a valid receipt grants authority to resume execution.
export const ExecutionSuspension = ExecutionSuspensionOrigin.extend({
  protocol: z.literal('roster-execution-suspension/1'),
  wait_id: id,
  checkpoint_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const SuspendedFrame = z.object({
  type: z.literal('suspended'), suspension: ExecutionSuspension,
}).strict();
export const SuspendedExecutionReceipt = z.object({
  id, state: z.literal('suspended'), suspension: ExecutionSuspension,
}).strict().refine(r => r.id === r.suspension.execution_id,
  'Suspension must belong to the original execution');

export type ExecutionSuspensionSpec = z.infer<typeof ExecutionSuspension>;
export type ExecutionSuspensionOriginSpec = z.infer<typeof ExecutionSuspensionOrigin>;
export type SuspendedExecutionReceiptSpec = z.infer<typeof SuspendedExecutionReceipt>;

// JSON Schema consumers must perform these request-dependent checks as well.
export function validateExecutionSuspension(value: unknown, original: ExecutionSuspensionOriginSpec): ExecutionSuspensionSpec {
  const receipt = ExecutionSuspension.parse(value);
  const origin = ExecutionSuspensionOrigin.parse(original);
  for (const key of ['execution_id', 'work_id', 'runtime_id', 'agent_id'] as const) {
    if (receipt[key] !== origin[key]) throw Error('Foreign execution suspension');
  }
  return receipt;
}

export function validateSuspendedExecutionReceipt(value: unknown, original: ExecutionSuspensionOriginSpec): SuspendedExecutionReceiptSpec {
  const receipt = SuspendedExecutionReceipt.parse(value);
  validateExecutionSuspension(receipt.suspension, original);
  return receipt;
}
