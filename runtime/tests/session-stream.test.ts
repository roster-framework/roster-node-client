import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL, Result } from "@roster/contracts";
import { RosterRuntime } from "../src/application/runtime.js";
import { createRuntimeApi } from "../src/interfaces/http.js";
import { FileRuntimeStorage } from "../src/infrastructure/filesystem.js";
import { inspectMcp, managedImplementation } from "../src/infrastructure/langchain-managed.js";
import type { RuntimeFrame } from "../src/domain/session.js";

test("HTTP session capability preserves explicit decisions, knowhow and UTF-8 logs without changing legacy streams", async t => {
  const directory = await mkdtemp(join(tmpdir(), "roster-sessions-"));
  const storage = new FileRuntimeStorage(directory, "session-test");
  const longText = "일😀".repeat(7000);
  const runtime = new RosterRuntime("session-test", [{
    spec: { id: "developer", name: "Developer", description: "test", statuses: ["ok"], events: [], skills: [], rules: [], capabilities: [] },
    async execute(_input, ctx) {
      ctx.log(longText);
      ctx.recordSession!({ kind: "decision", text: "Use a durable outbox" });
      ctx.recordSession!({ kind: "knowhow", text: "Check the receipt before retrying" });
      return Result.parse({ status: "ok", summary: "Saved" });
    },
  }], storage, storage, storage, { execute: (a,i,c) => a.execute(i,c) }, { create: managedImplementation }, { inspect: inspectMcp });
  await runtime.initialize();
  const server = createRuntimeApi(runtime, "session-test-token-at-least-24-chars");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive:true, force:true }); });
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/executions`;
  for (const enabled of [false,true]) {
    const response = await fetch(url, {
      method:"POST", headers:{ Authorization:"Bearer session-test-token-at-least-24-chars", "Content-Type":"application/json", ...(enabled ? {"X-Roster-Session-Stream":"1"}: {}) },
      body: JSON.stringify({ protocol:PROTOCOL, execution_id:enabled?"modern":"legacy", work_id:"work", agent_id:"developer", input:{}, context:{ request:"test", culture:"", history:[], knowledge:[] } }),
    });
    assert.equal(response.status,200);
    const frames: RuntimeFrame[] = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(frames.at(-1)?.type,"result");
    if (enabled) {
      const entries = frames.filter(frame => frame.type === "session").map(frame => frame.session);
      assert.equal(entries.filter(e => e.kind === "log").map(e => e.text).join(""),longText);
      assert.equal(entries.filter(e => e.kind === "decision").length,1);
      assert.equal(entries.filter(e => e.kind === "knowhow").length,1);
      assert.equal(new Set(entries.map(e => e.id)).size,entries.length);
      assert.ok(entries.every(e => Buffer.byteLength(e.text)<=20000 && !e.text.includes("�") && !('member_id' in e)));
    } else {
      assert.ok(frames.every(frame => frame.type === "log" || frame.type === "result"));
    }
  }
});
