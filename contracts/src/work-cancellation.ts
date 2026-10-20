import {z} from 'zod';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const CommandId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const PlannedWorkCancelCommand = z.object({version: z.literal(1), id: CommandId, work_id: Id}).strict();
export const PlannedWorkCancelReceipt = z.object({version: z.literal(1), kind: z.literal('planned-cancellation'), command_id: CommandId, work_id: Id, accepted_at: z.iso.datetime({offset: true}), replayed: z.boolean().optional()}).strict();
export type PlannedWorkCancelCommandSpec = z.infer<typeof PlannedWorkCancelCommand>;
export type PlannedWorkCancelReceiptSpec = z.infer<typeof PlannedWorkCancelReceipt>;

// Receipt acknowledges a durable cancellation intent, not Runtime termination.
export function validatePlannedWorkCancelReceipt(value: unknown, input: PlannedWorkCancelCommandSpec) {
  const command = PlannedWorkCancelCommand.parse(input);
  const receipt = PlannedWorkCancelReceipt.parse(value);
  if (receipt.command_id !== command.id || receipt.work_id !== command.work_id) throw Error('Foreign cancellation receipt');
  return receipt;
}
