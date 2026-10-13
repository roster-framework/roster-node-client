import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from 'node:crypto';
import {validateSuspensionJournal, type SuspensionJournalCommit} from '../domain/suspension-journal.js';
import type { SessionJournal } from "../application/session-journal.js";
import { SESSION_DELIVERY, journalRecoveryObservation, JournalNotFound, JournalRecordsExpired, validateBinding, validateRecord, validateCursor, type JournalBinding, type JournalPage, type SessionRecord } from "../domain/session-delivery.js";
import type { JournalRetentionStore } from "../domain/session-retention-store.js";
import { JOURNAL_PRUNE_BATCH, journalCanBePruned, journalRetentionPolicy, validateRetentionTime, type JournalPruneAudit, type JournalPruneResult, type JournalRetentionPolicy, type JournalRetentionUsage } from "../domain/session-retention.js";

type Head = JournalBinding & { through: number; acknowledged: number; sealed: number;
  suspension_fingerprint: string | null;
  fully_acknowledged_at: number | null; retained_bytes: number; pruned_through: number };
export class SqliteSessionJournal implements SessionJournal, JournalRetentionStore {
  private db: DatabaseSync;
  constructor(path: string, private runtimeId: string, private clock: () => number = Date.now) {
    mkdirSync(dirname(path), {recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS streams(execution_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, agent_id TEXT NOT NULL, consumer_id TEXT NOT NULL, through INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0, sealed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS records(execution_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(execution_id,sequence), UNIQUE(execution_id,id));`);
    try { this.initializeRetention(); }
    catch(error) { this.db.close(); throw error; }
  }
  private now() { const now=this.clock(); validateRetentionTime(now); return now; }
  private initializeRetention() {
    this.transaction(() => {
      const columns=new Set(this.db.prepare("PRAGMA table_info(streams)").all().map(row=>row.name));
      if(!columns.has('suspension_fingerprint'))this.db.exec('ALTER TABLE streams ADD COLUMN suspension_fingerprint TEXT');
      if(!columns.has("fully_acknowledged_at")) this.db.exec("ALTER TABLE streams ADD COLUMN fully_acknowledged_at INTEGER");
      if(!columns.has("pruned_through")) this.db.exec("ALTER TABLE streams ADD COLUMN pruned_through INTEGER NOT NULL DEFAULT 0");
      if(!columns.has("retained_bytes")) {
        this.db.exec("ALTER TABLE streams ADD COLUMN retained_bytes INTEGER NOT NULL DEFAULT 0");
        this.db.exec("UPDATE streams SET retained_bytes=COALESCE((SELECT SUM(length(CAST(body AS BLOB))) FROM records WHERE records.execution_id=streams.execution_id),0)");
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS journal_retention_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
        from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL, records INTEGER NOT NULL,
        payload_bytes INTEGER NOT NULL, pruned_at INTEGER NOT NULL, retain_hours INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS streams_retention_due ON streams(fully_acknowledged_at,execution_id) WHERE sealed=1 AND acknowledged=through AND retained_bytes>0;`);
      // Existing complete streams receive a fresh grace period, never an inferred old timestamp.
      this.markFullyAcknowledged(this.now());
    });
  }
  private markFullyAcknowledged(now: number, id?: string) {
    const query="UPDATE streams SET fully_acknowledged_at=? WHERE sealed=1 AND acknowledged=through AND fully_acknowledged_at IS NULL";
    if(id===undefined) this.db.prepare(query).run(now);
    else this.db.prepare(query+" AND execution_id=?").run(now,id);
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value=action(); this.db.exec("COMMIT"); return value; }
    catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private head(id: string, consumer?: string): Head {
    const head = this.db.prepare("SELECT * FROM streams WHERE execution_id=?").get(id) as Head | undefined;
    if (!head || (consumer !== undefined && head.consumer_id !== consumer)) throw new JournalNotFound("Journal not found");
    return head;
  }
  begin(binding: JournalBinding) {
    validateBinding(binding);
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO streams(execution_id,work_id,agent_id,consumer_id) VALUES(?,?,?,?)").run(binding.execution_id,binding.work_id,binding.agent_id,binding.consumer_id);
      const existing=this.head(binding.execution_id);
      if (existing.work_id !== binding.work_id || existing.agent_id !== binding.agent_id || existing.consumer_id !== binding.consumer_id) throw new Error("Journal binding conflict");
    });
  }
  append(id: string, record: SessionRecord) {
    this.appendBatch(id,[record]);
  }
  appendBatch(id: string, records: readonly SessionRecord[]) {
    if(!records.length || records.length>64) throw new Error("Invalid journal batch size");
    records.forEach(validateRecord);
    this.transaction(() => this.appendRecords(id, records));
  }
  private appendRecords(id: string, records: readonly SessionRecord[]) {
    const head=this.head(id);
    let through=head.through, bytes=0;
    for(const record of records) {
      const body=JSON.stringify(record);
      const old=this.db.prepare("SELECT body FROM records WHERE execution_id=? AND id=?").get(id,record.id);
      if (old) { if(old.body !== body) throw new Error("Journal record conflict"); continue; }
      if(head.sealed) throw new Error("Journal is sealed");
      this.db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(id,++through,record.id,body);
      bytes+=Buffer.byteLength(body);
    }
    if(through!==head.through) this.db.prepare("UPDATE streams SET through=?,retained_bytes=retained_bytes+? WHERE execution_id=?").run(through,bytes,id);
  }

  seal(id: string) {
    this.transaction(() => {
      if(this.head(id).sealed) return;
      this.db.prepare("UPDATE streams SET sealed=1 WHERE execution_id=?").run(id);
      this.markFullyAcknowledged(this.now(),id);
    });
  }
  commitSuspension(commit: SuspensionJournalCommit) {
    validateSuspensionJournal(commit);
    if(commit.receipt.runtime_id!==this.runtimeId)throw new Error('Foreign suspension Runtime');
    const {binding,entry}=commit;
    const fingerprint=createHash('sha256').update(JSON.stringify(commit)).digest('hex');
    this.transaction(()=>{
      const head=this.head(binding.execution_id,binding.consumer_id);
      if(head.work_id!==binding.work_id || head.agent_id!==binding.agent_id)throw new Error('Foreign suspension journal stream');
      if(head.suspension_fingerprint!==null) {
        if(head.suspension_fingerprint!==fingerprint || !head.sealed)throw new Error('Suspension journal conflict');
        return; // Includes an already acknowledged/pruned terminal record.
      }
      if(head.sealed)throw new Error('Suspension journal is already sealed');
      const body=JSON.stringify(entry);
      this.db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(binding.execution_id,head.through+1,entry.id,body);
      this.db.prepare('UPDATE streams SET through=through+1,retained_bytes=retained_bytes+?,sealed=1,suspension_fingerprint=? WHERE execution_id=?').run(Buffer.byteLength(body),fingerprint,binding.execution_id);
      this.markFullyAcknowledged(this.now(),binding.execution_id);
    });
  }
  recover() {
    this.transaction(() => {
      const now=this.now();
      const entry=journalRecoveryObservation(new Date(now).toISOString());
      for(const row of this.db.prepare("SELECT execution_id FROM streams WHERE sealed=0").iterate()) {
        const id=String(row.execution_id);
        this.appendRecords(id,[entry]);
        this.db.prepare("UPDATE streams SET sealed=1 WHERE execution_id=?").run(id);
      }
      this.markFullyAcknowledged(now);
    });
  }
  page(id: string, consumer: string, after: number, limit: number): JournalPage {
    validateCursor(after,limit);
    return this.transaction(() => {
      const h=this.head(id,consumer);
      if(after > h.through) throw new Error("Journal cursor exceeds published records");
      if(after < h.pruned_through) throw new JournalRecordsExpired(id,h.pruned_through,h.through,h.acknowledged);
      const rows=this.db.prepare("SELECT sequence,body FROM records WHERE execution_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(id,after,limit);
      return {protocol:SESSION_DELIVERY,runtime_id:this.runtimeId,execution_id:id,work_id:h.work_id,agent_id:h.agent_id,consumer_id:h.consumer_id,through:h.through,acknowledged:h.acknowledged,sealed:Boolean(h.sealed),
        entries:rows.map(r=>({delivery_sequence:Number(r.sequence),entry:JSON.parse(String(r.body))}))};
    });
  }
  acknowledge(id: string, consumer: string, through: number) {
    validateCursor(through);
    return this.transaction(() => {
      const head=this.head(id,consumer);
      if(through > head.through) throw new Error("ACK exceeds published records");
      if(through <= head.acknowledged) return head.acknowledged;
      const acknowledged=through;
      this.db.prepare("UPDATE streams SET acknowledged=? WHERE execution_id=?").run(acknowledged,id);
      this.markFullyAcknowledged(this.now(),id);
      return acknowledged;
    });
  }
  retentionUsage(policy: JournalRetentionPolicy, now: number): JournalRetentionUsage {
    journalRetentionPolicy(policy.retainHours,policy.budgetBytes); validateRetentionTime(now);
    return this.transaction(() => {
      const usage: JournalRetentionUsage={streams:0,retainedRecords:0,retainedPayloadBytes:0,protectedPayloadBytes:0,eligiblePayloadBytes:0,purgedRecords:0};
      for(const row of this.db.prepare("SELECT through,acknowledged,sealed,fully_acknowledged_at,retained_bytes,pruned_through FROM streams").iterate()) {
        const h=row as Omit<Head,keyof JournalBinding>;
        usage.streams++; usage.retainedRecords+=h.through-h.pruned_through; usage.purgedRecords+=h.pruned_through;
        usage.retainedPayloadBytes+=h.retained_bytes;
        if(journalCanBePruned({through:h.through,acknowledged:h.acknowledged,sealed:Boolean(h.sealed),fullyAcknowledgedAt:h.fully_acknowledged_at},policy,now)) usage.eligiblePayloadBytes+=h.retained_bytes;
        else usage.protectedPayloadBytes+=h.retained_bytes;
      }
      return usage;
    });
  }
  pruneAcknowledged(policy: JournalRetentionPolicy, now: number): JournalPruneResult {
    journalRetentionPolicy(policy.retainHours,policy.budgetBytes); validateRetentionTime(now);
    const result: JournalPruneResult={records:0,payloadBytes:0,streams:0};
    if(policy.retainHours === null) return result;
    return this.transaction(() => {
      const heads=this.db.prepare(`SELECT * FROM streams WHERE sealed=1 AND acknowledged=through AND retained_bytes>0
        AND fully_acknowledged_at<=? ORDER BY fully_acknowledged_at,execution_id LIMIT ?`).all(now-policy.retainHours!*3600000,JOURNAL_PRUNE_BATCH) as Head[];
      for(const h of heads) {
        if(result.records === JOURNAL_PRUNE_BATCH) break;
        if(!journalCanBePruned({through:h.through,acknowledged:h.acknowledged,sealed:Boolean(h.sealed),fullyAcknowledgedAt:h.fully_acknowledged_at},policy,now)) continue;
        const rows=this.db.prepare("SELECT sequence,length(CAST(body AS BLOB)) AS bytes FROM records WHERE execution_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(h.execution_id,h.pruned_through,JOURNAL_PRUNE_BATCH-result.records);
        if(!rows.length) throw new Error("Journal retention metadata is inconsistent");
        const through=Number(rows.at(-1)!.sequence), bytes=rows.reduce((n,r)=>n+Number(r.bytes),0);
        if(through-h.pruned_through!==rows.length || bytes>h.retained_bytes) throw new Error("Journal retention metadata is inconsistent");
        const deleted=this.db.prepare("DELETE FROM records WHERE execution_id=? AND sequence<=?").run(h.execution_id,through);
        if(Number(deleted.changes)!==rows.length) throw new Error("Journal retention deletion conflict");
        this.db.prepare("UPDATE streams SET pruned_through=?,retained_bytes=retained_bytes-? WHERE execution_id=?").run(through,bytes,h.execution_id);
        this.db.prepare("INSERT INTO journal_retention_audit(execution_id,consumer_id,from_sequence,through_sequence,records,payload_bytes,pruned_at,retain_hours) VALUES(?,?,?,?,?,?,?,?)").run(h.execution_id,h.consumer_id,h.pruned_through+1,through,rows.length,bytes,now,policy.retainHours!);
        result.records+=rows.length; result.payloadBytes+=bytes; result.streams++;
      }
      return result;
    });
  }
  pruneAudit(after: number, limit: number): JournalPruneAudit[] {
    validateCursor(after,limit);
    return this.db.prepare("SELECT * FROM journal_retention_audit WHERE id>? ORDER BY id LIMIT ?").all(after,limit).map(r=>({
      id:Number(r.id),executionId:String(r.execution_id),consumerId:String(r.consumer_id),
      fromSequence:Number(r.from_sequence),throughSequence:Number(r.through_sequence),records:Number(r.records),
      payloadBytes:Number(r.payload_bytes),prunedAt:Number(r.pruned_at),retainHours:Number(r.retain_hours),
    }));
  }
  close() { this.db.close(); }
}
