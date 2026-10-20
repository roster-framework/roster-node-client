import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ManagedAgent } from "@roster/contracts";
import type { ToolApproval } from "@roster/contracts";
import {
  ToolApprovals,
  type ApprovalRepository,
} from "../src/application/tool-approvals.js";
import { FileApprovalRepository } from "../src/infrastructure/approval-files.js";
import { approvalTools } from "../src/infrastructure/approval-tools.js";
import { FileRuntimeStorage } from "../src/infrastructure/filesystem.js";
import { fixtureMcpBinding } from "./fixtures/mcp-binding.js";
import { McpClientBindingDenied } from "../src/application/mcp-connections.js";
const input = {
  agent_id: "agent",
  execution_id: "run",
  work_id: "work",
  tool: "mcp/write",
  arguments: { path: "report.md", text: "original" },
};
class Memory implements ApprovalRepository {
  records: ToolApproval[] = [];
  list() {
    return structuredClone(this.records);
  }
  save(r: ToolApproval) {
    this.records = this.records
      .filter((v) => v.id !== r.id)
      .concat(structuredClone(r));
  }
}
function context(
  service: ToolApprovals,
  signal = new AbortController().signal,
) {
  return {
    workspace: "",
    signal,
    log: () => {},
    authorizeMcpTool: async (_connectionId: string, _toolName: string) => {},
    approveTool: (tool: string, args: Record<string, unknown>) =>
      service.request({ ...input, tool, arguments: args }, signal),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("approval cannot revive an MCP client whose connection changed while waiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-approval-revision-'));
  try {
    const {service, revision} = await fixtureMcpBinding(directory, new FileRuntimeStorage(directory), 'files', ['read']);
    const repo = new Memory();
    const approvals = new ToolApprovals(repo);
    let announce!: () => void;
    const waiting = new Promise<void>(resolve => { announce = resolve; });
    let calls = 0;
    const tool = new DynamicStructuredTool({name:'read', description:'read', schema:z.object({}), func:async () => {calls++; return 'private result';}});
    const ctx = {
      ...context(approvals),
      authorizeMcpTool: async (id:string, name:string, boundRevision?:string) => {
        assert.equal(boundRevision, revision);
        await service.assertClient(id, boundRevision!, name);
      },
      approveTool: async (key:string, args:Record<string,unknown>) => {
        const pending = approvals.request({...input, tool:key, arguments:args}, new AbortController().signal);
        announce();
        await pending;
      },
    };
    const pending = approvalTools([tool], {mode:'all',tools:[]}, ctx, 'files', revision)[0].invoke({});
    const refused = assert.rejects(pending, McpClientBindingDenied);
    await waiting;
    await service.change({protocol:'roster-mcp-change/1',request_id:'replace-during-approval',connection_id:'files',expected_revision:revision,action:'upsert',configuration:{id:'files',name:'Replacement',url:'https://replacement.example/mcp'}});
    approvals.decide('agent', approvals.list('agent')[0].id, true, 'reviewer');
    await refused;
    assert.equal(calls, 0);
  } finally {
    await rm(directory, {recursive:true,force:true});
  }
});
test("tools have no side effect before approval; exact call executes once and keeps artifacts", async () => {
  const repo = new Memory(),
    service = new ToolApprovals(repo);
  let calls = 0;
  const tool = new DynamicStructuredTool({
    name: "write",
    description: "write",
    schema: z.object({ text: z.string() }),
    responseFormat: "content_and_artifact",
    func: async (args) => {
      calls++;
      return [args.text, { written: true }];
    },
  });
  const wrapped = approvalTools(
    [tool],
    { mode: "all", tools: [] },
    context(service),
    "mcp",
  )[0];
  const pending = wrapped.invoke({
    type: "tool_call",
    id: "call",
    name: wrapped.name,
    args: { text: "approved text" },
  });
  await settle();
  assert.equal(calls, 0);
  const request = service.list("agent")[0];
  assert.equal(request.tool, "mcp/write");
  assert.equal(request.arguments.text, "approved text");
  assert.throws(() =>
    service.decide("another-agent", request.id, true, "reviewer"),
  );
  assert.equal(calls, 0);
  service.decide("agent", request.id, true, "reviewer");
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.content, "approved text");
  assert.deepEqual(result.artifact, { written: true });
  assert.equal(service.list("agent")[0].state, "consumed");
  assert.throws(() => service.decide("agent", request.id, true, "reviewer"));
});
test("selected tool policy scopes by MCP connection and missing approval gate fails closed", async () => {
  let calls = 0;
  const tool = new DynamicStructuredTool({
    name: "write",
    description: "write",
    schema: z.object({}),
    func: async () => {
      calls++;
      return "ok";
    },
  });
  const ctx = {
    workspace: "",
    signal: new AbortController().signal,
    log: () => {},
    authorizeMcpTool: async (_connectionId: string, _toolName: string) => {},
  };
  await approvalTools(
    [tool],
    { mode: "selected", tools: ["other/write"] },
    ctx,
    "mcp",
  )[0].invoke({});
  assert.equal(calls, 1);
  await assert.rejects(
    approvalTools(
      [tool],
      { mode: "selected", tools: ["mcp/write"] },
      ctx,
      "mcp",
    )[0].invoke({}),
    /unavailable/,
  );
  assert.equal(calls, 1);
});
test("MCP access is checked again after human approval before the tool runs", async () => {
  let checks = 0;
  let calls = 0;
  const tool = new DynamicStructuredTool({
    name: "write", description: "write", schema: z.object({}),
    func: async () => { calls++; return "ok"; },
  });
  const context = {
    workspace: "", signal: new AbortController().signal, log: () => {},
    authorizeMcpTool: async (connection: string, name: string) => {
      assert.equal(connection, "files");
      assert.equal(name, "write");
      checks++;
      if (checks === 2) throw Error("grant revoked");
    },
    approveTool: async () => {},
  };
  await assert.rejects(approvalTools([tool], {mode:"all",tools:[]}, context, "files")[0].invoke({}), /grant revoked/);
  assert.equal(checks, 2);
  assert.equal(calls, 0);
  await assert.rejects(approvalTools([tool], {mode:"none",tools:[]}, context, "files")[0].invoke({}), /grant revoked/);
  assert.equal(checks, 2);
  await assert.rejects(approvalTools([tool], {mode:"none",tools:[]}, {...context, toolAccessFailure: undefined, authorizeMcpTool: undefined}, "files")[0].invoke({}), /unavailable/);
  assert.equal(calls, 0);
});
test("denial, timeout and cancellation never authorize the call", async () => {
  for (const action of ["deny", "timeout", "abort"]) {
    const repo = new Memory(),
      service = new ToolApprovals(repo, 20),
      controller = new AbortController();
    const pending = service.request(input, controller.signal);
    const rejected = assert.rejects(pending);
    const row = service.list("agent")[0];
    if (action === "deny") service.decide("agent", row.id, false, "reviewer");
    if (action === "abort") controller.abort();
    await rejected;
    assert.equal(
      service.list("agent")[0].state,
      action === "deny" ? "denied" : "expired",
    );
    assert.throws(() => service.decide("agent", row.id, true, "reviewer"));
  }
});
test("concurrent calls require separate approvals and preserve argument snapshots", async () => {
  const repo = new Memory(),
    service = new ToolApprovals(repo);
  const args = { ...input, arguments: { text: "first" } };
  const one = service.request(args, new AbortController().signal);
  args.arguments.text = "mutated";
  const two = service.request(
    { ...input, execution_id: "run2" },
    new AbortController().signal,
  );
  const rejected = assert.rejects(two);
  const rows = service.list("agent");
  assert.equal(
    rows.find((r) => r.execution_id === "run")!.arguments.text,
    "first",
  );
  service.decide(
    "agent",
    rows.find((r) => r.execution_id === "run")!.id,
    true,
    "reviewer",
  );
  await one;
  assert.equal(rows.length, 2);
  service.decide(
    "agent",
    rows.find((r) => r.execution_id === "run2")!.id,
    false,
    "reviewer",
  );
  await rejected;
});
test("restart expires pending grants and persists the reviewer decision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roster-approvals-"));
  try {
    const repository = new FileApprovalRepository(dir);
    repository.save({
      ...input,
      id: "pending",
      state: "pending",
      created: new Date().toISOString(),
      expires: new Date(Date.now() + 10000).toISOString(),
    });
    repository.save({
      ...input,
      id: "approved",
      state: "approved",
      created: new Date().toISOString(),
      expires: new Date(Date.now() + 10000).toISOString(),
      decided_by: "reviewer",
    });
    const service = new ToolApprovals(repository);
    assert(service.list("agent").every((r) => r.state === "expired"));
    assert.equal(
      service.list("agent").find((r) => r.id === "approved")!.decided_by,
      "reviewer",
    );
    assert.throws(() => service.decide("agent", "pending", true, "reviewer"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("agent schema keeps legacy policy optional and rejects empty selective policies", () => {
  assert.equal(
    ManagedAgent.parse({ id: "old", name: "Old", kind: "llm" }).tool_approval,
    undefined,
  );
  assert.equal(
    ManagedAgent.safeParse({
      id: "agent",
      name: "Agent",
      kind: "llm",
      tool_approval: { mode: "selected", tools: [] },
    }).success,
    false,
  );
});

test("runtime HTTP exposes approvals by agent and resumes only the approved execution", async () => {
  const { RosterRuntime } = await import("../src/application/runtime.js");
  const { FileRuntimeStorage } = await import(
    "../src/infrastructure/filesystem.js"
  );
  const { createRuntimeApi } = await import("../src/interfaces/http.js");
  const { managedImplementation } = await import(
    "../src/infrastructure/langchain-managed.js"
  );
  const dir = await mkdtemp(join(tmpdir(), "roster-approval-http-"));
  const store = new FileRuntimeStorage(dir, "test");
  const approvals = new ToolApprovals(
    new FileApprovalRepository(join(dir, "approvals")),
  );
  let calls = 0;
  const agent = {
    spec: {
      id: "agent",
      name: "Agent",
      description: "fixture",
      statuses: ["ok"],
      events: [],
      skills: [],
      rules: [],
      capabilities: [],
    },
    execute: async (input: any, context: any) => {
      await context.approveTool("mcp/write", { text: input.input.text });
      calls++;
      return {
        status: "ok",
        summary: "done",
        output: {},
        events: [],
        artifacts: [],
        metrics: {},
      };
    },
  };
  const runtime = new RosterRuntime(
    "fixture",
    [agent],
    store,
    store,
    store,
    { execute: (agent, input, context) => agent.execute(input, context) },
    { create: managedImplementation },
    { inspect: async () => [] },
    { maxConcurrent: 2, maxPerAgent: 1 },
    approvals,
  );
  await runtime.initialize();
  const server = createRuntimeApi(runtime, "test-token");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = "http://127.0.0.1:" + address.port;
  async function api(path: string, method = "GET", body?: unknown) {
    return fetch(base + path, {
      method,
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    const stream = await api("/executions", "POST", {
      protocol: "roster/0.1",
      execution_id: "run",
      work_id: "work",
      agent_id: "agent",
      input: { text: "approved" },
      context: { request: "write", culture: "", history: [], knowledge: [] },
    });
    const finished = stream.text();
    await settle();
    const rows = await (await api("/admin/agents/agent/approvals")).json();
    const record = rows.approvals[0];
    assert.equal(record.state, "pending");
    assert.equal(calls, 0);
    assert.deepEqual(
      (await (await api("/admin/agents/other/approvals")).json()).approvals,
      [],
    );
    assert.equal(
      (
        await api("/admin/agents/other/approvals/" + record.id, "POST", {
          allow: true,
          actor: "reviewer",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api("/admin/agents/agent/approvals/" + record.id, "POST", {
          allow: true,
          actor: "reviewer",
        })
      ).status,
      200,
    );
    assert.match(await finished, /"type":"result"/);
    assert.equal(calls, 1);
    assert.equal(
      (
        await api("/admin/agents/agent/approvals/" + record.id, "POST", {
          allow: true,
          actor: "reviewer",
        })
      ).status,
      400,
    );
  } finally {
    await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
