import type { AgentImplementation } from "../../src/agent.js";

// Deterministic notification probe; no model or external tool side effect.
export function createAgents(): AgentImplementation[] {
  return ["designer", "developer"].map(id => ({
    spec: { id, name: id, description: "Notification contract fixture", statuses: ["ok"], events: ["complete"], skills: [], rules: [], capabilities: [] },
    async execute(input, context) {
      const wait = Number(input.input.wait_ms || 0);
      if (id === "designer" && wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
      context.signal.throwIfAborted();
      return { status: "ok", summary: "Ready", output: {}, events: id === "designer" ? [{ type: "complete", data: { message: "한글\n\"quoted\"", output: { ready: true, api_key: "private-test-value" }, token: "private-test-value", resource_ids: ["private-test-resource"] } }] : [], artifacts: [], metrics: {} };
    },
  }));
}
