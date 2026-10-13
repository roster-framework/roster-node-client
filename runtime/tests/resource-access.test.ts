import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ResourceInvocation } from "../src/interfaces/resource-contract.js";
import { invokeCoreResource } from "../src/infrastructure/core-resource-access.js";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { approvalTools } from "../src/infrastructure/approval-tools.js";
import type { AgentContext } from "../src/domain/agent.js";

test("optional resource descriptors survive parsing without accepting credentials", () => {
  const input = { protocol: "roster/0.1", execution_id: "run", work_id: "work", agent_id: "agent", input: {}, context: { request: "work", culture: "", history: [], knowledge: [], resources: [{ id: "figma", name: "Figma", server_id: "local", resource_id: "design", component: "mcp", route: "proxy", version: 1, operations: ["tools.list", "tools.call"] }] } };
  assert.equal(ResourceInvocation.parse(input).context.resources?.[0]?.id, "figma");
  assert.equal(ResourceInvocation.parse({ ...input, context: { ...input.context, resources: [{ ...input.context.resources[0], component: "internal-knowledge", operations: ["search"] }] } }).context.resources?.[0]?.operations[0], "search");
  assert.throws(() => ResourceInvocation.parse({ ...input, context: { ...input.context, resources: [{ ...input.context.resources[0], token: "provider-secret" }] } }));
  assert.throws(() => ResourceInvocation.parse({ ...input, context: { ...input.context, resources: [{ ...input.context.resources[0], route: "direct" }] } }));
});

test("resource proxy uses execution credential and rejects revocation and tool errors", async () => {
  let status = 200, isError = false;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url, token: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ isError, content: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const core = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, token: "test-token" };
    const operation = { id: "figma", name: "tools.call" as const, tool: "lookup", arguments: { query: "brief" } };
    await invokeCoreResource(core, operation, new AbortController().signal);
    assert.deepEqual(requests[0], { path: "/api/core/resource-invocations", token: `Bearer ${core.token}`, body: operation });
    status = 403; await assert.rejects(invokeCoreResource(core, operation, new AbortController().signal), /denied/);
    status = 200; isError = true; await assert.rejects(invokeCoreResource(core, operation, new AbortController().signal), /tool failed/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("managed resource tool uses scoped proxy after approval and retains failure", async () => {
  const events: string[] = [];
  const original = new DynamicStructuredTool({ name: "roster_invoke_resource", description: "resource proxy", schema: z.object({ id: z.string(), name: z.literal("tools.call"), tool: z.string() }), func: async () => { throw new Error("unscoped fallback used"); } });
  const context: AgentContext = {
    workspace: "", log: () => {}, signal: new AbortController().signal,
    approveTool: async () => { events.push("approved"); },
    invokeResource: async operation => { assert.equal(operation.id, "design"); events.push("proxy"); return { ok: true }; },
  };
  const [wrapped] = approvalTools([original], { mode: "all", tools: [] }, context, "roster-core");
  await wrapped!.invoke({ id: "design", name: "tools.call", tool: "lookup" });
  assert.deepEqual(events, ["approved", "proxy"]);
  context.invokeResource = async () => { throw new Error("revoked grant"); };
  await assert.rejects(wrapped!.invoke({ id: "design", name: "tools.call", tool: "lookup" }), /revoked/);
  assert.match(context.toolAccessFailure!.message, /revoked/);
});
