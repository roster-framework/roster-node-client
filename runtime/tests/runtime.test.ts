import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ManagedAgent,
  Result,
  PROTOCOL,
  type RunInput,
  type RunFrame,
} from "@roster/contracts";
import { RosterRuntime } from "../src/application/runtime.js";
import { FileRuntimeStorage } from "../src/infrastructure/filesystem.js";
import { executeAgent } from "../src/infrastructure/langgraph-engine.js";
import {
  managedImplementation,
  inspectMcp,
} from "../src/infrastructure/langchain-managed.js";
import { ConsoleStreamCapture } from "../src/infrastructure/console-stream.js";
import { createRuntimeApi } from "../src/interfaces/http.js";
import type { AgentImplementation } from "../src/domain/agent.js";

const input = (id: string, agent = "echo"): RunInput => ({
  protocol: PROTOCOL,
  execution_id: id,
  work_id: "work-1",
  agent_id: agent,
  input: { message: "hello" },
  context: {
    request: "확인",
    culture: "근거를 남긴다",
    history: [],
    knowledge: [],
  },
});
const spec = {
  id: "echo",
  name: "Echo",
  description: "test",
  statuses: ["success"],
  events: [],
  skills: [],
  rules: [],
  capabilities: [],
};
const token = "runtime-test-token-at-least-24-chars";

test("HTTP auth, NDJSON, contract validation, idempotency, cancellation and disk recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roster-runtime-"));
  const storage = new FileRuntimeStorage(directory, "test");
  const agents: AgentImplementation[] = [
    {
      spec: {...spec, id: "scope"},
      async execute(_i, ctx) {
        assert.deepEqual(ctx.coreMcp, {url: "http://127.0.0.1:7330/mcp", token: "scoped-execution-credential-32-bytes"});
        return Result.parse({status: "success", summary: "scoped"});
      },
    },
    {
      spec,
      async execute(_i, ctx) {
        ctx.log("first");
        return Result.parse({
          status: "success",
          summary: "done",
          metrics: { cost_usd: 0 },
        });
      },
    },
    {
      spec: { ...spec, id: "bad" },
      async execute() {
        return Result.parse({ status: "not-declared", summary: "must reject" });
      },
    },
    {
      spec: { ...spec, id: "slow" },
      async execute(_i, ctx) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 60000);
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
        return Result.parse({ status: "success", summary: "too late" });
      },
    },
  ];
  const runtime = new RosterRuntime(
    "test-runtime",
    agents,
    storage,
    storage,
    storage,
    { execute: executeAgent },
    { create: managedImplementation },
    { inspect: inspectMcp },
  );
  await runtime.initialize();
  const server = createRuntimeApi(runtime, token);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  });
  const post = (path: string, value: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
  assert.equal((await fetch(base + "/state")).status, 401);
	const scoped = await fetch(base + "/executions", {
		method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json",
			"X-Roster-Core-Mcp-Url": "http://127.0.0.1:7330/mcp",
			"X-Roster-Core-Mcp-Token": "scoped-execution-credential-32-bytes"},
		body: JSON.stringify(input("scoped-run", "scope")),
	});
	assert.equal(scoped.status, 200);
	assert.match(await scoped.text(), /"summary":"scoped"/);
	const incomplete = await fetch(base + "/executions", {
		method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json",
			"X-Roster-Core-Mcp-Url": "http://127.0.0.1:7330/mcp"},
		body: JSON.stringify(input("invalid-scope", "scope")),
	});
	assert.equal(incomplete.status, 400);
  const template={id:"developer",name:"Developer preset",agent:ManagedAgent.parse({id:"template",name:"Developer",kind:"echo",instructions:"Company policy",rules:["Test first"],statuses:["success"]})};
  assert.equal((await fetch(base+"/admin/agent-presets",{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(template)})).status,200);
  const administration=await (await fetch(base+"/admin",{headers:{Authorization:`Bearer ${token}`}})).json();
  assert.equal(administration.agent_presets[0].agent.instructions,"Company policy");
  const createdAgent={...administration.agent_presets[0].agent,id:"hired-developer",name:"Hired developer"};
  assert.equal((await fetch(base+"/admin/agents",{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(createdAgent)})).status,200);
  assert.equal((await storage.read()).managed_agents.find(a=>a.id==="hired-developer")?.version,1);
  assert.equal((await fetch(base+"/admin/agents",{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(createdAgent)})).status,409);
  const revisedAgent={...createdAgent,version:1,name:"Senior developer"};
  assert.equal((await fetch(base+"/admin/agents",{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(revisedAgent)})).status,200);
  assert.equal((await storage.read()).managed_agents.find(a=>a.id==="hired-developer")?.version,2);
  const generated=await post("/executions",input("preset-run","hired-developer"));assert.equal(generated.status,200);await generated.text();
  assert.equal((await storage.read()).managed_agents.find(a=>a.id==="hired-developer")?.instructions,"Company policy");

  assert.equal((await fetch(base+"/admin/agent-presets",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(template)})).status,401);

  const first = await post("/executions", input("exec-1"));
  assert.equal(first.status, 200);
  const frames = (await first.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunFrame);
  assert.equal(frames.at(-1)?.type, "result");
  assert.ok(frames.some((f) => f.type === "log" && f.text === "first"));
  assert.equal((await post("/executions", input("exec-1"))).status, 409);
  const bad = await post("/executions", input("bad-1", "bad"));
  const badFrames = (await bad.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(badFrames.at(-1).type, "observation");
  assert.equal(
    badFrames.some((f) => f.type === "result"),
    false,
  );
  const slow = await fetch(base + "/executions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input("slow-1", "slow")),
    signal: AbortSignal.timeout(2000),
  });
  assert.equal((await post("/executions/slow-1/cancel", {})).status, 200);
  assert.match(await slow.text(), /observation/);
  assert.equal((await storage.get("slow-1"))?.state, "attention");
  const managed = ManagedAgent.parse({
    id: "managed",
    name: "관리형 검사",
    kind: "echo",
  });
  await runtime.upsertAgent(managed);
  await storage.reserve("orphan");
  const reopened = new FileRuntimeStorage(directory, "ignored");
  const recovered = new RosterRuntime(
    "test-runtime",
    agents,
    reopened,
    reopened,
    reopened,
    { execute: executeAgent },
    { create: managedImplementation },
    { inspect: inspectMcp },
  );
  await recovered.initialize();
  assert.equal(
    (await recovered.manifest()).agents.some((a) => a.id === "managed"),
    true,
  );
  assert.equal((await reopened.get("exec-1"))?.state, "completed");
  assert.equal((await reopened.get("orphan"))?.state, "attention");
});

