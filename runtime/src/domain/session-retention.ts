export const JOURNAL_PRUNE_BATCH = 1000;
export type JournalRetentionPolicy = Readonly<{
  retainHours: number | null;
  budgetBytes: number | null;
}>;
export type JournalRetentionHead = {
  through: number;
  acknowledged: number;
  sealed: boolean;
  fullyAcknowledgedAt: number | null;
};
export function journalRetentionPolicy(retainHours: number | null = null, budgetBytes: number | null = null): JournalRetentionPolicy {
  if (retainHours !== null && (!Number.isSafeInteger(retainHours) || retainHours < 24 || retainHours > 87600))
    throw new Error("Journal retention must be 24..87600 hours");
  if (budgetBytes !== null && (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1))
    throw new Error("Journal payload budget must be a positive safe integer");
  return Object.freeze({ retainHours, budgetBytes });
}
export function validateRetentionTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid retention time");
}
export function journalCanBePruned(head: JournalRetentionHead, policy: JournalRetentionPolicy, now: number): boolean {
  return policy.retainHours !== null && head.sealed && head.through === head.acknowledged &&
    head.fullyAcknowledgedAt !== null && now >= head.fullyAcknowledgedAt + policy.retainHours * 3600000;
}
export type JournalRetentionUsage = {
  streams: number;
  retainedRecords: number;
  retainedPayloadBytes: number;
  protectedPayloadBytes: number;
  eligiblePayloadBytes: number;
  purgedRecords: number;
};
export type JournalPruneResult = { records: number; payloadBytes: number; streams: number };
export type JournalPruneAudit = {
  id: number;
  executionId: string;
  consumerId: string;
  fromSequence: number;
  throughSequence: number;
  records: number;
  payloadBytes: number;
  prunedAt: number;
  retainHours: number;
};
export class JournalRetentionDisabled extends Error {
  constructor() { super("Journal retention is disabled"); }
}
export class JournalRetentionFailed extends Error {
  constructor(cause: unknown) { super("Journal retention failed; no deletion was committed", { cause }); }
}
