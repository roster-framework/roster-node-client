import type { AgentImplementation } from "../../src/agent.js";

// Deterministic contract probe; no model account or external tool side effect.
export function createAgents(): AgentImplementation[] {
  return ["designer", "developer"].map(id => ({
    spec: {id, name: id === "designer" ? "Designer" : "Developer", description: "Event contract fixture", statuses: ["ok"], events: ["complete", "fail"], skills: [], rules: [], capabilities: []},
    async execute(input, context) {
      context.log("Contract probe " + id);
      const signal = String(input.input.signal || "complete");
      return {status: "ok", summary: "Contract checked", output: {request: input.context.request, delivery: input.context.subscription_delivery || null, resources: input.context.resources?.map(r => r.id) || []}, events: id === "designer" && signal !== "none" ? [{type: signal, data: {instruction: "Untrusted instruction", resource_ids: ["brief"], publisher_member_id: "forged"}}] : [], artifacts: [], metrics: {}};
    },
  }));
}
