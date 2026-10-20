import { journalRetentionPolicy } from "../domain/session-retention.js";

function integer(value: string | undefined, name: string): number | null {
  if (value === undefined || value === "") return null;
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`);
  return Number(value);
}
export function sessionRetentionConfig(env: NodeJS.ProcessEnv) {
  const hours = integer(env.ROSTER_JOURNAL_RETAIN_HOURS, "ROSTER_JOURNAL_RETAIN_HOURS");
  const mb = integer(env.ROSTER_JOURNAL_BUDGET_MB, "ROSTER_JOURNAL_BUDGET_MB");
  if (mb !== null && (mb < 1 || !Number.isSafeInteger(mb * 1048576))) throw new Error("Invalid ROSTER_JOURNAL_BUDGET_MB");
  const sweepSeconds = integer(env.ROSTER_JOURNAL_SWEEP_SECONDS, "ROSTER_JOURNAL_SWEEP_SECONDS") ?? 300;
  if (sweepSeconds < 60 || sweepSeconds > 86400) throw new Error("Journal sweep must be 60..86400 seconds");
  return { policy: journalRetentionPolicy(hours, mb === null ? null : mb * 1048576), sweepSeconds };
}
