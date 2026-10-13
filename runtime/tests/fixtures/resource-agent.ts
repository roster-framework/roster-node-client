import type { AgentImplementation } from "../../src/agent.js";

export function createAgents(): AgentImplementation[] {
  return [{
    spec: { id: "resource-probe", name: "Resource probe", description: "Independent service integration fixture", statuses: ["ok"], events: [], skills: [], rules: [], capabilities: [] },
    async execute(input, context) {
      const descriptors = context.resources ?? [];
      if (descriptors.some(resource => resource.id === "hidden")) throw new Error("Unauthorized descriptor disclosed");
      await context.invokeResource!({ id: "design", name: "tools.list" });
      const first = await context.invokeResource!({ id: "design", name: "tools.call", tool: "lookup", arguments: { query: "brief" } });
      if (typeof input.input.gate === "string") {
        await fetch(input.input.gate, { signal: context.signal });
        // Intentionally catches denial: the runtime must still reject a success result.
        try { await context.invokeResource!({ id: "design", name: "tools.call", tool: "lookup" }); } catch {}
      }
      context.recordSession?.({ kind: "decision", text: "Used a permitted resource through Core proxy" });
      return { status: "ok", summary: "Scoped resources verified", output: { descriptors, knowledge: input.context.knowledge, first }, events: [], artifacts: [], metrics: {} };
    },
  }];
}