test("UTF-8 log limits, late logs and failed delivery preserve the completed receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roster-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new FileRuntimeStorage(directory, "test");
  let lateLog!: (text: string) => void;
  const agent: AgentImplementation = {
    spec,
    async execute(_input, ctx) {
      lateLog = ctx.log;
      ctx.log("한😀".repeat(10000));
      return Result.parse({ status: "success", summary: "saved" });
    },
  };
  const runtime = new RosterRuntime(
    "test-runtime",
    [agent],
    storage,
    storage,
    storage,
    { execute: (a, i, c) => a.execute(i, c) },
    { create: managedImplementation },
    { inspect: inspectMcp },
  );
  const frames: RunFrame[] = [];
  await runtime.run(input("delivery"), (frame) => {
    frames.push(frame);
    if (frame.type === "result") throw new Error("connection closed");
  });
  lateLog("must not follow the result");
  assert.equal(frames.at(-1)?.type, "result");
  const logs = frames.filter((f) => f.type === "log");
  assert.ok(logs.every(log => Buffer.byteLength(log.text) <= 20000 && !log.text.includes("�")));
  assert.equal(logs.map(log => log.text).join(""), "한😀".repeat(10000));
  assert.equal((await storage.get("delivery"))?.state, "completed");
  await runtime.close();
});

