import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqliteSessionJournal } from "../src/infrastructure/sqlite-session-journal.js";
import { FileRuntimeStorage } from "../src/infrastructure/filesystem.js";
import { RosterRuntime } from "../src/application/runtime.js";
import { createRuntimeApi } from "../src/interfaces/http.js";
import { SESSION_DELIVERY, JournalNotFound, JournalRecordsExpired } from "../src/domain/session-delivery.js";
import { journalRetentionPolicy, JournalRetentionDisabled, JournalRetentionFailed } from "../src/domain/session-retention.js";
import { JournalRetention } from "../src/application/session-retention.js";
import { sessionRetentionConfig } from "../src/infrastructure/session-retention-config.js";
import { startSessionRetention } from "../src/infrastructure/session-retention-timer.js";
import type { JournalRetentionStore } from "../src/domain/session-retention-store.js";

const start = Date.parse("2026-10-04T00:00:00Z"), day = 86400000;
const record = (id: number) => ({ id: `record-${id}`, kind: "decision" as const, text: `결정 ${id}`, at: new Date(start).toISOString() });
function fill(journal: SqliteSessionJournal, id: string, count = 1) {
  journal.begin({ execution_id: id, work_id: "work", agent_id: "agent", consumer_id: "core" });
  for (let i = 0; i < count; i++) journal.append(id, record(i));
}

test("retention defaults off and rejects invalid settings without weakening the grace period", () => {
  assert.equal(sessionRetentionConfig({}).policy.retainHours, null);
  assert.equal(sessionRetentionConfig({ ROSTER_JOURNAL_RETAIN_HOURS: "24", ROSTER_JOURNAL_BUDGET_MB: "1" }).policy.budgetBytes, 1048576);
  for (const value of ["0", "23", "24.0", "NaN", "-24", "Infinity", "87601", " 24"])
    assert.throws(() => sessionRetentionConfig({ ROSTER_JOURNAL_RETAIN_HOURS: value }));
  assert.throws(() => sessionRetentionConfig({ ROSTER_JOURNAL_BUDGET_MB: "0" }));
  assert.throws(() => sessionRetentionConfig({ ROSTER_JOURNAL_SWEEP_SECONDS: "59" }));
  assert.throws(() => journalRetentionPolicy(23));
});

test("only sealed fully ACKed records expire; duplicates and capacity pressure cannot bypass protection", async t => {
  const dir = await mkdtemp(join(tmpdir(), "roster-retention-"));
  let now = start;
  const journal = new SqliteSessionJournal(join(dir, "journal.db"), "runtime", () => now);
  t.after(async () => { journal.close(); await rm(dir, { recursive: true, force: true }); });
  fill(journal, "complete", 2); journal.seal("complete"); journal.acknowledge("complete", "core", 2);
  fill(journal, "partial", 2); journal.seal("partial"); journal.acknowledge("partial", "core", 1);
  fill(journal, "unacked"); journal.seal("unacked");
  fill(journal, "live"); journal.acknowledge("live", "core", 1);
  const disabled = new JournalRetention(journal, journalRetentionPolicy(), () => now);
  assert.throws(() => disabled.prune(), JournalRetentionDisabled);
  const retention = new JournalRetention(journal, journalRetentionPolicy(24, 1), () => now);
  now += day - 1;
  journal.acknowledge("complete", "core", 2);
  assert.equal(retention.prune().records, 0);
  assert.equal(retention.status().budgetExceeded, true);
  now++;
  assert.equal(retention.prune().records, 2);
  for (const id of ["partial", "unacked", "live"]) assert.ok(journal.page(id, "core", 0, 100).entries.length);
  assert.equal(retention.status().usage.protectedPayloadBytes, retention.status().usage.retainedPayloadBytes);
  assert.throws(() => journal.page("complete", "other", 0, 100), JournalNotFound);
  assert.throws(() => journal.page("complete", "core", 0, 100), JournalRecordsExpired);
  assert.equal(journal.page("complete", "core", 2, 100).entries.length, 0);
  assert.equal(journal.acknowledge("complete", "core", 0), 2);
  assert.throws(() => journal.append("complete", record(0)), /sealed/);
  assert.equal(retention.audit().items[0].records, 2);
  assert.ok(!JSON.stringify(retention.audit()).includes("결정"));
  // ACK while live starts no grace period until sealing.
  now += 10 * day; journal.seal("live");
  assert.equal(retention.prune().records, 0);
  now += day;
  assert.equal(retention.prune().records, 1);
});

