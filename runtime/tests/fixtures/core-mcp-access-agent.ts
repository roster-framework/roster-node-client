import { Result } from "@roster/contracts";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { AgentModule } from "../../src/agent.js";

// Loaded only by the isolated core/runtime integration script. This code agent
// deliberately uses the runtime's authorization port to probe the live core.
export const createAgents: AgentModule["createAgents"] = () => [{
  spec: {
    id: "access-probe", name: "Access probe", description: "Integration fixture",
    statuses: ["success"], events: [], skills: [], rules: [], capabilities: [],
  },
  async execute(input, context) {
    if (!context.authorizeMcpTool) throw new Error("MCP access port unavailable");
    const endpoint = process.env.ROSTER_ACCESS_PROBE_URL;
    if (!endpoint) throw new Error("Probe endpoint unavailable");
    const check = () => context.authorizeMcpTool!("files", "write_note");
    await check();
    if (input.input.wait_for_release) {
      await fetch(endpoint + "/ready", {
        method: "POST", signal: context.signal,
        headers: {Authorization: `Bearer ${context.coreMcp?.token || ""}`},
      });
      for (;;) {
        context.signal.throwIfAborted();
        const gate = await fetch(endpoint + "/gate", {signal: context.signal});
        if ((await gate.json() as {open: boolean}).open) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await check();
    }
    const client = new MultiServerMCPClient({files: {transport: "http", url: endpoint + "/mcp"}});
    try {
      const tool = (await client.getTools("files")).find(tool => tool.name === "write_note");
      if (!tool) throw new Error("External MCP tool unavailable");
      await tool.invoke({});
    } finally {
      await client.close();
    }
    return Result.parse({status: "success", summary: "Authorized external call", metrics: {cost_usd: 0}});
  },
}];
