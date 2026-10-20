import { resolve } from "node:path";
import { SqliteSessionJournal } from "../infrastructure/sqlite-session-journal.js";
import { sessionRetentionConfig } from "../infrastructure/session-retention-config.js";
import { JournalRetention } from "../application/session-retention.js";

// This maintenance composition never loads agents or recovers running executions.
const [command, ...args] = process.argv.slice(2);
if (!["status", "prune", "audit"].includes(command ?? "") ||
    (command !== "audit" && args.length) || args.length > 2)
  throw new Error("Usage: tsx src/commands/session-journal.ts status|prune|audit [after] [limit]");
const config = sessionRetentionConfig(process.env);
const journal = new SqliteSessionJournal(resolve(process.env.ROSTER_DATA_DIR || ".roster", "session-journal.db"), process.env.ROSTER_RUNTIME_ID || "node-local");
try {
  const retention = new JournalRetention(journal, config.policy);
  const output = command === "status" ? retention.status() : command === "prune" ? retention.prune() : retention.audit(Number(args[0] ?? 0), Number(args[1] ?? 100));
  console.log(JSON.stringify(output));
} finally { journal.close(); }
