import type { JournalRetention } from "../application/session-retention.js";

export function startSessionRetention(retention: JournalRetention, sweepSeconds: number, warn: (message: string) => void = console.warn) {
  if (!Number.isSafeInteger(sweepSeconds) || sweepSeconds < 60 || sweepSeconds > 86400) throw new Error("Invalid journal sweep interval");
  if (retention.policy.retainHours === null) return () => {};
  let budgetWarning = false;
  const timer = setInterval(() => {
    try {
      retention.prune();
      const status = retention.status();
      if (status.budgetExceeded && !budgetWarning)
        warn(`Journal payload budget exceeded: ${status.usage.retainedPayloadBytes} bytes; protected records are retained`);
      budgetWarning = status.budgetExceeded;
    } catch {
      warn("Journal retention failed; records are preserved and the next sweep will retry");
    }
  }, sweepSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
