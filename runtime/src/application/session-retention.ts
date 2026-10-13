import { JournalRetentionDisabled, JournalRetentionFailed, journalRetentionPolicy, validateRetentionTime, type JournalRetentionPolicy } from "../domain/session-retention.js";
import type { JournalRetentionStore } from "../domain/session-retention-store.js";

export class JournalRetention {
  readonly policy: JournalRetentionPolicy;
  private failureAt: number | null = null;
  constructor(private store: JournalRetentionStore, policy: JournalRetentionPolicy, private clock: () => number = Date.now) {
    this.policy = journalRetentionPolicy(policy.retainHours, policy.budgetBytes);
  }
  private now() { const now = this.clock(); validateRetentionTime(now); return now; }
  status() {
    const now = this.now(), usage = this.store.retentionUsage(this.policy, now);
    return { enabled: this.policy.retainHours !== null, policy: this.policy, usage,
      budgetExceeded: this.policy.budgetBytes !== null && usage.retainedPayloadBytes > this.policy.budgetBytes,
      lastFailureAt: this.failureAt };
  }
  prune() {
    if (this.policy.retainHours === null) throw new JournalRetentionDisabled();
    const now = this.now();
    try { const result = this.store.pruneAcknowledged(this.policy, now); this.failureAt = null; return result; }
    catch (error) { this.failureAt = now; throw new JournalRetentionFailed(error); }
  }
  audit(after = 0, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid retention audit cursor");
    return { items: this.store.pruneAudit(after, limit) };
  }
}
