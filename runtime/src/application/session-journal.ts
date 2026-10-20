import type { JournalBinding, JournalPage, SessionRecord } from "../domain/session-delivery.js";

// Synchronous commits preserve the existing synchronous agent logging API.
export interface SessionJournal {
  // Atomically append the original fixed terminal note and seal its bound stream.
  commitSuspension?(commit: import('../domain/suspension-journal.js').SuspensionJournalCommit): void;
  begin(binding: JournalBinding): void;
  append(executionId: string, record: SessionRecord): void;
  // Optional atomic commit of a bounded burst; emission must follow the commit.
  appendBatch?(executionId: string, records: readonly SessionRecord[]): void;
  seal(executionId: string): void;
  recover(): void;
  page(executionId: string, consumer: string, after: number, limit: number): JournalPage;
  acknowledge(executionId: string, consumer: string, through: number): number;
  close(): void;
}