test("an agent returning after cancellation cannot publish success", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roster-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new FileRuntimeStorage(directory, "test");
  let runtime: RosterRuntime;
  const agent: AgentImplementation = {
    spec,
    async execute(_input, ctx) {
      assert.equal(runtime.cancel("cancel-late"), true);
      ctx.log("late log");
      return Result.parse({ status: "success", summary: "too late" });
    },
  };
  runtime = new RosterRuntime(
    "test-runtime",
    [agent],
    storage,
    storage,
    storage,
    { execute: (a, i, c) => a.execute(i, c) },
    { create: managedImplementation },
    { inspect: inspectMcp },
  );
  const frames: RunFrame[] = [];
  await runtime.run(input("cancel-late"), (frame) => frames.push(frame));
  assert.equal(frames.length, 1);
  assert.ok(
    frames[0]?.type === "observation" && frames[0].code === "interrupted",
  );
  assert.equal((await storage.get("cancel-late"))?.state, "attention");
  await runtime.close();
});

test("console output stays with its concurrent execution", async () => {
  const capture = new ConsoleStreamCapture();
  capture.install();
  const first: string[] = [],
    second: string[] = [];
  try {
    await Promise.all([
      capture.run(
        (s) => first.push(s),
        async () => {
          console.log("first %s", "one");
          await new Promise((r) => setTimeout(r, 15));
          console.warn("first two");
        },
      ),
      capture.run(
        (s) => second.push(s),
        async () => {
          console.log("second one");
          await new Promise((r) => setTimeout(r, 5));
          console.error("second two");
        },
      ),
    ]);
    assert.deepEqual(first, ["first one", "first two"]);
    assert.deepEqual(second, ["second one", "second two"]);
  } finally {
    capture.close();
  }
});

test("MCP connection fetches real tools over Streamable HTTP", async (t) => {
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: "local-docs-test", version: "1.0" });
    mcp.registerTool(
      "read_document",
      { description: "Read test document", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "test document" }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      const parts: Buffer[] = [];
      for await (const p of req) parts.push(Buffer.from(p));
      const body = parts.length
        ? JSON.parse(Buffer.concat(parts).toString())
        : undefined;
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const tools = await inspectMcp({
    id: "docs",
    name: "Documents",
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
  });
  assert.ok(tools.some((t) => t.includes("read_document")));
});


test("HTTP admission bounds parallel runs, leaves rejected IDs reusable and closes admission", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roster-admission-"));
  const storage = new FileRuntimeStorage(directory, "test");
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let executed = 0;
  const agents = ["a", "b", "c"].map(id => ({ spec: { ...spec, id },
    async execute() { executed++; await gate; return Result.parse({status:"success",summary:"done"}); } }));
  const runtime = new RosterRuntime("admission", agents, storage, storage, storage,
    { execute: (a,i,c) => a.execute(i,c) }, {create:managedImplementation}, {inspect:inspectMcp},
    {maxConcurrent:2,maxPerAgent:1});
  const server = createRuntimeApi(runtime, token); server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const base = "http://127.0.0.1:" + (server.address() as {port:number}).port;
  t.after(async () => { release(); await runtime.close(); await new Promise<void>(r => server.close(()=>r())); await rm(directory,{recursive:true,force:true}); });
  const post = (id:string, agent:string) => fetch(base+"/executions",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(input(id,agent))});
  const first = await post("one","a"); assert.equal(first.status,200);
  const duplicate = await post("one","a"); assert.equal(duplicate.status,409); await duplicate.text();
  const sameAgent = await post("two","a"); assert.equal(sameAgent.status,429);
  assert.deepEqual(await sameAgent.json(),{code:"runtime_busy",accepted:false,scope:"agent",error:"에이전트 실행 한도에 도달했습니다."});
  assert.equal(await storage.get("two"),undefined);
  const other = await post("three","b"); assert.equal(other.status,200);
  const full = await post("four","c"); assert.equal(full.status,429); assert.equal((await full.json()).scope,"runtime");
  assert.equal(runtime.capacity().active,2); assert.equal(executed,2);
  release(); await Promise.all([first.text(),other.text()]);
  const retry = await post("two","a"); assert.equal(retry.status,200); await retry.text();
  assert.equal((await storage.get("two"))?.state,"completed");
  await runtime.close();
  const closed = await post("five","a"); assert.equal(closed.status,503);
  assert.equal((await closed.json()).accepted,false); assert.equal(await storage.get("five"),undefined);
});

