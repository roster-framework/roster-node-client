import type { JournalPruneAudit, JournalPruneResult, JournalRetentionPolicy, JournalRetentionUsage } from "./session-retention.js";

export interface JournalRetentionStore {
  retentionUsage(policy: JournalRetentionPolicy, now: number): JournalRetentionUsage;
  pruneAcknowledged(policy: JournalRetentionPolicy, now: number): JournalPruneResult;
  pruneAudit(after: number, limit: number): JournalPruneAudit[];
}