test("bounded partial pruning preserves contiguous pages, watermarks and audit across reopen", async t => {
  const dir = await mkdtemp(join(tmpdir(), "roster-retention-batch-"));
  const path = join(dir, "journal.db"); let now = start;
  let journal = new SqliteSessionJournal(path, "runtime", () => now);
  fill(journal, "many", 1005); journal.seal("many"); journal.acknowledge("many", "core", 1005);
  now += day;
  assert.equal(journal.pruneAcknowledged(journalRetentionPolicy(24), now).records, 1000);
  assert.throws(() => journal.page("many", "core", 999, 100), (error: unknown) => error instanceof JournalRecordsExpired && error.prunedThrough === 1000);
  assert.equal(journal.page("many", "core", 1000, 100).entries.length, 5);
  journal.close(); journal = new SqliteSessionJournal(path, "runtime", () => now); journal.recover();
  t.after(async () => { journal.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(journal.pruneAcknowledged(journalRetentionPolicy(24), now).records, 5);
  const audits = journal.pruneAudit(0, 100);
  assert.deepEqual(audits.map(a => [a.fromSequence, a.throughSequence]), [[1, 1000], [1001, 1005]]);
  assert.equal(journal.pruneAudit(audits[0].id, 100).length, 1);
  const usage = journal.retentionUsage(journalRetentionPolicy(24), now);
  assert.equal(usage.retainedPayloadBytes, 0); assert.equal(usage.purgedRecords, 1005);
  assert.equal(journal.page("many", "core", 1005, 100).through, 1005);
  assert.throws(() => journal.begin({ execution_id: "many", work_id: "new", agent_id: "agent", consumer_id: "core" }));
});

test("ACK replay and repeated seal preserve grace without writing, including after reopen", async t => {
  const dir=await mkdtemp(join(tmpdir(),"roster-retention-replay-"));
  const path=join(dir,"journal.db"); let now=start;
  let journal=new SqliteSessionJournal(path,"runtime",()=>now);
  const db=new DatabaseSync(path);
  t.after(async()=>{db.close();journal.close();await rm(dir,{recursive:true,force:true});});
  db.exec(`CREATE TABLE writes(execution_id TEXT);
    CREATE TRIGGER count_stream_updates AFTER UPDATE ON streams
    BEGIN INSERT INTO writes VALUES(NEW.execution_id); END;`);
  fill(journal,"ack-first");fill(journal,"seal-first");
  journal.acknowledge("ack-first","core",1);
  journal.seal("seal-first");
  const count=()=>Number(db.prepare("SELECT count(*) AS n FROM writes").get()!.n);
  const before=count();
  now+=day;
  assert.equal(journal.acknowledge("ack-first","core",1),1);
  assert.equal(journal.acknowledge("ack-first","core",0),1);
  journal.seal("seal-first");
  assert.throws(()=>journal.acknowledge("ack-first","other",1),JournalNotFound);
  assert.throws(()=>journal.acknowledge("ack-first","core",2));
  assert.equal(count(),before);
  assert.equal(journal.pruneAcknowledged(journalRetentionPolicy(24),now).records,0);
  // Both orderings start grace only when seal and the final ACK have committed.
  journal.seal("ack-first");journal.acknowledge("seal-first","core",1);
  const rows=db.prepare("SELECT execution_id,fully_acknowledged_at FROM streams ORDER BY execution_id").all();
  assert.deepEqual(rows.map(r=>Number(r.fully_acknowledged_at)),[now,now]);
  journal.close();journal=new SqliteSessionJournal(path,"runtime",()=>now);
  const reopened=count();
  now+=day-1;
  for(const id of ["ack-first","seal-first"]){journal.seal(id);assert.equal(journal.acknowledge(id,"core",0),1);}
  assert.equal(count(),reopened);
  assert.deepEqual(db.prepare("SELECT execution_id,fully_acknowledged_at FROM streams ORDER BY execution_id").all(),rows);
  assert.equal(journal.pruneAcknowledged(journalRetentionPolicy(24),now).records,0);
  now++;
  assert.equal(journal.pruneAcknowledged(journalRetentionPolicy(24),now).records,2);
});

test("legacy journal upgrade retains original UTF-8 bytes and starts a fresh grace period", async t => {
  const dir = await mkdtemp(join(tmpdir(), "roster-retention-legacy-"));
  const path = join(dir, "journal.db"), db = new DatabaseSync(path), body = JSON.stringify(record(0));
  db.exec(`CREATE TABLE streams(execution_id TEXT PRIMARY KEY,work_id TEXT,agent_id TEXT,consumer_id TEXT,through INTEGER,acknowledged INTEGER,sealed INTEGER);
    CREATE TABLE records(execution_id TEXT,sequence INTEGER,id TEXT,body TEXT,PRIMARY KEY(execution_id,sequence),UNIQUE(execution_id,id));
    INSERT INTO streams VALUES('old','work','agent','core',1,1,1);`);
  db.prepare("INSERT INTO records VALUES('old',1,'record-0',?)").run(body); db.close();
  let now = start + 100 * day;
  const journal = new SqliteSessionJournal(path, "runtime", () => now);
  t.after(async () => { journal.close(); await rm(dir, { recursive: true, force: true }); });
  const policy = journalRetentionPolicy(24);
  assert.equal(journal.retentionUsage(policy, now).retainedPayloadBytes, Buffer.byteLength(body));
  assert.deepEqual(journal.page("old", "core", 0, 100).entries[0].entry, record(0));
  assert.equal(journal.pruneAcknowledged(policy, now).records, 0);
  now += day; assert.equal(journal.pruneAcknowledged(policy, now).records, 1);
});

test("audit write failure rolls back payload deletion and floor, then retries safely", async t => {
  const dir = await mkdtemp(join(tmpdir(), "roster-retention-failed-"));
  const path = join(dir, "journal.db"); let now = start;
  const journal = new SqliteSessionJournal(path, "runtime", () => now);
  fill(journal, "failed"); journal.seal("failed"); journal.acknowledge("failed", "core", 1); now += day;
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); journal.close(); await rm(dir, { recursive: true, force: true }); });
  db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON journal_retention_audit BEGIN SELECT RAISE(ABORT,'disk failed'); END;");
  const retention = new JournalRetention(journal, journalRetentionPolicy(24), () => now);
  assert.throws(() => retention.prune(), (error: unknown) => error instanceof JournalRetentionFailed && String(error.cause).includes("disk failed"));
  assert.equal(retention.status().lastFailureAt, now);
  assert.equal(journal.page("failed", "core", 0, 100).entries.length, 1);
  assert.equal(retention.audit().items.length, 0);
  db.exec("DROP TRIGGER reject_audit");
  assert.equal(retention.prune().records, 1); assert.equal(retention.status().lastFailureAt, null);
});