test("admission slots cover asynchronous lookup and shutdown waits for pending admission", async (t) => {
  const directory = await mkdtemp(join(tmpdir(),"roster-pending-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage = new FileRuntimeStorage(directory,"test");
  let release!:()=>void;
  const gate = new Promise<void>(r=>{release=r;});
  const registry = {read: async()=>{await gate; return storage.read();},
    transact: storage.transact.bind(storage), publish:storage.publish.bind(storage)};
  let calls = 0;
  const runtime = new RosterRuntime("pending",[{spec,async execute(){calls++;return Result.parse({status:"success",summary:"done"});}}],
    registry,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:managedImplementation},{inspect:inspectMcp},{maxConcurrent:1,maxPerAgent:1});
  const first = runtime.run(input("pending"),()=>{});
  await assert.rejects(runtime.run(input("extra"),()=>{}),/한도/);
  assert.equal(await storage.get("extra"),undefined);
  let closed=false;
  const closing = runtime.close().then(()=>{closed=true;});
  await Promise.resolve(); assert.equal(closed,false);
  release(); await Promise.all([first,closing]);
  assert.equal(calls,0); assert.equal((await storage.get("pending"))?.state,"attention");
  assert.equal(runtime.capacity().active,0); assert.equal(runtime.capacity().accepting,false);
});

test("failed admission releases the slot", async (t) => {
  const directory=await mkdtemp(join(tmpdir(),"roster-slot-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage=new FileRuntimeStorage(directory,"test");
  const runtime=new RosterRuntime("slots",[{spec,async execute(){return Result.parse({status:"success",summary:"done"});}}],storage,storage,storage,
    {execute:(a,i,c)=>a.execute(i,c)},{create:managedImplementation},{inspect:inspectMcp});
  await assert.rejects(runtime.run(input("unknown","missing"),()=>{}),/에이전트 없음/);
  assert.equal(runtime.capacity().active,0);
  await runtime.run(input("valid"),()=>{});
  assert.equal((await storage.get("valid"))?.state,"completed");
  await runtime.close();
});

test("LangGraph abort retains running receipt and capacity until the actual agent settles", async (t) => {
  const directory=await mkdtemp(join(tmpdir(),"roster-abort-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage=new FileRuntimeStorage(directory,"test");
  let release!:()=>void, started!:()=>void;
  const entered=new Promise<void>(r=>started=r), blocked=new Promise<void>(r=>release=r);
  const frames:RunFrame[]=[];
  const agent:AgentImplementation={spec,async execute(_input,ctx){started();await blocked;ctx.log("Late log");return Result.parse({status:"success",summary:"Late result"});}};
  const runtime=new RosterRuntime("abort",[agent],storage,storage,storage,{execute:executeAgent},{create:managedImplementation},{inspect:inspectMcp});
  const running=runtime.run(input("non-cooperative"),frame=>frames.push(frame));
  try {
    await entered;assert.equal(runtime.cancel("non-cooperative"),true);
    await new Promise(r=>setTimeout(r,50));
    assert.equal(runtime.capacity().active,1);
    assert.equal((await storage.get("non-cooperative"))?.state,"running");
    assert.equal(frames.some(f=>f.type==="result"||f.type==="observation"),false);
    await assert.rejects(runtime.run(input("duplicate"),()=>{}),e=>e instanceof Error && e.message.includes("에이전트 실행 한도"));
    assert.equal(await storage.get("duplicate"),undefined);
    let closed=false;const closing=runtime.close().then(()=>closed=true);
    await new Promise(r=>setTimeout(r,20));assert.equal(closed,false);
    release();await Promise.all([running,closing]);
    assert.equal((await storage.get("non-cooperative"))?.state,"attention");
    assert.equal(frames.filter(f=>f.type==="observation").length,1);
    assert.equal(frames.some(f=>f.type==="result"||f.type==="log"&&f.text==="Late log"),false);
    assert.equal(runtime.capacity().active,0);
  } finally { release();await running;await runtime.close(); }
});
