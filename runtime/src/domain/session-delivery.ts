import type { SessionNote } from "./session.js";

export const SESSION_DELIVERY = "roster-session-delivery/1";
export type SessionRecord = { id: string; kind: SessionNote["kind"] | "result" | "observation"; text: string; at: string; sequence?: 0 };
export type JournalBinding = { execution_id: string; work_id: string; agent_id: string; consumer_id: string };
export type JournalEntry = { delivery_sequence: number; entry: SessionRecord };
export type JournalPage = JournalBinding & { protocol: typeof SESSION_DELIVERY; runtime_id: string; through: number; acknowledged: number; sealed: boolean; entries: JournalEntry[] };
export class JournalNotFound extends Error {}
export class JournalRecordsExpired extends Error {
  constructor(readonly executionId: string, readonly prunedThrough: number, readonly through: number, readonly acknowledged: number) {
    super("Journal records expired; retrieve historical records from the log archive");
  }
}
export function validateBinding(binding: JournalBinding) {
  for (const [key, value] of Object.entries(binding))
    if (typeof value !== "string" || !(key==="consumer_id" ? /^[a-zA-Z0-9_-]{1,128}$/ : /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/).test(value)) throw new Error(`Invalid journal ${key}`);
}
export function validateRecord(entry: SessionRecord) {
  if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(entry.id) || !["log","decision","note","knowhow","result","observation"].includes(entry.kind) ||
      typeof entry.text !== "string" || !entry.text.trim() || Buffer.byteLength(entry.text) > 20000 ||
      !/^\d{4}-\d\d-\d\dT/.test(entry.at) || !Number.isFinite(Date.parse(entry.at)) || (entry.sequence !== undefined && entry.sequence !== 0))
    throw new Error("Invalid journal record");
}
export function validateCursor(after: number, limit = 100) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid journal cursor");
}

// Recovery closes a local stream; it cannot infer the engine/business outcome.
export function journalRecoveryObservation(at: string): SessionRecord {
  const entry: SessionRecord = {id:'journal.recovered',kind:'note',at,
    text:JSON.stringify({protocol:'roster-session-journal-observation/1',phase:'recovery_sealed'})};
  validateRecord(entry);
  return entry;
}