test("native HTTP uses server policy, protects credentials and returns explicit expiry without running agents", async t => {
  const dir = await mkdtemp(join(tmpdir(), "roster-retention-http-")); let now = start;
  const journal = new SqliteSessionJournal(join(dir, "journal.db"), "runtime", () => now);
  fill(journal, "run"); journal.seal("run"); journal.acknowledge("run", "core", 1); now += day;
  const storage = new FileRuntimeStorage(dir, "runtime");
  const runtime = new RosterRuntime("runtime", [], storage, storage, storage,
    { execute() { throw Error("Agent must never run"); } }, { create() { throw Error("No agent"); } }, { inspect: async () => [] }, undefined, undefined, journal);
  await runtime.initialize();
  const retention = new JournalRetention(journal, journalRetentionPolicy(24), () => now);
  const server = createRuntimeApi(runtime, "private-retention-operator-token", retention); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: "Bearer private-retention-operator-token", "Content-Type": "application/json", "X-Roster-Service-Protocol": SESSION_DELIVERY, "X-Roster-Session-Consumer": "core" };
  assert.equal((await fetch(origin + "/admin/session-journal")).status, 401);
  assert.equal((await fetch(origin + "/admin/session-journal/prune", { method: "POST", headers, body: JSON.stringify({ retainHours: 0 }) })).status, 400);
  assert.equal((await fetch(origin + "/admin/session-journal/prune", { method: "POST", headers, body: "{}" })).status, 200);
  const expired = await fetch(origin + "/executions/run/records", { headers });
  assert.equal(expired.status, 410); assert.equal((await expired.json()).pruned_through, 1);
  assert.equal((await fetch(origin + "/executions/run/records", { headers: { ...headers, "X-Roster-Session-Consumer": "other" } })).status, 404);
  assert.equal((await fetch(origin + "/executions/run/records?after=1", { headers })).status, 200);
  assert.equal((await (await fetch(origin + "/admin/session-journal/audit", { headers })).json()).items.length, 1);
  assert.equal((await (await fetch(origin + "/admin/session-journal", { headers })).json()).usage.purgedRecords, 1);
});

