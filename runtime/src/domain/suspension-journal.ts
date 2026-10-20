import { ExecutionSuspension } from '@roster/contracts';
import type { SuspensionReceipt } from './execution-suspension.js';
import { validateBinding, validateRecord, type JournalBinding, type SessionRecord } from './session-delivery.js';

export const SUSPENSION_NOTE = 'Execution suspended awaiting the registered reply.';

// Local recovery metadata. Never includes the private agent checkpoint or credentials.
export type SuspensionJournalCommit = {
  receipt: SuspensionReceipt;
  binding: JournalBinding;
  entry: SessionRecord;
};

export function validateSuspensionJournal(value: SuspensionJournalCommit) {
  if (!value || Object.keys(value).sort().join(',') !== 'binding,entry,receipt') throw new Error('Invalid suspension journal commit');
  ExecutionSuspension.parse(value.receipt);
  if (!value.binding || Object.keys(value.binding).sort().join(',') !== 'agent_id,consumer_id,execution_id,work_id') throw new Error('Invalid suspension journal binding');
  validateBinding(value.binding);
  const { receipt, binding, entry } = value;
  if (receipt.execution_id !== binding.execution_id || receipt.work_id !== binding.work_id || receipt.agent_id !== binding.agent_id) throw new Error('Foreign suspension journal binding');
  if (!entry || Object.keys(entry).sort().join(',') !== 'at,id,kind,text') throw new Error('Invalid suspension journal entry');
  validateRecord(entry);
  if (entry.kind !== 'note' || entry.id !== 'suspension.' + receipt.execution_id || entry.text !== SUSPENSION_NOTE) throw new Error('Invalid suspension terminal note');
}
