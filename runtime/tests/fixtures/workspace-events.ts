import type { AgentImplementation } from "../../src/agent.js";

// Declared explicit handoffs on both participants, without a model/tool call.
export function createAgents(): AgentImplementation[] {
  return ["designer", "developer", "designer-next", "designer-incompatible"].map(id => ({
    spec: { id, name: id, description: "Workspace event fixture", statuses: ["ok"], events: id === "designer-incompatible" ? [] : ["complete"], skills: [], rules: [], capabilities: [] },
    async execute(input, context) {
      const wait = Number(input.input.wait_ms || 0);
      if (id.startsWith("designer") && wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
      context.signal.throwIfAborted();
      return { status: "ok", summary: "Ready", output: {}, events: id === "designer-incompatible" ? [] : [{ type: "complete", data: { participant: id } }], artifacts: [], metrics: {} };
    },
  }));
}