test("CLI calls the same maintenance use cases without loading agent modules", async t => {
  const dir = await mkdtemp(join(tmpdir(), "roster-retention-cli-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new SqliteSessionJournal(join(dir, "session-journal.db"), "runtime", () => Date.now() - 2 * day);
  fill(journal, "cli"); journal.seal("cli"); journal.acknowledge("cli", "core", 1); journal.close();
  const env = { ...process.env, ROSTER_DATA_DIR: dir, ROSTER_JOURNAL_RETAIN_HOURS: "24", ROSTER_AGENT_MODULE: "/nonexistent-never-loaded.ts" };
  const run = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ["--import", "tsx", "src/commands/session-journal.ts", ...args], { env })).stdout);
  assert.equal((await run(["status"])).usage.retainedRecords, 1);
  assert.equal((await run(["prune"])).records, 1);
  assert.equal((await run(["audit", "0", "1"])).items[0].executionId, "cli");
});

test("scheduled sweeps keep protected records, report failures and stop before journal closure", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0, fail = true;
  const store: JournalRetentionStore = {
    retentionUsage: () => ({ streams: 1, retainedRecords: 1, retainedPayloadBytes: 2, protectedPayloadBytes: 2, eligiblePayloadBytes: 0, purgedRecords: 0 }),
    pruneAcknowledged() { calls++; if (fail) throw Error("failure"); return { records: 0, payloadBytes: 0, streams: 0 }; },
    pruneAudit: () => [],
  };
  const warnings: string[] = [], retention = new JournalRetention(store, journalRetentionPolicy(24, 1), () => start);
  const stop = startSessionRetention(retention, 60, message => warnings.push(message));
  t.mock.timers.tick(60000); assert.equal(retention.status().lastFailureAt, start);
  fail = false; t.mock.timers.tick(60000); assert.equal(retention.status().lastFailureAt, null);
  t.mock.timers.tick(60000); assert.equal(warnings.length, 2);
  stop(); t.mock.timers.tick(60000); assert.equal(calls, 3);
});
